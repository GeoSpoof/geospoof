/**
 * HTTP/2 client for APNs, ported from geospoof-ios:scripts/apns-push.mjs:
 * `node:http2` `connect("https://" + host)`, one POST to `/3/device/<token>`
 * with exactly the script's headers, then read `:status`, `apns-id` and the
 * `{"reason": ...}` error body.
 *
 * A 200 here is APNs ACCEPTING the push, not delivering it. A start push whose
 * attributes fail to decode is discarded silently after the 200.
 *
 * Session lifecycle (Lambda freezes between invokes, so a socket can be dead
 * without anyone having noticed):
 * - one session cached per authority, dropped on goaway, close or error;
 * - reconnect proactively when the cached session has been idle > 180 s;
 * - 4 s per attempt; on timeout the stream is cancelled and the session destroyed;
 * - retry ONCE on a fresh session, and only when a REUSED session failed at
 *   the connection level before any response headers arrived (`network`).
 *   Once headers arrive the response is returned as-is, and a timeout is never
 *   retried. A duplicate push after an ambiguous failure is harmless: it
 *   carries the same aps.timestamp and content.
 *
 * The push token and the provider JWT pass through here and are credentials.
 * This module logs nothing.
 */
import { connect as http2Connect, constants, type ClientHttp2Session } from "node:http2";
import type { ApnsEnvironment } from "./env-contract";

export const APNS_HOSTS = {
  sandbox: "api.sandbox.push.apple.com",
  production: "api.push.apple.com",
} as const satisfies Record<ApnsEnvironment, string>;

export const apnsAuthority = (env: ApnsEnvironment): string => `https://${APNS_HOSTS[env]}`;

export interface ApnsSendRequest {
  readonly authority: string;
  readonly pushToken: string;
  readonly jwt: string;
  readonly topic: string;
  readonly pushType: string;
  readonly priority: "5" | "10";
  readonly payload: string;
}

export type ApnsSendResult =
  | { kind: "response"; status: number; apnsId?: string; reason?: string }
  | { kind: "timeout" }
  /** The connection failed before any response headers arrived. */
  | { kind: "network"; code: string };

export interface ApnsClientOptions {
  readonly connect?: (authority: string) => ClientHttp2Session;
  readonly nowMs?: () => number;
  readonly timeoutMs?: number;
  readonly idleReconnectMs?: number;
}

const MAX_RESPONSE_BYTES = 4096;
const REASON_RE = /^[A-Za-z]{1,64}$/;
const APNS_ID_RE = /^[0-9A-Fa-f-]{36}$/;
const ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;

/**
 * A stable error code, never a message. A stream cancelled because its session
 * failed carries the session's error (e.g. ECONNREFUSED) as its `cause`.
 */
function errorCode(e: unknown): string {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | null;
  for (const code of [err?.cause?.code, err?.code]) {
    if (typeof code === "string" && ERROR_CODE_RE.test(code)) return code;
  }
  return "UNKNOWN";
}

export class ApnsClient {
  private readonly connectFn: (authority: string) => ClientHttp2Session;
  private readonly nowMs: () => number;
  private readonly timeoutMs: number;
  private readonly idleReconnectMs: number;
  private readonly sessions = new Map<
    string,
    { session: ClientHttp2Session; lastUsedMs: number }
  >();

  constructor(opts: ApnsClientOptions = {}) {
    this.connectFn = opts.connect ?? ((authority) => http2Connect(authority));
    this.nowMs = opts.nowMs ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.idleReconnectMs = opts.idleReconnectMs ?? 180_000;
  }

  async send(req: ApnsSendRequest): Promise<ApnsSendResult> {
    const reused = this.cachedSession(req.authority);
    if (reused) {
      const first = await this.attempt(req.authority, reused, req);
      if (first.kind !== "network") return first;
      // A reused session died under us before answering: one retry, fresh.
      this.forget(req.authority, reused, true);
    }
    return this.attempt(req.authority, this.openSession(req.authority), req);
  }

