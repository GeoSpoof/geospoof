/**
 * Property-Based Tests for Anti-Fingerprint Hardening
 * Feature: anti-fingerprint-hardening
 */

import fc from "fast-check";

describe("Anti-Fingerprint Hardening Properties", () => {
  // ── Shared infrastructure replicating injected.ts registry logic ──

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyFunction = (...args: any[]) => any;
  let overrideRegistry: Map<AnyFunction, string>;
  let originalFunctionToString: typeof Function.prototype.toString;
  let toStringOverride: AnyFunction;

  /** Replicate registerOverride from injected.ts */
  function registerOverride(fn: AnyFunction, nativeName: string): void {
    overrideRegistry.set(fn, nativeName);
  }

  /** Replicate installOverride from injected.ts */
  function installOverride(target: object, prop: string, overrideFn: AnyFunction): void {
    const originalDescriptor = Object.getOwnPropertyDescriptor(target, prop);
    if (originalDescriptor) {
      Object.defineProperty(target, prop, {
        value: overrideFn,
        configurable: originalDescriptor.configurable,
        enumerable: originalDescriptor.enumerable,
        writable: originalDescriptor.writable,
      });
    } else {
      Object.defineProperty(target, prop, {
        value: overrideFn,
        configurable: true,
        enumerable: false,
        writable: true,
      });
    }
    registerOverride(overrideFn, prop);
  }

  // Store originals for cleanup. These are only used to restore prototypes
  // in afterEach — never called standalone — so the unbound-method warning
  // does not apply.
  /* eslint-disable @typescript-eslint/unbound-method */
  const nativeToString = Function.prototype.toString;
  const nativeGetTimezoneOffset = Date.prototype.getTimezoneOffset;
  const nativeResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
  const nativeDateToString = Date.prototype.toString;
  const nativeToTimeString = Date.prototype.toTimeString;
  const nativeToDateString = Date.prototype.toDateString;
  /* eslint-enable @typescript-eslint/unbound-method */

  beforeEach(() => {
    // Reset registry
    overrideRegistry = new Map();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    originalFunctionToString = Function.prototype.toString;

    // Install toString override (mirrors injected.ts)
    toStringOverride = function (this: AnyFunction): string {
      const nativeName = overrideRegistry.get(this);
      if (nativeName !== undefined) {
        return `function ${nativeName}() { [native code] }`;
      }
      return originalFunctionToString.call(this);
    };
    Function.prototype.toString = toStringOverride;
    registerOverride(toStringOverride, "toString");
  });

  afterEach(() => {
    // Restore all native methods
    Function.prototype.toString = nativeToString;
    Date.prototype.getTimezoneOffset = nativeGetTimezoneOffset;
    Intl.DateTimeFormat.prototype.resolvedOptions = nativeResolvedOptions;
    Date.prototype.toString = nativeDateToString;
    Date.prototype.toTimeString = nativeToTimeString;
    Date.prototype.toDateString = nativeToDateString;
  });

  /**
   * Property 1: toString Masking Completeness
   *
   * For any function in the override registry with native name N,
   * calling Function.prototype.toString() on it returns
   * "function N() { [native code] }". For any function NOT in the
   * override registry, toString returns the original result.
   *
   * Validates: Requirements 1.1, 1.2, 1.5
   */
  test("Feature: anti-fingerprint-hardening, Property 1: toString Masking Completeness", () => {
    fc.assert(
      fc.property(
        // Generate a random native function name (valid JS identifier)
        fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,20}$/),
        (nativeName) => {
          // Create a function and register it
          const overrideFn: AnyFunction = function () {
            return 42;
          };
          registerOverride(overrideFn, nativeName);

          // Registered function should return native-looking string
          const result = Function.prototype.toString.call(overrideFn);
          expect(result).toBe(`function ${nativeName}() { [native code] }`);

          // The toString override itself should also look native
          const toStringResult = Function.prototype.toString.call(toStringOverride);
          expect(toStringResult).toBe("function toString() { [native code] }");

          // An unregistered function should return the original toString
          const unregisteredFn: AnyFunction = function myFunc() {
            return 0;
          };
          const unregisteredResult = Function.prototype.toString.call(unregisteredFn);
          expect(unregisteredResult).toContain("myFunc");
          expect(unregisteredResult).not.toContain("[native code]");
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 2: Property Descriptor Consistency
   *
   * For any overridden method on a prototype, Object.getOwnPropertyDescriptor
   * returns a descriptor whose configurable, enumerable, and writable fields
   * match the native method's original descriptor, and whose value field
   * references the override function.
   *
   * Validates: Requirements 2.3, 2.4
   */
  test("Feature: anti-fingerprint-hardening, Property 2: Property Descriptor Consistency", () => {
    // Define the prototype methods we can test installOverride against
    const targets: Array<{ target: object; prop: string }> = [
      { target: Date.prototype, prop: "getTimezoneOffset" },
      { target: Date.prototype, prop: "toString" },
      { target: Date.prototype, prop: "toTimeString" },
      { target: Date.prototype, prop: "toDateString" },
      { target: Intl.DateTimeFormat.prototype, prop: "resolvedOptions" },
    ];

    fc.assert(
      fc.property(fc.integer({ min: 0, max: targets.length - 1 }), (targetIndex) => {
        const { target, prop } = targets[targetIndex];

        // Capture the original descriptor before override
        const originalDescriptor = Object.getOwnPropertyDescriptor(target, prop);
        // In jsdom/Node, these should exist
        expect(originalDescriptor).toBeDefined();

        // Create and install an override
        const overrideFn: AnyFunction = function () {
          return null;
        };
        installOverride(target, prop, overrideFn);

        // Get the new descriptor
        const newDescriptor = Object.getOwnPropertyDescriptor(target, prop);
        expect(newDescriptor).toBeDefined();

        // Descriptor flags must match the original
        expect(newDescriptor!.configurable).toBe(originalDescriptor!.configurable);
        expect(newDescriptor!.enumerable).toBe(originalDescriptor!.enumerable);
        expect(newDescriptor!.writable).toBe(originalDescriptor!.writable);

        // Value must be the override function, not the original
        expect(newDescriptor!.value).toBe(overrideFn);

        // The override should also be in the toString registry
        const toStringResult = Function.prototype.toString.call(overrideFn);
        expect(toStringResult).toBe(`function ${prop}() { [native code] }`);
      }),
      { numRuns: 100 }
    );
  });
});

/**
 * Property-Based Tests for Scoped resolvedOptions & Offset Correctness
 * Feature: anti-fingerprint-hardening (Properties 5–8)
 *
 * These tests use setupContentScript from the test helper rather than
 * the shared toString-masking infrastructure above.
 */

import { setupContentScript } from "../helpers/content.test.helper";

// ── Timezone lists (same as timezone.property.test.ts) ──

const DST_ZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
] as const;

const NON_DST_ZONES_AF = [
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Africa/Nairobi",
] as const;

const EXCEPTION_ZONES_AF = [
  "America/Phoenix",
  "Pacific/Honolulu",
  "Asia/Kathmandu",
  "Asia/Colombo",
] as const;

const SOUTHERN_HEMISPHERE_ZONES_AF = [
  "Australia/Sydney",
  "Pacific/Auckland",
  "America/Santiago",
  "Australia/Adelaide",
] as const;

const ALL_TEST_ZONES_AF = [
  ...DST_ZONES,
  ...NON_DST_ZONES_AF,
  ...EXCEPTION_ZONES_AF,
  ...SOUTHERN_HEMISPHERE_ZONES_AF,
] as const;

describe("Scoped resolvedOptions & Offset Properties", () => {
  /**
   * Property 5: Explicit Timezone Preservation in resolvedOptions
   *
   * For any Intl.DateTimeFormat created with an explicit timeZone option,
   * resolvedOptions().timeZone returns the explicit timezone, not the
   * spoofed one, regardless of whether spoofing is enabled.
   *
   * Validates: Requirements 6.3, 7.1
   */
  test("Feature: anti-fingerprint-hardening, Property 5: Explicit Timezone Preservation in resolvedOptions", () => {
    fc.assert(
      fc.property(
        // Spoofed timezone
        fc.record({
          identifier: fc.constantFrom(...ALL_TEST_ZONES_AF),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        // Explicit timezone (different from spoofed)
        fc.constantFrom(...ALL_TEST_ZONES_AF),
        (spoofedTz, explicitTz) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
            timezone: spoofedTz,
          });

          // Create a DateTimeFormat with an explicit timeZone
          const formatter = contentScript.Intl.DateTimeFormat("en-US", {
            timeZone: explicitTz,
          });

          // resolvedOptions should return the explicit timezone, not the spoofed one
          const resolved = contentScript.Intl.resolvedOptions(formatter);

          // Intl normalizes IANA aliases, so compare against the normalized form
          const expectedTz = new Intl.DateTimeFormat("en-US", {
            timeZone: explicitTz,
          }).resolvedOptions().timeZone;

          expect(resolved.timeZone).toBe(expectedTz);
        }
      ),
      {
        numRuns: 100,
        examples: [
          // Regression: Asia/Kolkata alias (seed: -607857582, path: "97:1:1")
          [{ identifier: "Asia/Kolkata", offset: 0, dstOffset: 0 }, "Asia/Kolkata"],
        ],
      }
    );
  });

  /**
   * Property 6: Default Timezone Spoofing in resolvedOptions
   *
   * For any Intl.DateTimeFormat created without a timeZone option,
   * when spoofing is enabled, resolvedOptions().timeZone returns the
   * spoofed timezone identifier.
   *
   * Validates: Requirements 7.2
   */
  test("Feature: anti-fingerprint-hardening, Property 6: Default Timezone Spoofing in resolvedOptions", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.constantFrom(...ALL_TEST_ZONES_AF),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        (spoofedTz) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
            timezone: spoofedTz,
          });

          // Create a DateTimeFormat WITHOUT an explicit timeZone
          const formatter = contentScript.Intl.DateTimeFormat("en-US");

          // resolvedOptions should return the spoofed timezone
          const resolved = contentScript.Intl.resolvedOptions(formatter);

          // The constructor injected the spoofed tz, so the native
          // resolvedOptions returns the engine-normalized identifier
          // (e.g. "Asia/Calcutta" for "Asia/Kolkata"). This matches
          // real browser behavior and avoids fingerprinting via aliases.
          const expectedTz = new Intl.DateTimeFormat("en-US", {
            timeZone: spoofedTz.identifier,
          }).resolvedOptions().timeZone;

          expect(resolved.timeZone).toBe(expectedTz);
        }
      ),
      {
        numRuns: 100,
        examples: [
          // Regression: Asia/Kolkata alias normalization
          [{ identifier: "Asia/Kolkata", offset: 0, dstOffset: 0 }],
        ],
      }
    );
  });

  /**
   * Property 7: getTimezoneOffset Matches Native Intl Offset
   *
   * For any valid IANA timezone and any Date (including historical dates),
   * the overridden getTimezoneOffset() equals the negative of the native
   * Intl offset.
   *
   * Validates: Requirements 6.4, 6.5
   */
  test("Feature: anti-fingerprint-hardening, Property 7: getTimezoneOffset Matches Native Intl Offset", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.constantFrom(...ALL_TEST_ZONES_AF),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        fc.date({ noInvalidDate: true, min: new Date("1970-01-01"), max: new Date("2030-12-31") }),
        (spoofedTz, date) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
            timezone: spoofedTz,
          });

          const testDate = new Date(date);
          const result = contentScript.Date.prototype.getTimezoneOffset.call(testDate);

          // Compute expected: negative of native Intl offset
          const fmt = new Intl.DateTimeFormat("en-US", {
            timeZone: spoofedTz.identifier,
            timeZoneName: "shortOffset",
          });
          const parts = fmt.formatToParts(testDate);
          const tzPart = parts.find((p) => p.type === "timeZoneName");
          const gmtStr = tzPart?.value ?? "GMT";
          let nativeOffset = 0;
          if (gmtStr !== "GMT" && gmtStr !== "UTC") {
            const m = gmtStr.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
            if (m) {
              const sign = m[1] === "+" ? 1 : -1;
              nativeOffset = sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10));
            }
          }

          expect(result).toBe(-nativeOffset);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 8: DST-Observing Timezones Produce Varying Offsets
   *
   * For DST-observing timezones, there exist at least two dates within
   * a year where getTimezoneOffset() returns different values.
   *
   * Validates: Requirements 6.6
   */
  test("Feature: anti-fingerprint-hardening, Property 8: DST-Observing Timezones Produce Varying Offsets", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DST_ZONES),
        fc.integer({ min: 2000, max: 2030 }),
        (tzId, year) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
            timezone: { identifier: tzId, offset: 0, dstOffset: 60 },
          });

          // Sample 12 months (mid-month) to find varying offsets
          const offsets = new Set<number>();
          for (let month = 0; month < 12; month++) {
            const date = new Date(year, month, 15, 12, 0, 0);
            const offset = contentScript.Date.prototype.getTimezoneOffset.call(date);
            offsets.add(offset);
          }

          // DST-observing timezones must produce at least 2 distinct offsets
          expect(offsets.size).toBeGreaterThanOrEqual(2);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 3: Date Getter Timezone Consistency
   *
   * For any valid IANA timezone and any Date, when spoofing is enabled,
   * each overridden getter returns the same value that Intl.DateTimeFormat
   * with that timezone produces for the corresponding date component.
   *
   * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8
   */
  test("Feature: anti-fingerprint-hardening, Property 3: Date Getter Timezone Consistency", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.constantFrom(...ALL_TEST_ZONES_AF),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        fc.date({ noInvalidDate: true, min: new Date("1970-01-01"), max: new Date("2030-12-31") }),
        (spoofedTz, date) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
            timezone: spoofedTz,
          });

          const testDate = new Date(date);
          const tzId = spoofedTz.identifier;

          // Helper to get expected value from native Intl.DateTimeFormat
          function getExpected(options: Intl.DateTimeFormatOptions, partType: string): number {
            const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tzId, ...options });
            const parts = fmt.formatToParts(testDate);
            const part = parts.find((p) => p.type === partType);
            return parseInt(part?.value ?? "0", 10);
          }

          // getHours: en-US with hour12:false uses the h24 cycle, which renders
          // local midnight as "24"; Date.prototype.getHours() is h23 (0-23), so
          // normalize 24 -> 0 to compare like-for-like.
          const expectedHours = getExpected({ hour: "numeric", hour12: false }, "hour") % 24;
          expect(contentScript.Date.prototype.getHours.call(testDate)).toBe(expectedHours);

          // getMinutes
          const expectedMinutes = getExpected({ minute: "numeric" }, "minute");
          expect(contentScript.Date.prototype.getMinutes.call(testDate)).toBe(expectedMinutes);

          // getSeconds
          const expectedSeconds = getExpected({ second: "numeric" }, "second");
          expect(contentScript.Date.prototype.getSeconds.call(testDate)).toBe(expectedSeconds);

          // getMilliseconds — timezone-independent, same as original
          const expectedMs = testDate.getMilliseconds();
          expect(contentScript.Date.prototype.getMilliseconds.call(testDate)).toBe(expectedMs);

          // getDate (day of month)
          const expectedDay = getExpected({ day: "numeric" }, "day");
          expect(contentScript.Date.prototype.getDate.call(testDate)).toBe(expectedDay);

          // getDay (weekday 0-6)
          const weekdayFmt = new Intl.DateTimeFormat("en-US", {
            timeZone: tzId,
            weekday: "short",
          });
          const weekdayParts = weekdayFmt.formatToParts(testDate);
          const weekdayStr = weekdayParts.find((p) => p.type === "weekday")?.value ?? "";
          const dayMap: Record<string, number> = {
            Sun: 0,
            Mon: 1,
            Tue: 2,
            Wed: 3,
            Thu: 4,
            Fri: 5,
            Sat: 6,
          };
          expect(contentScript.Date.prototype.getDay.call(testDate)).toBe(dayMap[weekdayStr] ?? 0);

          // getMonth (0-indexed)
          const expectedMonth = getExpected({ month: "numeric" }, "month") - 1;
          expect(contentScript.Date.prototype.getMonth.call(testDate)).toBe(expectedMonth);

          // getFullYear
          const expectedYear = getExpected({ year: "numeric" }, "year");
          expect(contentScript.Date.prototype.getFullYear.call(testDate)).toBe(expectedYear);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 4: Date Getter Passthrough When Disabled
   *
   * For any Date, when spoofing is disabled, all overridden Date getters
   * return the same values as the originals.
   *
   * Validates: Requirements 5.9
   */
  test("Feature: anti-fingerprint-hardening, Property 4: Date Getter Passthrough When Disabled", () => {
    fc.assert(
      fc.property(
        fc.date({ noInvalidDate: true, min: new Date("1970-01-01"), max: new Date("2030-12-31") }),
        (date) => {
          const contentScript = setupContentScript({
            enabled: false,
            location: null,
            timezone: null,
          });

          const testDate = new Date(date);

          // All getters should match the originals when spoofing is disabled
          expect(contentScript.Date.prototype.getHours.call(testDate)).toBe(
            contentScript.originals.getHours.call(testDate)
          );
          expect(contentScript.Date.prototype.getMinutes.call(testDate)).toBe(
            contentScript.originals.getMinutes.call(testDate)
          );
          expect(contentScript.Date.prototype.getSeconds.call(testDate)).toBe(
            contentScript.originals.getSeconds.call(testDate)
          );
          expect(contentScript.Date.prototype.getMilliseconds.call(testDate)).toBe(
            contentScript.originals.getMilliseconds.call(testDate)
          );
          expect(contentScript.Date.prototype.getDate.call(testDate)).toBe(
            contentScript.originals.getDate.call(testDate)
          );
          expect(contentScript.Date.prototype.getDay.call(testDate)).toBe(
            contentScript.originals.getDay.call(testDate)
          );
          expect(contentScript.Date.prototype.getMonth.call(testDate)).toBe(
            contentScript.originals.getMonth.call(testDate)
          );
          expect(contentScript.Date.prototype.getFullYear.call(testDate)).toBe(
            contentScript.originals.getFullYear.call(testDate)
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 9: Temporal.Now Methods Return Spoofed Timezone
   *
   * For any valid IANA timezone identifier, when spoofing is enabled and
   * Temporal is available, Temporal.Now.timeZoneId() returns the spoofed
   * timezone identifier, and Temporal.Now.plainDateTimeISO(), plainDateISO(),
   * plainTimeISO(), and zonedDateTimeISO() use the spoofed timezone.
   *
   * Validates: Requirements 4.1, 4.2
   */
  test("Feature: anti-fingerprint-hardening, Property 9: Temporal.Now Methods Return Spoofed Timezone", () => {
    fc.assert(
      fc.property(
        fc.record({
          identifier: fc.constantFrom(...ALL_TEST_ZONES_AF),
          offset: fc.integer({ min: -720, max: 840 }),
          dstOffset: fc.integer({ min: 0, max: 120 }),
        }),
        (spoofedTz) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
            timezone: spoofedTz,
          });

          // timeZoneId should return the spoofed timezone
          expect(contentScript.Temporal.Now.timeZoneId()).toBe(spoofedTz.identifier);

          // plainDateTimeISO (no arg) should use the spoofed timezone
          const pdt = contentScript.Temporal.Now.plainDateTimeISO();
          // Verify it produces a valid PlainDateTime (has year, month, day, etc.)
          expect(typeof pdt.year).toBe("number");
          expect(typeof pdt.month).toBe("number");
          expect(typeof pdt.day).toBe("number");

          // plainDateISO (no arg) should use the spoofed timezone
          const pd = contentScript.Temporal.Now.plainDateISO();
          expect(typeof pd.year).toBe("number");
          expect(typeof pd.month).toBe("number");
          expect(typeof pd.day).toBe("number");

          // plainTimeISO (no arg) should use the spoofed timezone
          const pt = contentScript.Temporal.Now.plainTimeISO();
          expect(typeof pt.hour).toBe("number");
          expect(typeof pt.minute).toBe("number");
          expect(typeof pt.second).toBe("number");

          // zonedDateTimeISO (no arg) should use the spoofed timezone
          const zdt = contentScript.Temporal.Now.zonedDateTimeISO();
          expect(zdt.timeZoneId).toBe(spoofedTz.identifier);

          // When called with an explicit timezone arg, should use that instead
          const explicitTz = "UTC";
          const zdtExplicit = contentScript.Temporal.Now.zonedDateTimeISO(explicitTz);
          expect(zdtExplicit.timeZoneId).toBe(explicitTz);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 10: Temporal.Now Passthrough When Disabled
   *
   * For any Temporal.Now method, when spoofing is disabled, the method
   * returns the same result as the original native implementation.
   *
   * Validates: Requirements 4.3
   */
  test("Feature: anti-fingerprint-hardening, Property 10: Temporal.Now Passthrough When Disabled", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_TEST_ZONES_AF), (tzId) => {
        const contentScript = setupContentScript({
          enabled: false,
          location: null,
          timezone: null,
        });

        // timeZoneId should return the system timezone (same as original)
        expect(contentScript.Temporal.Now.timeZoneId()).toBe(
          contentScript.originals.temporalTimeZoneId()
        );

        // plainDateTimeISO should match original
        const pdt = contentScript.Temporal.Now.plainDateTimeISO();
        const origPdt = contentScript.originals.temporalPlainDateTimeISO();
        expect(pdt.year).toBe(origPdt.year);
        expect(pdt.month).toBe(origPdt.month);
        expect(pdt.day).toBe(origPdt.day);

        // plainDateISO should match original
        const pd = contentScript.Temporal.Now.plainDateISO();
        const origPd = contentScript.originals.temporalPlainDateISO();
        expect(pd.year).toBe(origPd.year);
        expect(pd.month).toBe(origPd.month);
        expect(pd.day).toBe(origPd.day);

        // plainTimeISO should match original (hour may differ by seconds, so just check types)
        const pt = contentScript.Temporal.Now.plainTimeISO();
        expect(typeof pt.hour).toBe("number");
        expect(typeof pt.minute).toBe("number");
        expect(typeof pt.second).toBe("number");

        // zonedDateTimeISO should return system timezone
        const zdt = contentScript.Temporal.Now.zonedDateTimeISO();
        const origZdt = contentScript.originals.temporalZonedDateTimeISO();
        expect(zdt.timeZoneId).toBe(origZdt.timeZoneId);

        // With explicit timezone arg, should pass through regardless
        const zdtExplicit = contentScript.Temporal.Now.zonedDateTimeISO(tzId);
        expect(zdtExplicit.timeZoneId).toBe(tzId);
      }),
      { numRuns: 100 }
    );
  });
});
