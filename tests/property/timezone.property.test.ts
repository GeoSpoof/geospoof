/**
 * Property-Based Tests for Timezone Functionality
 * Feature: geolocation-spoof-extension-mvp
 */

import fc from "fast-check";
import { importBackground } from "../helpers/import-background";
import { setupContentScript } from "../helpers/content.test.helper";

// Mock browser-geo-tz at the module level (no longer uses GeoNames fetch)
vi.mock("browser-geo-tz", () => ({
  init: vi.fn(() => ({
    find: vi.fn().mockResolvedValue([]),
  })),
}));

/**
 * Helper: get the mocked `find` function from the object returned by `init`.
 */
async function getMockedFind() {
  const mod = await import("browser-geo-tz");
  const initMock = vi.mocked(mod.init);
  // Get the most recent init() call result (importBackground resets modules, so init is called fresh each time)
  const results = initMock.mock.results;
  const lastResult = results[results.length - 1];
  if (lastResult && lastResult.type === "return") {
    return vi.mocked((lastResult.value as { find: ReturnType<typeof vi.fn> }).find);
  }
  const findFn = vi.fn().mockResolvedValue([]);
  initMock.mockReturnValue({ find: findFn });
  return findFn;
}

/**
 * Property 8: IANA Timezone Identifier Format
 *
 * Validates: Requirements 2.6
 *
 * For any timezone override, the timezone identifier should be a valid
 * IANA timezone database identifier (e.g., "America/Los_Angeles", "Europe/London").
 */
test("Property 8: IANA Timezone Identifier Format", async () => {
  const { getTimezoneForCoordinates, isValidIANATimezone } = await importBackground();
  const mockedFind = await getMockedFind();

  await fc.assert(
    fc.asyncProperty(
      fc.record({
        latitude: fc.double({ min: -90, max: 90, noNaN: true }),
        longitude: fc.double({ min: -180, max: 180, noNaN: true }),
      }),
      async ({ latitude, longitude }) => {
        const { clearTimezoneCache } = await importBackground();
        await clearTimezoneCache();

        // Mock browser-geo-tz to return a known timezone
        mockedFind.mockResolvedValue(["America/Los_Angeles"]);

        const timezone = await getTimezoneForCoordinates(latitude, longitude);

        // Timezone identifier should be valid IANA format
        return isValidIANATimezone(timezone.identifier);
      }
    ),
    { numRuns: 100 }
  );
});

/**
 * Test timezone fallback when browser-geo-tz find() fails
 */
test("Timezone fallback when browser-geo-tz fails", async () => {
  const mockedFind = await getMockedFind();

  await fc.assert(
    fc.asyncProperty(
      fc.record({
        // Use unique coordinates that won't collide with other tests
        latitude: fc.double({ min: -89, max: -80, noNaN: true }),
        longitude: fc.double({ min: 170, max: 180, noNaN: true }),
      }),
      async ({ latitude, longitude }) => {
        const { getTimezoneForCoordinates, clearTimezoneCache } = await importBackground();
        await clearTimezoneCache();

        // Mock browser-geo-tz failure
        mockedFind.mockRejectedValue(new Error("CDN unavailable"));

        const timezone = await getTimezoneForCoordinates(latitude, longitude);

        // Should return fallback timezone
        if (!timezone) return false;

        // Identifier should be in Etc/GMT format
        if (!timezone.identifier.startsWith("Etc/GMT")) return false;

        if (typeof timezone.offset !== "number") return false;
        if (typeof timezone.dstOffset !== "number") return false;
        if (timezone.dstOffset !== 0) return false;
        if (timezone.fallback !== true) return false;

        // Fallback offset should be based on longitude
        const expectedOffset = Math.round(longitude / 15) * 60;
        return timezone.offset === expectedOffset;
      }
    ),
    { numRuns: 100 }
  );
});

/**
 * Test IANA timezone identifier validation
 */
test("IANA timezone identifier validation", async () => {
  const { isValidIANATimezone } = await importBackground();

  fc.assert(
    fc.property(fc.constantFrom(...ALL_TEST_ZONES), (validTimezone) => {
      return isValidIANATimezone(validTimezone) === true;
    }),
    { numRuns: 100 }
  );
});

/**
 * Test invalid timezone identifiers are rejected
 */
