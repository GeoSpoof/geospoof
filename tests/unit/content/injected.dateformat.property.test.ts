/**
 * Property-Based Tests for Date Formatting Overrides
 * Feature: date-api-coverage
 *
 * Tests correctness properties for toString, toTimeString, and toDateString
 * overrides using fast-check with randomly generated Date instances and
 * IANA timezone identifiers.
 */
import fc from "fast-check";
import { setupContentScript } from "../../helpers/content.test.helper";

/** Representative IANA timezones covering DST, non-DST, half-hour, and southern hemisphere. */
const TEST_ZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Asia/Singapore",
  "Africa/Nairobi",
  "Australia/Sydney",
  "Pacific/Auckland",
  "America/Santiago",
  "America/Phoenix",
  "Pacific/Honolulu",
] as const;

/** Arbitrary for a timezone record compatible with setupContentScript (random offset). */
const arbTimezone = fc.constantFrom(...TEST_ZONES).chain((id) =>
  fc.record({
    identifier: fc.constant(id),
    offset: fc.integer({ min: -720, max: 840 }),
    dstOffset: fc.integer({ min: 0, max: 120 }),
  })
);

/** Resolve the real UTC offset for a date and IANA timezone via Intl. */
function resolveRealOffset(date: Date, timezoneId: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezoneId,
    timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(date);
  const tzVal = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  if (tzVal === "GMT" || tzVal === "UTC") return 0;
  const m = tzVal.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return 0;
  const sign = m[1] === "+" ? 1 : -1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10));
}

/** Arbitrary for dates across a wide range including DST boundaries. */
const arbDate = fc.date({
  noInvalidDate: true,
  min: new Date("2000-01-01"),
  max: new Date("2030-12-31"),
});

/** Reference helper: get the long timezone name via Intl. */
function referenceLongName(date: Date, timezoneId: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezoneId,
    timeZoneName: "long",
  });
  const parts = fmt.formatToParts(date);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timezoneId;
}

// Feature: date-api-coverage, Property 1: toString format correctness
// Validates: Requirements 2.1, 2.3, 2.4, 5.1
describe("Property 1: toString format correctness", () => {
  test("toString matches Firefox-native regex and contains correct long timezone name", () => {
    fc.assert(
      fc.property(arbTimezone, arbDate, (tz, date) => {
        const cs = setupContentScript({
          enabled: true,
          location: { latitude: 0, longitude: 0, accuracy: 10 },
          timezone: tz,
        });
        const result = cs.Date.prototype.toString.call(date);

        // Must match Firefox-native format
        expect(result).toMatch(
          /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4} \(.+\)$/
        );

        // Parenthesized name must match Intl long timezone name
        const parenMatch = result.match(/\((.+)\)$/);
        expect(parenMatch).not.toBeNull();
        const expectedName = referenceLongName(date, tz.identifier);
        expect(parenMatch![1]).toBe(expectedName);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: date-api-coverage, Property 2: toTimeString format correctness
// Validates: Requirements 3.1, 5.2
describe("Property 2: toTimeString format correctness", () => {
  test("toTimeString matches Firefox-native regex", () => {
    fc.assert(
      fc.property(arbTimezone, arbDate, (tz, date) => {
        const cs = setupContentScript({
          enabled: true,
          location: { latitude: 0, longitude: 0, accuracy: 10 },
          timezone: tz,
        });
        const result = cs.Date.prototype.toTimeString.call(date);

        expect(result).toMatch(/^\d{2}:\d{2}:\d{2} GMT[+-]\d{4} \(.+\)$/);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: date-api-coverage, Property 3: toDateString format correctness
// Validates: Requirements 1.1, 1.2, 5.3
describe("Property 3: toDateString format correctness", () => {
  test("toDateString matches regex and date components correspond to spoofed timezone", () => {
    fc.assert(
      fc.property(arbTimezone, arbDate, (tz, date) => {
        const cs = setupContentScript({
          enabled: true,
          location: { latitude: 0, longitude: 0, accuracy: 10 },
          timezone: tz,
        });
        const result = cs.Date.prototype.toDateString.call(date);

        // Must match Date_String_Format
        expect(result).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4}$/);

        // Verify date components match Intl in the spoofed timezone
        const fmt = new Intl.DateTimeFormat("en-US", {
          timeZone: tz.identifier,
          weekday: "short",
          year: "numeric",
          month: "short",
          day: "2-digit",
        });
        const parts = fmt.formatToParts(date);
        const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
        const expected = `${get("weekday")} ${get("month")} ${get("day")} ${get("year")}`;
        expect(result).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: date-api-coverage, Property 4: toString decomposition consistency
// Validates: Requirements 4.3, 4.4
describe("Property 4: toString decomposition consistency", () => {
  test("toString equals toDateString + space + toTimeString", () => {
    fc.assert(
      fc.property(arbTimezone, arbDate, (tz, date) => {
        const cs = setupContentScript({
          enabled: true,
          location: { latitude: 0, longitude: 0, accuracy: 10 },
          timezone: tz,
        });
        const full = cs.Date.prototype.toString.call(date);
        const datePart = cs.Date.prototype.toDateString.call(date);
        const timePart = cs.Date.prototype.toTimeString.call(date);

        expect(full).toBe(`${datePart} ${timePart}`);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: date-api-coverage, Property 5: Offset consistency across methods
// Validates: Requirements 4.2, 2.2, 3.2
describe("Property 5: Offset consistency across methods", () => {
  test("GMT offset in toString equals negation of getTimezoneOffset", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TEST_ZONES), arbDate, (tzId, date) => {
        // Use the real Intl-resolved offset so getTimezoneOffset agrees with toString
        const realOffset = resolveRealOffset(date, tzId);
        const cs = setupContentScript({
          enabled: true,
          location: { latitude: 0, longitude: 0, accuracy: 10 },
          timezone: { identifier: tzId, offset: realOffset, dstOffset: 0 },
        });
        const str = cs.Date.prototype.toString.call(date);

        // Parse GMT offset from toString output
        const offsetMatch = str.match(/GMT([+-])(\d{2})(\d{2})/);
        expect(offsetMatch).not.toBeNull();
        const sign = offsetMatch![1] === "+" ? 1 : -1;
        const hours = parseInt(offsetMatch![2], 10);
        const minutes = parseInt(offsetMatch![3], 10);
        const offsetFromString = sign * (hours * 60 + minutes);

        // getTimezoneOffset returns the negation of the UTC offset
        const gto = cs.Date.prototype.getTimezoneOffset.call(date);
        expect(offsetFromString).toBe(-gto);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: date-api-coverage, Property 6: Disabled passthrough
// Validates: Requirements 1.3, 2.5, 3.4, 5.4
describe("Property 6: Disabled passthrough", () => {
  test("all three methods return native output when spoofing is disabled", () => {
    fc.assert(
      fc.property(arbDate, (date) => {
        const cs = setupContentScript({
          enabled: false,
          location: null,
          timezone: null,
        });

        const toStr = cs.Date.prototype.toString.call(date);
        const toTime = cs.Date.prototype.toTimeString.call(date);
        const toDate = cs.Date.prototype.toDateString.call(date);

        expect(toStr).toBe(cs.originals.toString.call(date));
        expect(toTime).toBe(cs.originals.toTimeString.call(date));
        expect(toDate).toBe(cs.originals.toDateString.call(date));
      }),
      { numRuns: 100 }
    );
  });
});
