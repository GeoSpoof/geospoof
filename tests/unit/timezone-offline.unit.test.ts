/**
 * Unit Tests for Offline Timezone Lookup
 * Feature: offline-timezone-lookup
 *
 * Tests computeOffsets helper, known-city lookups, and GeoNames removal verification.
 *
 * Requirements: 1.2, 1.3, 2.1, 2.3, 6.4
 */

import { vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Mock browser-geo-tz at the module level
vi.mock("browser-geo-tz", () => ({
  init: vi.fn(() => ({
    find: vi.fn().mockResolvedValue([]),
  })),
}));

// Mock DOM for background module. Use vi.stubGlobal rather than direct
// assignment: under the jsdom bundled with vitest 5, `document` is a getter-only
// property on the global, so `globalThis.document = {...}` throws a TypeError.
vi.stubGlobal("document", {
  addEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
});

vi.stubGlobal("window", {
  addEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
});

const background = await import("@/background");
const { computeOffsets } = background;
const { init: initMock } = await import("browser-geo-tz");
const _initMocked = vi.mocked(initMock);
// Get the find mock from the object returned by init()
function getMockedFind() {
  const results = _initMocked.mock.results;
  const lastResult = results[results.length - 1];
  if (lastResult && lastResult.type === "return") {
    return vi.mocked((lastResult.value as { find: ReturnType<typeof vi.fn> }).find);
  }
  const findFn = vi.fn().mockResolvedValue([]);
  _initMocked.mockReturnValue({ find: findFn });
  return findFn;
}
const mockedFind = getMockedFind();

describe("computeOffsets", () => {
  test("returns correct offset for America/New_York", () => {
    const result = computeOffsets("America/New_York");
    // EST = -300 or EDT = -240 depending on time of year
    expect(Number.isFinite(result.offset)).toBe(true);
    expect(result.offset === -300 || result.offset === -240).toBe(true);
    // New York observes DST (60 min difference)
    expect(result.dstOffset).toBe(60);
  });

  test("returns correct offset for Europe/London", () => {
    const result = computeOffsets("Europe/London");
    // GMT = 0 or BST = 60 depending on time of year
    expect(result.offset === 0 || result.offset === 60).toBe(true);
    expect(result.dstOffset).toBe(60);
  });

  test("returns correct offset for Asia/Tokyo", () => {
    const result = computeOffsets("Asia/Tokyo");
    // JST = UTC+9 = 540 minutes, no DST
    expect(result.offset).toBe(540);
    expect(result.dstOffset).toBe(0);
  });

  test("returns correct offset for Asia/Kolkata", () => {
    const result = computeOffsets("Asia/Kolkata");
    // IST = UTC+5:30 = 330 minutes, no DST
    expect(result.offset).toBe(330);
    expect(result.dstOffset).toBe(0);
  });

  test("returns correct offset for Asia/Kathmandu", () => {
    const result = computeOffsets("Asia/Kathmandu");
    // NPT = UTC+5:45 = 345 minutes, no DST
    expect(result.offset).toBe(345);
    expect(result.dstOffset).toBe(0);
  });

  test("returns correct offset for Pacific/Kiritimati", () => {
    const result = computeOffsets("Pacific/Kiritimati");
    // UTC+14 = 840 minutes, no DST
    expect(result.offset).toBe(840);
    expect(result.dstOffset).toBe(0);
  });

  test("returns correct offset for Pacific/Pago_Pago", () => {
    const result = computeOffsets("Pacific/Pago_Pago");
    // UTC-11 = -660 minutes, no DST
    expect(result.offset).toBe(-660);
    expect(result.dstOffset).toBe(0);
  });

  test("returns finite values for all offsets", () => {
    const zones = [
      "America/New_York",
      "Europe/London",
      "Asia/Tokyo",
      "Asia/Kolkata",
      "Australia/Sydney",
      "America/Los_Angeles",
      "Europe/Berlin",
    ];

    for (const zone of zones) {
      const result = computeOffsets(zone);
      expect(Number.isFinite(result.offset)).toBe(true);
      expect(Number.isFinite(result.dstOffset)).toBe(true);
      expect(result.dstOffset).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("Known-city lookups", () => {
  beforeEach(async () => {
    await background.clearTimezoneCache();
    mockedFind.mockReset();
  });

  const knownCities: Array<{
    name: string;
    lat: number;
    lng: number;
    expectedTz: string;
  }> = [
    { name: "New York", lat: 40.7128, lng: -74.006, expectedTz: "America/New_York" },
    { name: "Los Angeles", lat: 34.0522, lng: -118.2437, expectedTz: "America/Los_Angeles" },
    { name: "London", lat: 51.5074, lng: -0.1278, expectedTz: "Europe/London" },
    { name: "Paris", lat: 48.8566, lng: 2.3522, expectedTz: "Europe/Paris" },
    { name: "Berlin", lat: 52.52, lng: 13.405, expectedTz: "Europe/Berlin" },
    { name: "Tokyo", lat: 35.6762, lng: 139.6503, expectedTz: "Asia/Tokyo" },
    { name: "Sydney", lat: -33.8688, lng: 151.2093, expectedTz: "Australia/Sydney" },
    { name: "São Paulo", lat: -23.5505, lng: -46.6333, expectedTz: "America/Sao_Paulo" },
    { name: "Dubai", lat: 25.2048, lng: 55.2708, expectedTz: "Asia/Dubai" },
    { name: "Singapore", lat: 1.3521, lng: 103.8198, expectedTz: "Asia/Singapore" },
  ];

  test.each(knownCities)("$name resolves to $expectedTz", async ({ lat, lng, expectedTz }) => {
    mockedFind.mockResolvedValue([expectedTz]);

    const tz = await background.getTimezoneForCoordinates(lat, lng);

    expect(tz.identifier).toBe(expectedTz);
    expect(background.isValidIANATimezone(tz.identifier)).toBe(true);
    expect(Number.isFinite(tz.offset)).toBe(true);
    expect(Number.isFinite(tz.dstOffset)).toBe(true);
  });
});

describe("GeoNames removal verification", () => {
  test("DEFAULT_SETTINGS does not contain geonamesUsername", () => {
    expect(background.DEFAULT_SETTINGS).not.toHaveProperty("geonamesUsername");
  });

  test("timezone.ts source contains no geonames string references", () => {
    const source = readFileSync(resolve(__dirname, "../../src/background/timezone.ts"), "utf-8");
    expect(source.toLowerCase()).not.toContain("geonames");
  });
});
