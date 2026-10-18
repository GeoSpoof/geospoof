/**
 * The relay: routing, the order of checks, and the mapping from APNs outcomes
 * to the relay's own responses. Every collaborator is injected, so this is
 * tested end to end on fakes; handler.ts wires the real ones.
 *
 *   POST /v1/session  Apple-signed entitlement -> session token (design.md "POST /v1/session")
 *   POST /v1/push     session token + push request -> one APNs push (design.md "POST /v1/push")
 *
 * A 200 from APNs is ACCEPTANCE, not delivery (a start push whose attributes
 * fail to decode is discarded silently after it), so it is reported as
 * `202 {"apns_id"}` and never in words that imply the card changed.
 *
 * Logging is failures only, through `logFailure`'s whitelist. The entitlement
 * JWS, push token, session token and provider JWT are credentials and are
 * never logged or echoed.
 */
import { apnsAuthority, type ApnsSendRequest, type ApnsSendResult } from "./apns-client";
import { verifyPro, type EntitlementVerifier } from "./entitlement";
import type { ApnsEnvironment, RelayRuntimeConfig } from "./env-contract";
import {
  errorResponse,
  json,
  readJsonBody,
  type HttpApiEvent,
  type HttpApiResult,
  type Rejection,
  type RelayErrorCode,
} from "./http";
import { statusBucket, type FailureFields, type MetricSink } from "./metrics";
import type { ProviderTokenCache } from "./provider-token";
import { apnsHeadersFor, buildAps, serializeApsPayload, validatePushRequest } from "./push-schema";
import { RelayFault, type ApnsSigningKey } from "./secrets";
import {
  mintSessionToken,
  parseBearer,
  pushTokenMatches,
  validateSessionRequest,
  verifySessionToken,
} from "./session-token";

export const SESSION_ROUTE = "POST /v1/session";
export const PUSH_ROUTE = "POST /v1/push";

/** Room for an AppTransaction plus ten transactions, each up to 16 KB. */
const SESSION_MAX_BYTES = 131_072;
const PUSH_MAX_BYTES = 8192;

export interface RelayDeps {
  /** Throws RelayFault("config_invalid") if the environment is bad. */
  readonly config: () => RelayRuntimeConfig;
  readonly nowMs: () => number;
  readonly apnsKey: (env: ApnsEnvironment) => Promise<ApnsSigningKey>;
  readonly sessionKey: () => Promise<Buffer>;
  readonly verifiers: () => readonly EntitlementVerifier[];
  readonly providerTokens: ProviderTokenCache;
  readonly apns: { send(req: ApnsSendRequest): Promise<ApnsSendResult> };
  readonly metrics: MetricSink;
  readonly log: (fields: FailureFields) => void;
}

type Route = "session" | "push";

const UNAUTHORIZED: Rejection = { status: 401, error: "unauthorized" };
const ENTITLEMENT_INVALID: Rejection = { status: 403, error: "entitlement_invalid" };

