/**
 * Relay session tokens: signed, self-describing, no store (design.md
 * "POST /v1/session").
 *
 *   gs1.<b64url(JSON {"v":1,"exp":<unix secs>,"pth":<b64url sha256(push_token)>})>.<b64url HMAC-SHA256>
 *
 * The MAC covers "gs1." + payload. `exp` comes from the relay's clock; the
 * client is told only the duration (`expires_in_secs`), so a skewed client
 * clock cannot make it believe in a token wrongly. The token is bound to a hash
 * of one push token: a stolen session updates one card and nothing else.
 *
 * Session tokens are credentials. Nothing here logs.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ok, schemaError, type Result } from "./http";
import { isPlainObject, PUSH_TOKEN_RE } from "./push-schema";

/** 8 h, the Live Activity ceiling. design.md "Settled constants". */
export const RELAY_SESSION_TTL_SECS = 28800;

const PREFIX = "gs1.";
const TOKEN_RE = /^gs1\.([A-Za-z0-9_-]{1,400})\.([A-Za-z0-9_-]{43})$/;
const HASH_B64URL_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_BEARER_LENGTH = 512;

/** A compact JWS: three base64url segments. StoreKit JWS are a few KB. */
const JWS_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_JWS_LENGTH = 16384;
const MAX_TRANSACTIONS = 10;

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

function mac(key: Buffer, payloadB64: string): string {
  return createHmac("sha256", key)
    .update(PREFIX + payloadB64, "utf8")
    .digest("base64url");
}

export function mintSessionToken(
  key: Buffer,
  pushToken: string,
  nowSecs: number
): { token: string; expiresInSecs: typeof RELAY_SESSION_TTL_SECS } {
  const payload = {
    v: 1,
    exp: nowSecs + RELAY_SESSION_TTL_SECS,
    pth: sha256(pushToken).toString("base64url"),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return {
    token: `${PREFIX}${payloadB64}.${mac(key, payloadB64)}`,
    expiresInSecs: RELAY_SESSION_TTL_SECS,
  };
}

export function verifySessionToken(
  key: Buffer,
  token: string,
  nowSecs: number
): { ok: true; pushTokenHash: Buffer } | { ok: false } {
  const m = TOKEN_RE.exec(token);
  if (!m) return { ok: false };
  const [, payloadB64, providedMac] = m;

  // Compare the canonical encodings, so a non-canonical base64url spelling of
  // the right bytes is not a second valid token.
  const expected = Buffer.from(mac(key, payloadB64), "utf8");
  const provided = Buffer.from(providedMac, "utf8");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false };
  }
  if (!isPlainObject(payload)) return { ok: false };
  const { v, exp, pth } = payload;
  if (v !== 1 || typeof exp !== "number" || !Number.isSafeInteger(exp)) return { ok: false };
  if (typeof pth !== "string" || !HASH_B64URL_RE.test(pth)) return { ok: false };
  if (nowSecs >= exp) return { ok: false };
  return { ok: true, pushTokenHash: Buffer.from(pth, "base64url") };
}

/** Constant-time check that `pushToken` is the one the session was bound to. */
export function pushTokenMatches(pushTokenHash: Buffer, pushToken: string): boolean {
  const actual = sha256(pushToken);
  return pushTokenHash.length === actual.length && timingSafeEqual(pushTokenHash, actual);
}

/** `Authorization: Bearer <token>`, any case. Undefined when absent or malformed. */
export function parseBearer(
  headers: Record<string, string | undefined> | undefined
): string | undefined {
  const value = headers?.authorization;
  if (typeof value !== "string") return undefined;
  const m = /^bearer +(\S+)$/i.exec(value.trim());
  if (!m || m[1].length > MAX_BEARER_LENGTH) return undefined;
  return m[1];
}

export interface SessionRequest {
  readonly appTransaction?: string;
  readonly transactions: string[];
  readonly pushToken: string;
}

const SESSION_KEYS: ReadonlySet<string> = new Set([
  "app_transaction",
  "transactions",
  "push_token",
]);

const isJws = (v: unknown): v is string =>
  typeof v === "string" && v.length <= MAX_JWS_LENGTH && JWS_RE.test(v);

/**
 * Validate a `/v1/session` body. Shape only: whether the material is genuine
 * is the entitlement verifier's job. Both proofs absent passes here; the relay
 * refuses it as `entitlement_invalid`.
 */
export function validateSessionRequest(body: unknown): Result<SessionRequest> {
  if (!isPlainObject(body)) return schemaError("body must be a JSON object");
  if (!Object.keys(body).every((k) => SESSION_KEYS.has(k))) {
    return schemaError("unknown field at top level");
  }
  const { app_transaction, transactions, push_token } = body;
  if (typeof push_token !== "string" || !PUSH_TOKEN_RE.test(push_token)) {
    return schemaError("push_token must be lowercase hex, even length, 32-512 characters");
  }
  if (app_transaction !== undefined && !isJws(app_transaction)) {
    return schemaError("app_transaction must be a compact JWS");
  }
  let txs: string[] = [];
  if (transactions !== undefined) {
    if (!Array.isArray(transactions) || transactions.length > MAX_TRANSACTIONS) {
      return schemaError("transactions must be an array of at most 10 compact JWS");
    }
    if (!transactions.every(isJws)) {
      return schemaError("transactions must be an array of at most 10 compact JWS");
    }
    txs = transactions;
  }
  return ok({
    ...(app_transaction !== undefined ? { appTransaction: app_transaction } : {}),
    transactions: txs,
    pushToken: push_token,
  });
}
