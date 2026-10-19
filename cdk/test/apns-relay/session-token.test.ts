import { describe, it, expect } from "vitest";
import { randomBytes, createHmac } from "node:crypto";
import {
  mintSessionToken,
  parseBearer,
  pushTokenMatches,
  RELAY_SESSION_TTL_SECS,
  validateSessionRequest,
  verifySessionToken,
} from "../../lib/lambda/apns-relay/session-token";

const KEY = randomBytes(48);
const NOW = 1_800_000_000;
const TOKEN = "80" + "cd".repeat(39);
const OTHER = "80" + "ef".repeat(39);
const JWS = "eyJhbGciOiJFUzI1NiJ9.eyJhIjoxfQ.c2ln";

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

function resign(payload: unknown, key = KEY): string {
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", key).update(`gs1.${p}`).digest("base64url");
  return `gs1.${p}.${mac}`;
}

describe("session token", () => {
  it("round-trips and binds the push token", () => {
    const { token } = mintSessionToken(KEY, TOKEN, NOW);
    const v = verifySessionToken(KEY, token, NOW);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(pushTokenMatches(v.pushTokenHash, TOKEN)).toBe(true);
      expect(pushTokenMatches(v.pushTokenHash, OTHER)).toBe(false);
    }
  });

  it("expires 28800 s after the relay clock's now", () => {
    const { token, expiresInSecs } = mintSessionToken(KEY, TOKEN, NOW);
    expect(expiresInSecs).toBe(28800);
    expect(RELAY_SESSION_TTL_SECS).toBe(28800);
    expect(decodePayload(token)).toMatchObject({ v: 1, exp: NOW + 28800 });
  });

  it("fails at exp and succeeds one second before", () => {
    const { token } = mintSessionToken(KEY, TOKEN, NOW);
    expect(verifySessionToken(KEY, token, NOW + 28800).ok).toBe(false);
    expect(verifySessionToken(KEY, token, NOW + 28799).ok).toBe(true);
  });

  it("does not put the push token itself in the token", () => {
    const { token } = mintSessionToken(KEY, TOKEN, NOW);
    expect(token).not.toContain(TOKEN);
    expect(JSON.stringify(decodePayload(token))).not.toContain(TOKEN);
  });

  describe("rejects", () => {
    const { token } = mintSessionToken(KEY, TOKEN, NOW);
    const [prefix, payload, mac] = token.split(".");

    it("a tampered payload", () => {
      const forged = { ...decodePayload(token), exp: NOW + 10 * 28800 };
      const p = Buffer.from(JSON.stringify(forged)).toString("base64url");
      expect(verifySessionToken(KEY, `${prefix}.${p}.${mac}`, NOW).ok).toBe(false);
    });

    it("a tampered MAC", () => {
      const flipped = (mac[0] === "A" ? "B" : "A") + mac.slice(1);
      expect(verifySessionToken(KEY, `${prefix}.${payload}.${flipped}`, NOW).ok).toBe(false);
    });

    it("a MAC from a different key", () => {
      const other = mintSessionToken(randomBytes(48), TOKEN, NOW).token;
      expect(verifySessionToken(KEY, other, NOW).ok).toBe(false);
    });

    it("the wrong prefix", () => {
      expect(verifySessionToken(KEY, `gs2.${payload}.${mac}`, NOW).ok).toBe(false);
    });

    it("an extra segment", () => {
      expect(verifySessionToken(KEY, `${token}.extra`, NOW).ok).toBe(false);
    });

    it("non-base64url characters", () => {
      expect(verifySessionToken(KEY, `gs1.${payload}+/.${mac}`, NOW).ok).toBe(false);
      expect(verifySessionToken(KEY, `gs1.${payload}.${mac.slice(0, 42)}=`, NOW).ok).toBe(false);
    });

    it("an oversized token", () => {
      const big = { ...decodePayload(token), pad: "x".repeat(500) };
      expect(verifySessionToken(KEY, resign(big), NOW).ok).toBe(false);
    });

    it("a v:2 payload with a valid MAC", () => {
      expect(verifySessionToken(KEY, resign({ ...decodePayload(token), v: 2 }), NOW).ok).toBe(
        false
      );
    });

    it("a validly MACed payload with a non-integer exp or a bad hash", () => {
      const base = decodePayload(token);
      expect(verifySessionToken(KEY, resign({ ...base, exp: "never" }), NOW).ok).toBe(false);
      expect(verifySessionToken(KEY, resign({ ...base, exp: NOW + 0.5 }), NOW).ok).toBe(false);
      expect(verifySessionToken(KEY, resign({ ...base, pth: "short" }), NOW).ok).toBe(false);
      expect(verifySessionToken(KEY, resign([1, 2]), NOW).ok).toBe(false);
    });

    it("an empty string", () => {
      expect(verifySessionToken(KEY, "", NOW).ok).toBe(false);
    });
  });
});