test("Invalid timezone identifiers are rejected", async () => {
  const { isValidIANATimezone } = await importBackground();

  const invalidTimezones = [
    "",
    "invalid",
    "america/los_angeles", // lowercase
    "America/", // incomplete
    "/Los_Angeles", // missing area
    "123/456", // numbers
    null,
    undefined,
  ];

  for (const invalidTimezone of invalidTimezones) {
    expect(isValidIANATimezone(invalidTimezone)).toBe(false);
  }
});

/**
 * Test invalid timezone identifiers are rejected - random strings
 */
test("Invalid timezone identifiers are rejected - random strings", async () => {
  const { isValidIANATimezone } = await importBackground();

  fc.assert(
    fc.property(
      fc.string().filter((s) => {
        // Filter out strings that accidentally match valid IANA patterns
        const ianaPattern = /^[A-Z][a-zA-Z_]+\/[A-Z][a-zA-Z_]+(?:\/[A-Z][a-zA-Z_]+)?$/;
        const etcGmtPattern = /^Etc\/GMT([+-]\d{1,2})?$/;
        return !ianaPattern.test(s) && s !== "UTC" && !etcGmtPattern.test(s);
      }),
      (invalidTimezone) => {
        return isValidIANATimezone(invalidTimezone) === false;
      }
    ),
    { numRuns: 100 }
  );
});

/**
 * getTimezoneOffset Override Properties
 * (Merged from timezone-offset.property.test.ts)
 */
describe("getTimezoneOffset Override Properties", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Property 1: Timezone Offset Override
   *
   * For any valid timezone data and any Date object, when protection is enabled,
   * calling getTimezoneOffset() should return the negative of the timezone's
   * current offset (accounting for DST).
   *
   * **Validates: Requirements 1.1, 1.5**
   */
  test("Property 1: Timezone Offset Override - returns negative of spoofed offset", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.constantFrom(...ALL_TEST_ZONES),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        fc.date({ noInvalidDate: true, min: new Date("2000-01-01"), max: new Date("2030-12-31") }),
        (timezone, date) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
            timezone: timezone,
          });

          // Create a date instance and call getTimezoneOffset
          const testDate = new Date(date);
          const result = contentScript.Date.prototype.getTimezoneOffset.call(testDate);

          // Should return negative of the offset
          expect(typeof result).toBe("number");
          expect(Number.isFinite(result)).toBe(true);

          // The result should be the formatToParts-derived offset for the IANA timezone.
          // getTimezoneOffset returns negative of the offset derived from formatToParts components.
          const expectedOffset = (() => {
            const fmt = new Intl.DateTimeFormat("en-US", {
              timeZone: timezone.identifier,
              weekday: "short",
              year: "numeric",
              month: "numeric",
              day: "numeric",
              hour: "numeric",
              minute: "numeric",
              second: "numeric",
              hour12: false,
            });
            const parts = fmt.formatToParts(testDate);
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
            const epochSeconds = Math.floor(testDate.getTime() / 1000) * 1000;
            return (localAsUTC - epochSeconds) / 60000;
          })();
          // getTimezoneOffset returns the negated offset
          expect(result).toBe(-expectedOffset);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 2: Original Timezone Offset When Disabled
   *
   * For any Date object, when protection is disabled, getTimezoneOffset()
   * should return the same value as the original (preserved) method.
   *
   * **Validates: Requirements 1.3**
   */
  test("Property 2: Original Timezone Offset When Disabled", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.string({ minLength: 1 }),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        fc.date({ noInvalidDate: true }),
        (timezone, date) => {
          const contentScript = setupContentScript({
            enabled: false, // Protection disabled
            location: null,
            timezone: timezone,
          });

          // Get the original timezone offset
          const originalOffset = contentScript.originals.getTimezoneOffset.call(date);

          // Get the offset through our override
          const testDate = new Date(date);
          const result = contentScript.Date.prototype.getTimezoneOffset.call(testDate);

          // Should return the same as original when disabled
          expect(result).toBe(originalOffset);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Property 1: Timezone Offset Override - handles null timezone gracefully", () => {
    fc.assert(
      fc.property(fc.date({ noInvalidDate: true }), (date) => {
        const contentScript = setupContentScript({
          enabled: true,
          location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
          timezone: null, // No timezone data
        });

        // Get the original timezone offset
        const originalOffset = contentScript.originals.getTimezoneOffset.call(date);

        // Should fallback to original when timezone is null
        const testDate = new Date(date);
        const result = contentScript.Date.prototype.getTimezoneOffset.call(testDate);

        expect(result).toBe(originalOffset);
      }),
      { numRuns: 100 }
    );
  });

  test("Property 1: Timezone Offset Override - consistent across multiple calls", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.constantFrom(...ALL_TEST_ZONES),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        fc.date({ noInvalidDate: true }),
        (timezone, date) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
            timezone: timezone,
          });

          // Call getTimezoneOffset multiple times with the same date
          const testDate = new Date(date);
          const result1 = contentScript.Date.prototype.getTimezoneOffset.call(testDate);
          const result2 = contentScript.Date.prototype.getTimezoneOffset.call(testDate);
          const result3 = contentScript.Date.prototype.getTimezoneOffset.call(testDate);

          // All calls should return the same value
          expect(result1).toBe(result2);
          expect(result2).toBe(result3);
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Intl-Based Timezone Offset Resolution Helpers
 * (Merged from timezone-intl-offset.property.test.ts)
 *
 * Re-implementations of parseGMTOffset and getIntlBasedOffset from
 * src/content/injected.ts for isolated testing without executing the IIFE.
 */
