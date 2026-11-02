/**
 * Pure/near-pure timezone utility functions.
 * No side effects on global objects — uses OriginalDateTimeFormat from state
 * to avoid self-interference with the spoofed DateTimeFormat constructor.
 */

import type { TimezoneData } from "./types";
import {
  OriginalDate,
  OriginalDateTimeFormat,
  originalGetTimezoneOffset,
  originalResolvedOptions,
  engineTimezoneMode,
} from "./state";
import { createLogger } from "@/shared/utils/debug-logger";

const logger = createLogger("INJ");

/**
 * Resolve the REAL system IANA timezone id via the native (pre-override)
 * Intl.DateTimeFormat, cached for the lifetime of the realm. Used to compute the
 * real system offset at full sub-minute precision (see computeEpochAdjustment),
 * independent of the spoofed timezone. Falls back to "UTC" if resolution fails.
 *
 * "Real" means the zone the engine itself uses for local time. In Engine-level
 * Spoofing that can change under the realm (an override that lands or changes
 * after this was cached), so `computeEpochAdjustment` re-checks it there.
 */
let _realTimeZoneId: string | undefined;
function getRealTimeZoneId(): string {
  if (_realTimeZoneId !== undefined) return _realTimeZoneId;
  try {
    _realTimeZoneId = originalResolvedOptions.call(new OriginalDateTimeFormat()).timeZone;
  } catch {
    _realTimeZoneId = "UTC";
  }
  return _realTimeZoneId;
}

/**
 * Whether this realm's engine already reports `id` as its own zone: the native
 * default `DateTimeFormat` resolves to the same zone as one built for `id`.
 * Both sides go through the engine's own canonicalization, so an alias
 * (`Asia/Calcutta` / `Asia/Kolkata`) compares equal. In Engine-level Spoofing a
 * realm where this holds keeps native Date/Intl; one where it doesn't (a
 * cross-site iframe in its own process, an override that hasn't landed)
 * installs the injected overrides. False on any error.
 */
export function engineReportsZone(id: string): boolean {
  try {
    const own = originalResolvedOptions.call(new OriginalDateTimeFormat()).timeZone;
    const wanted = originalResolvedOptions.call(
      new OriginalDateTimeFormat("en-US", { timeZone: id })
    ).timeZone;
    return own === wanted;
  } catch {
    return false;
  }
}

/** Validate that an unknown value conforms to the TimezoneData interface. */
export function validateTimezoneData(tz: unknown): tz is TimezoneData {
  if (!tz || typeof tz !== "object") {
    return false;
  }

  const t = tz as Partial<TimezoneData>;

  if (typeof t.identifier !== "string" || t.identifier.length === 0) {
    logger.error("Invalid timezone identifier:", t.identifier);
    return false;
  }

  if (typeof t.offset !== "number" || !Number.isFinite(t.offset)) {
    logger.error("Invalid timezone offset:", t.offset);
    return false;
  }

  if (typeof t.dstOffset !== "number" || !Number.isFinite(t.dstOffset)) {
    logger.error("Invalid timezone dstOffset:", t.dstOffset);
    return false;
  }

  return true;
}

/** Resolved date/time components from native `formatToParts` for a spoofed timezone. */
export interface ResolvedDateParts {
  year: number; // Full year (e.g., 1879, 2025)
  month: number; // 1-indexed (1=January)
  day: number; // Day of month (1-31)
  weekday: string; // Short weekday name ("Sun", "Mon", ...)
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
}

/** Map short weekday names from formatToParts to numeric 0-6 (0=Sunday). */
export const WEEKDAY_TO_NUMBER: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// ── Single-entry cache for resolvePartsForDate ───────────────────────
let _partsCacheEpoch = NaN;
let _partsCacheTz = "";
let _partsCacheValue: ResolvedDateParts | undefined;

/**
 * Resolve date/time components via native `formatToParts` for the given
 * date and IANA timezone. Returns `undefined` for invalid dates (NaN epoch)
 * so callers can fall back to original methods.
 *
 * Uses a single-entry cache keyed by (epoch-ms, timezone-id) — optimal for
 * the dominant pattern of multiple getters called on the same Date instance.
 */
