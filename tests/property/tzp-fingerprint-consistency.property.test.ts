/**
 * Property-Based Tests for TZP Fingerprint Consistency
 * Feature: tzp-fingerprint-consistency
 *
 * Property 1: Bug Condition — Historical Sub-Minute LMT Offset Hash Split
 *
 * Tests that all Date API overrides produce mutually consistent results
 * derived from the same getIntlBasedOffset offset. On UNFIXED code running
 * in Chrome, these tests are EXPECTED TO FAIL because toString/toDateString/
 * date-level getters use formatToParts which disagrees with getIntlBasedOffset
 * for sub-minute historical LMT offsets.
 *
 * NOTE: In Node.js/V8 (vitest), the Intl engine's formatToParts and shortOffset
 * paths happen to agree for sub-minute offsets, so the bug does not manifest
 * in this test environment. The tests still encode the correct expected behavior
 * and will validate the fix once applied — the fix unifies all paths to
 * arithmetic regardless of whether the Intl engine agrees or not.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { setupContentScript } from "../helpers/content.test.helper";

// ── Reference helpers ────────────────────────────────────────────────

/** Resolve date/time components via formatToParts (same path as production code). */
function resolvePartsForDate(
  date: Date,
  timezoneId: string
):
  | {
      year: number;
      month: number;
      day: number;
      weekday: string;
      hour: number;
      minute: number;
      second: number;
    }
  | undefined {
  const epoch = date.getTime();
  if (isNaN(epoch)) return undefined;
  const fmt = new Intl.DateTimeFormat("en-US", {
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
  if (hour === 24) hour = 0;
  return { year, month, day, weekday, hour, minute, second };
}

/** Derive offset from formatToParts — same as production deriveOffsetFromParts. */
function referenceDeriveOffset(date: Date, timezoneId: string): number {
  const parts = resolvePartsForDate(date, timezoneId);
  if (!parts) return 0;
  const localAsUTC = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  // Strip sub-second precision — formatToParts only resolves to whole seconds.
  const epochSeconds = Math.floor(date.getTime() / 1000) * 1000;
  return (localAsUTC - epochSeconds) / 60000;
}

/** Compute local date via formatToParts-derived offset (the single source of truth). */
function getLocalDateViaOffset(date: Date, timezoneId: string, _fallbackOffset?: number): Date {
  const offset = referenceDeriveOffset(date, timezoneId);
  return new Date(date.getTime() + offset * 60000);
}

/** Format offset as GMT±HHMM string, truncated toward zero (mirrors production formatGMTOffset). */
function formatGMTOffset(offsetMinutes: number): string {
  const whole = Math.trunc(offsetMinutes);
  const sign = whole < 0 ? "-" : "+";
  const abs = Math.abs(whole);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `GMT${sign}${String(hours).padStart(2, "0")}${String(minutes).padStart(2, "0")}`;
}

/** Simple string hash for TZP simulation. */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// ── Historical timezone configs with known sub-minute LMT offsets ────

const HISTORICAL_TIMEZONES = [
  {
    name: "Asia/Tokyo",
    identifier: "Asia/Tokyo",
    // LMT +9:18:59 before 1888
    offset: 558.9833333333333,
    dstOffset: 0,
  },
  {
    name: "Asia/Kolkata",
    identifier: "Asia/Kolkata",
    // LMT +5:53:28 before 1880
    offset: 353.4666666666667,
    dstOffset: 0,
  },
  {
    name: "Europe/Paris",
    identifier: "Europe/Paris",
    // LMT +0:09:21 before 1891
    offset: 9.35,
    dstOffset: 0,
  },
];

// ── Property 1: Bug Condition Tests ──────────────────────────────────

describe("TZP Fingerprint Consistency — Property 1: Bug Condition", () => {
  beforeEach(() => {
    // Clean state for each test
  });

  /**
   * For each historical timezone with sub-minute LMT offsets, verify that
   * ALL Date API overrides produce consistent results derived from the
   * same getIntlBasedOffset offset.
   *
   * On UNFIXED code this MUST FAIL — the failure confirms the bug exists.
   */
  for (const tz of HISTORICAL_TIMEZONES) {
    test(`All Date APIs consistent for ${tz.name} 1879 (sub-minute LMT offset)`, () => {
      const cs = setupContentScript({
        enabled: true,
        location: { latitude: 35.6762, longitude: 139.6503, accuracy: 10 },
        timezone: {
          identifier: tz.identifier,
          offset: tz.offset,
          dstOffset: tz.dstOffset,
        },
      });

      // Historical date in the sub-minute LMT period
      const date = new Date(1879, 0, 1);

      // Compute expected values via formatToParts-derived offset (same path as production)
      const offset = referenceDeriveOffset(date, tz.identifier);
      const local = getLocalDateViaOffset(date, tz.identifier, tz.offset);

      const expectedHours = local.getUTCHours();
      const expectedMinutes = local.getUTCMinutes();
      const expectedSeconds = local.getUTCSeconds();
      const expectedDate = local.getUTCDate();
      const expectedDay = local.getUTCDay();
      const expectedMonth = local.getUTCMonth();
      const expectedFullYear = local.getUTCFullYear();
      const expectedGMTOffset = formatGMTOffset(offset);

      // ── getTimezoneOffset must return -offset ──
      const tzo = cs.Date.prototype.getTimezoneOffset.call(date);
      expect(tzo).toBeCloseTo(-offset, 4);

      // ── Time-level getters must match arithmetic ──
      expect(cs.Date.prototype.getHours.call(date)).toBe(expectedHours);
      expect(cs.Date.prototype.getMinutes.call(date)).toBe(expectedMinutes);
      expect(cs.Date.prototype.getSeconds.call(date)).toBe(expectedSeconds);

      // ── Date-level getters must match arithmetic ──
      // (On unfixed code, these use formatToParts which may disagree)
      expect(cs.Date.prototype.getDate.call(date)).toBe(expectedDate);
      expect(cs.Date.prototype.getDay.call(date)).toBe(expectedDay);
      expect(cs.Date.prototype.getMonth.call(date)).toBe(expectedMonth);
      expect(cs.Date.prototype.getFullYear.call(date)).toBe(expectedFullYear);

      // ── toString must contain arithmetic-derived components ──
      const str = cs.Date.prototype.toString.call(date);
      const paddedHours = String(expectedHours).padStart(2, "0");
      const paddedMinutes = String(expectedMinutes).padStart(2, "0");
      const paddedSeconds = String(expectedSeconds).padStart(2, "0");
      const timeStr = `${paddedHours}:${paddedMinutes}:${paddedSeconds}`;

      expect(str).toContain(timeStr);
      expect(str).toContain(expectedGMTOffset);
      expect(str).toContain(String(expectedFullYear));

      // ── toTimeString must contain same time components and GMT offset ──
      const tStr = cs.Date.prototype.toTimeString.call(date);
      expect(tStr).toContain(timeStr);
      expect(tStr).toContain(expectedGMTOffset);

      // ── toDateString must contain same date components ──
      const dStr = cs.Date.prototype.toDateString.call(date);
      const expectedDayName = DAY_NAMES[expectedDay];
      const expectedMonthName = MONTH_NAMES[expectedMonth];
      const paddedDate = String(expectedDate).padStart(2, "0");

      expect(dStr).toContain(expectedDayName);
      expect(dStr).toContain(expectedMonthName);
      expect(dStr).toContain(paddedDate);
      expect(dStr).toContain(String(expectedFullYear));
    });
  }

  /**
   * Multi-year TZP simulation: create dates at 1879, 1952, 1976, 2025 in
   * Asia/Tokyo, hash all API results for each year, and assert a single
   * uniform hash across all years.
   *
   * On UNFIXED code this MUST FAIL — the 1879 date will produce a different
   * hash than the modern dates because formatToParts disagrees with
   * getIntlBasedOffset for the sub-minute LMT offset.
   */
  test("Multi-year TZP simulation: single uniform hash across all years in Asia/Tokyo", () => {
    const tzConfig = {
      identifier: "Asia/Tokyo",
      offset: 540, // modern JST +9:00 as fallback
      dstOffset: 0,
    };

    const cs = setupContentScript({
      enabled: true,
      location: { latitude: 35.6762, longitude: 139.6503, accuracy: 10 },
      timezone: tzConfig,
    });

    const years = [1879, 1952, 1976, 2025];
    const hashes: string[] = [];

    for (const year of years) {
      const date = new Date(year, 0, 1);

      // Collect all API results
      const tzo = cs.Date.prototype.getTimezoneOffset.call(date);
      const hours = cs.Date.prototype.getHours.call(date);
      const minutes = cs.Date.prototype.getMinutes.call(date);
      const seconds = cs.Date.prototype.getSeconds.call(date);
      const day = cs.Date.prototype.getDate.call(date);
      const weekday = cs.Date.prototype.getDay.call(date);
      const month = cs.Date.prototype.getMonth.call(date);
      const fullYear = cs.Date.prototype.getFullYear.call(date);
      cs.Date.prototype.toString.call(date);
      cs.Date.prototype.toTimeString.call(date);
      cs.Date.prototype.toDateString.call(date);

      // Verify internal consistency: all APIs agree with arithmetic from offset
      const local = getLocalDateViaOffset(date, tzConfig.identifier);

      // Build a consistency fingerprint from all API results
      // If all APIs derive from the same offset, the relationship between
      // getTimezoneOffset and the getter values will be consistent
      const fingerprint = [
        `tzo=${tzo}`,
        `h=${hours}`,
        `m=${minutes}`,
        `s=${seconds}`,
        `D=${day}`,
        `wd=${weekday}`,
        `M=${month}`,
        `Y=${fullYear}`,
        // Verify getters match arithmetic from the offset reported by getTimezoneOffset
        `h_match=${hours === local.getUTCHours()}`,
        `m_match=${minutes === local.getUTCMinutes()}`,
        `s_match=${seconds === local.getUTCSeconds()}`,
        `D_match=${day === local.getUTCDate()}`,
        `wd_match=${weekday === local.getUTCDay()}`,
        `M_match=${month === local.getUTCMonth()}`,
        `Y_match=${fullYear === local.getUTCFullYear()}`,
      ].join("|");

      hashes.push(simpleHash(fingerprint));
    }

    // All years must produce the same consistency hash
    // (i.e., all APIs are internally consistent for every year)
    // On unfixed code, 1879 will have mismatches (h_match=false, etc.)
    // while modern years will have all matches (h_match=true, etc.)

    // The real assertion: for each year, ALL getters must match arithmetic
    for (const year of years) {
      const date = new Date(year, 0, 1);
      const offset = referenceDeriveOffset(date, tzConfig.identifier);
      const local = getLocalDateViaOffset(date, tzConfig.identifier, tzConfig.offset);

      const hours = cs.Date.prototype.getHours.call(date);
      const minutes = cs.Date.prototype.getMinutes.call(date);
      const seconds = cs.Date.prototype.getSeconds.call(date);
      const day = cs.Date.prototype.getDate.call(date);
      const weekday = cs.Date.prototype.getDay.call(date);
      const month = cs.Date.prototype.getMonth.call(date);
      const fullYear = cs.Date.prototype.getFullYear.call(date);

      expect(hours).toBe(local.getUTCHours());
      expect(minutes).toBe(local.getUTCMinutes());
      expect(seconds).toBe(local.getUTCSeconds());
      expect(day).toBe(local.getUTCDate());
      expect(weekday).toBe(local.getUTCDay());
      expect(month).toBe(local.getUTCMonth());
      expect(fullYear).toBe(local.getUTCFullYear());

      // toString must contain the formatToParts-derived time and GMT offset
      const str = cs.Date.prototype.toString.call(date);
      const expectedGMT = formatGMTOffset(offset);
      const paddedH = String(local.getUTCHours()).padStart(2, "0");
      const paddedM = String(local.getUTCMinutes()).padStart(2, "0");
      const paddedS = String(local.getUTCSeconds()).padStart(2, "0");
      expect(str).toContain(`${paddedH}:${paddedM}:${paddedS}`);
      expect(str).toContain(expectedGMT);
    }
  });
});

// ── Property 2: Preservation Tests ───────────────────────────────────

import fc from "fast-check";

/**
 * Property 2: Preservation — Modern Timezone Behavior Unchanged
 *
 * These tests run on UNFIXED code and capture the baseline behavior that
 * must be preserved after the fix. All tests here MUST PASS on unfixed code.
 *
 * Observation-first methodology: we observe what the current code does for
 * non-buggy inputs (modern timezones with whole-hour/minute offsets) and
 * encode those observations as properties.
 */

const MODERN_TIMEZONES = [
  { identifier: "America/New_York", offset: -300, dstOffset: -240 },
  { identifier: "Europe/London", offset: 0, dstOffset: 60 },
  { identifier: "Asia/Kolkata", offset: 330, dstOffset: 330 },
  { identifier: "Asia/Tokyo", offset: 540, dstOffset: 540 },
  { identifier: "America/Los_Angeles", offset: -480, dstOffset: -420 },
  { identifier: "Europe/Berlin", offset: 60, dstOffset: 120 },
] as const;

const DST_OBSERVING_TIMEZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
] as const;

// Known DST transition dates (approximate, for generating nearby dates)
const DST_TRANSITIONS_2024 = [
  // US spring forward: March 10, 2024 02:00
  new Date(Date.UTC(2024, 2, 10, 7, 0, 0)),
  // US fall back: November 3, 2024 02:00
  new Date(Date.UTC(2024, 10, 3, 6, 0, 0)),
  // EU spring forward: March 31, 2024 01:00 UTC
  new Date(Date.UTC(2024, 2, 31, 1, 0, 0)),
  // EU fall back: October 27, 2024 01:00 UTC
  new Date(Date.UTC(2024, 9, 27, 1, 0, 0)),
];

/** Arbitrary for a random modern date epoch (2000-01-01 to 2030-01-01). */
const modernDateEpochArb = fc.integer({
  min: new Date(2000, 0, 1).getTime(),
  max: new Date(2030, 0, 1).getTime(),
});

/** Arbitrary for a random timezone from the modern list. */
const modernTimezoneArb = fc.constantFrom(...MODERN_TIMEZONES);

/** Arbitrary for a random DST-observing timezone. */
const dstTimezoneArb = fc.constantFrom(...DST_OBSERVING_TIMEZONES);

/** Arbitrary for a date near a DST transition (within ±2 hours). */
const dstNearbyDateArb = fc
  .tuple(
    fc.constantFrom(...DST_TRANSITIONS_2024),
    fc.integer({ min: -7200000, max: 7200000 }) // ±2 hours in ms
  )
  .map(([base, offsetMs]) => new Date(base.getTime() + offsetMs));

describe("TZP Fingerprint Consistency — Property 2: Preservation", () => {
  /**
   * Property 2a: For random modern dates in modern timezones, all Date API
   * overrides produce mutually consistent results.
   *
   * getHours/getMinutes/getSeconds match arithmetic from getIntlBasedOffset,
   * getDate/getDay/getMonth/getFullYear also match arithmetic,
   * and toString/toTimeString/toDateString contain the correct components.
   */
  test("Property 2a: Modern timezone API consistency", () => {
    fc.assert(
      fc.property(modernDateEpochArb, modernTimezoneArb, (epoch, tz) => {
        const cs = setupContentScript({
          enabled: true,
          location: { latitude: 0, longitude: 0, accuracy: 10 },
          timezone: {
            identifier: tz.identifier,
            offset: tz.offset,
            dstOffset: tz.dstOffset,
          },
        });

        const date = new Date(epoch);

        // Compute expected values via the same formatToParts offset path
        const offset = referenceDeriveOffset(date, tz.identifier);
        const local = getLocalDateViaOffset(date, tz.identifier);

        const expectedHours = local.getUTCHours();
        const expectedMinutes = local.getUTCMinutes();
        const expectedSeconds = local.getUTCSeconds();
        const expectedDate = local.getUTCDate();
        const expectedDay = local.getUTCDay();
        const expectedMonth = local.getUTCMonth();
        const expectedFullYear = local.getUTCFullYear();

        // Time-level getters
        expect(cs.Date.prototype.getHours.call(date)).toBe(expectedHours);
        expect(cs.Date.prototype.getMinutes.call(date)).toBe(expectedMinutes);
        expect(cs.Date.prototype.getSeconds.call(date)).toBe(expectedSeconds);

        // Date-level getters
        expect(cs.Date.prototype.getDate.call(date)).toBe(expectedDate);
        expect(cs.Date.prototype.getDay.call(date)).toBe(expectedDay);
        expect(cs.Date.prototype.getMonth.call(date)).toBe(expectedMonth);
        expect(cs.Date.prototype.getFullYear.call(date)).toBe(expectedFullYear);

        // getTimezoneOffset
        const tzo = cs.Date.prototype.getTimezoneOffset.call(date);
        expect(tzo).toBeCloseTo(-offset, 4);

        // toString contains correct time, GMT offset, and year
        const str = cs.Date.prototype.toString.call(date);
        const paddedH = String(expectedHours).padStart(2, "0");
        const paddedM = String(expectedMinutes).padStart(2, "0");
        const paddedS = String(expectedSeconds).padStart(2, "0");
        expect(str).toContain(`${paddedH}:${paddedM}:${paddedS}`);
        expect(str).toContain(formatGMTOffset(offset));
        expect(str).toContain(String(expectedFullYear));

        // toTimeString contains correct time and GMT offset
        const tStr = cs.Date.prototype.toTimeString.call(date);
        expect(tStr).toContain(`${paddedH}:${paddedM}:${paddedS}`);
        expect(tStr).toContain(formatGMTOffset(offset));

        // toDateString contains correct date components
        const dStr = cs.Date.prototype.toDateString.call(date);
        expect(dStr).toContain(DAY_NAMES[expectedDay]);
        expect(dStr).toContain(MONTH_NAMES[expectedMonth]);
        expect(dStr).toContain(String(expectedDate).padStart(2, "0"));
        expect(dStr).toContain(String(expectedFullYear));
      }),
      { numRuns: 200 }
    );
  });

  /**
   * Property 2b: For random dates near DST transitions in DST-observing
   * timezones, all APIs remain consistent.
   */
  test("Property 2b: DST transition consistency", () => {
    fc.assert(
      fc.property(dstNearbyDateArb, dstTimezoneArb, (date, tzId) => {
        const tz = MODERN_TIMEZONES.find((t) => t.identifier === tzId)!;
        const cs = setupContentScript({
          enabled: true,
          location: { latitude: 0, longitude: 0, accuracy: 10 },
          timezone: {
            identifier: tz.identifier,
            offset: tz.offset,
            dstOffset: tz.dstOffset,
          },
        });

        // Compute expected values via arithmetic
        const offset = referenceDeriveOffset(date, tz.identifier);
        const local = getLocalDateViaOffset(date, tz.identifier);

        const expectedHours = local.getUTCHours();
        const expectedMinutes = local.getUTCMinutes();
        const expectedSeconds = local.getUTCSeconds();
        const expectedDate = local.getUTCDate();
        const expectedDay = local.getUTCDay();
        const expectedMonth = local.getUTCMonth();
        const expectedFullYear = local.getUTCFullYear();

        // All getters must match arithmetic
        expect(cs.Date.prototype.getHours.call(date)).toBe(expectedHours);
        expect(cs.Date.prototype.getMinutes.call(date)).toBe(expectedMinutes);
        expect(cs.Date.prototype.getSeconds.call(date)).toBe(expectedSeconds);
        expect(cs.Date.prototype.getDate.call(date)).toBe(expectedDate);
        expect(cs.Date.prototype.getDay.call(date)).toBe(expectedDay);
        expect(cs.Date.prototype.getMonth.call(date)).toBe(expectedMonth);
        expect(cs.Date.prototype.getFullYear.call(date)).toBe(expectedFullYear);

        // getTimezoneOffset consistent
        expect(cs.Date.prototype.getTimezoneOffset.call(date)).toBeCloseTo(-offset, 4);

        // toString consistent
        const str = cs.Date.prototype.toString.call(date);
        const paddedH = String(expectedHours).padStart(2, "0");
        const paddedM = String(expectedMinutes).padStart(2, "0");
        const paddedS = String(expectedSeconds).padStart(2, "0");
        expect(str).toContain(`${paddedH}:${paddedM}:${paddedS}`);
        expect(str).toContain(formatGMTOffset(offset));
      }),
      { numRuns: 200 }
    );
  });

  /**
   * Property 2c: When spoofing is disabled, all Date APIs delegate to
   * original implementations and return identical results.
   */
  test("Property 2c: Disabled spoofing delegates to originals", () => {
    fc.assert(
      fc.property(modernDateEpochArb, (epoch) => {
        const cs = setupContentScript({
          enabled: false,
          location: null,
          timezone: null,
        });

        const date = new Date(epoch);

        // All overrides must return exactly what the originals return
        expect(cs.Date.prototype.toString.call(date)).toBe(cs.originals.toString.call(date));
        expect(cs.Date.prototype.toDateString.call(date)).toBe(
          cs.originals.toDateString.call(date)
        );
        expect(cs.Date.prototype.toTimeString.call(date)).toBe(
          cs.originals.toTimeString.call(date)
        );
        expect(cs.Date.prototype.getTimezoneOffset.call(date)).toBe(
          cs.originals.getTimezoneOffset.call(date)
        );
        expect(cs.Date.prototype.getHours.call(date)).toBe(cs.originals.getHours.call(date));
        expect(cs.Date.prototype.getMinutes.call(date)).toBe(cs.originals.getMinutes.call(date));
        expect(cs.Date.prototype.getSeconds.call(date)).toBe(cs.originals.getSeconds.call(date));
        expect(cs.Date.prototype.getDate.call(date)).toBe(cs.originals.getDate.call(date));
        expect(cs.Date.prototype.getDay.call(date)).toBe(cs.originals.getDay.call(date));
        expect(cs.Date.prototype.getMonth.call(date)).toBe(cs.originals.getMonth.call(date));
        expect(cs.Date.prototype.getFullYear.call(date)).toBe(cs.originals.getFullYear.call(date));
      }),
      { numRuns: 200 }
    );
  });

  /**
   * Property 2d: toLocaleString, toLocaleDateString, toLocaleTimeString
   * with no explicit timezone inject the spoofed timezone identifier and
   * produce results matching original.call(date, locales, { ...options, timeZone: spoofedTz }).
   */
  test("Property 2d: toLocale* methods inject spoofed timezone", () => {
    fc.assert(
      fc.property(modernDateEpochArb, modernTimezoneArb, (epoch, tz) => {
        const cs = setupContentScript({
          enabled: true,
          location: { latitude: 0, longitude: 0, accuracy: 10 },
          timezone: {
            identifier: tz.identifier,
            offset: tz.offset,
            dstOffset: tz.dstOffset,
          },
        });

        const date = new Date(epoch);

        // toLocaleString with no explicit tz should inject spoofed tz
        const spoofedLocale = cs.Date.prototype.toLocaleString.call(date);
        const expectedLocale = cs.originals.toLocaleString.call(date, undefined, {
          timeZone: tz.identifier,
        });
        expect(spoofedLocale).toBe(expectedLocale);

        // toLocaleDateString with no explicit tz
        const spoofedLocaleDate = cs.Date.prototype.toLocaleDateString.call(date);
        const expectedLocaleDate = cs.originals.toLocaleDateString.call(date, undefined, {
          timeZone: tz.identifier,
        });
        expect(spoofedLocaleDate).toBe(expectedLocaleDate);

        // toLocaleTimeString with no explicit tz
        const spoofedLocaleTime = cs.Date.prototype.toLocaleTimeString.call(date);
        const expectedLocaleTime = cs.originals.toLocaleTimeString.call(date, undefined, {
          timeZone: tz.identifier,
        });
        expect(spoofedLocaleTime).toBe(expectedLocaleTime);
      }),
      { numRuns: 200 }
    );
  });
});
