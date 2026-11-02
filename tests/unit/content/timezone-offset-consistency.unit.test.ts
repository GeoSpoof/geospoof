/**
 * End-to-End Cross-Method Consistency Tests
 * Feature: timezone-offset-consistency
 *
 * Verifies that getTimezoneOffset, toString GMT offset, toTimeString GMT offset,
 * and epoch arithmetic all agree for representative dates (historical + modern +
 * DST boundary). Also verifies modern dates produce unchanged results compared
 * to current behavior.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 7.1, 7.2
 */
import { vi, beforeEach } from "vitest";
import { setupContentScript } from "../../helpers/content.test.helper";

/**
 * Parse the GMT±HHMM offset from a toString() or toTimeString() output
 * and return the offset in minutes (positive = east of UTC).
 *
 * Example: "GMT+0530" → 330, "GMT-0800" → -480
 */
function parseGMTOffsetFromString(str: string): number | null {
  const match = str.match(/GMT([+-])(\d{2})(\d{2})/);
  if (!match) return null;
  const sign = match[1] === "+" ? 1 : -1;
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3], 10);
  return sign * (hours * 60 + minutes);
}

/**
 * Resolve the real UTC offset (minutes east of UTC) for a date and IANA timezone via Intl.
 * Uses the same formatToParts → Date.UTC → epoch diff approach as production code.
 */
function resolveIntlOffset(date: Date, timezoneId: string): number {
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
  const localAsUTC = Date.UTC(year, month - 1, day, hour, minute, second);
  // Strip sub-second precision — formatToParts only resolves to whole seconds.
  const epochSeconds = Math.floor(date.getTime() / 1000) * 1000;
  return (localAsUTC - epochSeconds) / 60000;
}

/** Timezone configs for testing. */
const TIMEZONE_CONFIGS = [
  { identifier: "Europe/Berlin", offset: 60, dstOffset: 120 },
  { identifier: "Asia/Kolkata", offset: 330, dstOffset: 330 },
  { identifier: "America/New_York", offset: -300, dstOffset: -240 },
  { identifier: "America/Los_Angeles", offset: -480, dstOffset: -420 },
  { identifier: "Asia/Tokyo", offset: 540, dstOffset: 540 },
  { identifier: "Pacific/Auckland", offset: 720, dstOffset: 780 },
  { identifier: "Australia/Sydney", offset: 600, dstOffset: 660 },
] as const;

/**
 * Test dates as UTC epoch milliseconds. Using explicit UTC epochs avoids
 * ambiguous-date-string parsing issues in the test environment where the
 * real system timezone affects Date constructor behavior.
 */
const MODERN_UTC_EPOCHS = [
  // Standard modern dates
  { label: "2024-01-15 12:00 UTC", epoch: Date.UTC(2024, 0, 15, 12, 0, 0) },
  { label: "2024-07-04 18:30 UTC", epoch: Date.UTC(2024, 6, 4, 18, 30, 0) },
  { label: "2023-12-25 00:00 UTC", epoch: Date.UTC(2023, 11, 25, 0, 0, 0) },
  // Near US DST transitions
  { label: "2024-03-10 06:00 UTC (near US spring-forward)", epoch: Date.UTC(2024, 2, 10, 6, 0, 0) },
  {
    label: "2024-03-10 08:00 UTC (after US spring-forward)",
    epoch: Date.UTC(2024, 2, 10, 8, 0, 0),
  },
  { label: "2024-11-03 05:00 UTC (near US fall-back)", epoch: Date.UTC(2024, 10, 3, 5, 0, 0) },
  { label: "2024-11-03 07:00 UTC (after US fall-back)", epoch: Date.UTC(2024, 10, 3, 7, 0, 0) },
  // Near EU DST transitions
  {
    label: "2024-03-31 00:00 UTC (before EU spring-forward)",
    epoch: Date.UTC(2024, 2, 31, 0, 0, 0),
  },
  {
    label: "2024-03-31 02:00 UTC (after EU spring-forward)",
    epoch: Date.UTC(2024, 2, 31, 2, 0, 0),
  },
  { label: "2024-10-27 00:00 UTC (before EU fall-back)", epoch: Date.UTC(2024, 9, 27, 0, 0, 0) },
  { label: "2024-10-27 02:00 UTC (after EU fall-back)", epoch: Date.UTC(2024, 9, 27, 2, 0, 0) },
  // Year boundaries
  { label: "2000-01-01 00:00 UTC", epoch: Date.UTC(2000, 0, 1, 0, 0, 0) },
  { label: "2030-12-31 23:59 UTC", epoch: Date.UTC(2030, 11, 31, 23, 59, 59) },
];