export function resolvePartsForDate(date: Date, timezoneId: string): ResolvedDateParts | undefined {
  const epoch = date.getTime();
  if (isNaN(epoch)) return undefined;

  if (epoch === _partsCacheEpoch && timezoneId === _partsCacheTz) {
    logger.trace("resolvePartsForDate: cache hit", timezoneId);
    return _partsCacheValue;
  }

  const fmt = new OriginalDateTimeFormat("en-US", {
    timeZone: timezoneId,
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });

  const parts = fmt.formatToParts(date);

  let year = 0,
    month = 0,
    day = 0,
    hour = 0,
    minute = 0,
    second = 0;
  let weekday = "";

  for (const p of parts) {
    switch (p.type) {
      case "year":
        year = parseInt(p.value, 10);
        break;
      case "month":
        month = parseInt(p.value, 10);
        break;
      case "day":
        day = parseInt(p.value, 10);
        break;
      case "weekday":
        weekday = p.value;
        break;
      case "hour":
        hour = parseInt(p.value, 10);
        break;
      case "minute":
        minute = parseInt(p.value, 10);
        break;
      case "second":
        second = parseInt(p.value, 10);
        break;
    }
  }

  // hour12:false with en-US can produce "24" for midnight — normalize to 0
  if (hour === 24) hour = 0;

  const result: ResolvedDateParts = { year, month, day, weekday, hour, minute, second };

  logger.trace("resolvePartsForDate:", epoch, timezoneId, year, month, day, hour, minute, second);

  _partsCacheEpoch = epoch;
  _partsCacheTz = timezoneId;
  _partsCacheValue = result;

  return result;
}
/**
 * Derive the UTC offset (in minutes, positive = east of UTC) for a given date
 * and IANA timezone using the same `formatToParts` path that the component
 * getters use. This ensures `getTimezoneOffset` and `getHours`/`getDate`/etc.
 * are always derived from the exact same native resolution, producing
 * consistent fingerprints on both Chrome and Firefox.
 *
 * Algorithm (same as TZP's "components" offset):
 *   1. Get local wall-clock components via `formatToParts` in the spoofed tz
 *   2. Construct a UTC date from those components
 *   3. offset = (localAsUTC - originalEpoch) / 60000
 *
 * Returns `undefined` for invalid dates (NaN epoch).
 */
export function deriveOffsetFromParts(date: Date, timezoneId: string): number | undefined {
  const epoch = date.getTime();
  if (isNaN(epoch)) return undefined;

  const parts = resolvePartsForDate(date, timezoneId);
  if (!parts) return undefined;

  // Construct a UTC date from the local wall-clock components.
  // Date.UTC expects 0-indexed month.
  const localAsUTC = OriginalDate.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  // Strip sub-second precision from the epoch since formatToParts only
  // resolves to whole seconds. Without this, milliseconds in the original
  // epoch would produce fractional-minute offsets for modern timezones
  // that should have clean whole-minute offsets.
  const epochSeconds = Math.floor(epoch / 1000) * 1000;

  // The difference between the local-as-UTC epoch and the real UTC epoch
  // gives us the offset in milliseconds. Convert to minutes.
  const offsetMinutes = (localAsUTC - epochSeconds) / 60000;
  logger.trace(
    "deriveOffsetFromParts:",
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    localAsUTC,
    epochSeconds,
    offsetMinutes
  );
  return offsetMinutes;
}

/** Parse a GMT offset string like "GMT+5:30" or "GMT-8" into fractional minutes from UTC.
 *  Returns exact fractional minutes for sub-minute offsets (e.g. "GMT+9:18:59" → 558.9833...).
 *  This matches native getTimezoneOffset() behavior which returns fractional values for
 *  historical sub-minute LMT offsets. */
export function parseGMTOffset(gmtString: string): number {
  if (gmtString === "GMT" || gmtString === "UTC") {
    return 0;
  }

  // Handle GMT±H:MM:SS (historical sub-minute offsets like GMT+0:53:28)
  // as well as the standard GMT±H:MM and GMT±H formats.
  const match = gmtString.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/);
  if (!match) {
    return 0;
  }

  const sign = match[1] === "+" ? 1 : -1;
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3] || "0", 10);
  const seconds = parseInt(match[4] || "0", 10);
  // Return exact fractional minutes to match native getTimezoneOffset() behavior.
  // Native engines return fractional values like -558.9833... for +9:18:59.
  return sign * (hours * 60 + minutes + seconds / 60);
}

/**
 * Resolve the actual UTC offset for a given date and IANA timezone using
 * Intl.DateTimeFormat. Returns offset in minutes from UTC (positive = east).
 * Falls back to the stored timezone.offset on any error.
 *
 * Results are cached per (epoch, timezoneId) to guarantee that repeated calls
 * for the same date always return the same offset. This is critical on Chrome
 * where the Intl engine can return non-deterministic shortOffset strings for
 * historical sub-minute LMT offsets (e.g., GMT+9:18:59 on one call vs
 * GMT+9:18:57 on the next for the same UTC instant in Asia/Tokyo 1879).
 */
let _offsetCacheEpoch = NaN;
let _offsetCacheTz = "";
let _offsetCacheValue = 0;

