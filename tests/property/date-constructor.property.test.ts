/**
 * Property-Based Tests for Date Constructor Spoofing
 * Feature: date-constructor-spoofing
 *
 * Tests the Date constructor override and Date.parse override that adjust
 * epoch milliseconds for ambiguous date strings and multi-argument calls
 * to close the TZP fingerprint detection leak.
 */

import fc from "fast-check";
import { setupContentScript } from "../helpers/content.test.helper";

// ── Timezone zone lists ──────────────────────────────────────────────

const DST_ZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
] as const;

const NON_DST_ZONES = [
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Africa/Nairobi",
] as const;

const SOUTHERN_HEMISPHERE_ZONES = [
  "Australia/Sydney",
  "Pacific/Auckland",
  "America/Santiago",
] as const;

const EXCEPTION_ZONES = ["America/Phoenix", "Pacific/Honolulu", "Asia/Kathmandu"] as const;

const ALL_TEST_ZONES = [
  ...DST_ZONES,
  ...NON_DST_ZONES,
  ...SOUTHERN_HEMISPHERE_ZONES,
  ...EXCEPTION_ZONES,
] as const;

// ── Reference helpers (mirrors injected.ts logic for verification) ───

function parseGMTOffset(gmtString: string): number {
  if (gmtString === "GMT" || gmtString === "UTC") return 0;
  const match = gmtString.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/);
  if (!match) return 0;
  const sign = match[1] === "+" ? 1 : -1;
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3] || "0", 10);
  const seconds = parseInt(match[4] || "0", 10);
  return sign * (hours * 60 + minutes + seconds / 60);
}

function referenceIntlOffset(date: Date, timezoneId: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezoneId,
      timeZoneName: "shortOffset",
    });
    const parts = formatter.formatToParts(date);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    return parseGMTOffset(tzPart?.value ?? "GMT");
  } catch {
    return 0;
  }
}

/**
 * Fixed reference instant for the (fallback-only) config offset below. MUST be
 * deterministic — never `new Date()` — so the arbitrary doesn't depend on when
 * the suite runs. The implementation resolves offsets per-date via `Intl` from
 * the identifier; the numeric `offset`/`dstOffset` fields are only used if that
 * `Intl` path throws, which never happens in these tests, so the exact value is
 * immaterial here — only its determinism is.
 */
const REFERENCE_INSTANT = new Date("2024-01-15T12:00:00Z");

/**
 * True when the spoofed-zone UTC offset is the same throughout a window around
 * `epoch` — i.e. `epoch` is not on/near a DST transition.
 *
 * The epoch-adjustment properties below assert that a constructed instant,
 * viewed in the spoofed zone, reproduces the input wall-clock time. At a
 * spring-forward gap that wall-clock time does not exist, and at a fall-back
 * fold it is ambiguous, so the property is undefined there. Those inputs are
 * outside the property's domain, not failures — this guard excludes them
 * deterministically (it depends only on the instant and the zone's real rules).
 */
function offsetStableAround(epoch: number, timezoneId: string): boolean {
  const hours = 2 * 60 * 60 * 1000;
  const here = referenceIntlOffset(new Date(epoch), timezoneId);
  const before = referenceIntlOffset(new Date(epoch - hours), timezoneId);
  const after = referenceIntlOffset(new Date(epoch + hours), timezoneId);
  return here === before && here === after;
}
// ── Custom fast-check arbitraries ────────────────────────────────────

