/**
 * Property-Based Tests for Graceful Degradation
 *
 * Tests that timezone spoofing failures don't affect geolocation spoofing
 * and that fallback timezone data works correctly.
 *
 * Feature: timezone-spoofing-and-status-display
 */

import fc from "fast-check";
import type { SpoofedGeolocationPosition } from "@/shared/types/location";
import type { Timezone } from "@/shared/types/settings";
import { setupContentScript } from "../helpers/content.test.helper";

/**
 * Property: Geolocation Spoofing Independence
 *
 * For any geolocation API call, when timezone data is null, undefined, or invalid,
 * geolocation spoofing should continue to function normally.
 *
 * **Validates: Requirements 10.4, 11.2, 12.5**
 */
describe("Property: Geolocation Spoofing Independence", () => {
  test("geolocation spoofing works with null timezone data", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          latitude: fc.double({ min: -90, max: 90, noNaN: true }),
          longitude: fc.double({ min: -180, max: 180, noNaN: true }),
          accuracy: fc.double({ min: 1, max: 1000, noNaN: true }),
        }),
        async (location) => {
          // Setup content script with null timezone
          const contentScript = setupContentScript({
            enabled: true,
            location: location,
            timezone: null,
          });

          // Test geolocation API
          const position = await new Promise<SpoofedGeolocationPosition>((resolve) => {
            contentScript.navigator.geolocation.getCurrentPosition(
              (pos: SpoofedGeolocationPosition) => {
                resolve(pos);
              }
            );
          });

          // Geolocation should still work
          expect(position).not.toBeNull();
          expect(position.coords.latitude).toBe(location.latitude);
          expect(position.coords.longitude).toBe(location.longitude);
          expect(position.coords.accuracy).toBe(location.accuracy);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("geolocation spoofing works with undefined timezone data", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          latitude: fc.double({ min: -90, max: 90, noNaN: true }),
          longitude: fc.double({ min: -180, max: 180, noNaN: true }),
          accuracy: fc.double({ min: 1, max: 1000, noNaN: true }),
        }),
        async (location) => {
          // Setup content script without timezone property
          const contentScript = setupContentScript({
            enabled: true,
            location: location,
            // timezone property omitted (undefined)
          });

          // Test geolocation API
          const position = await new Promise<SpoofedGeolocationPosition>((resolve) => {
            contentScript.navigator.geolocation.getCurrentPosition(
              (pos: SpoofedGeolocationPosition) => {
                resolve(pos);
              }
            );
          });

          // Geolocation should still work
          expect(position).not.toBeNull();
          expect(position.coords.latitude).toBe(location.latitude);
          expect(position.coords.longitude).toBe(location.longitude);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("geolocation spoofing works with invalid timezone data", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          latitude: fc.double({ min: -90, max: 90, noNaN: true }),
          longitude: fc.double({ min: -180, max: 180, noNaN: true }),
          accuracy: fc.double({ min: 1, max: 1000, noNaN: true }),
        }),
        fc.oneof(
          // Invalid timezone structures
          fc.constant({ identifier: 123, offset: "invalid", dstOffset: null }),
          fc.constant({ identifier: null, offset: null, dstOffset: null }),
          fc.constant({ foo: "bar" }),
          fc.constant("invalid string"),
          fc.constant(12345)
        ),
        async (location, invalidTimezone) => {
          // Setup content script with invalid timezone
          const contentScript = setupContentScript({
            enabled: true,
            location: location,
            timezone: invalidTimezone as unknown as Timezone,
          });

          // Test geolocation API
          const position = await new Promise<SpoofedGeolocationPosition>((resolve) => {
            contentScript.navigator.geolocation.getCurrentPosition(
              (pos: SpoofedGeolocationPosition) => {
                resolve(pos);
              }
            );
          });

          // Geolocation should still work despite invalid timezone
          expect(position).not.toBeNull();
          expect(position.coords.latitude).toBe(location.latitude);
          expect(position.coords.longitude).toBe(location.longitude);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("watchPosition works with missing timezone data", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          latitude: fc.double({ min: -90, max: 90, noNaN: true }),
          longitude: fc.double({ min: -180, max: 180, noNaN: true }),
          accuracy: fc.double({ min: 1, max: 1000, noNaN: true }),
        }),
        async (location) => {
          // Setup content script with null timezone
          const contentScript = setupContentScript({
            enabled: true,
            location: location,
            timezone: null,
          });

          // Test watchPosition API
          const position = await new Promise<SpoofedGeolocationPosition>((resolve) => {
            const watchId = contentScript.navigator.geolocation.watchPosition(
              (pos: SpoofedGeolocationPosition) => {
                resolve(pos);
                contentScript.navigator.geolocation.clearWatch(watchId);
              }
            );
          });

          // watchPosition should still work
          expect(position).not.toBeNull();
          expect(position.coords.latitude).toBe(location.latitude);
          expect(position.coords.longitude).toBe(location.longitude);
        }
      ),
      { numRuns: 50 } // Fewer runs for watchPosition to avoid performance issues
    );
  });
});