export function createRelay(deps: RelayDeps): (event: HttpApiEvent) => Promise<HttpApiResult> {
  /** A refusal of the client's request: counted, logged by code only, answered. */
  const refuse = (route: Route, r: Rejection): HttpApiResult => {
    deps.metrics.rejected(r.error);
    deps.log({ route, error: r.error });
    return errorResponse(r.status, r.error, r.reason);
  };

  const onFault = (route: Route, e: unknown): HttpApiResult => {
    const fault = e instanceof RelayFault ? e.reason : "internal";
    deps.metrics.fault(fault);
    let status: number;
    let error: RelayErrorCode;
    if (fault === "secret_unavailable") [status, error] = [503, "relay_unavailable"];
    else if (fault === "internal") [status, error] = [500, "internal"];
    else [status, error] = [500, "relay_misconfigured"];
    deps.log({ route, error, fault });
    return errorResponse(status, error);
  };

  const onApnsResult = (result: ApnsSendResult): HttpApiResult => {
    if (result.kind === "timeout") {
      deps.metrics.apnsOutcome("timeout");
      deps.log({ route: "push", error: "apns_timeout" });
      return errorResponse(504, "apns_timeout");
    }
    if (result.kind === "network") {
      deps.metrics.apnsOutcome("network");
      deps.log({ route: "push", error: "apns_unreachable" });
      return errorResponse(503, "apns_unreachable", undefined, { "retry-after": "30" });
    }

    const { status, apnsId, reason } = result;
    deps.metrics.apnsOutcome(statusBucket(status));
    // Accepted by APNs. Not "delivered": see the header comment.
    if (status === 200) return json(202, { apns_id: apnsId ?? null });

    let out: { status: number; error: RelayErrorCode; headers?: Record<string, string> };
    if (status === 410 || (status === 400 && reason === "BadDeviceToken")) {
      // BadDeviceToken: the token is not valid for this host/environment.
      // Unregistered (410): the activity has ended. Either way the agent should
      // clear the token and stop; the reason says which.
      out = { status: 410, error: "token_dead" };
    } else if (status === 403) {
      // InvalidProviderToken & co: the key, kid or signature is wrong. Every
      // push will fail the same way, so this is a relay fault and it pages.
      deps.metrics.fault("apns_auth");
      out = { status: 502, error: "relay_misconfigured" };
    } else if (status === 429) {
      out = { status: 429, error: "rate_limited", headers: { "retry-after": "60" } };
    } else if (status === 500 || status === 503) {
      out = { status: 503, error: "apns_unavailable", headers: { "retry-after": "30" } };
    } else {
      out = { status: 502, error: "apns_rejected" };
    }
    deps.log({
      route: "push",
      error: out.error,
      apnsStatus: status,
      apnsReason: reason,
      apnsId,
      ...(status === 403 ? { fault: "apns_auth" as const } : {}),
    });
    return errorResponse(out.status, out.error, reason, out.headers);
  };

  const handleSession = async (event: HttpApiEvent): Promise<HttpApiResult> => {
    const cfg = deps.config();
    const body = readJsonBody(event, SESSION_MAX_BYTES);
    if (!body.ok) return refuse("session", body);
    const req = validateSessionRequest(body.value);
    if (!req.ok) return refuse("session", req);
    const proof = req.value;
    if (proof.appTransaction === undefined && proof.transactions.length === 0) {
      return refuse("session", ENTITLEMENT_INVALID);
    }

    const nowMs = deps.nowMs();
    // Verify and discard: the decoded material goes no further than this call.
    if (!(await verifyPro(proof, deps.verifiers(), cfg.bundleId, nowMs))) {
      return refuse("session", ENTITLEMENT_INVALID);
    }

    const key = await deps.sessionKey();
    const { token, expiresInSecs } = mintSessionToken(
      key,
      proof.pushToken,
      Math.floor(nowMs / 1000)
    );
    deps.metrics.sessionIssued();
    return json(200, { token, expires_in_secs: expiresInSecs });
  };

  const handlePush = async (event: HttpApiEvent): Promise<HttpApiResult> => {
    const cfg = deps.config();
    const nowSecs = Math.floor(deps.nowMs() / 1000);

    // 1. Who is asking. One code for missing, invalid and expired.
    const bearer = parseBearer(event.headers);
    if (bearer === undefined) return refuse("push", UNAUTHORIZED);
    const session = verifySessionToken(await deps.sessionKey(), bearer, nowSecs);
    if (!session.ok) return refuse("push", UNAUTHORIZED);

    // 2-3. What they ask for. unknown_kind is reported before schema.
    const body = readJsonBody(event, PUSH_MAX_BYTES);
    if (!body.ok) return refuse("push", body);
    const validated = validatePushRequest(body.value);
    if (!validated.ok) return refuse("push", validated);
    const v = validated.value;

    // 4. A session updates the one card it was issued for.
    if (!pushTokenMatches(session.pushTokenHash, v.pushToken)) {
      return refuse("push", { status: 403, error: "token_mismatch" });
    }

    // 5. Never forward to a host this deployment holds no key for.
    const keyRef = cfg.apnsKeys[v.environment];
    if (keyRef === undefined) {
      return refuse("push", {
        status: 400,
        error: "environment_unsupported",
        reason: "this relay does not serve that APNs environment",
      });
    }

    // 6. Sign, build, send. Every absolute time comes from nowSecs.
    const signing = await deps.apnsKey(v.environment);
    // The secret parser already checks this; re-checked here so no wiring
    // mistake can mint a JWT under a kid APNs would reject.
    if (signing.keyId !== keyRef.keyId || signing.teamId !== cfg.teamId) {
      throw new RelayFault("key_mismatch");
    }
    const jwt = deps.providerTokens.get(
      v.environment,
      signing.key,
      signing.keyId,
      signing.teamId,
      nowSecs
    );
    const payload = serializeApsPayload(buildAps(v, nowSecs));
    const headers = apnsHeadersFor(v.kind, v.priority, cfg.bundleId);
    const result = await deps.apns.send({
      authority: apnsAuthority(v.environment),
      pushToken: v.pushToken,
      jwt,
      topic: headers.topic,
      pushType: headers.pushType,
      priority: headers.priority,
      payload,
    });
    return onApnsResult(result);
  };

  return async (event) => {
    let route: Route;
    if (event.routeKey === SESSION_ROUTE) route = "session";
    else if (event.routeKey === PUSH_ROUTE) route = "push";
    else {
      deps.metrics.rejected("not_found");
      return errorResponse(404, "not_found");
    }
    try {
      return route === "session" ? await handleSession(event) : await handlePush(event);
    } catch (e) {
      return onFault(route, e);
    }
  };
}
