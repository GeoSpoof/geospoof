/**
 * `POST /v1/push`: strict validation per kind, and the translation from the
 * relay's snake_case request into the APNs payload ActivityKit decodes.
 *
 * Wire-format authority: geospoof-ios:.kiro/specs/live-activity-push/design.md
 * ("POST /v1/push", "Times inside content-state are Unix epoch seconds").
 * This repo mirrors nothing; when that file changes, this one follows.
 *
 * THE TRAP. The relay's own API is snake_case. APNs `content-state` uses the
 * raw Swift property names of `RouteActivityAttributes.ContentState`
 * (geospoof-ios:app/Shared (App)/RouteActivityAttributes.swift), because that
 * type declares no CodingKeys. So the relay TRANSLATES, and two fields change
 * meaning on the way:
 *
 *   relay request         APNs content-state
 *   travelled_m        -> travelledM
 *   total_m            -> totalM
 *   finishes_in_secs   -> finishesAtEpoch   DURATION -> ABSOLUTE (relay now + value)
 *   repeats/paused/finished (unchanged)
 *   speed_defaulted    -> speedDefaulted
 *   confirmed_age_secs -> confirmedAtEpoch  AGE -> ABSOLUTE (relay now - value)
 *   pending_action     -> pendingAction
 *   location_in_effect -> locationInEffect
 *
 * plus `stale_in_secs` -> absolute `aps.stale-date`, and `aps.timestamp`
 * stamped here. Every absolute is computed from the RELAY's clock: a
 * customer's machine with a wrong clock must never be able to produce a
 * wrong-looking card, so no client value that renders as a time is accepted.
 *
 * All absolutes are UNIX epoch seconds (since 1970), NOT Apple's reference date
 * (2001). ContentState stores them as Double precisely so a non-Swift producer
 * cannot be 31 years off in a field that renders as a countdown.
 */
import type { ApnsEnvironment } from "./env-contract";
import { ok, schemaError, reject, type Result } from "./http";

/** design.md "Settled constants": `LIVE_ACTIVITY_STALE_SECS`, relay default. */
export const LIVE_ACTIVITY_STALE_SECS = 120;
/** A Live Activity lives at most 8 h. */
export const MAX_LIVE_ACTIVITY_SECS = 28800;
/** APNs payload ceiling for a Live Activity push. */
export const MAX_APS_PAYLOAD_BYTES = 4096;

/**
 * The push token goes into the APNs URL path (`/3/device/<token>`), so this is
 * a path-injection boundary: lowercase hex only, even length, 32-512 chars.
 * Not hard-coded to 64 - Apple does not promise a length.
 */
export const PUSH_TOKEN_RE = /^(?:[0-9a-f]{2}){16,256}$/;

/**
 * The ONLY source of push type, topic suffix and attributes type. The client
 * names a kind; it never names a push type or topic.
 */
export const KINDS = {
  route: {
    pushType: "liveactivity",
    topicSuffix: ".push-type.liveactivity",
    attributesType: "RouteActivityAttributes",
  },
} as const;

export type Kind = keyof typeof KINDS;

/** Reserved by design.md "Kinds" (Requirement 8.1) and not implemented. */
const RESERVED_KINDS: readonly string[] = ["steering"];

export type PushEvent = "start" | "update" | "end";
export type PushPriority = "low" | "high";
export type PendingAction = "pause" | "resume";

/** A validated request, in the relay's own (camelCase) terms. Durations only. */
export interface ValidatedPush {
  readonly environment: ApnsEnvironment;
  readonly kind: Kind;
  readonly pushToken: string;
  readonly event: PushEvent;
  readonly priority: PushPriority;
  readonly staleInSecs: number;
  readonly confirmedAgeSecs: number;
  readonly contentState: {
    readonly travelledM: number;
    readonly totalM: number;
    readonly finishesInSecs?: number;
    readonly repeats: boolean;
    readonly paused: boolean;
    readonly finished: boolean;
    readonly speedDefaulted: boolean;
    readonly pendingAction?: PendingAction;
    readonly locationInEffect: boolean;
  };
  readonly attributes?: { readonly savedRouteId: string | null };
  readonly dismissInSecs?: number;
}

/**
 * `RouteActivityAttributes.ContentState` exactly as Swift's synthesized Codable
 * reads it, in declaration order. Optionals are omitted when absent.
 */
export interface RouteContentState {
  travelledM: number;
  totalM: number;
  finishesAtEpoch?: number;
  repeats: boolean;
  paused: boolean;
  finished: boolean;
  speedDefaulted: boolean;
  confirmedAtEpoch: number;
  pendingAction?: PendingAction;
  locationInEffect: boolean;
}

export interface ApsPayload {
  timestamp: number;
  event: PushEvent;
  "stale-date": number;
  "content-state": RouteContentState;
  "dismissal-date"?: number;
  "attributes-type"?: string;
  attributes?: { savedRouteId: string | null };
  "input-push-token"?: 1;
}

