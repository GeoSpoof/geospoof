/**
 * Location-precision cadence: how often approximate mode draws a new point.
 *
 * The point a page sees is a pure function of the settings and one period key
 * owned by the background:
 *
 *   point      = applyPrecisionOffset(anchor, effectivePrecision, periodSeed)
 *   periodSeed = cadence === "never" ? precisionSeed
 *                                    : derivePeriodSeed(precisionSeed, { cadence, index })
 *
 * `index` is a per-session random id (session) or a time bucket (hour / day).
 * Under `never` there is no key, and {@link resolvePageLocation} evaluates
 * today's expression token for token.
 *
 * Every export is PURE: no I/O, no `browser`, and no clock reads. Callers pass
 * `Date.now()` (epoch ms) in, never `performance.now()`, which resets on every
 * background spawn. `offset.ts` is deliberately left untouched.
 */

import type { Location, PrecisionCadence, Settings } from "@/shared/types/settings";
import { applyPrecisionOffset, computeEffectiveLocationPrecision } from "@/shared/precision/offset";

/** Every valid cadence, in popup order. */
export const PRECISION_CADENCES = ["never", "session", "hour", "day"] as const;

/** Repair any stored or received cadence: anything unrecognized becomes `"never"`. */
export function validatePrecisionCadence(v: unknown): PrecisionCadence {
  return typeof v === "string" && (PRECISION_CADENCES as readonly string[]).includes(v)
    ? (v as PrecisionCadence)
    : "never";
}

/** Cadences whose period is a clock bucket. */
export type TimeCadence = "hour" | "day";

/** The period a draw belongs to. `never` has no period. */
export interface PeriodKey {
  cadence: Exclude<PrecisionCadence, "never">;
  index: number;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export const isTimeCadence = (c: PrecisionCadence): c is TimeCadence => c === "hour" || c === "day";

export const periodMs = (c: TimeCadence): number => (c === "hour" ? HOUR_MS : DAY_MS);

/**
 * xmur3 string hash + one mulberry32 step → uint32. The same mixing as
 * `offsetHash01`, without the final `/ 2^32`, inlined so `offset.ts` stays
 * unmodified.
 */
export function cadenceHash32(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;

  let t = (h + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/** The seed handed to `applyPrecisionOffset` for one period. */
export function derivePeriodSeed(precisionSeed: number, key: PeriodKey): number {
  return cadenceHash32(`gs-cadence-v1|${precisionSeed}|${key.cadence}|${key.index}`);
}

/**
 * Per-install offset of the bucket boundaries, in `[0, P)`. Its own domain tag,
 * so it's independent of the draw and of `offsetHash01`'s key.
 */
export function phaseMs(precisionSeed: number, P: number): number {
  const u = cadenceHash32(`gs-phase-v1|${precisionSeed}|${P}`) / 4294967296;
  return Math.min(P - 1, Math.floor(u * P));
}

/** Bucket index for `nowMs` (epoch ms) with the given phase and period. */
export function timeBucket(nowMs: number, phase: number, P: number): number {
  return Math.floor((nowMs - phase) / P);
}

/** The clock's bucket for a time cadence and seed. */
export function clockBucket(c: TimeCadence, seed: number, nowMs: number): number {
  return timeBucket(nowMs, phaseMs(seed, periodMs(c)), periodMs(c));
}

/** Epoch ms at which bucket `index` ends and `index + 1` begins. */
export function nextBoundaryMs(c: TimeCadence, seed: number, index: number): number {
  return (index + 1) * periodMs(c) + phaseMs(seed, periodMs(c));
}

export type PageLocationSettings = Pick<
  Settings,
  "location" | "locationPrecision" | "precisionSeed" | "proFeaturesBlocked"
>;

/**
 * THE resolver for the location delivered to pages. `period === null` is
 * today's expression, token for token. Exact mode and the Safari Pro gate come
 * from `computeEffectiveLocationPrecision` / `resolveReportedLocation`, so they
 * beat any cadence.
 */
export function resolvePageLocation(
  s: PageLocationSettings,
  period: PeriodKey | null
): Location | null {
  const precision = computeEffectiveLocationPrecision(s.locationPrecision, s.proFeaturesBlocked);
  const seed = period === null ? s.precisionSeed : derivePeriodSeed(s.precisionSeed, period);
  return applyPrecisionOffset(s.location, precision, seed);
}
