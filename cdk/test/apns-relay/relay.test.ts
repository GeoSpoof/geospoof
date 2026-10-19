import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createRelay, type RelayDeps } from "../../lib/lambda/apns-relay/relay";
import type { ApnsSendRequest, ApnsSendResult } from "../../lib/lambda/apns-relay/apns-client";
import type { EntitlementVerifier } from "../../lib/lambda/apns-relay/entitlement";
import type { RelayRuntimeConfig } from "../../lib/lambda/apns-relay/env-contract";
import type { HttpApiEvent, HttpApiResult } from "../../lib/lambda/apns-relay/http";
import { emfSink, logFailure, METRIC_NAMESPACE } from "../../lib/lambda/apns-relay/metrics";
import {
  ProviderTokenCache,
  signProviderToken,
  type ProviderTokenSigner,
} from "../../lib/lambda/apns-relay/provider-token";
import {
  parseApnsSecret,
  parseSessionSecret,
  RelayFault,
  SecretCache,
  type SecretFetcher,
} from "../../lib/lambda/apns-relay/secrets";
import {
  mintSessionToken,
  pushTokenMatches,
  verifySessionToken,
} from "../../lib/lambda/apns-relay/session-token";

// ---------------------------------------------------------------------------
// Fixtures. Every credential is generated in-process and never written anywhere.

const NOW = 1_800_000_000;
const NOW_MS = NOW * 1000 + 250;
const APPLE_REFERENCE_OFFSET = 978_307_200;
const PUSH_TOKEN = "80" + "a1".repeat(39);
const OTHER_TOKEN = "80" + "b2".repeat(39);
const APNS_ID = "8E4A2F6B-1C3D-4E5F-A6B7-C8D9E0F1A2B3";
const APNS_SECRET_ID = "geospoof/apns/signing-key";
const SESSION_SECRET_ID = "arn:aws:secretsmanager:us-east-1:898565151814:secret:session-AbCdEf";
const SESSION_SECRET = randomBytes(32).toString("hex");
const SESSION_KEY = parseSessionSecret(SESSION_SECRET);
const P8 = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;
const APP_TX_JWS = "eyJhbGciOiJFUzI1NiJ9.eyJhcHBUeCI6InRlc3QifQ.YXBwLXR4LXNpZ25hdHVyZQ";
const TX_JWS = "eyJhbGciOiJFUzI1NiJ9.eyJ0eCI6InRlc3QifQ.dHgtc2lnbmF0dXJl";

const DEV_CONFIG: RelayRuntimeConfig = {
  bundleId: "com.moonloaf.geospoof",
  teamId: "9445Q654K8",
  appAppleId: 6765719745,
  storeKitEnvironments: ["Production", "Sandbox"],
  apnsKeys: { sandbox: { keyId: "A3TWAYM427", secretId: APNS_SECRET_ID } },
  sessionSecretId: SESSION_SECRET_ID,
};

const apnsSecret = (over: Record<string, string> = {}) =>
  JSON.stringify({ keyId: "A3TWAYM427", teamId: "9445Q654K8", p8: P8, ...over });

const proVerifier: EntitlementVerifier = {
  verifyAppTransaction: async () => ({
    bundleId: "com.moonloaf.geospoof",
    originalApplicationVersion: "1",
  }),
  verifyTransaction: () => Promise.reject(new Error("unverifiable")),
};
const notProVerifier: EntitlementVerifier = {
  verifyAppTransaction: async () => ({
    bundleId: "com.moonloaf.geospoof",
    originalApplicationVersion: "99",
  }),
  verifyTransaction: () => Promise.reject(new Error("unverifiable")),
};

// ---------------------------------------------------------------------------
// Output capture. Every test runs with stdout, stderr and console captured; the
// afterEach checks none of the credentials that test handled reached any of it.

let captured: { stdout: string[]; other: string[] };
let credentials: Set<string>;
let restore: (() => void)[] = [];

