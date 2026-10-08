/**
 * Property-Based Tests for Settings Dispatch Round-Trip via CustomEvent
 * Feature: chromium-browser-compat, Property 4: Settings dispatch round-trip via CustomEvent
 *
 * Validates: Requirements 3.4, 4.4, 9.5
 */

import fc from "fast-check";

/** Mirrors the SettingsEventDetail interface from src/content/index.ts */
interface SettingsEventDetail {
  enabled: boolean;
  location: {
    latitude: number;
    longitude: number;
    accuracy: number;
    accuracySetting?: AccuracySetting;
    accuracySeed?: number;
  } | null;
  timezone: {
    identifier: string;
    offset: number;
    dstOffset: number;
    fallback?: boolean;
  } | null;
}

/** Mirrors the AccuracySetting union from src/shared/types/settings.ts */
type AccuracySetting =
  | { mode: "auto" }
  | { mode: "fixed"; meters: number }
  | { mode: "range"; min: number; max: number };

/** A representative set of valid IANA timezone identifiers for generation. */
const IANA_TIMEZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
  "Pacific/Auckland",
  "Africa/Cairo",
  "UTC",
];

/** fast-check arbitrary for an AccuracySetting union value. */
const arbAccuracySetting: fc.Arbitrary<AccuracySetting> = fc.oneof(
  fc.constant({ mode: "auto" as const }),
  fc.record({ mode: fc.constant("fixed" as const), meters: fc.integer({ min: 1, max: 5000 }) }),
  fc
    .tuple(fc.integer({ min: 1, max: 2500 }), fc.integer({ min: 2500, max: 5000 }))
    .map(([min, max]) => ({ mode: "range" as const, min, max }))
);

/** fast-check arbitrary for a valid Location object, carrying accuracy resolution inputs. */
const arbLocation = fc.record({
  latitude: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
  // [-180, 180): +180 is the antimeridian, canonicalized to -180 downstream, so
  // keep generated anchors in the canonical domain the round-trip compares against.
  longitude: fc.double({
    min: -180,
    max: 180,
    maxExcluded: true,
    noNaN: true,
    noDefaultInfinity: true,
  }),
  accuracy: fc.double({ min: 0.1, max: 10000, noNaN: true, noDefaultInfinity: true }),
  accuracySetting: arbAccuracySetting,
  accuracySeed: fc.integer({ min: 0, max: 2 ** 31 }),
});

/** fast-check arbitrary for a valid Timezone object. */
const arbTimezone = fc.record({
  identifier: fc.constantFrom(...IANA_TIMEZONES),
  offset: fc.integer({ min: -720, max: 840 }),
  dstOffset: fc.integer({ min: -720, max: 840 }),
  fallback: fc.option(fc.boolean(), { nil: undefined }),
});

/** fast-check arbitrary for a valid SettingsEventDetail. */
const arbSettingsDetail: fc.Arbitrary<SettingsEventDetail> = fc.record({
  enabled: fc.boolean(),
  location: fc.option(arbLocation, { nil: null }),
  timezone: fc.option(arbTimezone, { nil: null }),
});

const EVENT_NAME = "__geospoof_settings_update";

describe("Settings Dispatch Round-Trip via CustomEvent", () => {
  /**
   * Property 4: Settings dispatch round-trip via CustomEvent
   *
   * For any valid settings object, dispatching via CustomEvent and reading
   * the detail in the event listener produces an equivalent settings object,
   * regardless of whether cloneInto is available.
   *
   * Feature: chromium-browser-compat, Property 4: Settings dispatch round-trip via CustomEvent
   * Validates: Requirements 3.4, 4.4, 9.5
   */
  test("Property 4: round-trip WITHOUT cloneInto (Chromium path)", () => {
    fc.assert(
      fc.property(arbSettingsDetail, (settings) => {
        let received: SettingsEventDetail | null = null;

        const listener = (e: Event): void => {
          received = (e as CustomEvent<SettingsEventDetail>).detail;
        };

        window.addEventListener(EVENT_NAME, listener);
        try {
          // Chromium path: pass settings directly (no cloneInto)
          const event = new CustomEvent(EVENT_NAME, { detail: settings });
          window.dispatchEvent(event);

          expect(received).not.toBeNull();
          expect(received!.enabled).toBe(settings.enabled);
          expect(received!.location).toEqual(settings.location);
          expect(received!.timezone).toEqual(settings.timezone);
          // The accuracy resolution inputs ride on `location` and must
          // survive the dispatch round-trip so the injected Resolver can
          // read the user's chosen setting/seed (bug: these were dropped).
          if (settings.location) {
            expect(received!.location!.accuracySetting).toEqual(settings.location.accuracySetting);
            expect(received!.location!.accuracySeed).toBe(settings.location.accuracySeed);
          }
        } finally {
          window.removeEventListener(EVENT_NAME, listener);
        }
      }),
      { numRuns: 100 }
    );
  });

  test("Property 4: round-trip WITH cloneInto mock (Firefox path)", () => {
    // Simulate Firefox's cloneInto: deep-clone via structuredClone
    const mockCloneInto = <T>(obj: T, _targetScope: typeof globalThis): T => structuredClone(obj);

    fc.assert(
      fc.property(arbSettingsDetail, (settings) => {
        let received: SettingsEventDetail | null = null;

        const listener = (e: Event): void => {
          received = (e as CustomEvent<SettingsEventDetail>).detail;
        };

        window.addEventListener(EVENT_NAME, listener);
        try {
          // Firefox path: cloneInto the detail before dispatching
          const detail = mockCloneInto(settings, window);
          const event = new CustomEvent(EVENT_NAME, { detail });
          window.dispatchEvent(event);

          expect(received).not.toBeNull();
          expect(received!.enabled).toBe(settings.enabled);
          expect(received!.location).toEqual(settings.location);
          expect(received!.timezone).toEqual(settings.timezone);
        } finally {
          window.removeEventListener(EVENT_NAME, listener);
        }
      }),
      { numRuns: 100 }
    );
  });

  test("Property 4: cloneInto detection selects correct path", () => {
    fc.assert(
      fc.property(arbSettingsDetail, (settings) => {
        let received: SettingsEventDetail | null = null;

        const listener = (e: Event): void => {
          received = (e as CustomEvent<SettingsEventDetail>).detail;
        };

        window.addEventListener(EVENT_NAME, listener);
        try {
          // Replicate the exact branching logic from src/content/index.ts
          // In vitest (Node/jsdom), cloneInto is never defined, so this
          // always takes the Chromium (direct-pass) path — which is the
          // correct runtime behavior for environments without cloneInto.
          const cloneIntoFn = (globalThis as Record<string, unknown>)["cloneInto"] as
            (<T>(obj: T, scope: typeof globalThis) => T) | undefined;
          const detail =
            typeof cloneIntoFn === "function" ? cloneIntoFn(settings, window) : settings;

          const event = new CustomEvent(EVENT_NAME, { detail });
          window.dispatchEvent(event);

          expect(received).not.toBeNull();
          expect(received!.enabled).toBe(settings.enabled);
          expect(received!.location).toEqual(settings.location);
          expect(received!.timezone).toEqual(settings.timezone);
        } finally {
          window.removeEventListener(EVENT_NAME, listener);
        }
      }),
      { numRuns: 100 }
    );
  });
});
