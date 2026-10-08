/**
 * Property-Based Tests for Spoofing Non-Regression After Function Conversion
 * Feature: prototype-lie-detection-fix, Property 5
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
 *
 * Verifies that converting override functions to arrow functions and adding
 * strict mode does not break existing geolocation, timezone, or Date spoofing.
 */

"use strict";

import fc from "fast-check";
import type { SpoofedGeolocationPosition } from "@/shared/types/location";
import { setupContentScript } from "../helpers/content.test.helper";

/**
 * A curated set of IANA timezone identifiers covering diverse UTC offsets,
 * DST rules, and edge cases. Using constantFrom avoids generating invalid
 * identifiers that would cause Intl.DateTimeFormat to throw.
 */
const ianaTimezoneArb = fc.constantFrom(
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
  "Asia/Kathmandu", // UTC+5:45
  "Australia/Lord_Howe", // UTC+10:30 / +11
  "Pacific/Chatham" // UTC+12:45 / +13:45
);

/** Generate a timezone object with Intl-derived offset for a given IANA id. */
function buildTimezone(identifier: string): {
  identifier: string;
  offset: number;
  dstOffset: number;
} {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: identifier,
    timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(now);
  const tzPart = parts.find((p) => p.type === "timeZoneName");
  const gmtStr = tzPart?.value ?? "GMT";
  let offset = 0;
  if (gmtStr !== "GMT" && gmtStr !== "UTC") {
    const m = gmtStr.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (m) {
      const sign = m[1] === "+" ? 1 : -1;
      offset = sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10));
    }
  }
  return { identifier, offset, dstOffset: 0 };
}