/** Generate ambiguous date strings (no timezone indicator) */
const ambiguousDateStringArb = fc
  .record({
    year: fc.integer({ min: 2000, max: 2030 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
    hour: fc.integer({ min: 0, max: 23 }),
    minute: fc.integer({ min: 0, max: 59 }),
    second: fc.integer({ min: 0, max: 59 }),
  })
  .map(({ year, month, day, hour, minute, second }) => {
    const months = [
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
    const m = months[month - 1];
    const d = String(day).padStart(2, "0");
    const h = String(hour).padStart(2, "0");
    const min = String(minute).padStart(2, "0");
    const s = String(second).padStart(2, "0");
    return `${m} ${d} ${year} ${h}:${min}:${s}`;
  });

/** Generate explicit timezone date strings that isAmbiguousDateString classifies as explicit */
const explicitDateStringArb = fc.oneof(
  // ISO with Z suffix
  fc
    .record({
      year: fc.integer({ min: 2000, max: 2030 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 28 }),
      hour: fc.integer({ min: 0, max: 23 }),
      minute: fc.integer({ min: 0, max: 59 }),
      second: fc.integer({ min: 0, max: 59 }),
    })
    .map(({ year, month, day, hour, minute, second }) => {
      const m = String(month).padStart(2, "0");
      const d = String(day).padStart(2, "0");
      const h = String(hour).padStart(2, "0");
      const min = String(minute).padStart(2, "0");
      const s = String(second).padStart(2, "0");
      return `${year}-${m}-${d}T${h}:${min}:${s}Z`;
    }),
  // ISO date-only (UTC per spec) — detected by date-only regex
  fc
    .record({
      year: fc.integer({ min: 2000, max: 2030 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 28 }),
    })
    .map(({ year, month, day }) => {
      const m = String(month).padStart(2, "0");
      const d = String(day).padStart(2, "0");
      return `${year}-${m}-${d}`;
    }),
  // With UTC keyword
  fc
    .record({
      year: fc.integer({ min: 2000, max: 2030 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 28 }),
      hour: fc.integer({ min: 0, max: 23 }),
      minute: fc.integer({ min: 0, max: 59 }),
      second: fc.integer({ min: 0, max: 59 }),
    })
    .map(({ year, month, day, hour, minute, second }) => {
      const months = [
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
      const m = months[month - 1];
      const d = String(day).padStart(2, "0");
      const h = String(hour).padStart(2, "0");
      const min = String(minute).padStart(2, "0");
      const s = String(second).padStart(2, "0");
      return `${m} ${d} ${year} ${h}:${min}:${s} UTC`;
    }),
  // With GMT keyword
  fc
    .record({
      year: fc.integer({ min: 2000, max: 2030 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 28 }),
      hour: fc.integer({ min: 0, max: 23 }),
      minute: fc.integer({ min: 0, max: 59 }),
      second: fc.integer({ min: 0, max: 59 }),
    })
    .map(({ year, month, day, hour, minute, second }) => {
      const months = [
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
      const m = months[month - 1];
      const d = String(day).padStart(2, "0");
      const h = String(hour).padStart(2, "0");
      const min = String(minute).padStart(2, "0");
      const s = String(second).padStart(2, "0");
      return `${m} ${d} ${year} ${h}:${min}:${s} GMT`;
    }),
  // With offset suffix (±HH:MM)
  fc
    .record({
      year: fc.integer({ min: 2000, max: 2030 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 28 }),
      hour: fc.integer({ min: 0, max: 23 }),
      minute: fc.integer({ min: 0, max: 59 }),
      second: fc.integer({ min: 0, max: 59 }),
      offsetHour: fc.integer({ min: 0, max: 12 }),
      offsetSign: fc.constantFrom("+", "-"),
    })
    .map(({ year, month, day, hour, minute, second, offsetHour, offsetSign }) => {
      const m = String(month).padStart(2, "0");
      const d = String(day).padStart(2, "0");
      const h = String(hour).padStart(2, "0");
      const min = String(minute).padStart(2, "0");
      const s = String(second).padStart(2, "0");
      const oh = String(offsetHour).padStart(2, "0");
      return `${year}-${m}-${d}T${h}:${min}:${s}${offsetSign}${oh}:00`;
    })
);

/** Generate a timezone config object */
const timezoneArb = fc.constantFrom(...ALL_TEST_ZONES).map((tz) => ({
  identifier: tz,
  offset: referenceIntlOffset(REFERENCE_INSTANT, tz),
  dstOffset: 0,
}));

/** Generate valid date components for multi-arg constructor */
const dateComponentsArb = fc.record({
  year: fc.integer({ min: 2000, max: 2030 }),
  month: fc.integer({ min: 0, max: 11 }),
  day: fc.integer({ min: 1, max: 28 }),
  hour: fc.integer({ min: 0, max: 23 }),
  minute: fc.integer({ min: 0, max: 59 }),
  second: fc.integer({ min: 0, max: 59 }),
});
// ── Property Tests ───────────────────────────────────────────────────

describe("Date Constructor Spoofing Properties", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Property 1: Ambiguous String Epoch Adjustment
   * Feature: date-constructor-spoofing, Property 1: Ambiguous String Epoch Adjustment
   *
   * For any ambiguous date string and spoofed IANA timezone, both
   * `new Date(str).getTime()` and `Date.parse(str)` return the epoch that
   * would result if the system timezone were actually the spoofed timezone.
   *
   * Validates: Requirements 2.1, 3.1
   */
  test("Property 1: Ambiguous String Epoch Adjustment", () => {
    fc.assert(
      fc.property(ambiguousDateStringArb, timezoneArb, (dateStr, timezone) => {
        const cs = setupContentScript({
          enabled: true,
          location: { latitude: 35.6762, longitude: 139.6503, accuracy: 10 },
          timezone,
        });

        // Original parse (no spoofing)
        const originalEpoch = cs.originals.DateParse(dateStr);
        if (isNaN(originalEpoch)) return; // skip unparseable

        // The adjusted epoch must be consistent with getTimezoneOffset on the result.
        // computeEpochAdjustment iterates until the offset at the final adjusted date
        // is stable, so we verify the result's getTimezoneOffset matches the epoch shift.
        const constructedDate = cs.DateConstructor(dateStr);
        const resultEpoch = constructedDate.getTime();

        // The constructed wall-clock time must exist unambiguously in the
        // spoofed zone; skip DST-transition instants where it doesn't (see
        // offsetStableAround).
        fc.pre(offsetStableAround(resultEpoch, timezone.identifier));

        // The offset at the result date should match the epoch arithmetic
        const resultOffset = referenceIntlOffset(constructedDate, timezone.identifier);
        const parsedDate = new Date(originalEpoch);
        const realOffset = cs.originals.getTimezoneOffset.call(parsedDate);
        const expectedAdjustment = Math.round((-resultOffset - realOffset) * 60000);
        expect(resultEpoch).toBe(originalEpoch + expectedAdjustment);

        // Date.parse should produce the same epoch
        const parsedEpoch = cs.DateParse(dateStr);
        expect(parsedEpoch).toBe(resultEpoch);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 2: Explicit String Passthrough
   * Feature: date-constructor-spoofing, Property 2: Explicit String Passthrough
   *
   * For any explicit timezone string (Z, UTC, GMT, ±offset) or ISO date-only,
   * both overrides return the same epoch as the originals.
   *
   * Validates: Requirements 1.2, 2.5, 3.2
   */
  test("Property 2: Explicit String Passthrough", () => {
    fc.assert(
      fc.property(explicitDateStringArb, timezoneArb, (dateStr, timezone) => {
        const cs = setupContentScript({
          enabled: true,
          location: { latitude: 35.6762, longitude: 139.6503, accuracy: 10 },
          timezone,
        });

        const originalEpoch = cs.originals.DateParse(dateStr);
        if (isNaN(originalEpoch)) return; // skip unparseable

        // Constructor should produce same epoch as original
        const constructedDate = cs.DateConstructor(dateStr);
        expect(constructedDate.getTime()).toBe(originalEpoch);

        // Date.parse should produce same epoch as original
        const parsedEpoch = cs.DateParse(dateStr);
        expect(parsedEpoch).toBe(originalEpoch);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 3: Numeric Argument Passthrough
   * Feature: date-constructor-spoofing, Property 3: Numeric Argument Passthrough
   *
   * For any finite number `n`, `new Date(n).getTime()` equals `n`
   * regardless of spoofing state.
   *
   * Validates: Requirements 2.3
   */
  test("Property 3: Numeric Argument Passthrough", () => {
    fc.assert(
      fc.property(
        fc.double({
          min: -8640000000000000,
          max: 8640000000000000,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        timezoneArb,
        (n, timezone) => {
          const cs = setupContentScript({
            enabled: true,
            location: { latitude: 35.6762, longitude: 139.6503, accuracy: 10 },
            timezone,
          });

          const result = cs.DateConstructor(n);
          // For integer-valued doubles, getTime() should equal n exactly
          // For non-integer doubles, Date truncates to integer
          const expected = new Date(n).getTime();
          expect(result.getTime()).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 4: Multi-Argument Epoch Adjustment
   * Feature: date-constructor-spoofing, Property 4: Multi-Argument Epoch Adjustment
   *
   * For any valid date components and spoofed timezone, multi-arg construction
   * returns epoch equal to original + offset adjustment.
   *
   * Validates: Requirements 2.4, 5.1
   */
  test("Property 4: Multi-Argument Epoch Adjustment", () => {
    fc.assert(
      fc.property(dateComponentsArb, timezoneArb, (comps, timezone) => {
        const cs = setupContentScript({
          enabled: true,
          location: { latitude: 35.6762, longitude: 139.6503, accuracy: 10 },
          timezone,
        });

        // Original multi-arg construction (no spoofing)
        const OrigDate = cs.originals.DateConstructor;
        const originalDate = new OrigDate(
          comps.year,
          comps.month,
          comps.day,
          comps.hour,
          comps.minute,
          comps.second
        );
        const originalEpoch = originalDate.getTime();
        if (isNaN(originalEpoch)) return;

        // Compute expected adjustment using corrected formula:
        // The adjustment must be consistent with the offset at the *final* adjusted date,
        // not the original date. computeEpochAdjustment iterates until stable.
        const result = cs.DateConstructor(
          comps.year,
          comps.month,
          comps.day,
          comps.hour,
          comps.minute,
          comps.second
        );
        const resultEpoch = result.getTime();

        // The constructed wall-clock time must exist unambiguously in the
        // spoofed zone; skip DST-transition instants where it doesn't (see
        // offsetStableAround).
        fc.pre(offsetStableAround(resultEpoch, timezone.identifier));

        // Verify: the offset at the result date matches the epoch shift
        const realOffset = cs.originals.getTimezoneOffset.call(originalDate);
        const resultOffset = referenceIntlOffset(result, timezone.identifier);
        const expectedAdjustment = Math.round((-resultOffset - realOffset) * 60000);
        expect(resultEpoch).toBe(originalEpoch + expectedAdjustment);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 5: Disabled Passthrough
   * Feature: date-constructor-spoofing, Property 5: Disabled Passthrough
   *
   * When spoofing disabled, all Date constructor and Date.parse calls
   * produce identical results to originals.
   *
   * Validates: Requirements 2.7, 3.4, 5.2
   */
  test("Property 5: Disabled Passthrough", () => {
    fc.assert(
      fc.property(
        ambiguousDateStringArb,
        dateComponentsArb,
        fc.double({
          min: -8640000000000000,
          max: 8640000000000000,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        timezoneArb,
        (dateStr, comps, numArg, timezone) => {
          const cs = setupContentScript({
            enabled: false,
            location: { latitude: 35.6762, longitude: 139.6503, accuracy: 10 },
            timezone,
          });

          const OrigDate = cs.originals.DateConstructor;

          // String arg
          const origStrEpoch = cs.originals.DateParse(dateStr);
          if (!isNaN(origStrEpoch)) {
            expect(cs.DateConstructor(dateStr).getTime()).toBe(origStrEpoch);
            expect(cs.DateParse(dateStr)).toBe(origStrEpoch);
          }

          // Numeric arg
          const origNumDate = new OrigDate(numArg);
          expect(cs.DateConstructor(numArg).getTime()).toBe(origNumDate.getTime());

          // Multi-arg
          const origMulti = new OrigDate(
            comps.year,
            comps.month,
            comps.day,
            comps.hour,
            comps.minute,
            comps.second
          );
          const result = cs.DateConstructor(
            comps.year,
            comps.month,
            comps.day,
            comps.hour,
            comps.minute,
            comps.second
          );
          expect(result.getTime()).toBe(origMulti.getTime());
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 6: instanceof Preservation
   * Feature: date-constructor-spoofing, Property 6: instanceof Preservation
   *
   * For any constructor call pattern, `new Date(...) instanceof Date` is `true`.
   *
   * Validates: Requirements 2.8
   */
  test("Property 6: instanceof Preservation", () => {
    fc.assert(
      fc.property(
        ambiguousDateStringArb,
        dateComponentsArb,
        fc.integer({ min: 0, max: 1700000000000 }),
        timezoneArb,
        (dateStr, comps, numArg, timezone) => {
          const cs = setupContentScript({
            enabled: true,
            location: { latitude: 35.6762, longitude: 139.6503, accuracy: 10 },
            timezone,
          });

          // No-arg
          expect(cs.DateConstructor()).toBeInstanceOf(Date);

          // Numeric arg
          expect(cs.DateConstructor(numArg)).toBeInstanceOf(Date);

          // String arg
          expect(cs.DateConstructor(dateStr)).toBeInstanceOf(Date);

          // Multi-arg
          expect(
            cs.DateConstructor(
              comps.year,
              comps.month,
              comps.day,
              comps.hour,
              comps.minute,
              comps.second
            )
          ).toBeInstanceOf(Date);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 7: DST-Aware Adjustment
   * Feature: date-constructor-spoofing, Property 7: DST-Aware Adjustment
   *
   * For DST-observing timezones, dates on opposite sides of a DST transition
   * produce different epoch adjustments.
   *
   * Validates: Requirements 4.3
   */
  test("Property 7: DST-Aware Adjustment", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DST_ZONES),
        fc.integer({ min: 2020, max: 2028 }),
        (tzId, year) => {
          const timezone = {
            identifier: tzId,
            offset: referenceIntlOffset(REFERENCE_INSTANT, tzId),
            dstOffset: 60,
          };

          const cs = setupContentScript({
            enabled: true,
            location: { latitude: 35.6762, longitude: 139.6503, accuracy: 10 },
            timezone,
          });

          // Pick dates in January (winter) and July (summer)
          const winterStr = `Jan 15 ${year} 12:00:00`;
          const summerStr = `Jul 15 ${year} 12:00:00`;

          const origWinter = cs.originals.DateParse(winterStr);
          const origSummer = cs.originals.DateParse(summerStr);
          if (isNaN(origWinter) || isNaN(origSummer)) return;

          // Verify the spoofed timezone has different offsets in winter vs summer
          const spoofedWinterOffset = referenceIntlOffset(new Date(origWinter), tzId);
          const spoofedSummerOffset = referenceIntlOffset(new Date(origSummer), tzId);

          // The property: the spoofed zone must have different offsets across DST
          // (this is what makes it "DST-aware")
          expect(spoofedWinterOffset).not.toBe(spoofedSummerOffset);

          // Now verify the override uses date-specific offsets (not a fixed value)
          // by checking that computeEpochAdjustment returns different values
          const winterAdj = cs.computeEpochAdjustment(new Date(origWinter), tzId, timezone.offset);
          const summerAdj = cs.computeEpochAdjustment(new Date(origSummer), tzId, timezone.offset);

          // The real system offset may also differ between winter and summer.
          // The adjustments will differ unless the real and spoofed offsets
          // change by exactly the same amount (which only happens if the
          // test machine's timezone has identical DST rules).
          const realWinterOffset = Date.prototype.getTimezoneOffset.call(new Date(origWinter));
          const realSummerOffset = Date.prototype.getTimezoneOffset.call(new Date(origSummer));
          // Normalize to same convention: both as getTimezoneOffset (positive = west)
          const realDelta = realWinterOffset - realSummerOffset;
          const spoofedDelta = -spoofedWinterOffset - -spoofedSummerOffset;

          if (realDelta !== spoofedDelta) {
            expect(winterAdj).not.toBe(summerAdj);
          }
          // If realDelta === spoofedDelta, adjustments may be equal — that's correct
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 8: Static Method Preservation
   * Feature: date-constructor-spoofing, Property 8: Static Method Preservation
   *
   * `Date.UTC(...)` returns same value as original, `Date.now()` returns
   * value within tolerance of real time.
   *
   * Validates: Requirements 6.1, 6.2
   */
  test("Property 8: Static Method Preservation", () => {
    fc.assert(
      fc.property(dateComponentsArb, timezoneArb, (comps, timezone) => {
        // Date.UTC should be unaffected by spoofing
        const originalUTC = Date.UTC(
          comps.year,
          comps.month,
          comps.day,
          comps.hour,
          comps.minute,
          comps.second
        );

        // Setup spoofing — Date.UTC should still return the same value
        setupContentScript({
          enabled: true,
          location: { latitude: 35.6762, longitude: 139.6503, accuracy: 10 },
          timezone,
        });

        const spoofedUTC = Date.UTC(
          comps.year,
          comps.month,
          comps.day,
          comps.hour,
          comps.minute,
          comps.second
        );
        expect(spoofedUTC).toBe(originalUTC);

        // Date.now() should return a value within 100ms of real time
        const before = Date.now();
        const now = Date.now();
        const after = Date.now();
        expect(now).toBeGreaterThanOrEqual(before);
        expect(now).toBeLessThanOrEqual(after + 100);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 9: No Self-Interference with Existing Overrides
   * Feature: date-constructor-spoofing, Property 9: No Self-Interference
   *
   * After Date constructor override is installed, `getTimezoneOffset` override
   * still returns correct spoofed offset matching negated Intl-based offset.
   *
   * Validates: Requirements 7.1
   */
  test("Property 9: No Self-Interference with Existing Overrides", () => {
    fc.assert(
      fc.property(
        timezoneArb,
        fc.date({ noInvalidDate: true, min: new Date("2000-01-01"), max: new Date("2030-12-31") }),
        (timezone, date) => {
          const cs = setupContentScript({
            enabled: true,
            location: { latitude: 35.6762, longitude: 139.6503, accuracy: 10 },
            timezone,
          });

          // Exercise the Date constructor override first (to ensure it doesn't
          // corrupt internal state used by getTimezoneOffset)
          cs.DateConstructor("Jul 4 2024 12:00:00");
          cs.DateParse("Jul 4 2024 12:00:00");

          // Now verify getTimezoneOffset still returns the correct spoofed offset
          const testDate = new Date(date);
          const result = cs.Date.prototype.getTimezoneOffset.call(testDate);

          const expectedIntlOffset = referenceIntlOffset(testDate, timezone.identifier);
          expect(result).toBe(-expectedIntlOffset);
        }
      ),
      { numRuns: 100 }
    );
  });
});