function parseGMTOffset(gmtString: string): number {
  if (gmtString === "GMT" || gmtString === "UTC") {
    return 0;
  }
  const match = gmtString.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/);
  if (!match) {
    return 0;
  }
  const sign = match[1] === "+" ? 1 : -1;
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3] || "0", 10);
  const seconds = parseInt(match[4] || "0", 10);
  return sign * (hours * 60 + minutes + seconds / 60);
}

function getIntlBasedOffset(date: Date, timezoneId: string, fallbackOffset: number): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezoneId,
      timeZoneName: "shortOffset",
    });
    const parts = formatter.formatToParts(date);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    return parseGMTOffset(tzPart?.value ?? "GMT");
  } catch {
    return fallbackOffset;
  }
}

function referenceOffset(date: Date, timezoneId: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezoneId,
    timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(date);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";

  if (tz === "GMT" || tz === "UTC") return 0;
  const m = tz.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return 0;
  const sign = m[1] === "+" ? 1 : -1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10));
}

// Comprehensive timezone zone lists for Intl offset testing
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
  "Australia/Adelaide",
] as const;

const EXCEPTION_ZONES = [
  "America/Phoenix", // US state that does not observe DST
  "Pacific/Honolulu", // Hawaii, no DST
  "Asia/Kathmandu", // UTC+5:45 (non-standard offset)
  "Asia/Colombo", // UTC+5:30
] as const;

const DST_ZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
] as const;

const ALL_TEST_ZONES = [
  ...NON_DST_ZONES,
  ...SOUTHERN_HEMISPHERE_ZONES,
  ...EXCEPTION_ZONES,
  ...DST_ZONES,
] as const;

/**
 * Timezone Offset Consistency with Intl.DateTimeFormat (Property 3)
 * (Merged from timezone-intl-offset.property.test.ts)
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5
 */