const ROUTE_TOP_KEYS: ReadonlySet<string> = new Set([
  "environment",
  "kind",
  "push_token",
  "event",
  "priority",
  "stale_in_secs",
  "confirmed_age_secs",
  "content_state",
  "attributes",
  "dismiss_in_secs",
]);

const ROUTE_CONTENT_KEYS: ReadonlySet<string> = new Set([
  "travelled_m",
  "total_m",
  "finishes_in_secs",
  "repeats",
  "paused",
  "finished",
  "speed_defaulted",
  "pending_action",
  "location_in_effect",
]);

const ROUTE_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(["savedRouteId"]);

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const MAX_DISTANCE_M = 1e8;
const MAX_FINISHES_IN_SECS = 31_536_000;
const MAX_DISMISS_IN_SECS = 14_400;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function onlyKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(obj).every((k) => allowed.has(k));
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const numberIn = (v: unknown, min: number, max: number): v is number =>
  isFiniteNumber(v) && v >= min && v <= max;

const integerIn = (v: unknown, min: number, max: number): v is number =>
  numberIn(v, min, max) && Number.isInteger(v);

const has = (obj: Record<string, unknown>, key: string): boolean => Object.hasOwn(obj, key);

/**
 * Validate a `/v1/push` body. Order: plain object, then `kind` (so an unknown
 * kind is reported as such even when other fields are also wrong), then the
 * kind's strict schema, where any unknown key at any level is refused.
 */
export function validatePushRequest(body: unknown): Result<ValidatedPush> {
  if (!isPlainObject(body)) return schemaError("body must be a JSON object");

  const kind = body.kind;
  if (typeof kind !== "string") return schemaError("kind is required");
  if (RESERVED_KINDS.includes(kind)) {
    return reject(400, "unknown_kind", "kind 'steering' is reserved and not implemented");
  }
  if (!Object.hasOwn(KINDS, kind)) {
    return reject(400, "unknown_kind", "kind is not supported; the only kind is 'route'");
  }

  return validateRoute(body);
}

function validateRoute(body: Record<string, unknown>): Result<ValidatedPush> {
  if (!onlyKeys(body, ROUTE_TOP_KEYS)) return schemaError("unknown field at top level");

  const { environment, push_token, event, priority } = body;
  if (environment !== "sandbox" && environment !== "production") {
    return schemaError("environment must be 'sandbox' or 'production'");
  }
  if (typeof push_token !== "string" || !PUSH_TOKEN_RE.test(push_token)) {
    return schemaError("push_token must be lowercase hex, even length, 32-512 characters");
  }
  if (event !== "start" && event !== "update" && event !== "end") {
    return schemaError("event must be 'start', 'update' or 'end'");
  }
  if (priority !== "low" && priority !== "high") {
    return schemaError("priority must be 'low' or 'high'");
  }

  let staleInSecs = LIVE_ACTIVITY_STALE_SECS;
  if (has(body, "stale_in_secs")) {
    if (!integerIn(body.stale_in_secs, 1, MAX_LIVE_ACTIVITY_SECS)) {
      return schemaError("stale_in_secs must be an integer from 1 to 28800");
    }
    staleInSecs = body.stale_in_secs;
  }

  const confirmedAgeSecs = body.confirmed_age_secs;
  if (!numberIn(confirmedAgeSecs, 0, MAX_LIVE_ACTIVITY_SECS)) {
    return schemaError("confirmed_age_secs must be a number from 0 to 28800");
  }

  const cs = body.content_state;
  if (!isPlainObject(cs)) return schemaError("content_state must be an object");
  if (!onlyKeys(cs, ROUTE_CONTENT_KEYS)) return schemaError("unknown field in content_state");
  if (!numberIn(cs.travelled_m, 0, MAX_DISTANCE_M)) {
    return schemaError("content_state.travelled_m must be a number from 0 to 1e8");
  }
  if (!numberIn(cs.total_m, 0, MAX_DISTANCE_M)) {
    return schemaError("content_state.total_m must be a number from 0 to 1e8");
  }
  let finishesInSecs: number | undefined;
  if (cs.finishes_in_secs !== undefined && cs.finishes_in_secs !== null) {
    if (!numberIn(cs.finishes_in_secs, 0, MAX_FINISHES_IN_SECS)) {
      return schemaError(
        "content_state.finishes_in_secs must be null or a number from 0 to 31536000"
      );
    }
    finishesInSecs = cs.finishes_in_secs;
  }
  for (const flag of ["repeats", "paused", "finished", "speed_defaulted", "location_in_effect"]) {
    if (typeof cs[flag] !== "boolean")
      return schemaError(`content_state.${flag} must be a boolean`);
  }
  let pendingAction: PendingAction | undefined;
  if (cs.pending_action !== undefined && cs.pending_action !== null) {
    if (cs.pending_action !== "pause" && cs.pending_action !== "resume") {
      return schemaError("content_state.pending_action must be null, 'pause' or 'resume'");
    }
    pendingAction = cs.pending_action;
  }

  let attributes: { savedRouteId: string | null } | undefined;
  if (event === "start") {
    const attrs = body.attributes;
    if (!isPlainObject(attrs)) return schemaError("attributes is required for event 'start'");
    if (!onlyKeys(attrs, ROUTE_ATTRIBUTE_KEYS)) {
      return schemaError("attributes may only contain savedRouteId (never a route name)");
    }
    const id = attrs.savedRouteId;
    if (id !== undefined && id !== null && (typeof id !== "string" || !UUID_RE.test(id))) {
      return schemaError("attributes.savedRouteId must be a UUID or null");
    }
    attributes = { savedRouteId: typeof id === "string" ? id : null };
  } else if (has(body, "attributes")) {
    return schemaError("attributes is only allowed for event 'start'");
  }

  let dismissInSecs: number | undefined;
  if (has(body, "dismiss_in_secs")) {
    if (event !== "end") return schemaError("dismiss_in_secs is only allowed for event 'end'");
    if (!integerIn(body.dismiss_in_secs, 0, MAX_DISMISS_IN_SECS)) {
      return schemaError("dismiss_in_secs must be an integer from 0 to 14400");
    }
    dismissInSecs = body.dismiss_in_secs;
  }

  return ok({
    environment,
    kind: "route",
    pushToken: push_token,
    event,
    priority,
    staleInSecs,
    confirmedAgeSecs,
    contentState: {
      travelledM: cs.travelled_m,
      totalM: cs.total_m,
      finishesInSecs,
      repeats: cs.repeats as boolean,
      paused: cs.paused as boolean,
      finished: cs.finished as boolean,
      speedDefaulted: cs.speed_defaulted as boolean,
      pendingAction,
      locationInEffect: cs.location_in_effect as boolean,
    },
    attributes,
    dismissInSecs,
  });
}