export function getIntlBasedOffset(date: Date, timezoneId: string, fallbackOffset: number): number {
  const epoch = date.getTime();
  if (epoch === _offsetCacheEpoch && timezoneId === _offsetCacheTz) {
    logger.trace("getIntlBasedOffset: cache hit", _offsetCacheValue);
    return _offsetCacheValue;
  }
  try {
    const formatter = new OriginalDateTimeFormat("en-US", {
      timeZone: timezoneId,
      timeZoneName: "shortOffset",
    });
    const parts = formatter.formatToParts(date);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    const result = parseGMTOffset(tzPart?.value ?? "GMT");
    logger.trace("getIntlBasedOffset:", epoch, timezoneId, tzPart?.value ?? "GMT", result);
    _offsetCacheEpoch = epoch;
    _offsetCacheTz = timezoneId;
    _offsetCacheValue = result;
    return result;
  } catch {
    // Invalid IANA identifier or unsupported environment — use fallback
    logger.warn("getIntlBasedOffset: fallback", timezoneId, fallbackOffset);
    return fallbackOffset;
  }
}

/**
 * Compute the local time in the spoofed timezone by shifting the UTC epoch
 * by the Intl-based offset. Returns a Date whose UTC methods give the
 * wall-clock time in the spoofed timezone.
 *
 * This is the same offset used by getTimezoneOffset, guaranteeing consistency
 * across all Date API overrides.
 */
export function getLocalDateViaOffset(
  date: Date,
  timezoneId: string,
  fallbackOffset: number
): Date {
  const offsetMinutes = getIntlBasedOffset(date, timezoneId, fallbackOffset);
  return new OriginalDate(date.getTime() + offsetMinutes * 60000);
}

/** Convert an offset in minutes east of UTC to a `GMT±HHMM` string.
 *  Prints whole minutes truncated toward zero, with the sign of the truncated
 *  value, as every engine's native toString() does (V8 date.cc, SpiderMonkey
 *  jsdate.cpp, JavaScriptCore DateConversion.cpp): 1879 Tokyo, +9:18:59, prints
 *  GMT+0918, even on engines whose getTimezoneOffset keeps the seconds. */
export function formatGMTOffset(offsetMinutes: number): string {
  const whole = Math.trunc(offsetMinutes);
  const sign = whole < 0 ? "-" : "+";
  const abs = Math.abs(whole);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `GMT${sign}${String(hours).padStart(2, "0")}${String(minutes).padStart(2, "0")}`;
}

/** Extract the long timezone name (e.g. "Pacific Daylight Time") for a date and IANA tz. */
export function getLongTimezoneName(date: Date, timezoneId: string): string {
  try {
    const formatter = new OriginalDateTimeFormat("en-US", {
      timeZone: timezoneId,
      timeZoneName: "long",
    });
    const parts = formatter.formatToParts(date);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    return tzPart?.value ?? timezoneId;
  } catch {
    return timezoneId;
  }
}

// ── Date constructor helpers ─────────────────────────────────────────

/**
 * Determine if a date string lacks an explicit timezone indicator.
 * Returns true if the string is "ambiguous" (no tz info), meaning
 * the JS engine will parse it using the local timezone.
 *
 * Explicit indicators: Z, UTC, GMT, ±HH:MM, ±HHMM, ±HH (at end)
 * ISO 8601 date-only (e.g. "2024-01-15") is treated as explicit (UTC per spec).
 */
export function isAmbiguousDateString(str: string): boolean {
  // ISO 8601 date-only: YYYY-MM-DD with no time component → UTC per ECMAScript spec
  if (/^\d{4}-\d{2}-\d{2}$/.test(str.trim())) {
    return false;
  }

  // Check for explicit timezone indicators
  const hasExplicitTz =
    // Trailing Z (UTC designator) — e.g. "2024-01-15T12:00:00Z"
    /Z$/i.test(str.trim()) ||
    // UTC or GMT keywords (case-insensitive)
    /\b(?:UTC|GMT)\b/i.test(str) ||
    // ±HH:MM, ±HHMM, or ±HH at end of string
    /[+-]\d{2}(?::?\d{2})?$/.test(str.trim());

  return !hasExplicitTz;
}

/**
 * Compute the epoch adjustment in milliseconds to shift a timestamp
 * from real-local-time interpretation to spoofed-local-time interpretation.
 *
 * The algorithm resolves the spoofed offset at the correct UTC instant
 * (the wall-clock time interpreted in the spoofed timezone) and then
 * verifies the offset at the *final* adjusted epoch, iterating until
 * stable. This guarantees that `getUTC*` component differences on the
 * adjusted date exactly match what `getTimezoneOffset` reports, even
 * for historical dates with sub-minute LMT offsets where Chrome's Intl
 * engine may return slightly different shortOffset strings for nearby
 * UTC instants.
 *
 * @param parsedDate - Date object parsed in real local time
 * @param timezoneId - Spoofed IANA timezone identifier
 * @param fallbackOffset - Fallback offset from timezoneData (minutes, positive = east)
 * @returns adjustment in milliseconds (add to epoch)
 */