describe("parseBearer", () => {
  it("returns undefined for a missing header, another scheme, or an empty token", () => {
    expect(parseBearer(undefined)).toBeUndefined();
    expect(parseBearer({})).toBeUndefined();
    expect(parseBearer({ authorization: "Basic dXNlcjpwYXNz" })).toBeUndefined();
    expect(parseBearer({ authorization: "Bearer " })).toBeUndefined();
    expect(parseBearer({ authorization: "Bearer" })).toBeUndefined();
    expect(parseBearer({ authorization: "Bearer a b" })).toBeUndefined();
  });

  it("accepts any case of the scheme", () => {
    expect(parseBearer({ authorization: "bearer abc" })).toBe("abc");
    expect(parseBearer({ authorization: "BEARER abc" })).toBe("abc");
    expect(parseBearer({ authorization: "Bearer abc" })).toBe("abc");
  });

  it("caps the token at 512 characters", () => {
    expect(parseBearer({ authorization: `Bearer ${"a".repeat(512)}` })).toHaveLength(512);
    expect(parseBearer({ authorization: `Bearer ${"a".repeat(513)}` })).toBeUndefined();
  });
});

describe("validateSessionRequest", () => {
  const good = { app_transaction: JWS, transactions: [JWS], push_token: TOKEN };

  it("accepts a well-formed body", () => {
    expect(validateSessionRequest(good)).toEqual({
      ok: true,
      value: { appTransaction: JWS, transactions: [JWS], pushToken: TOKEN },
    });
  });

  it.each([
    ["an unknown key", { ...good, extra: 1 }],
    ["an environment key", { ...good, environment: "sandbox" }],
    ["a non-string app_transaction", { ...good, app_transaction: 42 }],
    ["a null app_transaction", { ...good, app_transaction: null }],
    ["a JWS without three segments", { ...good, app_transaction: "a.b" }],
    ["a JWS with four segments", { ...good, app_transaction: "a.b.c.d" }],
    ["a JWS with padding", { ...good, app_transaction: "a.b.c=" }],
    ["a non-array transactions", { ...good, transactions: JWS }],
    ["more than 10 transactions", { ...good, transactions: Array<string>(11).fill(JWS) }],
    ["a malformed transaction", { ...good, transactions: [JWS, "nope"] }],
    ["an oversized JWS", { ...good, app_transaction: `a.${"b".repeat(16384)}.c` }],
    ["a missing push_token", { app_transaction: JWS }],
    ["an uppercase push_token", { ...good, push_token: TOKEN.toUpperCase() }],
    ["a non-object", [good]],
  ])("rejects %s with schema", (_label, body) => {
    const r = validateSessionRequest(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.status, r.error]).toEqual([400, "schema"]);
  });

  it("passes the schema with both proofs absent (the relay maps that to 403)", () => {
    expect(validateSessionRequest({ push_token: TOKEN })).toEqual({
      ok: true,
      value: { transactions: [], pushToken: TOKEN },
    });
  });
});
