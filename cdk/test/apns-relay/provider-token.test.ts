import { describe, it, expect, vi } from "vitest";
import { createPrivateKey, generateKeyPairSync, verify } from "node:crypto";
import {
  b64url,
  PROVIDER_TOKEN_REFRESH_SECS,
  ProviderTokenCache,
  signProviderToken,
} from "../../lib/lambda/apns-relay/provider-token";

// A P-256 key generated in-process and exported as PKCS#8 PEM, the shape of an
// Apple .p8. Never written anywhere.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const p8 = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const key = createPrivateKey(p8);

const KEY_ID = "A3TWAYM427";
const TEAM_ID = "9445Q654K8";
const NOW = 1_800_000_000;

const decode = (seg: string): unknown =>
  JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as unknown;

// The script's algorithm, inlined as the reference implementation.
const scriptB64url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("signProviderToken", () => {
  const jwt = signProviderToken(key, KEY_ID, TEAM_ID, NOW);
  const [h, c, s] = jwt.split(".");
  const signingInput = Buffer.from(`${h}.${c}`);
  const sig = Buffer.from(s, "base64url");

  it("signs in IEEE P1363 (raw r||s, 64 bytes), not DER", () => {
    expect(sig.length).toBe(64);
    // A DER ECDSA signature is a SEQUENCE, which starts 0x30 and is 70-72 bytes.
    expect(sig[0] === 0x30 && sig.length >= 70).toBe(false);
  });

  it("verifies as ieee-p1363 and not as DER", () => {
    expect(verify("sha256", signingInput, { key: publicKey, dsaEncoding: "ieee-p1363" }, sig)).toBe(
      true
    );
    expect(verify("sha256", signingInput, publicKey, sig)).toBe(false);
  });

  it("has header {alg: ES256, kid} and claims exactly {iss, iat}, with no sub", () => {
    expect(decode(h)).toEqual({ alg: "ES256", kid: KEY_ID });
    expect(decode(c)).toEqual({ iss: TEAM_ID, iat: NOW });
    expect(Object.keys(decode(c) as object)).toEqual(["iss", "iat"]);
  });

  it("encodes segments exactly as the script's b64url", () => {
    expect(h).toBe(scriptB64url(JSON.stringify({ alg: "ES256", kid: KEY_ID })));
    expect(c).toBe(scriptB64url(JSON.stringify({ iss: TEAM_ID, iat: NOW })));
  });
});

describe("b64url", () => {
  it("matches the script on inputs containing +, / and padding", () => {
    const inputs = [
      Buffer.from([0xfb, 0xff]), // "+/8=" in base64
      Buffer.from([0xfb, 0xef, 0xbe]), // "++++"
      Buffer.from([0xff, 0xff, 0xff, 0xff]), // "/////w=="
      "a",
      "ab",
      "abc",
      "",
    ];
    for (const i of inputs) {
      const out = b64url(i);
      expect(out).toBe(scriptB64url(i));
      expect(out).not.toMatch(/[+/=]/);
      expect(out).toBe(Buffer.from(i).toString("base64url"));
    }
  });
});

describe("ProviderTokenCache", () => {
  const spySigner = () => {
    let n = 0;
    return vi.fn(
      (_k: unknown, keyId: string, teamId: string, iat: number) =>
        `jwt${++n}:${keyId}:${teamId}:${iat}`
    );
  };

  it("reuses one token for ~50 min rather than re-signing per call", () => {
    const sign = spySigner();
    const cache = new ProviderTokenCache(sign);
    const a = cache.get("sandbox", key, KEY_ID, TEAM_ID, NOW);
    const b = cache.get("sandbox", key, KEY_ID, TEAM_ID, NOW + 60);
    const c = cache.get("sandbox", key, KEY_ID, TEAM_ID, NOW + 2999);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("re-signs at 3000 s with a new iat", () => {
    const sign = spySigner();
    const cache = new ProviderTokenCache(sign);
    const a = cache.get("sandbox", key, KEY_ID, TEAM_ID, NOW);
    const d = cache.get("sandbox", key, KEY_ID, TEAM_ID, NOW + PROVIDER_TOKEN_REFRESH_SECS);
    expect(PROVIDER_TOKEN_REFRESH_SECS).toBe(3000);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(d).not.toBe(a);
    expect(sign).toHaveBeenLastCalledWith(key, KEY_ID, TEAM_ID, NOW + 3000);
  });

  it("keeps entries separate per environment and per key id", () => {
    const sign = spySigner();
    const cache = new ProviderTokenCache(sign);
    const sandbox = cache.get("sandbox", key, KEY_ID, TEAM_ID, NOW);
    const production = cache.get("production", key, KEY_ID, TEAM_ID, NOW);
    const otherKey = cache.get("sandbox", key, "Y7QSB5K2Y6", TEAM_ID, NOW);
    expect(sign).toHaveBeenCalledTimes(3);
    expect(new Set([sandbox, production, otherKey]).size).toBe(3);
    expect(cache.get("sandbox", key, KEY_ID, TEAM_ID, NOW + 1)).toBe(sandbox);
    expect(cache.get("production", key, KEY_ID, TEAM_ID, NOW + 1)).toBe(production);
    expect(sign).toHaveBeenCalledTimes(3);
  });

  it("uses the real ES256 signer by default", () => {
    const jwt = new ProviderTokenCache().get("sandbox", key, KEY_ID, TEAM_ID, NOW);
    expect(Buffer.from(jwt.split(".")[2], "base64url").length).toBe(64);
  });
});
