import { describe, it, expect } from "vitest";
import {
  apnsHeadersFor,
  buildAps,
  serializeApsPayload,
  validatePushRequest,
  type ApsPayload,
  type ValidatedPush,
} from "../../lib/lambda/apns-relay/push-schema";
import { readJsonBody } from "../../lib/lambda/apns-relay/http";
import {
  encodeRelayEnv,
  parseRelayEnv,
  ConfigError,
  type RelayRuntimeConfig,
} from "../../lib/lambda/apns-relay/env-contract";

const TOKEN = "80" + "ab".repeat(39); // 80 hex chars, lowercase
const UUID = "6F1C2A4E-3B5D-4C7E-9A8B-0D1E2F3A4B5C";
const NOW = 1_800_000_000;
/** Seconds between the Unix epoch (1970) and Apple's reference date (2001). */
const APPLE_REFERENCE_OFFSET = 978_307_200;

type Body = Record<string, unknown>;

function baseBody(overrides: Body = {}): Body {
  return {
    environment: "sandbox",
    kind: "route",
    push_token: TOKEN,
    event: "update",
    priority: "low",
    stale_in_secs: 120,
    confirmed_age_secs: 5,
    content_state: {
      travelled_m: 1240.5,
      total_m: 5010,
      finishes_in_secs: 100,
      repeats: false,
      paused: false,
      finished: false,
      speed_defaulted: false,
      pending_action: null,
      location_in_effect: true,
    },
    ...overrides,
  };
}

function withContent(overrides: Body): Body {
  const b = baseBody();
  return { ...b, content_state: { ...(b.content_state as Body), ...overrides } };
}

const omit = (obj: Body, key: string): Body =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));

function withoutContent(key: string): Body {
  const b = baseBody();
  return { ...b, content_state: omit(b.content_state as Body, key) };
}

function without(key: string): Body {
  return omit(baseBody(), key);
}

function valid(body: unknown): ValidatedPush {
  const r = validatePushRequest(body);
  if (!r.ok) throw new Error(`expected valid, got ${r.error}: ${r.reason}`);
  return r.value;
}

function expectError(body: unknown, error: string): void {
  const r = validatePushRequest(body);
  expect(r.ok, JSON.stringify(body)).toBe(false);
  if (!r.ok) expect(r.error).toBe(error);
}

