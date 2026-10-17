/**
 * Location-precision cadence: the background-owned period state.
 *
 * Under a non-Never cadence the point a page sees depends on one period key
 * (see `shared/precision/cadence.ts`). This module owns that key:
 *
 *   - session → a random uint32 id kept in `storage.session`, minted the first
 *               time it's needed. A failed read never mints-and-writes, so a
 *               transient failure can't replace the current session.
 *   - hour/day → a HELD time bucket. It advances only in the rollover handler
 *               (`onPrecisionRolloverAlarm` in index.ts), which then pushes to
 *               every tab, so every reply, push, and bootstrap registration
 *               between rollovers uses the same bucket. Mirrored in
 *               `storage.session` so it survives service-worker restarts.
 *
 * It also owns the one-shot `precision-rollover` alarm, through a single
 * serialized scheduling queue whose jobs read settings when they run.
 *
 * Deliberately imports neither `./settings` nor `./tabs` (both would close an
 * import cycle); callers pass a settings loader where fresh settings are needed.
 * All time math uses `Date.now()` (epoch ms), never `performance.now()`.
 */

import type { PrecisionCadence, Settings } from "@/shared/types/settings";
import { createLogger } from "@/shared/utils/debug-logger";
import { computeEffectiveLocationPrecision } from "@/shared/precision/offset";
import {
  clockBucket,
  isTimeCadence,
  nextBoundaryMs,
  resolvePageLocation,
  validatePrecisionCadence,
  type PageLocationSettings,
  type PeriodKey,
  type TimeCadence,
} from "@/shared/precision/cadence";
import { sessionRead, sessionSet, type SessionReadResult } from "./session-cache";

const logger = createLogger("BG");

/** Name of the one-shot alarm that marks the next hour/day boundary. */
export const PRECISION_ROLLOVER_ALARM = "precision-rollover";

/** Stored by session-cache as `cache:precisionCadence:session`. */
const SESSION_KEY = "precisionCadence:session";
/** Stored by session-cache as `cache:precisionCadence:bucket`. */
const BUCKET_KEY = "precisionCadence:bucket";

/**
 * An existing alarm this far past its `scheduledTime` was missed or is stuck,
 * so a spawn runs the rollover itself. Well above Chrome's 30 s alarm clamp, so
 * a normal catch-up never trips it.
 */
export const OVERDUE_GRACE_MS = 120_000;

interface HeldBucket {
  cadence: TimeCadence;
  seed: number;
  index: number;
}

type CadenceSettings = Pick<Settings, "precisionCadence" | "precisionSeed">;

/** Loader injected by callers so this module never imports `./settings`. */
export type LoadCadenceSettings = () => Promise<CadenceSettings>;

/** This spawn's held hour/day period. */
let held: HeldBucket | null = null;
/** Dedupes concurrent first reads of the bucket record only; clears on settle. */
let bucketInflight: Promise<SessionReadResult<unknown>> | null = null;
let sessionIdP: Promise<number> | null = null;
/** Used only while `storage.session` reads fail; never persisted. */
let fallbackSessionId: number | null = null;
/** One WARN per spawn for failed reads. */
let warnedRead = false;
/** Serializes every alarm write. */
let scheduleQueue: Promise<void> = Promise.resolve();

const heldFor = (c: TimeCadence, seed: number): number | null =>
  held && held.cadence === c && held.seed === seed ? held.index : null;

/**
 * The location delivered to pages, for every page-bound builder. Exact mode and
 * a missing location short-circuit before any period I/O; their output doesn't
 * depend on the seed.
 */
export async function resolveCurrentPageLocation(
  s: PageLocationSettings & CadenceSettings
): Promise<Settings["location"]> {
  const p = computeEffectiveLocationPrecision(s.locationPrecision, s.proFeaturesBlocked);
  if (!s.location || p.mode !== "approximate") return resolvePageLocation(s, null);
  return resolvePageLocation(s, await getCurrentPeriod(s));
}

/** The current period key, or `null` under Never (and any stray value). */
export async function getCurrentPeriod(
  s: CadenceSettings,
  nowMs = Date.now()
): Promise<PeriodKey | null> {
  switch (validatePrecisionCadence(s.precisionCadence)) {
    case "session":
      return { cadence: "session", index: await getSessionId() };
    case "hour":
      return { cadence: "hour", index: await getHeldBucket("hour", s.precisionSeed, nowMs) };
    case "day":
      return { cadence: "day", index: await getHeldBucket("day", s.precisionSeed, nowMs) };
    default:
      return null;
  }
}

async function getHeldBucket(c: TimeCadence, seed: number, now: number): Promise<number> {
  const known = heldFor(c, seed);
  if (known !== null) return known;
  const r = await (bucketInflight ??= sessionRead<unknown>(BUCKET_KEY).finally(() => {
    bucketInflight = null;
  }));
  // A concurrent caller may have set `held` while this one awaited.
  const raced = heldFor(c, seed);
  if (raced !== null) return raced;
  if (!r.ok) {
    // Degraded: use the clock, but hold and write nothing.
    warnReadOnce();
    return clockBucket(c, seed, now);
  }
  const stored = parseHeldBucket(r.value);
  if (stored && stored.cadence === c && stored.seed === seed) {
    held = stored;
    return stored.index;
  }
  return setHeld({ cadence: c, seed, index: clockBucket(c, seed, now) });
}