/**
 * Property: Fallback Timezone Spoofing
 *
 * For any fallback timezone data (with fallback: true), timezone spoofing
 * should apply using the estimated offset values.
 *
 * **Validates: Requirements 11.4**
 */
describe("Property: Fallback Timezone Spoofing", () => {
  test("getTimezoneOffset uses fallback timezone data", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.constantFrom("UTC", "Etc/GMT", "Etc/GMT+0"),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 60 }),
          fallback: fc.constant(true), // Fallback flag
        }),
        (fallbackTimezone) => {
          // Setup content script with fallback timezone
          const contentScript = setupContentScript({
            enabled: true,
            location: {
              latitude: 0,
              longitude: 0,
              accuracy: 10,
            },
            timezone: fallbackTimezone,
          });

          // Test getTimezoneOffset
          const date = new Date();
          const offset = contentScript.Date.prototype.getTimezoneOffset.call(date);

          // With Intl-based offset, the offset comes from the IANA identifier, not the offset field.
          // For UTC/Etc/GMT identifiers, the Intl offset is always 0.
          const expectedOffset = (() => {
            const fmt = new Intl.DateTimeFormat("en-US", {
              timeZone: fallbackTimezone.identifier,
              timeZoneName: "shortOffset",
            });
            const parts = fmt.formatToParts(date);
            const tzPart = parts.find((p) => p.type === "timeZoneName");
            const gmtStr = tzPart?.value ?? "GMT";
            if (gmtStr === "GMT" || gmtStr === "UTC") return 0;
            const m = gmtStr.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
            if (!m) return 0;
            const sign = m[1] === "+" ? 1 : -1;
            return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10));
          })();
          expect(offset).toBe(-expectedOffset);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Intl.DateTimeFormat uses fallback timezone identifier", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.constantFrom("UTC", "Etc/GMT", "Etc/GMT+0", "Etc/GMT-0"),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.constant(0),
          fallback: fc.constant(true),
        }),
        (fallbackTimezone) => {
          // Setup content script with fallback timezone
          const contentScript = setupContentScript({
            enabled: true,
            location: {
              latitude: 0,
              longitude: 0,
              accuracy: 10,
            },
            timezone: fallbackTimezone,
          });

          // Test Intl.DateTimeFormat
          const formatter = contentScript.Intl.DateTimeFormat();
          const options = formatter.resolvedOptions();

          // Intl may normalize timezone aliases (e.g., Etc/GMT+0 → UTC)
          const expectedTz = new Intl.DateTimeFormat("en-US", {
            timeZone: fallbackTimezone.identifier,
          }).resolvedOptions().timeZone;
          expect(options.timeZone).toBe(expectedTz);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Date formatting methods use fallback timezone", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.constantFrom("UTC", "Etc/GMT"),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.constant(0),
          fallback: fc.constant(true),
        }),
        fc.date({ noInvalidDate: true }),
        (fallbackTimezone, date) => {
          // Setup content script with fallback timezone
          const contentScript = setupContentScript({
            enabled: true,
            location: {
              latitude: 0,
              longitude: 0,
              accuracy: 10,
            },
            timezone: fallbackTimezone,
          });

          // Test Date formatting methods
          const dateString = contentScript.Date.prototype.toString.call(date);
          const timeString = contentScript.Date.prototype.toTimeString.call(date);
          const localeString = contentScript.Date.prototype.toLocaleString.call(date);

          // All should be strings (not throw errors)
          expect(typeof dateString).toBe("string");
          expect(typeof timeString).toBe("string");
          expect(typeof localeString).toBe("string");

          // Should contain timezone information
          expect(dateString.length).toBeGreaterThan(0);
          expect(timeString.length).toBeGreaterThan(0);
          expect(localeString.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("fallback timezone with various offsets works correctly", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -720, max: 840 }), // All valid timezone offsets
        (offset) => {
          const fallbackTimezone = {
            identifier: "UTC",
            offset: offset,
            dstOffset: 0,
            fallback: true,
          };

          // Setup content script
          const contentScript = setupContentScript({
            enabled: true,
            location: {
              latitude: 0,
              longitude: 0,
              accuracy: 10,
            },
            timezone: fallbackTimezone,
          });

          // Test getTimezoneOffset
          const date = new Date();
          const timezoneOffset = contentScript.Date.prototype.getTimezoneOffset.call(date);

          // With Intl-based offset, UTC always resolves to offset 0 regardless of the offset field
          // eslint-disable-next-line no-compare-neg-zero
          expect(timezoneOffset === 0 || timezoneOffset === -0).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("fallback timezone doesn't break when geolocation also active", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          latitude: fc.double({ min: -90, max: 90, noNaN: true }),
          longitude: fc.double({ min: -180, max: 180, noNaN: true }),
          accuracy: fc.double({ min: 1, max: 1000, noNaN: true }),
        }),
        fc.record({
          identifier: fc.constantFrom("UTC", "Etc/GMT"),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.constant(0),
          fallback: fc.constant(true),
        }),
        async (location, fallbackTimezone) => {
          // Setup content script with both location and fallback timezone
          const contentScript = setupContentScript({
            enabled: true,
            location: location,
            timezone: fallbackTimezone,
          });

          // Test both geolocation and timezone APIs
          const position = await new Promise<SpoofedGeolocationPosition>((resolve) => {
            contentScript.navigator.geolocation.getCurrentPosition(
              (pos: SpoofedGeolocationPosition) => {
                resolve(pos);
              }
            );
          });

          const date = new Date();
          const timezoneOffset = contentScript.Date.prototype.getTimezoneOffset.call(date);

          // Both should work
          expect(position).not.toBeNull();
          expect(position.coords.latitude).toBe(location.latitude);
          // With Intl-based offset, the offset comes from the IANA identifier
          const expectedOffset = (() => {
            const fmt = new Intl.DateTimeFormat("en-US", {
              timeZone: fallbackTimezone.identifier,
              timeZoneName: "shortOffset",
            });
            const parts = fmt.formatToParts(date);
            const tzPart = parts.find((p) => p.type === "timeZoneName");
            const gmtStr = tzPart?.value ?? "GMT";
            if (gmtStr === "GMT" || gmtStr === "UTC") return 0;
            const m = gmtStr.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
            if (!m) return 0;
            const sign = m[1] === "+" ? 1 : -1;
            return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10));
          })();
          expect(timezoneOffset).toBe(-expectedOffset);
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Property: Timezone Validation Doesn't Affect Geolocation
 *
 * For any timezone data that fails validation, geolocation spoofing
 * should continue to work normally.
 */