describe("kind", () => {
  it("rejects an unknown kind with unknown_kind", () => {
    expectError(baseBody({ kind: "banner" }), "unknown_kind");
  });

  it("rejects the reserved steering kind with its stated reason", () => {
    const r = validatePushRequest(baseBody({ kind: "steering" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toBe("unknown_kind");
      expect(r.reason).toBe("kind 'steering' is reserved and not implemented");
    }
  });

  it("treats a missing or non-string kind as a schema error", () => {
    expectError(without("kind"), "schema");
    expectError(baseBody({ kind: 7 }), "schema");
  });

  it("checks kind before anything else", () => {
    expectError(
      { kind: "banner", push_token: "NOT HEX", content_state: 3, bogus: true },
      "unknown_kind"
    );
    expectError({ kind: "steering", event: "explode" }, "unknown_kind");
  });

  it("does not treat inherited property names as kinds", () => {
    expectError(baseBody({ kind: "constructor" }), "unknown_kind");
    expectError(baseBody({ kind: "__proto__" }), "unknown_kind");
  });

  it("does not echo the client's kind in the reason", () => {
    const r = validatePushRequest(baseBody({ kind: "evil<script>" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toContain("evil");
  });
});

describe("route schema rejection", () => {
  it("accepts the base body", () => {
    expect(validatePushRequest(baseBody()).ok).toBe(true);
  });

  it("rejects a non-object body", () => {
    for (const b of [null, [], "x", 3, true]) expectError(b, "schema");
  });

  it.each([
    "environment",
    "push_token",
    "event",
    "priority",
    "confirmed_age_secs",
    "content_state",
  ])("rejects a missing top-level %s", (key) => {
    expectError(without(key), "schema");
  });

  it.each([
    "travelled_m",
    "total_m",
    "repeats",
    "paused",
    "finished",
    "speed_defaulted",
    "location_in_effect",
  ])("rejects a missing content_state.%s", (key) => {
    expectError(withoutContent(key), "schema");
  });

  it("rejects wrong types", () => {
    expectError(baseBody({ environment: 1 }), "schema");
    expectError(baseBody({ push_token: 1234 }), "schema");
    expectError(baseBody({ event: ["update"] }), "schema");
    expectError(baseBody({ priority: 10 }), "schema");
    expectError(baseBody({ stale_in_secs: "120" }), "schema");
    expectError(baseBody({ confirmed_age_secs: "5" }), "schema");
    expectError(baseBody({ content_state: "{}" }), "schema");
    expectError(baseBody({ content_state: [] }), "schema");
    expectError(withContent({ travelled_m: "1" }), "schema");
    expectError(withContent({ total_m: null }), "schema");
    expectError(withContent({ finishes_in_secs: "100" }), "schema");
    expectError(withContent({ repeats: "false" }), "schema");
    expectError(withContent({ paused: 0 }), "schema");
    expectError(withContent({ finished: null }), "schema");
    expectError(withContent({ speed_defaulted: 1 }), "schema");
    expectError(withContent({ location_in_effect: "true" }), "schema");
    expectError(withContent({ pending_action: true }), "schema");
  });

  it("rejects non-finite numbers (JSON.parse('1e400') is Infinity)", () => {
    const inf = JSON.parse("1e400") as number;
    expect(inf).toBe(Infinity);
    expectError(baseBody({ confirmed_age_secs: inf }), "schema");
    expectError(baseBody({ stale_in_secs: inf }), "schema");
    expectError(withContent({ travelled_m: inf }), "schema");
    expectError(withContent({ total_m: NaN }), "schema");
    expectError(withContent({ finishes_in_secs: inf }), "schema");
  });

  it("rejects negative numbers", () => {
    expectError(baseBody({ confirmed_age_secs: -1 }), "schema");
    expectError(baseBody({ stale_in_secs: -120 }), "schema");
    expectError(withContent({ travelled_m: -0.5 }), "schema");
    expectError(withContent({ total_m: -1 }), "schema");
    expectError(withContent({ finishes_in_secs: -1 }), "schema");
    expectError(baseBody({ event: "end", dismiss_in_secs: -1 }), "schema");
  });

  it("rejects out-of-bounds values", () => {
    expectError(baseBody({ stale_in_secs: 0 }), "schema");
    expectError(baseBody({ stale_in_secs: 28801 }), "schema");
    expectError(baseBody({ stale_in_secs: 120.5 }), "schema");
    expectError(baseBody({ confirmed_age_secs: 28801 }), "schema");
    expectError(baseBody({ event: "end", dismiss_in_secs: 14401 }), "schema");
    expectError(baseBody({ event: "end", dismiss_in_secs: 1.5 }), "schema");
    expectError(withContent({ travelled_m: 1e9 }), "schema");
    expectError(withContent({ finishes_in_secs: 31_536_001 }), "schema");
  });

  it("rejects bad enum values", () => {
    expectError(baseBody({ event: "pause" }), "schema");
    expectError(baseBody({ priority: "medium" }), "schema");
    expectError(baseBody({ priority: "5" }), "schema");
    expectError(baseBody({ environment: "development" }), "schema");
    expectError(withContent({ pending_action: "stop" }), "schema");
  });

  it("rejects unknown keys at the top level and in content_state", () => {
    expectError(baseBody({ extra: 1 }), "schema");
    expectError(withContent({ extra: 1 }), "schema");
    expectError(JSON.parse(JSON.stringify(baseBody()).replace("{", '{"__proto__":{},')), "schema");
  });

  it("enforces attributes on start only", () => {
    expectError(baseBody({ event: "update", attributes: { savedRouteId: UUID } }), "schema");
    expectError(baseBody({ event: "end", attributes: {} }), "schema");
    expectError(baseBody({ event: "start" }), "schema");
    expectError(baseBody({ event: "start", attributes: null }), "schema");
    expectError(
      baseBody({ event: "start", attributes: { savedRouteId: UUID, routeName: "Home" } }),
      "schema"
    );
    expectError(baseBody({ event: "start", attributes: { routeName: null } }), "schema");
    expectError(baseBody({ event: "start", attributes: { savedRouteId: "not-a-uuid" } }), "schema");
    expectError(baseBody({ event: "start", attributes: { savedRouteId: 42 } }), "schema");
  });

  it("allows dismiss_in_secs on end only", () => {
    expectError(baseBody({ event: "update", dismiss_in_secs: 0 }), "schema");
    expectError(
      baseBody({ event: "start", attributes: { savedRouteId: null }, dismiss_in_secs: 0 }),
      "schema"
    );
    expect(validatePushRequest(baseBody({ event: "end", dismiss_in_secs: 0 })).ok).toBe(true);
  });

  it.each([
    ["uppercase", TOKEN.toUpperCase()],
    ["odd length", TOKEN + "a"],
    ["under 32 chars", "ab".repeat(15)],
    ["over 512 chars", "ab".repeat(257)],
    ["a slash", TOKEN.slice(0, 40) + "/" + TOKEN.slice(41)],
    ["a dot-dot", TOKEN.slice(0, 40) + ".." + TOKEN.slice(42)],
    ["%2F", TOKEN.slice(0, 40) + "%2F" + TOKEN.slice(43)],
    ["whitespace", TOKEN.slice(0, 40) + " " + TOKEN.slice(41)],
    ["a trailing newline", TOKEN + "\n"],
    ["empty", ""],
  ])("rejects a push_token with %s", (_label, token) => {
    expectError(baseBody({ push_token: token }), "schema");
  });

  it("accepts push tokens at both length bounds", () => {
    expect(validatePushRequest(baseBody({ push_token: "ab".repeat(16) })).ok).toBe(true);
    expect(validatePushRequest(baseBody({ push_token: "ab".repeat(256) })).ok).toBe(true);
  });
});

describe("client-supplied absolute times and transport fields are refused", () => {
  it.each(["finishesAtEpoch", "confirmedAtEpoch", "timestamp", "stale-date"])(
    "rejects content_state.%s",
    (key) => {
      expectError(withContent({ [key]: NOW }), "schema");
    }
  );

  it.each([
    "confirmed_at",
    "confirmed_at_epoch",
    "finishes_at_epoch",
    "timestamp",
    "stale_date",
    "stale-date",
    "dismissal_date",
    "aps",
    "push_type",
    "apns-push-type",
    "topic",
    "apns-topic",
    "apns_priority",
  ])("rejects top-level %s", (key) => {
    expectError(baseBody({ [key]: key === "aps" ? {} : NOW }), "schema");
  });

  it.each([
    ["travelledM", "travelled_m"],
    ["totalM", "total_m"],
    ["speedDefaulted", "speed_defaulted"],
    ["pendingAction", "pending_action"],
    ["locationInEffect", "location_in_effect"],
  ])("rejects the Swift-cased %s in place of %s", (swift, snake) => {
    const b = withoutContent(snake);
    const cs = b.content_state as Body;
    const original = (baseBody().content_state as Body)[snake];
    expectError({ ...b, content_state: { ...cs, [swift]: original } }, "schema");
  });

  it("rejects a Swift-cased content_state wholesale", () => {
    expectError(
      baseBody({
        content_state: {
          travelledM: 1,
          totalM: 2,
          finishesAtEpoch: NOW + 100,
          repeats: false,
          paused: false,
          finished: false,
          speedDefaulted: false,
          confirmedAtEpoch: NOW,
          locationInEffect: true,
        },
      }),
      "schema"
    );
  });
});

describe("buildAps: clocks come from the relay", () => {
  const v = valid(baseBody({ confirmed_age_secs: 5, stale_in_secs: 120 }));
  const aps = buildAps(v, NOW);

  it("stamps every absolute from the relay clock, in Unix epoch seconds", () => {
    expect(aps.timestamp).toBe(1_800_000_000);
    expect(aps["content-state"].confirmedAtEpoch).toBe(1_799_999_995);
    expect(aps["content-state"].finishesAtEpoch).toBe(1_800_000_100);
    expect(aps["stale-date"]).toBe(1_800_000_120);
  });

  it("is not Apple's 2001 reference date and not milliseconds", () => {
    const absolutes = [
      aps.timestamp,
      aps["stale-date"],
      aps["content-state"].confirmedAtEpoch,
      aps["content-state"].finishesAtEpoch as number,
    ];
    const expected = [1_800_000_000, 1_800_000_120, 1_799_999_995, 1_800_000_100];
    absolutes.forEach((value, i) => {
      expect(value).not.toBe(expected[i] - APPLE_REFERENCE_OFFSET);
      expect(value).not.toBe(expected[i] * 1000);
      expect(value).toBeLessThan(1e10); // seconds, not ms
      expect(value).toBeGreaterThan(1.5e9); // after 2017 in Unix seconds
    });
  });

  it("moves every absolute with the relay clock while the client body stays fixed", () => {
    const body = baseBody({ confirmed_age_secs: 5, stale_in_secs: 120 });
    const snapshot = JSON.stringify(body);
    const a = buildAps(valid(body), NOW);
    const b = buildAps(valid(body), NOW + 3600);
    expect(JSON.stringify(body)).toBe(snapshot);
    expect(b.timestamp - a.timestamp).toBe(3600);
    expect(b["stale-date"] - a["stale-date"]).toBe(3600);
    expect(b["content-state"].confirmedAtEpoch - a["content-state"].confirmedAtEpoch).toBe(3600);
    expect(
      (b["content-state"].finishesAtEpoch as number) -
        (a["content-state"].finishesAtEpoch as number)
    ).toBe(3600);
  });
});

describe("buildAps: defaults and omissions", () => {
  it("defaults stale-date to now + 120", () => {
    expect(buildAps(valid(without("stale_in_secs")), NOW)["stale-date"]).toBe(NOW + 120);
  });

  it("omits finishesAtEpoch when finishes_in_secs is null or absent", () => {
    const nulled = buildAps(valid(withContent({ finishes_in_secs: null })), NOW);
    const absent = buildAps(valid(withoutContent("finishes_in_secs")), NOW);
    expect("finishesAtEpoch" in nulled["content-state"]).toBe(false);
    expect("finishesAtEpoch" in absent["content-state"]).toBe(false);
  });

  it("keeps a zero finishes_in_secs as now", () => {
    const aps = buildAps(valid(withContent({ finishes_in_secs: 0 })), NOW);
    expect(aps["content-state"].finishesAtEpoch).toBe(NOW);
  });

  it("omits pendingAction when pending_action is null or absent, and maps it otherwise", () => {
    const nulled = buildAps(valid(withContent({ pending_action: null })), NOW);
    const absent = buildAps(valid(withoutContent("pending_action")), NOW);
    const pause = buildAps(valid(withContent({ pending_action: "pause" })), NOW);
    const resume = buildAps(valid(withContent({ pending_action: "resume" })), NOW);
    expect("pendingAction" in nulled["content-state"]).toBe(false);
    expect("pendingAction" in absent["content-state"]).toBe(false);
    expect(pause["content-state"].pendingAction).toBe("pause");
    expect(resume["content-state"].pendingAction).toBe("resume");
  });
});

describe("buildAps: closed key sets", () => {
  it("emits exactly the ten Swift ContentState names, in declaration order", () => {
    const aps = buildAps(
      valid(
        withContent({
          travelled_m: 4321,
          total_m: 5010,
          finishes_in_secs: 60,
          repeats: true,
          paused: true,
          finished: false,
          speed_defaulted: true,
          pending_action: "pause",
          location_in_effect: false,
        })
      ),
      NOW
    );
    expect(Object.keys(aps["content-state"])).toEqual([
      "travelledM",
      "totalM",
      "finishesAtEpoch",
      "repeats",
      "paused",
      "finished",
      "speedDefaulted",
      "confirmedAtEpoch",
      "pendingAction",
      "locationInEffect",
    ]);
    expect(aps["content-state"]).toEqual({
      travelledM: 4321,
      totalM: 5010,
      finishesAtEpoch: NOW + 60,
      repeats: true,
      paused: true,
      finished: false,
      speedDefaulted: true,
      confirmedAtEpoch: NOW - 5,
      pendingAction: "pause",
      locationInEffect: false,
    });
  });

  it("orders aps keys exactly per event", () => {
    const upd = buildAps(valid(baseBody()), NOW);
    expect(Object.keys(upd)).toEqual(["timestamp", "event", "stale-date", "content-state"]);
    const end = buildAps(valid(baseBody({ event: "end", dismiss_in_secs: 10 })), NOW);
    expect(Object.keys(end)).toEqual([
      "timestamp",
      "event",
      "stale-date",
      "content-state",
      "dismissal-date",
    ]);
    const start = buildAps(
      valid(baseBody({ event: "start", attributes: { savedRouteId: UUID } })),
      NOW
    );
    expect(Object.keys(start)).toEqual([
      "timestamp",
      "event",
      "stale-date",
      "content-state",
      "attributes-type",
      "attributes",
      "input-push-token",
    ]);
  });
});

describe("buildAps: end", () => {
  it("dismiss_in_secs 0 dismisses at now", () => {
    const aps = buildAps(valid(baseBody({ event: "end", dismiss_in_secs: 0 })), NOW);
    expect(aps.event).toBe("end");
    expect(aps["dismissal-date"]).toBe(NOW);
  });

  it("omits dismissal-date when dismiss_in_secs is absent", () => {
    const aps = buildAps(valid(baseBody({ event: "end" })), NOW);
    expect("dismissal-date" in aps).toBe(false);
  });
});

describe("buildAps: start", () => {
  const start = (attributes: Body): ApsPayload =>
    buildAps(valid(baseBody({ event: "start", attributes })), NOW);

  it("names the attributes type and asks for a push token", () => {
    const aps = start({ savedRouteId: UUID });
    expect(aps["attributes-type"]).toBe("RouteActivityAttributes");
    expect(aps["input-push-token"]).toBe(1);
  });

  it("carries only savedRouteId in attributes", () => {
    expect(start({ savedRouteId: UUID }).attributes).toEqual({ savedRouteId: UUID });
    expect(start({ savedRouteId: null }).attributes).toEqual({ savedRouteId: null });
    expect(start({}).attributes).toEqual({ savedRouteId: null });
  });

  it("never carries an alert or a route name", () => {
    const payload = serializeApsPayload(start({ savedRouteId: UUID }));
    expect(payload).not.toContain("alert");
    expect(payload).not.toContain("routeName");
  });
});

describe("apnsHeadersFor", () => {
  it("maps priority low to 5 and high to 10", () => {
    expect(apnsHeadersFor("route", "low", "com.moonloaf.geospoof").priority).toBe("5");
    expect(apnsHeadersFor("route", "high", "com.moonloaf.geospoof").priority).toBe("10");
  });

  it("derives topic and push type from the kind alone", () => {
    for (const p of ["low", "high"] as const) {
      const h = apnsHeadersFor("route", p, "com.moonloaf.geospoof");
      expect(h.topic).toBe("com.moonloaf.geospoof.push-type.liveactivity");
      expect(h.pushType).toBe("liveactivity");
    }
  });
});

describe("payload and body handling", () => {
  it("serializes as {aps} and refuses over 4096 bytes", () => {
    const aps = buildAps(valid(baseBody()), NOW);
    expect(JSON.parse(serializeApsPayload(aps))).toEqual({ aps });
    const huge = { ...aps, event: "x".repeat(5000) } as unknown as ApsPayload;
    expect(() => serializeApsPayload(huge)).toThrow(/4096/);
  });

  it("readJsonBody decodes a base64 body", () => {
    const body = Buffer.from(JSON.stringify({ a: 1 })).toString("base64");
    const r = readJsonBody({ routeKey: "x", body, isBase64Encoded: true }, 100);
    expect(r).toEqual({ ok: true, value: { a: 1 } });
  });

  it("readJsonBody returns 413 over the cap, encoded or not", () => {
    const text = JSON.stringify({ a: "x".repeat(200) });
    const plain = readJsonBody({ routeKey: "x", body: text }, 100);
    const b64 = readJsonBody(
      { routeKey: "x", body: Buffer.from(text).toString("base64"), isBase64Encoded: true },
      100
    );
    for (const r of [plain, b64]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect([r.status, r.error]).toEqual([413, "payload_too_large"]);
    }
  });

  it("readJsonBody counts bytes, not characters", () => {
    const r = readJsonBody({ routeKey: "x", body: JSON.stringify("é".repeat(60)) }, 100);
    expect(r.ok).toBe(false);
  });

  it("readJsonBody returns schema for invalid or missing JSON", () => {
    for (const body of ["{not json", "", undefined]) {
      const r = readJsonBody({ routeKey: "x", body }, 100);
      expect(r.ok).toBe(false);
      if (!r.ok) expect([r.status, r.error]).toEqual([400, "schema"]);
    }
  });
});

describe("env contract", () => {
  const dev: RelayRuntimeConfig = {
    bundleId: "com.moonloaf.geospoof",
    teamId: "9445Q654K8",
    appAppleId: 6765719745,
    storeKitEnvironments: ["Production", "Sandbox"],
    apnsKeys: { sandbox: { keyId: "A3TWAYM427", secretId: "geospoof/apns/signing-key" } },
    sessionSecretId: "arn:aws:secretsmanager:us-east-1:898565151814:secret:session-abc123",
  };
  const prod: RelayRuntimeConfig = {
    ...dev,
    apnsKeys: { production: { keyId: "Y7QSB5K2Y6", secretId: "geospoof/apns/signing-key" } },
  };

  it("round-trips the dev and prod shapes", () => {
    expect(parseRelayEnv(encodeRelayEnv(dev))).toEqual(dev);
    expect(parseRelayEnv(encodeRelayEnv(prod))).toEqual(prod);
  });

  it("rejects Xcode and LocalTesting StoreKit environments", () => {
    for (const bad of ["Xcode", "LocalTesting", "Production,Xcode", "Sandbox,LocalTesting"]) {
      const env = { ...encodeRelayEnv(dev), RELAY_STOREKIT_ENVIRONMENTS: bad };
      expect(() => parseRelayEnv(env)).toThrow(ConfigError);
    }
  });

  it("rejects a bad keyId or teamId", () => {
    const base = encodeRelayEnv(dev);
    expect(() => parseRelayEnv({ ...base, RELAY_TEAM_ID: "9445q654k8" })).toThrow(/RELAY_TEAM_ID/);
    expect(() =>
      parseRelayEnv({
        ...base,
        RELAY_APNS_KEYS: JSON.stringify({ sandbox: { keyId: "SHORT", secretId: "x" } }),
      })
    ).toThrow(/RELAY_APNS_KEYS/);
  });

  it("rejects an empty or unknown APNs key table", () => {
    const base = encodeRelayEnv(dev);
    expect(() => parseRelayEnv({ ...base, RELAY_APNS_KEYS: "{}" })).toThrow(/RELAY_APNS_KEYS/);
    expect(() =>
      parseRelayEnv({
        ...base,
        RELAY_APNS_KEYS: JSON.stringify({ development: { keyId: "A3TWAYM427", secretId: "x" } }),
      })
    ).toThrow(/RELAY_APNS_KEYS/);
    expect(() => parseRelayEnv({ ...base, RELAY_APNS_KEYS: "not json" })).toThrow(
      /RELAY_APNS_KEYS/
    );
  });

  it("rejects missing variables and a bad app Apple ID, naming the variable", () => {
    const base = encodeRelayEnv(dev);
    expect(() => parseRelayEnv({})).toThrow(ConfigError);
    expect(() => parseRelayEnv({ ...base, RELAY_APP_APPLE_ID: "-1" })).toThrow(
      /RELAY_APP_APPLE_ID/
    );
    expect(() => parseRelayEnv({ ...base, RELAY_SESSION_SECRET_ID: "" })).toThrow(
      /RELAY_SESSION_SECRET_ID/
    );
  });

  it("encodes no secret material, only ids", () => {
    const encoded = JSON.stringify(encodeRelayEnv(dev));
    expect(encoded).not.toMatch(/BEGIN|PRIVATE|p8/);
  });
});