async function setHeld(h: HeldBucket): Promise<number> {
  // Synchronous, so concurrent callers see it immediately.
  held = h;
  // Existing helper: WARNs, never throws.
  await sessionSet(BUCKET_KEY, h);
  return h.index;
}

/**
 * The only forward move of the held bucket. Returns whether tabs need a push.
 * An absent record hydrates to the clock bucket (no frame has seen another
 * value), so no push. A failed read leaves the period unknown, so it pushes.
 */
export async function advanceHeldBucketToClock(
  c: TimeCadence,
  seed: number,
  now = Date.now()
): Promise<boolean> {
  const target = clockBucket(c, seed, now);
  await getHeldBucket(c, seed, now);
  // No await between this check and setHeld's synchronous assignment, so two
  // concurrent handlers can't both report a change for the same target.
  if (heldFor(c, seed) === target) return false;
  await setHeld({ cadence: c, seed, index: target });
  return true;
}

/** The user switched to a time cadence: start from the clock, ignoring any held or stored bucket. */
export function adoptClockBucket(c: TimeCadence, seed: number, now = Date.now()): Promise<number> {
  return setHeld({ cadence: c, seed, index: clockBucket(c, seed, now) });
}

function getSessionId(): Promise<number> {
  return (sessionIdP ??= loadSessionId());
}

async function loadSessionId(): Promise<number> {
  const r = await sessionRead<unknown>(SESSION_KEY);
  if (!r.ok) {
    // Never mint-and-write after a failed read; retry on the next call.
    sessionIdP = null;
    warnReadOnce();
    return (fallbackSessionId ??= random32());
  }
  if (isUint32(r.value)) return r.value;
  // Absent or corrupt, and the read succeeded: mint. A failed write keeps the
  // id for this spawn only.
  const id = random32();
  await sessionSet(SESSION_KEY, id);
  return id;
}

function random32(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

function warnReadOnce(): void {
  if (warnedRead) return;
  warnedRead = true;
  logger.warn("[cadence] storage.session read failed");
}

function isUint32(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 4294967296;
}

function parseHeldBucket(v: unknown): HeldBucket | null {
  if (!v || typeof v !== "object") return null;
  const r = v as { cadence?: unknown; seed?: unknown; index?: unknown };
  if (r.cadence !== "hour" && r.cadence !== "day") return null;
  if (typeof r.seed !== "number" || !Number.isFinite(r.seed)) return null;
  if (typeof r.index !== "number" || !Number.isSafeInteger(r.index)) return null;
  return { cadence: r.cadence, seed: r.seed, index: r.index };
}

/**
 * The sole alarm writer. Serialized, and each job schedules from what `load`
 * returns when the job runs, so a late caller's stale snapshot can't win. Never
 * rejects.
 */
export function reschedulePrecisionRollover(load: LoadCadenceSettings): Promise<void> {
  const run = scheduleQueue.then(async () => {
    try {
      await scheduleFrom(await load());
    } catch (error) {
      logger.warn("[cadence] could not schedule rollover:", error);
    }
  });
  // `run` never rejects, so the queue never wedges.
  scheduleQueue = run;
  return run;
}

async function scheduleFrom(s: CadenceSettings): Promise<void> {
  const c: PrecisionCadence = validatePrecisionCadence(s.precisionCadence);
  if (!isTimeCadence(c)) {
    await browser.alarms.clear(PRECISION_ROLLOVER_ALARM);
    return;
  }
  const index = await getHeldBucket(c, s.precisionSeed, Date.now());
  // A held bucket behind the clock makes this a catch-up alarm ~1 s out.
  const when = Math.max(nextBoundaryMs(c, s.precisionSeed, index), Date.now() + 1000);
  // Replaces any existing alarm with the same name.
  await browser.alarms.create(PRECISION_ROLLOVER_ALARM, { when });
}

/**
 * Spawn check. Under a time cadence, makes sure the rollover alarm exists, and
 * returns `true` when an existing one is overdue (missed or stuck) so the caller
 * runs the rollover handler, whose reschedule replaces it. A healthy alarm is
 * left alone. Never rejects.
 */
export async function ensurePrecisionRollover(
  s: CadenceSettings,
  load: LoadCadenceSettings
): Promise<boolean> {
  if (!isTimeCadence(validatePrecisionCadence(s.precisionCadence))) return false;
  let existing: browser.alarms.Alarm | undefined;
  try {
    existing = await browser.alarms.get(PRECISION_ROLLOVER_ALARM);
  } catch {
    existing = undefined;
  }
  if (!existing) {
    await reschedulePrecisionRollover(load);
    return false;
  }
  return (
    Number.isFinite(existing.scheduledTime) &&
    existing.scheduledTime < Date.now() - OVERDUE_GRACE_MS
  );
}

/** Tests only: reset all module state, as a fresh background spawn would. */
export function _resetPrecisionCadenceState(): void {
  held = null;
  bucketInflight = null;
  sessionIdP = null;
  fallbackSessionId = null;
  warnedRead = false;
  scheduleQueue = Promise.resolve();
}