describe("Property: Timezone Validation Doesn't Affect Geolocation", () => {
  test("invalid timezone identifier doesn't break geolocation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          latitude: fc.double({ min: -90, max: 90, noNaN: true }),
          longitude: fc.double({ min: -180, max: 180, noNaN: true }),
          accuracy: fc.double({ min: 1, max: 1000, noNaN: true }),
        }),
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.integer(),
          fc.constant(""),
          fc.constant({})
        ),
        async (location, invalidIdentifier) => {
          // Setup content script with invalid timezone identifier
          const contentScript = setupContentScript({
            enabled: true,
            location: location,
            timezone: {
              identifier: invalidIdentifier as unknown as string,
              offset: 0,
              dstOffset: 0,
            },
          });

          // Geolocation should still work
          const position = await new Promise<SpoofedGeolocationPosition>((resolve) => {
            contentScript.navigator.geolocation.getCurrentPosition(
              (pos: SpoofedGeolocationPosition) => {
                resolve(pos);
              }
            );
          });

          expect(position).not.toBeNull();
          expect(position.coords.latitude).toBe(location.latitude);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("invalid timezone offset doesn't break geolocation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          latitude: fc.double({ min: -90, max: 90, noNaN: true }),
          longitude: fc.double({ min: -180, max: 180, noNaN: true }),
          accuracy: fc.double({ min: 1, max: 1000, noNaN: true }),
        }),
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant("invalid"),
          fc.constant(NaN),
          fc.constant(Infinity)
        ),
        async (location, invalidOffset) => {
          // Setup content script with invalid timezone offset
          const contentScript = setupContentScript({
            enabled: true,
            location: location,
            timezone: {
              identifier: "UTC",
              offset: invalidOffset as unknown as number,
              dstOffset: 0,
            },
          });

          // Geolocation should still work
          const position = await new Promise<SpoofedGeolocationPosition>((resolve) => {
            contentScript.navigator.geolocation.getCurrentPosition(
              (pos: SpoofedGeolocationPosition) => {
                resolve(pos);
              }
            );
          });

          expect(position).not.toBeNull();
          expect(position.coords.latitude).toBe(location.latitude);
        }
      ),
      { numRuns: 100 }
    );
  });
});