/** Historical dates as UTC epochs (pre-1900, sub-minute LMT offsets). */
const HISTORICAL_UTC_EPOCHS = [
  { label: "1879-01-01 12:00 UTC (Berlin LMT era)", epoch: Date.UTC(1879, 0, 1, 12, 0, 0) },
  { label: "1909-03-01 12:00 UTC (Amsterdam LMT era)", epoch: Date.UTC(1909, 2, 1, 12, 0, 0) },
  { label: "1971-12-31 12:00 UTC (Monrovia LMT era)", epoch: Date.UTC(1971, 11, 31, 12, 0, 0) },
  { label: "1850-06-15 06:00 UTC (deep historical)", epoch: Date.UTC(1850, 5, 15, 6, 0, 0) },
  { label: "1800-01-01 12:00 UTC (very early)", epoch: Date.UTC(1800, 0, 1, 12, 0, 0) },
];

/**
 * For a given Date instance and content script, verify that all offset-exposing
 * APIs return consistent offset values.
 *
 * Checks: getTimezoneOffset, toString GMT offset, toTimeString GMT offset.
 * For sub-minute historical offsets, getTimezoneOffset may return fractional minutes
 * while toString/toTimeString show whole-minute GMT±HHMM strings (truncated toward
 * zero, as every engine prints them).
 * Returns the UTC offset in minutes (positive = east) for further assertions.
 */
function assertAllOffsetsAgree(cs: ReturnType<typeof setupContentScript>, date: Date): number {
  // 1. getTimezoneOffset (returns negative of UTC offset, may be fractional)
  const gtzOffset = cs.Date.prototype.getTimezoneOffset.call(date);
  const utcOffset = -gtzOffset; // positive = east

  // 2. toString GMT offset (always whole minutes)
  const toStringResult = cs.Date.prototype.toString.call(date);
  const toStringOffset = parseGMTOffsetFromString(toStringResult);

  // 3. toTimeString GMT offset (always whole minutes)
  const toTimeStringResult = cs.Date.prototype.toTimeString.call(date);
  const toTimeStringOffset = parseGMTOffsetFromString(toTimeStringResult);

  // String offsets are whole minutes truncated toward zero; getTimezoneOffset may
  // be fractional. They must agree at the truncated-minute level.
  const truncatedUtcOffset = Math.trunc(utcOffset);
  if (toStringOffset !== null) {
    expect(toStringOffset).toBe(truncatedUtcOffset);
  }
  if (toTimeStringOffset !== null) {
    expect(toTimeStringOffset).toBe(truncatedUtcOffset);
  }

  return utcOffset;
}