beforeEach(() => {
  captured = { stdout: [], other: [] };
  credentials = new Set([PUSH_TOKEN, OTHER_TOKEN, SESSION_SECRET, APP_TX_JWS, TX_JWS, P8]);
  for (const line of P8.split("\n")) if (line.length > 20) credentials.add(line);
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    captured.stdout.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    captured.other.push(String(chunk));
    return true;
  });
  const consoles = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      captured.other.push(args.map(String).join(" "));
    })
  );
  restore = [
    () => out.mockRestore(),
    () => err.mockRestore(),
    ...consoles.map((c) => () => c.mockRestore()),
  ];
});

afterEach(() => {
  for (const r of restore) r();
  const text = [...captured.stdout, ...captured.other].join("\n");
  for (const secret of credentials) {
    expect(text.includes(secret), "a credential reached the logs").toBe(false);
  }
});

const emfLines = () =>
  captured.stdout
    .join("")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const warnLines = () => captured.other.map((l) => JSON.parse(l) as Record<string, unknown>);

// ---------------------------------------------------------------------------
// Harness

interface HarnessOptions {
  config?: () => RelayRuntimeConfig;
  verifiers?: readonly EntitlementVerifier[];
  apnsSecretRaw?: string;
  fetchFails?: (id: string) => boolean;
  send?: (req: ApnsSendRequest) => Promise<ApnsSendResult>;
  apnsKey?: RelayDeps["apnsKey"];
}

function harness(opts: HarnessOptions = {}) {
  let nowMs = NOW_MS;
  const fetch: SecretFetcher = async (id) => {
    if (opts.fetchFails?.(id)) throw new Error(`AccessDeniedException ${id}`);
    if (id === APNS_SECRET_ID) return opts.apnsSecretRaw ?? apnsSecret();
    if (id === SESSION_SECRET_ID) return SESSION_SECRET;
    throw new Error("ResourceNotFoundException");
  };
  const secrets = new SecretCache(fetch, () => nowMs);
  const signer = vi.fn<ProviderTokenSigner>((...args) => {
    const jwt = signProviderToken(...args);
    credentials.add(jwt);
    return jwt;
  });
  const send = vi.fn<(req: ApnsSendRequest) => Promise<ApnsSendResult>>(
    opts.send ?? (async () => ({ kind: "response", status: 200, apnsId: APNS_ID }))
  );
  const config = opts.config ?? (() => DEV_CONFIG);
  const deps: RelayDeps = {
    config,
    nowMs: () => nowMs,
    apnsKey:
      opts.apnsKey ??
      ((env) => {
        const ref = config().apnsKeys[env];
        if (!ref) throw new RelayFault("config_invalid");
        return secrets.get(ref.secretId, (raw) =>
          parseApnsSecret(raw, { keyId: ref.keyId, teamId: config().teamId })
        );
      }),
    sessionKey: () => secrets.get(config().sessionSecretId, parseSessionSecret),
    verifiers: () => opts.verifiers ?? [proVerifier],
    providerTokens: new ProviderTokenCache(signer),
    apns: { send },
    metrics: emfSink(undefined, () => nowMs),
    log: logFailure,
  };
  const relay = createRelay(deps);
  return {
    relay,
    send,
    signer,
    setNowMs: (ms: number) => {
      nowMs = ms;
    },
    invoke: async (event: HttpApiEvent): Promise<HttpApiResult> => {
      const res = await relay(event);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      if (typeof body.token === "string") credentials.add(body.token);
      return res;
    },
  };
}

