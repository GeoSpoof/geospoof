/**
 * Pure cadence module: pinned vectors, phase spread, bucket edges, the
 * validator, and the guarantee that Never is today's expression token for token.
 *
 * Feature: location-precision cadence (GeoSpoof/geospoof#1). The vectors here
 * are extension-only literals, deliberately NOT in tests/fixtures/*.json (those
 * are cross-language contracts read by Swift and Rust).
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import fc from "fast-check";
import {
  DAY_MS,
  HOUR_MS,
  PRECISION_CADENCES,
  cadenceHash32,
  clockBucket,
  derivePeriodSeed,
  isTimeCadence,
  nextBoundaryMs,
  phaseMs,
  resolvePageLocation,
  timeBucket,
  validatePrecisionCadence,
  type PageLocationSettings,
  type PeriodKey,
} from "@/shared/precision/cadence";
import {
  applyPrecisionOffset,
  computeEffectiveLocationPrecision,
  offsetHash01,
} from "@/shared/precision/offset";
import type { LocationPrecision } from "@/shared/types/settings";

describe("pinned vectors (AC7)", () => {
  test("cadenceHash32", () => {
    expect(cadenceHash32("")).toBe(4190637403);
    expect(cadenceHash32("gs-phase-v1|1|3600000")).toBe(3620075640);
  });

  test("phaseMs", () => {
    expect(phaseMs(1, HOUR_MS)).toBe(3034312);
    expect(phaseMs(1, DAY_MS)).toBe(44511523);
    expect(phaseMs(2 ** 31 - 1, HOUR_MS)).toBe(710276);
    expect(phaseMs(2 ** 31 - 1, DAY_MS)).toBe(11724673);
  });

  test("derivePeriodSeed", () => {
    expect(derivePeriodSeed(1, { cadence: "session", index: 4294967295 })).toBe(873239360);
    expect(derivePeriodSeed(2 ** 31 - 1, { cadence: "day", index: 20000 })).toBe(1731804232);
    expect(derivePeriodSeed(1, { cadence: "hour", index: 0 })).toBe(1791649214);
    expect(derivePeriodSeed(123456789, { cadence: "hour", index: 480000 })).toBe(381198126);
  });

  test("clockBucket", () => {
    expect(clockBucket("hour", 1, 1_700_000_000_000)).toBe(472221);
  });

  test("cadenceHash32 uses the same mixing as offsetHash01", () => {
    expect(cadenceHash32(`1|${0x9e3779b9}|0|0`) / 2 ** 32).toBe(offsetHash01(1, 0, 0, 0x9e3779b9));
  });
});

describe("phase spread (AC8)", () => {
  test.each([
    ["hour", HOUR_MS],
    ["day", DAY_MS],
  ])("every decile of phaseMs/P holds 8–12 %% of seeds 1–10,000 (%s)", (_name, P) => {
    const deciles = new Array<number>(10).fill(0);
    for (let seed = 1; seed <= 10_000; seed++) {
      const phase = phaseMs(seed, P);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(P);
      deciles[Math.floor((phase / P) * 10)]++;
    }
    for (const count of deciles) {
      expect(count).toBeGreaterThanOrEqual(800);
      expect(count).toBeLessThanOrEqual(1200);
    }
  });
});

describe("bucket edges (AC9)", () => {
  test.each([
    ["hour", HOUR_MS],
    ["day", DAY_MS],
  ])("timeBucket flips exactly at the phase (%s)", (_name, P) => {
    const phase = phaseMs(7, P);
    expect(timeBucket(phase - 1, phase, P)).toBe(-1);
    expect(timeBucket(phase, phase, P)).toBe(0);
    expect(timeBucket(phase + P - 1, phase, P)).toBe(0);
  });

  test("nextBoundaryMs is the first instant of the next bucket", () => {
    for (const c of ["hour", "day"] as const) {
      const seed = 123456789;
      const k = clockBucket(c, seed, 1_700_000_000_000);
      const boundary = nextBoundaryMs(c, seed, k);
      expect(clockBucket(c, seed, boundary - 1)).toBe(k);
      expect(clockBucket(c, seed, boundary)).toBe(k + 1);
    }
  });
});

describe("buckets follow the real Date.now under a faked clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("hour and day buckets, per-seed phase, and a backward clock step", () => {
    // Fake only Date: if the module ever read performance.now() instead, these
    // assertions would track the real clock and fail.
    vi.useFakeTimers({ toFake: ["Date"] });
    const seedA = 123456789;
    const seedB = 987654321;

    for (const c of ["hour", "day"] as const) {
      const k = 20_000;
      const startA = nextBoundaryMs(c, seedA, k - 1); // first instant of bucket k for seed A
      vi.setSystemTime(startA);
      expect(clockBucket(c, seedA, Date.now())).toBe(k);

      vi.setSystemTime(startA - 1);
      expect(clockBucket(c, seedA, Date.now()), "backward step lands in k − 1").toBe(k - 1);

      vi.setSystemTime(nextBoundaryMs(c, seedA, k) - 1);
      expect(clockBucket(c, seedA, Date.now())).toBe(k);
      vi.setSystemTime(nextBoundaryMs(c, seedA, k));
      expect(clockBucket(c, seedA, Date.now())).toBe(k + 1);

      // A different install rolls over at a different instant.
      expect(phaseMs(seedA, c === "hour" ? HOUR_MS : DAY_MS)).not.toBe(
        phaseMs(seedB, c === "hour" ? HOUR_MS : DAY_MS)
      );
      expect(nextBoundaryMs(c, seedA, k)).not.toBe(nextBoundaryMs(c, seedB, k));
    }
  });
});

describe("validatePrecisionCadence (AC1)", () => {
  test.each([undefined, null, 1, {}, "page", "weekly"])("repairs %j to never", (junk) => {
    expect(validatePrecisionCadence(junk)).toBe("never");
  });

  test("every valid value round-trips", () => {
    for (const c of PRECISION_CADENCES) {
      expect(validatePrecisionCadence(c)).toBe(c);
    }
    expect(PRECISION_CADENCES).toEqual(["never", "session", "hour", "day"]);
  });

  test("isTimeCadence", () => {
    expect(isTimeCadence("hour")).toBe(true);
    expect(isTimeCadence("day")).toBe(true);
    expect(isTimeCadence("never")).toBe(false);
    expect(isTimeCadence("session")).toBe(false);
  });
});

const arbPageSettings: fc.Arbitrary<PageLocationSettings> = fc.record({
  location: fc.option(
    fc.record({
      latitude: fc.double({ min: -90, max: 90, noNaN: true }),
      longitude: fc.double({ min: -180, max: 180, noNaN: true }),
      accuracy: fc.double({ min: 0.1, max: 10_000, noNaN: true }),
    }),
    { nil: null }
  ),
  locationPrecision: fc.oneof(
    fc.constant<LocationPrecision>({ mode: "exact" }),
    fc
      .integer({ min: 50, max: 50_000 })
      .map((radiusMeters): LocationPrecision => ({ mode: "approximate", radiusMeters }))
  ),
  precisionSeed: fc.integer({ min: 0, max: 2 ** 31 }),
  proFeaturesBlocked: fc.boolean(),
});

describe("Never is today's expression (AC5)", () => {
  test("resolvePageLocation(s, null) deep-equals the pre-change builder expression", () => {
    fc.assert(
      fc.property(arbPageSettings, (s) => {
        const today = applyPrecisionOffset(
          s.location,
          computeEffectiveLocationPrecision(s.locationPrecision, s.proFeaturesBlocked),
          s.precisionSeed
        );
        expect(resolvePageLocation(s, null)).toEqual(today);
      }),
      { numRuns: 2000 }
    );
  });
});

describe("Exact returns the Anchor for any period (AC10)", () => {
  const anchor = { latitude: 37.7749, longitude: -122.4194, accuracy: 42 };
  const s: PageLocationSettings = {
    location: anchor,
    locationPrecision: { mode: "exact" },
    precisionSeed: 123456789,
    proFeaturesBlocked: false,
  };

  test("every cadence and index", () => {
    for (const cadence of ["session", "hour", "day"] as const) {
      for (const index of [0, 1, 2 ** 32 - 1]) {
        const period: PeriodKey = { cadence, index };
        expect(resolvePageLocation(s, period)).toEqual(anchor);
      }
    }
    expect(resolvePageLocation(s, null)).toEqual(anchor);
  });

  test("no location stays null for any period", () => {
    const none: PageLocationSettings = {
      ...s,
      location: null,
      locationPrecision: { mode: "approximate", radiusMeters: 2000 },
    };
    expect(resolvePageLocation(none, { cadence: "hour", index: 5 })).toBeNull();
  });
});

describe("derivePeriodSeed separates periods", () => {
  test("differs across cadences for the same index, and across consecutive indices", () => {
    const seed = 123456789;
    for (const index of [0, 1, 472221, 20000]) {
      const session = derivePeriodSeed(seed, { cadence: "session", index });
      const hour = derivePeriodSeed(seed, { cadence: "hour", index });
      const day = derivePeriodSeed(seed, { cadence: "day", index });
      expect(new Set([session, hour, day]).size).toBe(3);
      expect(derivePeriodSeed(seed, { cadence: "hour", index: index + 1 })).not.toBe(hour);
    }
  });

  test("approximate points differ between consecutive hour buckets", () => {
    const s: PageLocationSettings = {
      location: { latitude: 37.7749, longitude: -122.4194, accuracy: 42 },
      locationPrecision: { mode: "approximate", radiusMeters: 2000 },
      precisionSeed: 123456789,
      proFeaturesBlocked: false,
    };
    const a = resolvePageLocation(s, { cadence: "hour", index: 100 });
    const b = resolvePageLocation(s, { cadence: "hour", index: 101 });
    expect(a).not.toEqual(b);
    // Same period reproduces the same point (FR-3.2).
    expect(resolvePageLocation(s, { cadence: "hour", index: 100 })).toEqual(a);
  });
});
