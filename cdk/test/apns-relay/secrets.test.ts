import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  parseApnsSecret,
  parseSessionSecret,
  RelayFault,
  SecretCache,
  SECRET_RETRY_PERMANENT_MS,
  SECRET_RETRY_TRANSIENT_MS,
} from "../../lib/lambda/apns-relay/secrets";

// Generated in-process; shaped like an Apple .p8 (PKCS#8 PEM, P-256). Never written anywhere.
const pem = (type: "ec" | "rsa", namedCurve?: string): string =>
  (type === "ec"
    ? generateKeyPairSync("ec", { namedCurve: namedCurve ?? "P-256" })
    : generateKeyPairSync("rsa", { modulusLength: 2048 })
  ).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const P8 = pem("ec");
const EXPECTED = { keyId: "A3TWAYM427", teamId: "9445Q654K8" };
const secret = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ keyId: EXPECTED.keyId, teamId: EXPECTED.teamId, p8: P8, ...over });

function faultOf(fn: () => unknown): RelayFault {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RelayFault);
    return e as RelayFault;
  }
  throw new Error("expected a RelayFault");
}

describe("parseApnsSecret", () => {
  it("loads a valid P-256 PKCS#8 key", () => {
    const k = parseApnsSecret(secret(), EXPECTED);
    expect(k.keyId).toBe(EXPECTED.keyId);
    expect(k.teamId).toBe(EXPECTED.teamId);
    expect(k.key.asymmetricKeyType).toBe("ec");
    expect(k.key.type).toBe("private");
  });

  it("refuses a keyId or teamId that differs from config", () => {
    expect(faultOf(() => parseApnsSecret(secret({ keyId: "Y7QSB5K2Y6" }), EXPECTED)).reason).toBe(
      "key_mismatch"
    );
    expect(faultOf(() => parseApnsSecret(secret({ teamId: "AAAAAAAAAA" }), EXPECTED)).reason).toBe(
      "key_mismatch"
    );
  });

  it.each([
    ["non-JSON", "-----BEGIN PRIVATE KEY-----"],
    ["a JSON array", "[]"],
    ["a missing p8", JSON.stringify({ keyId: EXPECTED.keyId, teamId: EXPECTED.teamId })],
    ["a non-string p8", secret({ p8: 42 })],
    ["a garbage p8", secret({ p8: "not a key" })],
    ["an RSA key", secret({ p8: pem("rsa") })],
    ["a P-384 key", secret({ p8: pem("ec", "P-384") })],
  ])("refuses %s as secret_malformed", (_label, raw) => {
    expect(faultOf(() => parseApnsSecret(raw, EXPECTED)).reason).toBe("secret_malformed");
  });

  it("never puts the PEM or the secret's ids in the error", () => {
    for (const raw of [
      secret({ keyId: "ZZZZZZZZZZ", teamId: "QQQQQQQQQQ" }),
      secret({ p8: pem("rsa") }),
      "not json " + P8,
    ]) {
      const f = faultOf(() => parseApnsSecret(raw, EXPECTED));
      const text = `${f.message} ${f.stack ?? ""} ${String(f)}`;
      expect(text).not.toContain("PRIVATE KEY");
      expect(text).not.toContain(P8.split("\n")[1]);
      expect(text).not.toContain("ZZZZZZZZZZ");
      expect(text).not.toContain("QQQQQQQQQQ");
    }
  });
});

describe("parseSessionSecret", () => {
  it("accepts >= 32 characters and refuses less", () => {
    expect(parseSessionSecret("x".repeat(64))).toEqual(Buffer.from("x".repeat(64)));
    expect(faultOf(() => parseSessionSecret("short")).reason).toBe("secret_malformed");
  });
});

describe("SecretCache", () => {
  it("fetches once across many gets", async () => {
    const fetch = vi.fn(async () => "value");
    const cache = new SecretCache(fetch);
    for (let i = 0; i < 5; i++)
      expect(await cache.get("id", (raw) => raw.toUpperCase())).toBe("VALUE");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight fetch between concurrent gets", async () => {
    const fetch = vi.fn(async () => "value");
    const cache = new SecretCache(fetch);
    await Promise.all([cache.get("id", (r) => r), cache.get("id", (r) => r)]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps a failed fetch to secret_unavailable and retries only after 30 s", async () => {
    let now = 1_000_000;
    const fetch = vi.fn(async (): Promise<string> => {
      throw new Error("AccessDeniedException: arn:aws:secretsmanager:...");
    });
    const cache = new SecretCache(fetch, () => now);
    await expect(cache.get("id", (r) => r)).rejects.toMatchObject({ reason: "secret_unavailable" });
    now += SECRET_RETRY_TRANSIENT_MS - 1;
    await expect(cache.get("id", (r) => r)).rejects.toMatchObject({ reason: "secret_unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 1;
    fetch.mockResolvedValueOnce("recovered");
    expect(await cache.get("id", (r) => r)).toBe("recovered");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(SECRET_RETRY_TRANSIENT_MS).toBe(30_000);
  });

  it("negatively caches a parse failure for 300 s", async () => {
    let now = 1_000_000;
    const fetch = vi.fn(async () => secret({ keyId: "Y7QSB5K2Y6" }));
    const cache = new SecretCache(fetch, () => now);
    const parse = (raw: string) => parseApnsSecret(raw, EXPECTED);
    await expect(cache.get("id", parse)).rejects.toMatchObject({ reason: "key_mismatch" });
    now += SECRET_RETRY_PERMANENT_MS - 1;
    await expect(cache.get("id", parse)).rejects.toMatchObject({ reason: "key_mismatch" });
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 1;
    await expect(cache.get("id", parse)).rejects.toMatchObject({ reason: "key_mismatch" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(SECRET_RETRY_PERMANENT_MS).toBe(300_000);
  });

  it("turns a non-RelayFault parse error into secret_malformed", async () => {
    const cache = new SecretCache(async () => "x");
    await expect(
      cache.get("id", () => {
        throw new Error("boom with value x");
      })
    ).rejects.toMatchObject({
      reason: "secret_malformed",
      message: "relay fault: secret_malformed",
    });
  });
});