describe("Cross-method offset consistency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Modern dates: getTimezoneOffset, toString, and toTimeString all agree", () => {
    for (const tz of TIMEZONE_CONFIGS) {
      describe(`timezone: ${tz.identifier}`, () => {
        for (const { label, epoch } of MODERN_UTC_EPOCHS) {
          test(label, () => {
            const cs = setupContentScript({
              enabled: true,
              location: { latitude: 0, longitude: 0, accuracy: 10 },
              timezone: tz,
            });

            const date = new Date(epoch);
            assertAllOffsetsAgree(cs, date);
          });
        }
      });
    }
  });

  describe("Historical dates: getTimezoneOffset, toString, and toTimeString all agree", () => {
    for (const tz of TIMEZONE_CONFIGS) {
      describe(`timezone: ${tz.identifier}`, () => {
        for (const { label, epoch } of HISTORICAL_UTC_EPOCHS) {
          test(label, () => {
            const cs = setupContentScript({
              enabled: true,
              location: { latitude: 0, longitude: 0, accuracy: 10 },
              timezone: tz,
            });

            const date = new Date(epoch);
            assertAllOffsetsAgree(cs, date);
          });
        }
      });
    }
  });

  describe("Epoch arithmetic agrees with getTimezoneOffset for modern ambiguous dates", () => {
    // Use safe modern dates well away from DST boundaries to avoid ambiguity
    const SAFE_MODERN_DATES = [
      "January 15, 2024 12:00:00",
      "July 4, 2024 18:30:00",
      "December 25, 2023 08:00:00",
      "June 21, 2024 14:00:00",
      "January 1, 2000 12:00:00",
    ];

    for (const tz of TIMEZONE_CONFIGS) {
      describe(`timezone: ${tz.identifier}`, () => {
        for (const dateStr of SAFE_MODERN_DATES) {
          test(dateStr, () => {
            const cs = setupContentScript({
              enabled: true,
              location: { latitude: 0, longitude: 0, accuracy: 10 },
              timezone: tz,
            });

            const date = cs.DateConstructor(dateStr);
            if (isNaN(date.getTime())) return;

            const utcDate = cs.DateConstructor(dateStr + " UTC");
            if (isNaN(utcDate.getTime())) return;

            // getTimezoneOffset on the constructed date
            const gtzOffset = cs.Date.prototype.getTimezoneOffset.call(date);
            const utcOffsetFromGTZ = -gtzOffset;

            // Epoch arithmetic: (ambiguous - UTC) / 60000 gives negative UTC offset
            const epochDiffMinutes = (date.getTime() - utcDate.getTime()) / 60000;
            const utcOffsetFromEpoch = -epochDiffMinutes;

            // For modern dates (no sub-minute offsets), these should match exactly.
            // Use toBeCloseTo for floating point safety.
            expect(utcOffsetFromEpoch).toBeCloseTo(utcOffsetFromGTZ, 5);
          });
        }
      });
    }
  });

  describe("Modern dates produce unchanged results (no regression)", () => {
    // Verify that for modern dates, the spoofed offset matches what Intl resolves
    const REGRESSION_EPOCHS = [
      { label: "2024-01-15 winter", epoch: Date.UTC(2024, 0, 15, 12, 0, 0) },
      { label: "2024-07-15 summer", epoch: Date.UTC(2024, 6, 15, 12, 0, 0) },
      { label: "2024-03-15 spring", epoch: Date.UTC(2024, 2, 15, 12, 0, 0) },
      { label: "2024-10-15 autumn", epoch: Date.UTC(2024, 9, 15, 12, 0, 0) },
    ];

    for (const tz of TIMEZONE_CONFIGS) {
      describe(`timezone: ${tz.identifier}`, () => {
        for (const { label, epoch } of REGRESSION_EPOCHS) {
          test(label, () => {
            const cs = setupContentScript({
              enabled: true,
              location: { latitude: 0, longitude: 0, accuracy: 10 },
              timezone: tz,
            });

            const date = new Date(epoch);

            // The expected offset from Intl (ground truth for modern dates)
            const expectedOffset = resolveIntlOffset(date, tz.identifier);

            // getTimezoneOffset should return negated offset
            const gtzOffset = cs.Date.prototype.getTimezoneOffset.call(date);
            expect(-gtzOffset).toBeCloseTo(expectedOffset, 4);

            // toString should contain the matching GMT offset (whole minutes, truncated toward zero)
            const toStringResult = cs.Date.prototype.toString.call(date);
            const toStringOffset = parseGMTOffsetFromString(toStringResult);
            if (toStringOffset !== null) {
              expect(toStringOffset).toBe(Math.trunc(expectedOffset));
            }

            // toTimeString should contain the matching GMT offset (whole minutes, truncated toward zero)
            const toTimeStringResult = cs.Date.prototype.toTimeString.call(date);
            const toTimeStringOffset = parseGMTOffsetFromString(toTimeStringResult);
            if (toTimeStringOffset !== null) {
              expect(toTimeStringOffset).toBe(Math.trunc(expectedOffset));
            }
          });
        }
      });
    }
  });

  describe("DST boundary dates: all offset APIs agree at transition points", () => {
    // Use UTC epochs at known DST transition points to avoid ambiguous parsing
    const DST_BOUNDARY_EPOCHS = [
      // US Eastern: spring forward 2024-03-10 at 02:00 EST (07:00 UTC)
      {
        label: "NY just before spring-forward (06:59 UTC)",
        epoch: Date.UTC(2024, 2, 10, 6, 59, 0),
        tz: { identifier: "America/New_York", offset: -300, dstOffset: -240 },
      },
      {
        label: "NY just after spring-forward (07:01 UTC)",
        epoch: Date.UTC(2024, 2, 10, 7, 1, 0),
        tz: { identifier: "America/New_York", offset: -300, dstOffset: -240 },
      },
      // US Eastern: fall back 2024-11-03 at 02:00 EDT (06:00 UTC)
      {
        label: "NY just before fall-back (05:59 UTC)",
        epoch: Date.UTC(2024, 10, 3, 5, 59, 0),
        tz: { identifier: "America/New_York", offset: -300, dstOffset: -240 },
      },
      {
        label: "NY just after fall-back (06:01 UTC)",
        epoch: Date.UTC(2024, 10, 3, 6, 1, 0),
        tz: { identifier: "America/New_York", offset: -300, dstOffset: -240 },
      },
      // EU Berlin: spring forward 2024-03-31 at 02:00 CET (01:00 UTC)
      {
        label: "Berlin just before spring-forward (00:59 UTC)",
        epoch: Date.UTC(2024, 2, 31, 0, 59, 0),
        tz: { identifier: "Europe/Berlin", offset: 60, dstOffset: 120 },
      },
      {
        label: "Berlin just after spring-forward (01:01 UTC)",
        epoch: Date.UTC(2024, 2, 31, 1, 1, 0),
        tz: { identifier: "Europe/Berlin", offset: 60, dstOffset: 120 },
      },
      // EU Berlin: fall back 2024-10-27 at 03:00 CEST (01:00 UTC)
      {
        label: "Berlin just before fall-back (00:59 UTC)",
        epoch: Date.UTC(2024, 9, 27, 0, 59, 0),
        tz: { identifier: "Europe/Berlin", offset: 60, dstOffset: 120 },
      },
      {
        label: "Berlin just after fall-back (01:01 UTC)",
        epoch: Date.UTC(2024, 9, 27, 1, 1, 0),
        tz: { identifier: "Europe/Berlin", offset: 60, dstOffset: 120 },
      },
      // Australia/Sydney: ends DST first Sunday of April 2024 at 03:00 AEDT (16:00 UTC prev day)
      {
        label: "Sydney just before DST end (15:59 UTC)",
        epoch: Date.UTC(2024, 3, 6, 15, 59, 0),
        tz: { identifier: "Australia/Sydney", offset: 600, dstOffset: 660 },
      },
      {
        label: "Sydney just after DST end (16:01 UTC)",
        epoch: Date.UTC(2024, 3, 6, 16, 1, 0),
        tz: { identifier: "Australia/Sydney", offset: 600, dstOffset: 660 },
      },
    ];

    for (const { label, epoch, tz } of DST_BOUNDARY_EPOCHS) {
      test(label, () => {
        const cs = setupContentScript({
          enabled: true,
          location: { latitude: 0, longitude: 0, accuracy: 10 },
          timezone: tz,
        });

        const date = new Date(epoch);
        assertAllOffsetsAgree(cs, date);
      });
    }
  });
});