  close(): void {
    for (const { session } of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private cachedSession(authority: string): ClientHttp2Session | undefined {
    const entry = this.sessions.get(authority);
    if (!entry) return undefined;
    const { session, lastUsedMs } = entry;
    if (session.closed || session.destroyed || this.nowMs() - lastUsedMs > this.idleReconnectMs) {
      this.forget(authority, session, true);
      return undefined;
    }
    return session;
  }

  private openSession(authority: string): ClientHttp2Session {
    const session = this.connectFn(authority);
    // An http2 session with no 'error' listener crashes the process on error.
    session.on("error", () => this.forget(authority, session, false));
    session.on("goaway", () => this.forget(authority, session, false));
    session.on("close", () => this.forget(authority, session, false));
    this.sessions.set(authority, { session, lastUsedMs: this.nowMs() });
    return session;
  }

  private forget(authority: string, session: ClientHttp2Session, close: boolean): void {
    if (this.sessions.get(authority)?.session === session) this.sessions.delete(authority);
    if (close && !session.closed && !session.destroyed) session.close();
  }

  private attempt(
    authority: string,
    session: ClientHttp2Session,
    req: ApnsSendRequest
  ): Promise<ApnsSendResult> {
    return new Promise<ApnsSendResult>((resolve) => {
      let settled = false;
      let stream: ReturnType<ClientHttp2Session["request"]> | undefined;
      let status: number | undefined;
      let apnsId: string | undefined;
      const chunks: Buffer[] = [];
      let bytes = 0;

      const responseResult = (): ApnsSendResult => {
        const result: { kind: "response"; status: number; apnsId?: string; reason?: string } = {
          kind: "response",
          status: status as number,
        };
        if (apnsId !== undefined) result.apnsId = apnsId;
        if (status !== 200 && bytes > 0) {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            const reason = (parsed as { reason?: unknown } | null)?.reason;
            if (typeof reason === "string" && REASON_RE.test(reason)) result.reason = reason;
          } catch {
            // A non-JSON error body carries no reason we can trust.
          }
        }
        return result;
      };

      // Once headers have arrived the status is known and wins; before that,
      // any failure is a connection-level one.
      const fail = (code: string) =>
        finish(status !== undefined ? responseResult() : { kind: "network", code });
      const onSessionError = (e: unknown) => fail(errorCode(e));
      const onSessionClose = () => fail("ERR_HTTP2_SESSION_CLOSED");

      const finish = (r: ApnsSendResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.off("error", onSessionError);
        session.off("close", onSessionClose);
        const entry = this.sessions.get(authority);
        if (entry?.session === session) entry.lastUsedMs = this.nowMs();
        resolve(r);
      };

      const timer = setTimeout(() => {
        stream?.close(constants.NGHTTP2_CANCEL);
        this.forget(authority, session, false);
        session.destroy();
        finish({ kind: "timeout" });
      }, this.timeoutMs);
      session.on("error", onSessionError);
      session.on("close", onSessionClose);

      try {
        stream = session.request({
          ":method": "POST",
          ":path": `/3/device/${req.pushToken}`,
          authorization: `bearer ${req.jwt}`,
          "apns-topic": req.topic,
          "apns-push-type": req.pushType,
          "apns-priority": req.priority,
        });
      } catch (e) {
        finish({ kind: "network", code: errorCode(e) });
        return;
      }

      stream.on("response", (headers) => {
        status = Number(headers[":status"]);
        const id = headers["apns-id"];
        if (typeof id === "string" && APNS_ID_RE.test(id)) apnsId = id;
      });
      stream.on("data", (chunk: Buffer) => {
        if (bytes >= MAX_RESPONSE_BYTES) return;
        const take = chunk.subarray(0, MAX_RESPONSE_BYTES - bytes);
        chunks.push(take);
        bytes += take.length;
      });
      stream.on("end", () => fail("ERR_HTTP2_STREAM_ENDED"));
      stream.on("error", (e: unknown) => fail(errorCode(e)));
      stream.on("close", () => fail("ERR_HTTP2_STREAM_CLOSED"));
      stream.end(req.payload);
    });
  }
}