const sessionEvent = (body: unknown): HttpApiEvent => ({
  routeKey: "POST /v1/session",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const bearerFor = (pushToken = PUSH_TOKEN, mintedAtSecs = NOW): string => {
  const { token } = mintSessionToken(SESSION_KEY, pushToken, mintedAtSecs);
  credentials.add(token);
  return token;
};

const pushBody = (over: Record<string, unknown> = {}) => ({
  environment: "sandbox",
  kind: "route",
  push_token: PUSH_TOKEN,
  event: "update",
  priority: "high",
  stale_in_secs: 120,
  confirmed_age_secs: 5,
  content_state: {
    travelled_m: 4321,
    total_m: 5010,
    finishes_in_secs: 100,
    repeats: false,
    paused: true,
    finished: false,
    speed_defaulted: true,
    pending_action: null,
    location_in_effect: true,
  },
  ...over,
});

/** `bearer: null` sends no Authorization header at all. */
const pushEvent = (body: unknown, bearer: string | null = bearerFor()): HttpApiEvent => {
  if (bearer !== null) credentials.add(bearer);
  return {
    routeKey: "POST /v1/push",
    headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  };
};

const parse = (res: HttpApiResult) => JSON.parse(res.body) as Record<string, unknown>;

function expectError(res: HttpApiResult, status: number, error: string): void {
  expect(res.statusCode).toBe(status);
  expect(parse(res).error).toBe(error);
}

// ---------------------------------------------------------------------------

describe("POST /v1/session", () => {
  it("issues a token bound to the push token when the entitlement is Pro", async () => {
    const h = harness();
    const res = await h.invoke(
      sessionEvent({ app_transaction: APP_TX_JWS, transactions: [TX_JWS], push_token: PUSH_TOKEN })
    );
    expect(res.statusCode).toBe(200);
    const body = parse(res);
    expect(body.expires_in_secs).toBe(28800);
    expect(Object.keys(body).sort()).toEqual(["expires_in_secs", "token"]);
    const v = verifySessionToken(SESSION_KEY, body.token as string, NOW);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(pushTokenMatches(v.pushTokenHash, PUSH_TOKEN)).toBe(true);
      expect(pushTokenMatches(v.pushTokenHash, OTHER_TOKEN)).toBe(false);
    }
    // Expiry is from the relay clock: valid until NOW + 28800, not after.
    expect(verifySessionToken(SESSION_KEY, body.token as string, NOW + 28799).ok).toBe(true);
    expect(verifySessionToken(SESSION_KEY, body.token as string, NOW + 28800).ok).toBe(false);
    expect(emfLines().filter((l) => "SessionIssued" in l)).toHaveLength(1);
  });

  it("refuses a verified but non-Pro entitlement with 403 entitlement_invalid", async () => {
    const h = harness({ verifiers: [notProVerifier] });
    const res = await h.invoke(
      sessionEvent({ app_transaction: APP_TX_JWS, push_token: PUSH_TOKEN })
    );
    expectError(res, 403, "entitlement_invalid");
    expect(emfLines().filter((l) => "SessionIssued" in l)).toHaveLength(0);
  });

  it("refuses unverifiable material with 403 entitlement_invalid", async () => {
    const throwing: EntitlementVerifier = {
      verifyAppTransaction: () => Promise.reject(new Error("bad chain")),
      verifyTransaction: () => Promise.reject(new Error("bad chain")),
    };
    const h = harness({ verifiers: [throwing, throwing] });
    const res = await h.invoke(
      sessionEvent({ app_transaction: APP_TX_JWS, transactions: [TX_JWS], push_token: PUSH_TOKEN })
    );
    expectError(res, 403, "entitlement_invalid");
  });

  it("refuses a body with both proofs absent with 403", async () => {
    const verify = vi.fn();
    const h = harness({
      verifiers: [{ verifyAppTransaction: verify, verifyTransaction: verify }],
    });
    expectError(
      await h.invoke(sessionEvent({ push_token: PUSH_TOKEN })),
      403,
      "entitlement_invalid"
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it("refuses a schema error with 400 schema", async () => {
    const h = harness();
    expectError(
      await h.invoke(sessionEvent({ app_transaction: APP_TX_JWS, push_token: PUSH_TOKEN, x: 1 })),
      400,
      "schema"
    );
    expectError(await h.invoke(sessionEvent("{not json")), 400, "schema");
  });

  it("refuses a body over 128 KB with 413", async () => {
    const h = harness();
    const res = await h.invoke(sessionEvent(`{"push_token":"${"a".repeat(131_072)}"}`));
    expectError(res, 413, "payload_too_large");
  });

  it("logs the entitlement outcome as a code only - nothing about the material", async () => {
    const h = harness({ verifiers: [notProVerifier] });
    await h.invoke(sessionEvent({ app_transaction: APP_TX_JWS, push_token: PUSH_TOKEN }));
    expect(warnLines()).toEqual([{ route: "session", error: "entitlement_invalid" }]);
  });
});

describe("POST /v1/push: auth", () => {
  it("refuses a missing, garbage, or expired bearer with 401 and sends nothing", async () => {
    const h = harness();
    expectError(await h.invoke(pushEvent(pushBody(), null)), 401, "unauthorized");
    expectError(await h.invoke(pushEvent(pushBody(), "garbage.token.value")), 401, "unauthorized");
    const expired = bearerFor(PUSH_TOKEN, NOW - 28800);
    expectError(await h.invoke(pushEvent(pushBody(), expired)), 401, "unauthorized");
    const forged = mintSessionToken(randomBytes(32), PUSH_TOKEN, NOW).token;
    expectError(await h.invoke(pushEvent(pushBody(), forged)), 401, "unauthorized");
    expect(h.send).not.toHaveBeenCalled();
    expect(h.signer).not.toHaveBeenCalled();
  });

  it("refuses a session bound to another push token with 403 token_mismatch", async () => {
    const h = harness();
    const res = await h.invoke(pushEvent(pushBody(), bearerFor(OTHER_TOKEN)));
    expectError(res, 403, "token_mismatch");
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("POST /v1/push: refusals that are never forwarded", () => {
  it.each([
    ["an unknown kind", pushBody({ kind: "banner" }), "unknown_kind"],
    ["steering", pushBody({ kind: "steering" }), "unknown_kind"],
    ["a schema error", pushBody({ priority: "urgent" }), "schema"],
    ["a client absolute time", pushBody({ timestamp: NOW }), "schema"],
    ["a client push type", pushBody({ push_type: "alert" }), "schema"],
  ])("refuses %s with 400 and sends nothing", async (_label, body, error) => {
    const h = harness();
    const res = await h.invoke(pushEvent(body));
    expectError(res, 400, error);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("states the reason for steering", async () => {
    const h = harness();
    const res = await h.invoke(pushEvent(pushBody({ kind: "steering" })));
    expect(parse(res).reason).toBe("kind 'steering' is reserved and not implemented");
  });

  it("refuses production against a sandbox-only deployment with 400 environment_unsupported", async () => {
    const h = harness();
    const res = await h.invoke(pushEvent(pushBody({ environment: "production" })));
    expectError(res, 400, "environment_unsupported");
    expect(h.send).not.toHaveBeenCalled();
    expect(h.signer).not.toHaveBeenCalled();
  });

  it("refuses a body over 8 KB with 413", async () => {
    const h = harness();
    const ev = pushEvent(pushBody());
    const res = await h.invoke({ ...ev, body: ev.body + " ".repeat(8192) });
    expectError(res, 413, "payload_too_large");
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("POST /v1/push: happy path", () => {
  it("answers 202 with the apns_id and forwards a correctly built request", async () => {
    const h = harness();
    const res = await h.invoke(pushEvent(pushBody({ priority: "high" })));
    expect(res.statusCode).toBe(202);
    expect(parse(res)).toEqual({ apns_id: APNS_ID });

    expect(h.send).toHaveBeenCalledTimes(1);
    const req = h.send.mock.calls[0][0];
    expect(req.authority).toBe("https://api.sandbox.push.apple.com");
    expect(req.pushToken).toBe(PUSH_TOKEN);
    expect(req.topic).toBe("com.moonloaf.geospoof.push-type.liveactivity");
    expect(req.pushType).toBe("liveactivity");
    expect(req.priority).toBe("10");
    const [header] = req.jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "A3TWAYM427",
    });
  });

  it("maps priority low to 5", async () => {
    const h = harness();
    await h.invoke(pushEvent(pushBody({ priority: "low" })));
    expect(h.send.mock.calls[0][0].priority).toBe("5");
  });

  it("stamps every absolute in the payload from the relay clock, never the body", async () => {
    const h = harness();
    await h.invoke(pushEvent(pushBody({ confirmed_age_secs: 5, stale_in_secs: 120 })));
    const { aps } = JSON.parse(h.send.mock.calls[0][0].payload) as {
      aps: Record<string, unknown> & { "content-state": Record<string, unknown> };
    };
    expect(aps.timestamp).toBe(NOW);
    expect(aps["stale-date"]).toBe(NOW + 120);
    expect(aps["content-state"].confirmedAtEpoch).toBe(NOW - 5);
    expect(aps["content-state"].finishesAtEpoch).toBe(NOW + 100);
    expect(aps.timestamp).not.toBe(NOW - APPLE_REFERENCE_OFFSET);
    expect(aps["content-state"]).toEqual({
      travelledM: 4321,
      totalM: 5010,
      finishesAtEpoch: NOW + 100,
      repeats: false,
      paused: true,
      finished: false,
      speedDefaulted: true,
      confirmedAtEpoch: NOW - 5,
      locationInEffect: true,
    });
    expect(Object.keys(aps)).toEqual(["timestamp", "event", "stale-date", "content-state"]);
  });

  it("follows the relay clock when it moves, with the same client body", async () => {
    const h = harness();
    const body = pushBody();
    await h.invoke(pushEvent(body));
    h.setNowMs(NOW_MS + 3_600_000);
    await h.invoke(pushEvent(body));
    const stamps = h.send.mock.calls.map(
      ([req]) => (JSON.parse(req.payload) as { aps: { timestamp: number } }).aps.timestamp
    );
    expect(stamps).toEqual([NOW, NOW + 3600]);
  });

  it("reuses the provider JWT across invokes and re-signs at ~50 min", async () => {
    const h = harness();
    await h.invoke(pushEvent(pushBody()));
    h.setNowMs(NOW_MS + 600_000);
    await h.invoke(pushEvent(pushBody()));
    expect(h.signer).toHaveBeenCalledTimes(1);
    const [first, second] = h.send.mock.calls.map(([req]) => req.jwt);
    expect(second).toBe(first);

    h.setNowMs(NOW_MS + 3_000_000);
    await h.invoke(pushEvent(pushBody()));
    expect(h.signer).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[2][0].jwt).not.toBe(first);
  });

  it("never says delivered or success", async () => {
    const h = harness();
    const res = await h.invoke(pushEvent(pushBody()));
    expect(res.body).not.toMatch(/deliver|success/i);
  });
});

describe("POST /v1/push: APNs response mapping", () => {
  const cases: {
    name: string;
    result: ApnsSendResult;
    status: number;
    error: string;
    reason?: string;
    retryAfter?: string;
    bucket: string;
    apnsAuthFault?: boolean;
  }[] = [
    {
      name: "400 BadDeviceToken",
      result: { kind: "response", status: 400, reason: "BadDeviceToken" },
      status: 410,
      error: "token_dead",
      reason: "BadDeviceToken",
      bucket: "400",
    },
    {
      name: "410 Unregistered",
      result: { kind: "response", status: 410, reason: "Unregistered" },
      status: 410,
      error: "token_dead",
      reason: "Unregistered",
      bucket: "410",
    },
    {
      name: "403 InvalidProviderToken",
      result: { kind: "response", status: 403, reason: "InvalidProviderToken" },
      status: 502,
      error: "relay_misconfigured",
      reason: "InvalidProviderToken",
      bucket: "403",
      apnsAuthFault: true,
    },
    {
      name: "429 TooManyRequests",
      result: { kind: "response", status: 429, reason: "TooManyRequests" },
      status: 429,
      error: "rate_limited",
      reason: "TooManyRequests",
      retryAfter: "60",
      bucket: "429",
    },
    {
      name: "500 InternalServerError",
      result: { kind: "response", status: 500, reason: "InternalServerError" },
      status: 503,
      error: "apns_unavailable",
      retryAfter: "30",
      bucket: "500",
    },
    {
      name: "503 ServiceUnavailable",
      result: { kind: "response", status: 503, reason: "ServiceUnavailable" },
      status: 503,
      error: "apns_unavailable",
      retryAfter: "30",
      bucket: "503",
    },
    {
      name: "400 BadPriority (other 4xx)",
      result: { kind: "response", status: 400, reason: "BadPriority" },
      status: 502,
      error: "apns_rejected",
      reason: "BadPriority",
      bucket: "400",
    },
    {
      name: "413 PayloadTooLarge",
      result: { kind: "response", status: 413, reason: "PayloadTooLarge" },
      status: 502,
      error: "apns_rejected",
      reason: "PayloadTooLarge",
      bucket: "413",
    },
    {
      name: "an unlisted status",
      result: { kind: "response", status: 418 },
      status: 502,
      error: "apns_rejected",
      bucket: "other",
    },
    {
      name: "a timeout",
      result: { kind: "timeout" },
      status: 504,
      error: "apns_timeout",
      bucket: "timeout",
    },
    {
      name: "a network failure",
      result: { kind: "network", code: "ECONNRESET" },
      status: 503,
      error: "apns_unreachable",
      retryAfter: "30",
      bucket: "network",
    },
  ];

  it.each(cases)("maps $name", async (c) => {
    const h = harness({ send: async () => c.result });
    const res = await h.invoke(pushEvent(pushBody()));
    expectError(res, c.status, c.error);
    if (c.reason) expect(parse(res).reason).toBe(c.reason);
    expect(res.headers["retry-after"]).toBe(c.retryAfter);

    const lines = emfLines();
    const outcome = lines.find((l) => "ApnsResponse" in l);
    expect(outcome).toMatchObject({ Status: c.bucket, ApnsResponse: 1, ApnsNon2xx: 1 });
    const faults = lines.filter((l) => "RelayFault" in l);
    if (c.apnsAuthFault) expect(faults).toEqual([expect.objectContaining({ Reason: "apns_auth" })]);
    else expect(faults).toHaveLength(0);

    const [warn] = warnLines();
    expect(warn).toMatchObject({ route: "push", error: c.error });
    expect(
      Object.keys(warn).every((k) =>
        ["route", "error", "apnsStatus", "apnsReason", "apnsId", "fault"].includes(k)
      )
    ).toBe(true);
  });

  it("emits ApnsNon2xx 0 and no log line for a 200", async () => {
    const h = harness();
    await h.invoke(pushEvent(pushBody()));
    expect(emfLines().find((l) => "ApnsResponse" in l)).toMatchObject({
      Status: "200",
      ApnsResponse: 1,
      ApnsNon2xx: 0,
    });
    expect(warnLines()).toEqual([]);
  });

  it("answers apns_id null when APNs sent none", async () => {
    const h = harness({ send: async () => ({ kind: "response", status: 200 }) });
    const res = await h.invoke(pushEvent(pushBody()));
    expect(res.statusCode).toBe(202);
    expect(parse(res)).toEqual({ apns_id: null });
  });
});

describe("faults", () => {
  it("refuses to sign with a secret whose keyId differs from config", async () => {
    const h = harness({ apnsSecretRaw: apnsSecret({ keyId: "Y7QSB5K2Y6" }) });
    const res = await h.invoke(pushEvent(pushBody()));
    expectError(res, 500, "relay_misconfigured");
    expect(emfLines().find((l) => "RelayFault" in l)).toMatchObject({ Reason: "key_mismatch" });
    expect(h.signer).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("refuses to sign when the apnsKey dep returns another key id (defense in depth)", async () => {
    const h = harness({
      apnsKey: async () => ({
        ...parseApnsSecret(apnsSecret(), { keyId: "A3TWAYM427", teamId: "9445Q654K8" }),
        keyId: "Y7QSB5K2Y6",
      }),
    });
    const res = await h.invoke(pushEvent(pushBody()));
    expectError(res, 500, "relay_misconfigured");
    expect(emfLines().find((l) => "RelayFault" in l)).toMatchObject({ Reason: "key_mismatch" });
    expect(h.signer).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("answers 503 relay_unavailable when a secret cannot be fetched", async () => {
    const h = harness({ fetchFails: (id) => id === APNS_SECRET_ID });
    const res = await h.invoke(pushEvent(pushBody()));
    expectError(res, 503, "relay_unavailable");
    expect(emfLines().find((l) => "RelayFault" in l)).toMatchObject({
      Reason: "secret_unavailable",
    });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("answers 500 relay_misconfigured on every route when the env is invalid", async () => {
    const h = harness({
      config: () => {
        throw new RelayFault("config_invalid");
      },
    });
    expectError(
      await h.invoke(sessionEvent({ app_transaction: APP_TX_JWS, push_token: PUSH_TOKEN })),
      500,
      "relay_misconfigured"
    );
    expectError(await h.invoke(pushEvent(pushBody())), 500, "relay_misconfigured");
    expect(emfLines().filter((l) => l.Reason === "config_invalid")).toHaveLength(2);
  });

  it("answers 500 internal and counts a fault when sending throws", async () => {
    const h = harness({
      send: () => Promise.reject(new Error(`exploded near ${PUSH_TOKEN}`)),
    });
    const res = await h.invoke(pushEvent(pushBody()));
    expectError(res, 500, "internal");
    expect(emfLines().find((l) => "RelayFault" in l)).toMatchObject({ Reason: "internal" });
    expect(res.body).not.toContain("exploded");
  });

  it("imports handler.ts with no RELAY_* env without throwing, and fails closed", async () => {
    for (const k of Object.keys(process.env)) expect(k.startsWith("RELAY_")).toBe(false);
    const mod = await import("../../lib/lambda/apns-relay/handler.js");
    expect(typeof mod.handler).toBe("function");
    const res = await mod.handler({ routeKey: "POST /v1/push", body: "{}" });
    expectError(res, 500, "relay_misconfigured");
  });
});

describe("routing and response shape", () => {
  it("answers an unknown routeKey with 404 not_found", async () => {
    const h = harness();
    expectError(await h.invoke({ routeKey: "GET /v1/push" }), 404, "not_found");
    expectError(await h.invoke({ routeKey: "POST /v1/nope" }), 404, "not_found");
  });

  it("marks every response no-store JSON", async () => {
    const h = harness();
    const responses = [
      await h.invoke(sessionEvent({ app_transaction: APP_TX_JWS, push_token: PUSH_TOKEN })),
      await h.invoke(pushEvent(pushBody())),
      await h.invoke(pushEvent(pushBody(), null)),
      await h.invoke({ routeKey: "POST /v1/nope" }),
    ];
    for (const r of responses) {
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
    }
  });

  it("writes only well-formed EMF to stdout", async () => {
    const h = harness({
      send: async () => ({ kind: "response", status: 410, reason: "Unregistered" }),
    });
    await h.invoke(sessionEvent({ app_transaction: APP_TX_JWS, push_token: PUSH_TOKEN }));
    await h.invoke(pushEvent(pushBody()));
    await h.invoke(pushEvent(pushBody({ kind: "banner" })));
    await h.invoke({ routeKey: "POST /v1/nope" });

    const lines = emfLines();
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const allowedTop = new Set([
      "_aws",
      "Status",
      "Reason",
      "ApnsResponse",
      "ApnsNon2xx",
      "RelayRejected",
      "RelayFault",
      "SessionIssued",
    ]);
    for (const line of lines) {
      const aws = line._aws as { Timestamp: number; CloudWatchMetrics: { Namespace: string }[] };
      expect(aws.Timestamp).toBe(NOW_MS);
      for (const d of aws.CloudWatchMetrics) expect(d.Namespace).toBe(METRIC_NAMESPACE);
      for (const k of Object.keys(line)) expect(allowedTop.has(k), k).toBe(true);
    }
    expect(lines.find((l) => "ApnsResponse" in l)).toMatchObject({
      Status: "410",
      ApnsNon2xx: 1,
    });
    expect(lines.filter((l) => "RelayRejected" in l).map((l) => l.Reason)).toEqual([
      "unknown_kind",
      "not_found",
    ]);
  });
});

describe("the never-log capture itself", () => {
  it("sees what the relay writes (so the afterEach check is not vacuous)", async () => {
    const h = harness({
      send: async () => ({ kind: "response", status: 410, reason: "Unregistered" }),
    });
    await h.invoke(pushEvent(pushBody()));
    expect(captured.stdout.length).toBeGreaterThan(0);
    expect(captured.other.length).toBeGreaterThan(0);
    expect(credentials.has(PUSH_TOKEN)).toBe(true);
    expect([...credentials].some((c) => c.startsWith("gs1."))).toBe(true);
    expect([...credentials].some((c) => c.startsWith("eyJhbGciOiJFUzI1NiIsImtpZCI6"))).toBe(true);
  });
});