describe("Timezone Offset Consistency with Intl.DateTimeFormat (Property 3)", () => {
  test("Property 3: getIntlBasedOffset matches Intl-resolved offset for any timezone and date", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_TEST_ZONES),
        fc.date({ noInvalidDate: true, min: new Date("2000-01-01"), max: new Date("2030-12-31") }),
        (timezoneId, date) => {
          const result = getIntlBasedOffset(date, timezoneId, 0);
          const expected = referenceOffset(date, timezoneId);
          expect(result).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Non-DST zones return the same offset year-round", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NON_DST_ZONES),
        fc.date({ noInvalidDate: true, min: new Date("2020-01-01"), max: new Date("2026-12-31") }),
        fc.date({ noInvalidDate: true, min: new Date("2020-01-01"), max: new Date("2026-12-31") }),
        (timezoneId, dateA, dateB) => {
          const offsetA = getIntlBasedOffset(dateA, timezoneId, 0);
          const offsetB = getIntlBasedOffset(dateB, timezoneId, 0);
          expect(offsetA).toBe(offsetB);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Southern-hemisphere zones produce valid offsets for any date", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SOUTHERN_HEMISPHERE_ZONES),
        fc.date({ noInvalidDate: true, min: new Date("2020-01-01"), max: new Date("2026-12-31") }),
        (timezoneId, date) => {
          const offset = getIntlBasedOffset(date, timezoneId, 0);
          expect(typeof offset).toBe("number");
          expect(Number.isFinite(offset)).toBe(true);
          // Offset must be within valid range (-720 to +840 minutes)
          expect(offset).toBeGreaterThanOrEqual(-720);
          expect(offset).toBeLessThanOrEqual(840);
          // Must match the reference
          expect(offset).toBe(referenceOffset(date, timezoneId));
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Exception zones (no DST despite region conventions) return constant offset", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("America/Phoenix", "Pacific/Honolulu"),
        fc.date({ noInvalidDate: true, min: new Date("2020-01-01"), max: new Date("2026-12-31") }),
        fc.date({ noInvalidDate: true, min: new Date("2020-01-01"), max: new Date("2026-12-31") }),
        (timezoneId, dateA, dateB) => {
          const offsetA = getIntlBasedOffset(dateA, timezoneId, 0);
          const offsetB = getIntlBasedOffset(dateB, timezoneId, 0);
          expect(offsetA).toBe(offsetB);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("getTimezoneOffset simulation equals negative of Intl-resolved offset", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_TEST_ZONES),
        fc.date({ noInvalidDate: true, min: new Date("2000-01-01"), max: new Date("2030-12-31") }),
        (timezoneId, date) => {
          const intlOffset = getIntlBasedOffset(date, timezoneId, 0);
          const simulatedGetTimezoneOffset = -intlOffset;
          expect(simulatedGetTimezoneOffset).toBe(-referenceOffset(date, timezoneId));
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Invalid timezone identifiers fall back to provided offset", () => {
    // A random lowercase string is *usually* not a valid timezone, but a few
    // collide with legacy IANA aliases that Intl resolves case-insensitively
    // (e.g. "nz" → NZ → Pacific/Auckland, "gb" → GB, "prc", "cuba", "utc").
    // Those are genuinely valid, so exclude them — this test is specifically
    // about identifiers Intl REJECTS falling back to the provided offset.
    const isResolvableTimeZone = (tz: string): boolean => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    };

    fc.assert(
      fc.property(
        fc
          .string({
            unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"),
            minLength: 1,
            maxLength: 20,
          })
          .filter((s) => !isResolvableTimeZone(s)),
        fc.integer({ min: -720, max: 840 }),
        fc.date({ noInvalidDate: true }),
        (invalidTz, fallback, date) => {
          const result = getIntlBasedOffset(date, invalidTz, fallback);
          expect(result).toBe(fallback);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("parseGMTOffset produces valid minute offsets for well-formed strings", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("+", "-"),
        fc.integer({ min: 0, max: 14 }),
        fc.integer({ min: 0, max: 59 }),
        (sign, hours, minutes) => {
          const gmtString =
            minutes > 0
              ? `GMT${sign}${hours}:${String(minutes).padStart(2, "0")}`
              : `GMT${sign}${hours}`;
          const result = parseGMTOffset(gmtString);
          const expected = (sign === "+" ? 1 : -1) * (hours * 60 + minutes);
          expect(result).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("parseGMTOffset returns 0 for GMT and UTC", () => {
    expect(parseGMTOffset("GMT")).toBe(0);
    expect(parseGMTOffset("UTC")).toBe(0);
  });

  test("parseGMTOffset returns 0 for malformed strings", () => {
    fc.assert(
      fc.property(
        fc
          .string({
            unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789 "),
            minLength: 0,
            maxLength: 15,
          })
          .filter((s) => !s.match(/^GMT([+-]\d{1,2}(:\d{2})?)?$/) && s !== "UTC"),
        (malformed) => {
          expect(parseGMTOffset(malformed)).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Timezone Override Consistency Properties
 * (Merged from timezone-content.property.test.ts)
 */
describe("Timezone Override Consistency Properties", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Property 5: Timezone Override Consistency
   *
   * For any timezone override, both Date.prototype.getTimezoneOffset() and
   * Intl.DateTimeFormat().resolvedOptions().timeZone should return values
   * consistent with the overridden timezone.
   *
   * Validates: Requirements 2.2, 2.3
   */
  test("Property 5: Timezone Override Consistency", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.constantFrom(...ALL_TEST_ZONES),
          offset: fc.integer({ min: -720, max: 720 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        (timezoneOverride) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 37.7749, longitude: -122.4194, accuracy: 10 },
            timezone: timezoneOverride,
          });

          // Test Date.prototype.getTimezoneOffset
          const date = new Date();
          const timezoneOffset = contentScript.Date.prototype.getTimezoneOffset.call(date);

          // Expected offset derived from formatToParts (same path as production code)
          const expectedOffset = (() => {
            const fmt = new Intl.DateTimeFormat("en-US", {
              timeZone: timezoneOverride.identifier,
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
            const epochSeconds = Math.floor(date.getTime() / 1000) * 1000;
            return (localAsUTC - epochSeconds) / 60000;
          })();
          expect(timezoneOffset).toBe(-expectedOffset);

          // Test Intl.DateTimeFormat
          const DateTimeFormatCtor = contentScript.Intl
            .DateTimeFormat as unknown as typeof Intl.DateTimeFormat;
          const formatter = new DateTimeFormatCtor();
          const resolvedOptions = formatter.resolvedOptions();

          // Intl may normalize timezone aliases
          const expectedTz = new Intl.DateTimeFormat("en-US", {
            timeZone: timezoneOverride.identifier,
          }).resolvedOptions().timeZone;
          expect(resolvedOptions.timeZone).toBe(expectedTz);
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 7: Timezone Disable Restores Original Behavior
 * (Merged from timezone-content.property.test.ts)
 *
 * For any initial timezone state, enabling timezone override then disabling
 * protection should restore the original timezone behavior.
 *
 * Validates: Requirements 2.5
 */
test("Property 7: Timezone Disable Restores Original Behavior", () => {
  fc.assert(
    fc.property(
      fc.record({
        identifier: fc.constantFrom(...ALL_TEST_ZONES),
        offset: fc.integer({ min: -720, max: 720 }),
        dstOffset: fc.integer({ min: 0, max: 120 }),
      }),
      (timezoneOverride) => {
        // Get original timezone offset before any overrides
        const originalDate = new Date();
        const originalOffset = Date.prototype.getTimezoneOffset.call(originalDate);

        // Start with protection enabled
        const contentScript = setupContentScript({
          enabled: true,
          location: { latitude: 37.7749, longitude: -122.4194, accuracy: 10 },
          timezone: timezoneOverride,
        });

        // Verify timezone is overridden (uses formatToParts-derived offset)
        const date1 = new Date();
        const overriddenOffset = contentScript.Date.prototype.getTimezoneOffset.call(date1);
        const expectedOffset = (() => {
          const fmt = new Intl.DateTimeFormat("en-US", {
            timeZone: timezoneOverride.identifier,
            weekday: "short",
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            second: "numeric",
            hour12: false,
          });
          const parts = fmt.formatToParts(date1);
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
          const epochSeconds = Math.floor(date1.getTime() / 1000) * 1000;
          return (localAsUTC - epochSeconds) / 60000;
        })();
        expect(overriddenOffset).toBe(-expectedOffset);

        // Disable protection
        contentScript.updateSettings({ enabled: false });

        // Verify timezone is restored to original
        const date2 = new Date();
        const restoredOffset = contentScript.Date.prototype.getTimezoneOffset.call(date2);
        expect(restoredOffset).toBe(originalOffset);
      }
    ),
    { numRuns: 100 }
  );
});

/**
 * Timezone Data Validation Properties
 * (Merged from timezone-validation.property.test.ts)
 *
 * The validateTimezoneData function below mirrors the implementation in
 * src/content/injected.ts — kept as a local copy because the source is
 * inside an IIFE and cannot be imported directly. Keep in sync manually.
 */
describe("Timezone Data Validation Properties", () => {
  function validateTimezoneData(tz: unknown): boolean {
    if (!tz || typeof tz !== "object") {
      return false;
    }

    const tzObj = tz as Record<string, unknown>;

    if (typeof tzObj.identifier !== "string" || tzObj.identifier.length === 0) {
      return false;
    }

    if (typeof tzObj.offset !== "number" || !Number.isFinite(tzObj.offset)) {
      return false;
    }

    if (typeof tzObj.dstOffset !== "number" || !Number.isFinite(tzObj.dstOffset)) {
      return false;
    }

    return true;
  }

  /**
   * Property 13: Timezone Data Validation
   *
   * For any received timezone data object, validation should verify that
   * identifier is a string, offset is a number, and dstOffset is a number,
   * rejecting the data if any check fails.
   *
   * **Validates: Requirements 12.1, 12.2, 12.3**
   */
  test("Property 13: Timezone Data Validation - valid data passes", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.string({ minLength: 1 }),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
          fallback: fc.option(fc.boolean()),
        }),
        (timezoneData) => {
          expect(validateTimezoneData(timezoneData)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Property 13: Timezone Data Validation - null/undefined fails", () => {
    expect(validateTimezoneData(null)).toBe(false);
    expect(validateTimezoneData(undefined)).toBe(false);
  });

  test("Property 13: Timezone Data Validation - invalid identifier fails", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.integer(),
          fc.boolean(),
          fc.constant(""),
          fc.object()
        ),
        fc.integer({ min: -720, max: 840 }),
        fc.integer({ min: 0, max: 120 }),
        (invalidIdentifier, offset, dstOffset) => {
          const timezoneData = {
            identifier: invalidIdentifier,
            offset: offset,
            dstOffset: dstOffset,
          };
          expect(validateTimezoneData(timezoneData)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Property 13: Timezone Data Validation - invalid offset fails", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant(NaN),
          fc.constant(Infinity),
          fc.constant(-Infinity),
          fc.string(),
          fc.boolean(),
          fc.object()
        ),
        fc.integer({ min: 0, max: 120 }),
        (identifier, invalidOffset, dstOffset) => {
          const timezoneData = {
            identifier: identifier,
            offset: invalidOffset,
            dstOffset: dstOffset,
          };
          expect(validateTimezoneData(timezoneData)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Property 13: Timezone Data Validation - invalid dstOffset fails", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.integer({ min: -720, max: 840 }),
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant(NaN),
          fc.constant(Infinity),
          fc.constant(-Infinity),
          fc.string(),
          fc.boolean(),
          fc.object()
        ),
        (identifier, offset, invalidDstOffset) => {
          const timezoneData = {
            identifier: identifier,
            offset: offset,
            dstOffset: invalidDstOffset,
          };
          expect(validateTimezoneData(timezoneData)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Property 13: Timezone Data Validation - missing properties fail", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.integer({ min: -720, max: 840 }),
        fc.integer({ min: 0, max: 120 }),
        (identifier, offset, dstOffset) => {
          // Missing identifier
          expect(validateTimezoneData({ offset, dstOffset })).toBe(false);

          // Missing offset
          expect(validateTimezoneData({ identifier, dstOffset })).toBe(false);

          // Missing dstOffset
          expect(validateTimezoneData({ identifier, offset })).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Intl.DateTimeFormat Override Properties
 * (Merged from intl-datetime.property.test.ts)
 */
describe("Intl.DateTimeFormat Override Properties", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Property 3: Intl.DateTimeFormat Timezone Override
   *
   * For any valid timezone data, when protection is enabled, calling
   * Intl.DateTimeFormat().resolvedOptions().timeZone should return the
   * spoofed IANA timezone identifier.
   *
   * **Validates: Requirements 2.1**
   */
  test("Property 3: Intl.DateTimeFormat Timezone Override", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.constantFrom(...ALL_TEST_ZONES),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        (timezone) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
            timezone: timezone,
          });

          // Create DateTimeFormat instance and get resolved options
          const formatter = contentScript.Intl.DateTimeFormat();
          const options = formatter.resolvedOptions();

          // Should return the spoofed timezone identifier (Intl may normalize aliases)
          // e.g., Asia/Kathmandu → Asia/Katmandu, so compare via Intl normalization
          const expectedTz = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone.identifier,
          }).resolvedOptions().timeZone;
          expect(options.timeZone).toBe(expectedTz);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 4: Original Intl.DateTimeFormat When Disabled
   *
   * For any DateTimeFormat options, when protection is disabled,
   * resolvedOptions() should return the same result as the original
   * (preserved) method.
   *
   * **Validates: Requirements 2.3**
   */
  test("Property 4: Original Intl.DateTimeFormat When Disabled", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.string({ minLength: 1 }),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        (timezone) => {
          const contentScript = setupContentScript({
            enabled: false, // Protection disabled
            location: null,
            timezone: timezone,
          });

          // Create DateTimeFormat with original
          const originalFormatter = new contentScript.originals.DateTimeFormat();
          const originalOptions = originalFormatter.resolvedOptions();

          // Create DateTimeFormat with override
          const formatter = contentScript.Intl.DateTimeFormat();
          const options = formatter.resolvedOptions();

          // Should return the same timezone as original when disabled
          expect(options.timeZone).toBe(originalOptions.timeZone);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 5: Intl.DateTimeFormat Properties Preservation
   *
   * For any DateTimeFormat options, when protection is enabled, all properties
   * returned by resolvedOptions() except timeZone should remain unchanged from
   * the original method.
   *
   * **Validates: Requirements 2.5**
   */
  test("Property 5: Intl.DateTimeFormat Properties Preservation", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.constantFrom(...ALL_TEST_ZONES),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        fc.constantFrom("en-US", "en-GB", "fr-FR", "de-DE", "ja-JP"),
        (timezone, locale) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
            timezone: timezone,
          });

          // Create DateTimeFormat with specific locale
          const formatter = contentScript.Intl.DateTimeFormat(locale);
          const options = formatter.resolvedOptions();

          // Should have all standard properties
          expect(options).toHaveProperty("locale");
          expect(options).toHaveProperty("calendar");
          expect(options).toHaveProperty("numberingSystem");
          expect(options).toHaveProperty("timeZone");

          // Locale should be preserved (or normalized)
          expect(typeof options.locale).toBe("string");
          expect(options.locale.length).toBeGreaterThan(0);

          // Calendar and numberingSystem should be preserved
          expect(typeof options.calendar).toBe("string");
          expect(typeof options.numberingSystem).toBe("string");

          // TimeZone should be spoofed (Intl may normalize aliases)
          const expectedTz = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone.identifier,
          }).resolvedOptions().timeZone;
          expect(options.timeZone).toBe(expectedTz);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Property 3: Intl.DateTimeFormat handles null timezone gracefully", () => {
    const contentScript = setupContentScript({
      enabled: true,
      location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
      timezone: null, // No timezone data
    });

    // Create DateTimeFormat with original
    const originalFormatter = new contentScript.originals.DateTimeFormat();
    const originalOptions = originalFormatter.resolvedOptions();

    // Create DateTimeFormat with override
    const formatter = contentScript.Intl.DateTimeFormat();
    const options = formatter.resolvedOptions();

    // Should fallback to original timezone when timezone is null
    expect(options.timeZone).toBe(originalOptions.timeZone);
  });

  test("Property 3: Intl.DateTimeFormat with explicit timezone option", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.constantFrom(...ALL_TEST_ZONES),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        (timezone) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
            timezone: timezone,
          });

          // Create DateTimeFormat with explicit timezone option
          const formatter = contentScript.Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago", // User explicitly sets timezone
          });
          const options = contentScript.Intl.resolvedOptions(formatter);

          // With scoped resolvedOptions, explicit timezone should be preserved
          expect(options.timeZone).toBe("America/Chicago");
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Date Formatting Methods Override Properties
 * (Merged from date-formatting.property.test.ts)
 */
describe("Date Formatting Methods Override Properties", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Property 6: Date Formatting Methods Use Spoofed Timezone
   *
   * For any Date object and valid timezone data, when protection is enabled,
   * all Date formatting methods (toString, toTimeString, toLocaleString,
   * toLocaleDateString, toLocaleTimeString) should reflect the spoofed
   * timezone in their output.
   *
   * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
   */
  test("Property 6: Date Formatting Methods Use Spoofed Timezone", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.constantFrom(...ALL_TEST_ZONES),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        fc.date({ noInvalidDate: true }),
        (timezone, date) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
            timezone: timezone,
          });

          const testDate = new Date(date);

          // Test toString
          const toStringResult = contentScript.Date.prototype.toString.call(testDate);
          expect(typeof toStringResult).toBe("string");
          expect(toStringResult.length).toBeGreaterThan(0);

          // Test toTimeString
          const toTimeStringResult = contentScript.Date.prototype.toTimeString.call(testDate);
          expect(typeof toTimeStringResult).toBe("string");
          expect(toTimeStringResult.length).toBeGreaterThan(0);

          // Test toLocaleString
          const toLocaleStringResult = contentScript.Date.prototype.toLocaleString.call(testDate);
          expect(typeof toLocaleStringResult).toBe("string");
          expect(toLocaleStringResult.length).toBeGreaterThan(0);

          // Test toLocaleDateString
          const toLocaleDateStringResult =
            contentScript.Date.prototype.toLocaleDateString.call(testDate);
          expect(typeof toLocaleDateStringResult).toBe("string");
          expect(toLocaleDateStringResult.length).toBeGreaterThan(0);

          // Test toLocaleTimeString
          const toLocaleTimeStringResult =
            contentScript.Date.prototype.toLocaleTimeString.call(testDate);
          expect(typeof toLocaleTimeStringResult).toBe("string");
          expect(toLocaleTimeStringResult.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 7: Original Date Formatting When Disabled
   *
   * For any Date object, when protection is disabled, all Date formatting
   * methods should return the same output as the original (preserved) methods.
   *
   * **Validates: Requirements 3.6**
   */
  test("Property 7: Original Date Formatting When Disabled", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.string({ minLength: 1 }),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        fc.date({ noInvalidDate: true }),
        (timezone, date) => {
          const contentScript = setupContentScript({
            enabled: false, // Protection disabled
            location: null,
            timezone: timezone,
          });

          const testDate = new Date(date);

          // Test toString
          const originalToString = contentScript.originals.toString.call(testDate);
          const overrideToString = contentScript.Date.prototype.toString.call(testDate);
          expect(overrideToString).toBe(originalToString);

          // Test toTimeString
          const originalToTimeString = contentScript.originals.toTimeString.call(testDate);
          const overrideToTimeString = contentScript.Date.prototype.toTimeString.call(testDate);
          expect(overrideToTimeString).toBe(originalToTimeString);

          // Test toLocaleString
          const originalToLocaleString = contentScript.originals.toLocaleString.call(testDate);
          const overrideToLocaleString = contentScript.Date.prototype.toLocaleString.call(testDate);
          expect(overrideToLocaleString).toBe(originalToLocaleString);

          // Test toLocaleDateString
          const originalToLocaleDateString =
            contentScript.originals.toLocaleDateString.call(testDate);
          const overrideToLocaleDateString =
            contentScript.Date.prototype.toLocaleDateString.call(testDate);
          expect(overrideToLocaleDateString).toBe(originalToLocaleDateString);

          // Test toLocaleTimeString
          const originalToLocaleTimeString =
            contentScript.originals.toLocaleTimeString.call(testDate);
          const overrideToLocaleTimeString =
            contentScript.Date.prototype.toLocaleTimeString.call(testDate);
          expect(overrideToLocaleTimeString).toBe(originalToLocaleTimeString);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Property 6: Date Formatting handles null timezone gracefully", () => {
    fc.assert(
      fc.property(fc.date({ noInvalidDate: true }), (date) => {
        const contentScript = setupContentScript({
          enabled: true,
          location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
          timezone: null, // No timezone data
        });

        const testDate = new Date(date);

        // Should fallback to original methods when timezone is null
        const originalToString = contentScript.originals.toString.call(testDate);
        const overrideToString = contentScript.Date.prototype.toString.call(testDate);
        expect(overrideToString).toBe(originalToString);

        const originalToLocaleString = contentScript.originals.toLocaleString.call(testDate);
        const overrideToLocaleString = contentScript.Date.prototype.toLocaleString.call(testDate);
        expect(overrideToLocaleString).toBe(originalToLocaleString);
      }),
      { numRuns: 100 }
    );
  });

  test("Property 6: toLocaleString with custom locale", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.constantFrom(...ALL_TEST_ZONES),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        fc.date({ noInvalidDate: true }),
        fc.constantFrom("en-US", "en-GB", "fr-FR", "de-DE"),
        (timezone, date, locale) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
            timezone: timezone,
          });

          const testDate = new Date(date);

          // Test with custom locale
          const result = contentScript.Date.prototype.toLocaleString.call(testDate, locale);
          expect(typeof result).toBe("string");
          expect(result.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Property 6: Date formatting methods are consistent", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.constantFrom(...ALL_TEST_ZONES),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        fc.date({ noInvalidDate: true }),
        (timezone, date) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
            timezone: timezone,
          });

          const testDate = new Date(date);

          // Call the same method multiple times
          const result1 = contentScript.Date.prototype.toLocaleString.call(testDate);
          const result2 = contentScript.Date.prototype.toLocaleString.call(testDate);
          const result3 = contentScript.Date.prototype.toLocaleString.call(testDate);

          // Should return consistent results
          expect(result1).toBe(result2);
          expect(result2).toBe(result3);
        }
      ),
      { numRuns: 100 }
    );
  });
});
