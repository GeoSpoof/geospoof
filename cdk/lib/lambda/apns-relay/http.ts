/**
 * The slice of API Gateway HTTP API (payload format 2.0) the relay uses, plus
 * response helpers. Kept local and minimal rather than pulling in
 * `@types/aws-lambda`.
 *
 * Responses never echo a client value. `reason` strings are built only from the
 * relay's own field names and enums, or from APNs' own reason enum.
 */

export interface HttpApiEvent {
  readonly routeKey: string;
  readonly headers?: Record<string, string | undefined>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
}

export interface HttpApiResult {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export type RelayErrorCode =
  | "schema"
  | "unknown_kind"
  | "environment_unsupported"
  | "payload_too_large"
  | "unauthorized"
  | "token_mismatch"
  | "entitlement_invalid"
  | "token_dead"
  | "rate_limited"
  | "apns_rejected"
  | "apns_unavailable"
  | "apns_unreachable"
  | "apns_timeout"
  | "relay_misconfigured"
  | "relay_unavailable"
  | "internal"
  | "not_found";

/** A refusal: the HTTP status and the stable error code the client branches on. */
export interface Rejection {
  readonly status: number;
  readonly error: RelayErrorCode;
  readonly reason?: string;
}

export type Result<T> =
  { readonly ok: true; readonly value: T } | ({ readonly ok: false } & Rejection);

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function reject<T = never>(
  status: number,
  error: RelayErrorCode,
  reason?: string
): Result<T> {
  return reason === undefined ? { ok: false, status, error } : { ok: false, status, error, reason };
}

/** A 400 schema refusal. `reason` must name our own fields only. */
export function schemaError<T = never>(reason: string): Result<T> {
  return reject<T>(400, "schema", reason);
}

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

export function json(
  status: number,
  obj: unknown,
  extraHeaders?: Record<string, string>
): HttpApiResult {
  return {
    statusCode: status,
    headers: { ...BASE_HEADERS, ...extraHeaders },
    body: JSON.stringify(obj),
  };
}

export function errorResponse(
  status: number,
  error: RelayErrorCode,
  reason?: string,
  extraHeaders?: Record<string, string>
): HttpApiResult {
  return json(status, reason === undefined ? { error } : { error, reason }, extraHeaders);
}

/**
 * Decode and parse a JSON body, enforcing a byte cap before parsing.
 * `413 payload_too_large` over the cap, `400 schema` for anything unparseable.
 */
export function readJsonBody(event: HttpApiEvent, maxBytes: number): Result<unknown> {
  const raw = event.body ?? "";
  let text: string;
  if (event.isBase64Encoded) {
    // Cheap pre-check on the encoded length so a huge body is never decoded.
    if (Math.floor((raw.length * 3) / 4) > maxBytes + 2) {
      return reject(413, "payload_too_large");
    }
    const bytes = Buffer.from(raw, "base64");
    if (bytes.length > maxBytes) return reject(413, "payload_too_large");
    text = bytes.toString("utf8");
  } else {
    if (Buffer.byteLength(raw, "utf8") > maxBytes) return reject(413, "payload_too_large");
    text = raw;
  }
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    return schemaError("body is not valid JSON");
  }
}