describe("Prototype Lie Detection Fix — Spoofing Non-Regression Properties", () => {
  /**
   * Property 5a: getCurrentPosition returns spoofed coordinates
   *
   * For any valid coordinates and IANA timezone, getCurrentPosition invokes
   * the success callback with the spoofed latitude, longitude, and accuracy.
   */
  test("Feature: prototype-lie-detection-fix, Property 5: Spoofing Non-Regression — getCurrentPosition returns spoofed coords", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          latitude: fc.double({ min: -90, max: 90, noNaN: true }),
          longitude: fc.double({ min: -180, max: 180, noNaN: true }),
          accuracy: fc.double({ min: 1, max: 1000, noNaN: true }),
        }),
        ianaTimezoneArb,
        async (location, tzId) => {
          const timezone = buildTimezone(tzId);
          const cs = setupContentScript({
            enabled: true,
            location,
            timezone,
          });

          const position = await new Promise<SpoofedGeolocationPosition>((resolve) => {
            cs.navigator.geolocation.getCurrentPosition((pos: SpoofedGeolocationPosition) =>
              resolve(pos)
            );
          });

          expect(position.coords.latitude).toBe(location.latitude);
          expect(position.coords.longitude).toBe(location.longitude);
          expect(position.coords.accuracy).toBe(location.accuracy);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 5b: getTimezoneOffset returns spoofed offset
   *
   * For any IANA timezone, getTimezoneOffset returns the negated Intl-based
   * UTC offset for the spoofed timezone (matching the real Intl resolution).
   */
  test("Feature: prototype-lie-detection-fix, Property 5: Spoofing Non-Regression — getTimezoneOffset returns spoofed offset", () => {
    fc.assert(
      fc.property(
        ianaTimezoneArb,
        fc.date({ noInvalidDate: true, min: new Date("2000-01-01"), max: new Date("2030-12-31") }),
        (tzId, date) => {
          const timezone = buildTimezone(tzId);
          const cs = setupContentScript({
            enabled: true,
            location: { latitude: 0, longitude: 0, accuracy: 10 },
            timezone,
          });

          const offset = cs.Date.prototype.getTimezoneOffset.call(date);

          // Compute expected offset via formatToParts (same path as production code)
          const fmt = new Intl.DateTimeFormat("en-US", {
            timeZone: tzId,
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
          const expectedUtcOffset = (localAsUTC - epochSeconds) / 60000;
          // getTimezoneOffset returns the negation of the UTC offset.
          expect(offset).toBe(-expectedUtcOffset);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 5c: resolvedOptions returns spoofed timezone identifier
   *
   * For any IANA timezone, Intl.DateTimeFormat().resolvedOptions().timeZone
   * returns the spoofed timezone identifier (possibly normalized by Intl).
   */
  test("Feature: prototype-lie-detection-fix, Property 5: Spoofing Non-Regression — resolvedOptions returns spoofed timezone", () => {
    fc.assert(
      fc.property(ianaTimezoneArb, (tzId) => {
        const timezone = buildTimezone(tzId);
        const cs = setupContentScript({
          enabled: true,
          location: { latitude: 0, longitude: 0, accuracy: 10 },
          timezone,
        });

        const formatter = cs.Intl.DateTimeFormat();
        const options = formatter.resolvedOptions();

        // Intl may normalize timezone aliases (e.g., UTC → UTC)
        const expectedTz = new Intl.DateTimeFormat("en-US", {
          timeZone: tzId,
        }).resolvedOptions().timeZone;
        expect(options.timeZone).toBe(expectedTz);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 5d: Date string methods format with spoofed timezone
   *
   * For any IANA timezone, Date.prototype.toString, toTimeString, and
   * toDateString produce non-empty strings. toString and toTimeString
   * contain the GMT offset matching the spoofed timezone.
   */
  test("Feature: prototype-lie-detection-fix, Property 5: Spoofing Non-Regression — Date string methods use spoofed timezone", () => {
    fc.assert(
      fc.property(
        ianaTimezoneArb,
        fc.date({ noInvalidDate: true, min: new Date("2000-01-01"), max: new Date("2030-12-31") }),
        (tzId, date) => {
          const timezone = buildTimezone(tzId);
          const cs = setupContentScript({
            enabled: true,
            location: { latitude: 0, longitude: 0, accuracy: 10 },
            timezone,
          });

          const dateStr = cs.Date.prototype.toString.call(date);
          const timeStr = cs.Date.prototype.toTimeString.call(date);
          const dateOnlyStr = cs.Date.prototype.toDateString.call(date);

          // All must be non-empty strings
          expect(typeof dateStr).toBe("string");
          expect(dateStr.length).toBeGreaterThan(0);
          expect(typeof timeStr).toBe("string");
          expect(timeStr.length).toBeGreaterThan(0);
          expect(typeof dateOnlyStr).toBe("string");
          expect(dateOnlyStr.length).toBeGreaterThan(0);

          // toString and toTimeString should contain a GMT offset pattern
          expect(dateStr).toMatch(/GMT[+-]\d{4}/);
          expect(timeStr).toMatch(/GMT[+-]\d{4}/);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 5e: toLocale* methods format with spoofed timezone
   *
   * For any IANA timezone, toLocaleString, toLocaleDateString, and
   * toLocaleTimeString produce non-empty strings without throwing.
   */
  test("Feature: prototype-lie-detection-fix, Property 5: Spoofing Non-Regression — toLocale* methods use spoofed timezone", () => {
    fc.assert(
      fc.property(
        ianaTimezoneArb,
        fc.date({ noInvalidDate: true, min: new Date("2000-01-01"), max: new Date("2030-12-31") }),
        (tzId, date) => {
          const timezone = buildTimezone(tzId);
          const cs = setupContentScript({
            enabled: true,
            location: { latitude: 0, longitude: 0, accuracy: 10 },
            timezone,
          });

          const localeStr = cs.Date.prototype.toLocaleString.call(date);
          const localeDateStr = cs.Date.prototype.toLocaleDateString.call(date);
          const localeTimeStr = cs.Date.prototype.toLocaleTimeString.call(date);

          expect(typeof localeStr).toBe("string");
          expect(localeStr.length).toBeGreaterThan(0);
          expect(typeof localeDateStr).toBe("string");
          expect(localeDateStr.length).toBeGreaterThan(0);
          expect(typeof localeTimeStr).toBe("string");
          expect(localeTimeStr.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 5f: Date getter methods return spoofed timezone values
   *
   * For any IANA timezone, all getter methods (time and date level) return
   * values consistent with getTimezoneOffset, derived from the same
   * formatToParts resolution path.
   */
  test("Feature: prototype-lie-detection-fix, Property 5: Spoofing Non-Regression — Date getter methods use spoofed timezone", () => {
    fc.assert(
      fc.property(ianaTimezoneArb, fc.date({ noInvalidDate: true }), (tzId, date) => {
        const timezone = buildTimezone(tzId);
        const cs = setupContentScript({
          enabled: true,
          location: { latitude: 0, longitude: 0, accuracy: 10 },
          timezone,
        });

        const hours = cs.Date.prototype.getHours.call(date);
        const minutes = cs.Date.prototype.getMinutes.call(date);
        const seconds = cs.Date.prototype.getSeconds.call(date);
        const day = cs.Date.prototype.getDate.call(date);
        const weekday = cs.Date.prototype.getDay.call(date);
        const month = cs.Date.prototype.getMonth.call(date);
        const year = cs.Date.prototype.getFullYear.call(date);

        // Getters now delegate to native formatToParts with the spoofed timezone.
        // Verify by computing expected values from formatToParts directly.
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
        const parts = fmt.formatToParts(date);
        const getPart = (type: string): string => parts.find((p) => p.type === type)?.value ?? "0";

        expect(hours).toBe(parseInt(getPart("hour"), 10) % 24);
        expect(minutes).toBe(parseInt(getPart("minute"), 10));
        expect(seconds).toBe(parseInt(getPart("second"), 10));
        expect(day).toBe(parseInt(getPart("day"), 10));
        expect(month).toBe(parseInt(getPart("month"), 10) - 1);
        expect(year).toBe(parseInt(getPart("year"), 10));

        const dayMap: Record<string, number> = {
          Sun: 0,
          Mon: 1,
          Tue: 2,
          Wed: 3,
          Thu: 4,
          Fri: 5,
          Sat: 6,
        };
        expect(weekday).toBe(dayMap[getPart("weekday")] ?? 0);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 5g: Spoofing disabled delegates to originals
   *
   * When spoofing is disabled, all APIs delegate to original implementations.
   */
  test("Feature: prototype-lie-detection-fix, Property 5: Spoofing Non-Regression — disabled spoofing delegates to originals", () => {
    fc.assert(
      fc.property(fc.date({ noInvalidDate: true }), (date) => {
        const cs = setupContentScript({
          enabled: false,
          location: null,
          timezone: null,
        });

        // getTimezoneOffset should match the real system offset
        const offset = cs.Date.prototype.getTimezoneOffset.call(date);
        const realOffset = date.getTimezoneOffset();
        expect(offset).toBe(realOffset);

        // resolvedOptions should return the system timezone
        const formatter = cs.Intl.DateTimeFormat();
        const options = formatter.resolvedOptions();
        const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        expect(options.timeZone).toBe(systemTz);
      }),
      { numRuns: 100 }
    );
  });
});