export function computeEpochAdjustment(
  parsedDate: Date,
  timezoneId: string,
  fallbackOffset: number
): number {
  // (a) Real system offset in minutes (positive = west of UTC, getTimezoneOffset
  //     convention), resolved at FULL sub-minute precision.
  //
  //     We cannot use getTimezoneOffset() here: V8 before Chrome 156 and
  //     JavaScriptCore truncate sub-minute historical LMT offsets to a whole
  //     minute in it, while the native Date constructor (which produced
  //     parsedDate.getTime()) uses the full-precision offset. Mixing the two
  //     leaks the dropped fraction into the adjustment —
  //     e.g. spoofing America/Sao_Paulo (LMT -3:06:28) from a machine also in
  //     Sao_Paulo produced 186.9333 instead of the native 186.4667. Resolving the
  //     real offset via Intl (same shortOffset path as the spoofed offset) keeps
  //     both sides at the same precision so the fraction cancels correctly.
  const realEastFallback = -originalGetTimezoneOffset.call(parsedDate);
  let realOffset = -getIntlBasedOffset(parsedDate, getRealTimeZoneId(), realEastFallback);
  // Engine-level Spoofing can change the engine's zone after the realm cached
  // it (a CDP override that lands after this realm installed the injected
  // overrides). Native getTimezoneOffset always follows the engine, and it
  // differs from the cached zone's offset by under a minute only through
  // truncation, so a gap of a minute or more means the cache is stale.
  // (`realOffset` is positive-west, `realEastFallback` positive-east.)
  if (engineTimezoneMode && Math.abs(realOffset + realEastFallback) >= 1) {
    _realTimeZoneId = undefined;
    realOffset = -getIntlBasedOffset(parsedDate, getRealTimeZoneId(), realEastFallback);
  }

  // (b) Compute the wall-clock time as a UTC epoch.
  //     parsedDate.getTime() is the UTC instant the browser chose when parsing
  //     the ambiguous string in the real local timezone. Adding realOffset * 60000
  //     "undoes" the real timezone interpretation, giving us the raw wall-clock epoch.
  const utcEpoch = parsedDate.getTime() + realOffset * 60000;

  try {
    // (c) Create a probe date at the estimated UTC instant for the spoofed timezone.
    //     fallbackOffset is positive-east (Intl convention), so subtract it to go from
    //     wall-clock to UTC in the spoofed timezone.
    const probeDate = new OriginalDate(utcEpoch - fallbackOffset * 60000);

    logger.trace(
      "computeEpochAdjustment: inputs",
      realOffset,
      utcEpoch,
      probeDate.getTime(),
      fallbackOffset
    );

    // (d) Resolve the actual spoofed offset at the probe instant (positive = east).
    let spoofedOffset = getIntlBasedOffset(probeDate, timezoneId, fallbackOffset);

    // (e) Refine for DST boundary crossings: if the resolved offset differs
    //     from our initial estimate, the probe was at the wrong instant. Re-probe
    //     with the corrected offset.
    if (spoofedOffset !== fallbackOffset) {
      const refinedProbe = new OriginalDate(utcEpoch - spoofedOffset * 60000);
      const originalOffset = spoofedOffset;
      spoofedOffset = getIntlBasedOffset(refinedProbe, timezoneId, fallbackOffset);
      logger.debug("computeEpochAdjustment: DST refinement", originalOffset, spoofedOffset);
    }

    // (f) Every engine's native Date constructor interprets ambiguous local-time
    //     inputs using the FULL sub-minute offset (only getTimezoneOffset() may
    //     truncate, on a separate code path). Keeping full precision here makes
    //     the epoch — and therefore getTime/valueOf/Date.parse/component arithmetic —
    //     match what a real browser in the spoofed zone reports (e.g. Asia/Tokyo 1879
    //     resolves to -558.9833, not -558 or -560). getTimezoneOffset's per-engine
    //     truncation is applied only in its own override, not here.
    return Math.round((-spoofedOffset - realOffset) * 60000);
  } catch {
    // Fall back to a simple adjustment using the fallback offset on any error.
    const adjustment = Math.round((-fallbackOffset - realOffset) * 60000);
    logger.warn("computeEpochAdjustment: fallback", fallbackOffset, adjustment);
    return adjustment;
  }
}