/**
 * Fractional offset precision: getTimezoneOffset agrees with shortOffset string
 *
 * Regression test for the "mixed" TZP result caused by getTimezoneOffset using
 * deriveOffsetFromParts (formatToParts, whole-second precision → loses sub-second
 * LMT detail) while TZP's offsetNanoseconds and timeZoneName methods use the
 * shortOffset string path (e.g. "GMT-9:59:36") which preserves full fractional
 * precision. On Firefox (fractional getTimezoneOffset), this caused a split:
 * 8 methods returning 599 and 2 returning 599.6 for America/Anchorage in 1879.
 *
 * Fix: on Firefox, getTimezoneOffset uses getIntlBasedOffset (shortOffset string)
 * instead of deriveOffsetFromParts, matching the precision of offsetNanoseconds
 * and timeZoneName.
 */
describe("Fractional offset precision: getTimezoneOffset matches shortOffset string", () => {
  /**
   * Resolve the UTC offset via the shortOffset string path — the same method
   * TZP's offsetNanoseconds and timeZoneName use. Returns fractional minutes.
   */
  function resolveShortOffsetMinutes(date: Date, timezoneId: string): number {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezoneId,
      timeZoneName: "shortOffset",
    });
    const parts = fmt.formatToParts(date);
    const tzVal = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    if (tzVal === "GMT" || tzVal === "UTC") return 0;
    const m = tzVal.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/);
    if (!m) return 0;
    const sign = m[1] === "+" ? 1 : -1;
    const seconds = parseInt(m[4] || "0", 10);
    return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10) + seconds / 60);
  }

  /**
   * Timezones with known sub-minute historical LMT offsets.
   * These are the cases that triggered the "mixed" TZP result.
   */
  const FRACTIONAL_OFFSET_CASES = [
    {
      label: "America/Anchorage 1879 (Sitka Mean Time: -9:59:36 = 599.6 min)",
      timezone: { identifier: "America/Anchorage", offset: -480, dstOffset: -480 },
      epoch: Date.UTC(1879, 0, 15, 13, 0, 0),
    },
    {
      label: "Asia/Kolkata 1879 (Madras Mean Time: +5:21:10 = 321.166... min)",
      timezone: { identifier: "Asia/Kolkata", offset: 330, dstOffset: 330 },
      epoch: Date.UTC(1879, 0, 15, 13, 0, 0),
    },
    {
      label: "Asia/Dhaka 1879 (Dacca Mean Time: +6:01:40 = 361.666... min)",
      timezone: { identifier: "Asia/Dhaka", offset: 360, dstOffset: 360 },
      epoch: Date.UTC(1879, 0, 15, 13, 0, 0),
    },
    {
      label: "Europe/Paris 1879 (Paris Mean Time: +0:09:21 = 9.35 min)",
      timezone: { identifier: "Europe/Paris", offset: 60, dstOffset: 120 },
      epoch: Date.UTC(1879, 0, 15, 13, 0, 0),
    },
  ];

  for (const { label, timezone, epoch } of FRACTIONAL_OFFSET_CASES) {
    test(label, () => {
      const cs = setupContentScript({
        enabled: true,
        location: { latitude: 0, longitude: 0, accuracy: 10 },
        timezone,
      });

      const date = new Date(epoch);

      // Ground truth: shortOffset string (same path as TZP's offsetNanoseconds + timeZoneName)
      const shortOffsetMinutes = resolveShortOffsetMinutes(date, timezone.identifier);

      // getTimezoneOffset must agree with the shortOffset string to the same
      // precision the engine provides. On Chrome (integer truncation) both will
      // be integers; on Firefox both will be fractional.
      const gtzOffset = cs.Date.prototype.getTimezoneOffset.call(date);
      const utcOffsetFromGTZ = -gtzOffset;

      // They must agree to at least 4 decimal places (sub-second precision).
      // This catches the 599 vs 599.6 split that caused the TZP "mixed" result.
      expect(utcOffsetFromGTZ).toBeCloseTo(shortOffsetMinutes, 4);
    });
  }

  test("modern dates: getTimezoneOffset still agrees with shortOffset (no regression)", () => {
    const MODERN_CASES = [
      {
        timezone: { identifier: "America/Anchorage", offset: -480, dstOffset: -480 },
        epoch: Date.UTC(2024, 6, 15, 12, 0, 0),
      },
      {
        timezone: { identifier: "Asia/Kolkata", offset: 330, dstOffset: 330 },
        epoch: Date.UTC(2024, 0, 15, 12, 0, 0),
      },
      {
        timezone: { identifier: "Europe/Paris", offset: 60, dstOffset: 120 },
        epoch: Date.UTC(2024, 6, 15, 12, 0, 0),
      },
      {
        timezone: { identifier: "America/New_York", offset: -300, dstOffset: -240 },
        epoch: Date.UTC(2024, 0, 15, 12, 0, 0),
      },
    ];

    for (const { timezone, epoch } of MODERN_CASES) {
      const cs = setupContentScript({
        enabled: true,
        location: { latitude: 0, longitude: 0, accuracy: 10 },
        timezone,
      });

      const date = new Date(epoch);
      const shortOffsetMinutes = resolveShortOffsetMinutes(date, timezone.identifier);
      const gtzOffset = cs.Date.prototype.getTimezoneOffset.call(date);
      expect(-gtzOffset).toBeCloseTo(shortOffsetMinutes, 4);
    }
  });
});