/**
 * Build the `aps` dictionary. `nowSecs` is the RELAY's clock in Unix epoch
 * seconds; every absolute instant in the payload derives from it and nothing
 * else. Key order follows apns-push.mjs (hardware-proven) and, for
 * content-state, Swift declaration order.
 */
export function buildAps(v: ValidatedPush, nowSecs: number): ApsPayload {
  const s = v.contentState;
  // Swift declaration order. The two Optionals are omitted, not null, when
  // absent (design.md: "omitted entirely when finishes_in_secs is absent").
  const contentState: RouteContentState = {
    travelledM: s.travelledM,
    totalM: s.totalM,
    ...(s.finishesInSecs !== undefined ? { finishesAtEpoch: nowSecs + s.finishesInSecs } : {}),
    repeats: s.repeats,
    paused: s.paused,
    finished: s.finished,
    speedDefaulted: s.speedDefaulted,
    confirmedAtEpoch: nowSecs - v.confirmedAgeSecs,
    ...(s.pendingAction !== undefined ? { pendingAction: s.pendingAction } : {}),
    locationInEffect: s.locationInEffect,
  };

  const aps: ApsPayload = {
    // What iOS orders updates on. Relay-stamped, so a skewed customer clock
    // cannot make its own card stop updating.
    timestamp: nowSecs,
    event: v.event,
    "stale-date": nowSecs + v.staleInSecs,
    "content-state": contentState,
  };
  if (v.event === "end" && v.dismissInSecs !== undefined) {
    aps["dismissal-date"] = nowSecs + v.dismissInSecs;
  }
  if (v.event === "start") {
    aps["attributes-type"] = KINDS[v.kind].attributesType;
    // Never a route name (Requirement 3.3): nothing a customer typed goes over the wire.
    aps.attributes = { savedRouteId: v.attributes?.savedRouteId ?? null };
    aps["input-push-token"] = 1;
  }
  // Never an `alert` (Requirement 8.4).
  return aps;
}

export interface ApnsHeaders {
  readonly topic: string;
  readonly pushType: string;
  readonly priority: "5" | "10";
}

/** Push type and topic come from the kind registry, never from the client. */
export function apnsHeadersFor(kind: Kind, priority: PushPriority, bundleId: string): ApnsHeaders {
  const k = KINDS[kind];
  return {
    topic: `${bundleId}${k.topicSuffix}`,
    pushType: k.pushType,
    priority: priority === "high" ? "10" : "5",
  };
}

/** `JSON.stringify({ aps })`, refusing anything over the APNs payload ceiling. */
export function serializeApsPayload(aps: ApsPayload): string {
  const payload = JSON.stringify({ aps });
  if (Buffer.byteLength(payload, "utf8") > MAX_APS_PAYLOAD_BYTES) {
    throw new Error("APNs payload exceeds 4096 bytes");
  }
  return payload;
}
