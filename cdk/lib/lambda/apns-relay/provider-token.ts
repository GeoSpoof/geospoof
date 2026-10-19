/**
 * The APNs provider JWT, ported from geospoof-ios:scripts/apns-push.mjs (which
 * has updated a real Live Activity on a real iPhone). Do not re-derive it.
 *
 *   header {"alg":"ES256","kid":<keyId>}   claims {"iss":<teamId>,"iat":<secs>}   (no `sub`)
 *
 * ES256 MUST be signed with `dsaEncoding: "ieee-p1363"` (raw r||s, which JWS
 * requires). Node's default is DER, which APNs rejects as 403
 * InvalidProviderToken with nothing in the error pointing at the encoding.
 *
 * Apple accepts a provider token for up to 1 h and rate-limits refreshes more
 * often than every 20 min (429 TooManyProviderTokenUpdates), so minting one per
 * request is a defect. The cache below reuses one per env+key for ~50 min.
 *
 * Provider JWTs are credentials. Nothing here logs.
 */
import { createSign, type KeyObject } from "node:crypto";
import type { ApnsEnvironment } from "./env-contract";

/** ~50 min. APNs accepts 60; refreshing more often than every 20 is throttled. */
export const PROVIDER_TOKEN_REFRESH_SECS = 3000;

// Verbatim from apns-push.mjs.
export const b64url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export type ProviderTokenSigner = (
  key: KeyObject,
  keyId: string,
  teamId: string,
  iatSecs: number
) => string;

export const signProviderToken: ProviderTokenSigner = (key, keyId, teamId, iatSecs) => {
  const claims = { iss: teamId, iat: iatSecs };
  const signingInput = `${b64url(JSON.stringify({ alg: "ES256", kid: keyId }))}.${b64url(
    JSON.stringify(claims)
  )}`;
  // `ieee-p1363` is the raw r||s encoding JWS requires. See the header comment.
  const signature = createSign("SHA256")
    .update(signingInput)
    .sign({ key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(signature)}`;
};

/** One provider JWT per APNs environment + key, reused until it is ~50 min old. */
export class ProviderTokenCache {
  private readonly entries = new Map<string, { jwt: string; iatSecs: number }>();

  constructor(private readonly sign: ProviderTokenSigner = signProviderToken) {}

  get(
    env: ApnsEnvironment,
    key: KeyObject,
    keyId: string,
    teamId: string,
    nowSecs: number
  ): string {
    const id = `${env}:${keyId}:${teamId}`;
    const cached = this.entries.get(id);
    if (cached && nowSecs - cached.iatSecs < PROVIDER_TOKEN_REFRESH_SECS) return cached.jwt;
    const jwt = this.sign(key, keyId, teamId, nowSecs);
    this.entries.set(id, { jwt, iatSecs: nowSecs });
    return jwt;
  }
}
