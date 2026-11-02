import { describe, it, expect } from "vitest";
import {
  isValidIANATimezone,
  isValidLocation,
  isValidTimezone,
  isValidSettings,
} from "@/shared/utils/type-guards";

describe("isValidIANATimezone", () => {
  it("accepts standard Area/Location identifiers", () => {
    expect(isValidIANATimezone("America/Los_Angeles")).toBe(true);
    expect(isValidIANATimezone("Europe/London")).toBe(true);
    expect(isValidIANATimezone("Asia/Tokyo")).toBe(true);
  });

  it("accepts Area/Location/Sublocation identifiers", () => {
    expect(isValidIANATimezone("America/Argentina/Buenos_Aires")).toBe(true);
  });

  it('accepts "UTC"', () => {
    expect(isValidIANATimezone("UTC")).toBe(true);
  });

  it("accepts Etc/GMT patterns", () => {
    expect(isValidIANATimezone("Etc/GMT")).toBe(true);
    expect(isValidIANATimezone("Etc/GMT+5")).toBe(true);
    expect(isValidIANATimezone("Etc/GMT-5")).toBe(true);
    expect(isValidIANATimezone("Etc/GMT+12")).toBe(true);
  });

  // The five real zones the check used to refuse: all of Haiti and Benin,
  // Blanc-Sablon (Quebec), Ust-Nera (Russia), and Apple's bare "GMT".
  it.each([
    "America/Port-au-Prince",
    "Africa/Porto-Novo",
    "America/Blanc-Sablon",
    "Asia/Ust-Nera",
    "GMT",
  ])("accepts %s", (identifier) => {
    expect(isValidIANATimezone(identifier)).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(isValidIANATimezone("")).toBe(false);
    expect(isValidIANATimezone(null)).toBe(false);
    expect(isValidIANATimezone(undefined)).toBe(false);
    expect(isValidIANATimezone(42)).toBe(false);
    expect(isValidIANATimezone("invalid")).toBe(false);
    expect(isValidIANATimezone("lowercase/timezone")).toBe(false);
  });

  it.each([
    "123/456",
    "America/",
    "/Los_Angeles",
    "America/Los Angeles",
    "../../etc/passwd",
    "America/../Europe/London",
    "America/Port-au-Prince/",
    "America/-Port",
    "America/Port-",
    "America/Port--au-Prince",
    "Port-au-Prince",
    "Africa/Porto-Novo\n",
    "America/Port-au-Prince; rm -rf /",
    "gmt",
    "GMT+5",
    "Etc/GMT+123",
  ])("still rejects %j", (identifier) => {
    expect(isValidIANATimezone(identifier)).toBe(false);
  });

  // Every zone this runtime knows must pass, so the next tzdata name the pattern
  // misses fails here and not in a customer's save. No exclusions today. If a
  // runtime lists an id the extension rejects on purpose, name it in a
  // commented exclusion list here rather than widening the pattern.
  it("accepts every zone in Intl.supportedValuesOf", (ctx) => {
    ctx.skip(
      typeof Intl.supportedValuesOf !== "function",
      "Intl.supportedValuesOf is unavailable in this runtime, so there is no list to sweep"
    );
    const zones = Intl.supportedValuesOf("timeZone");

    expect(zones.length).toBeGreaterThan(0);
    expect(zones.filter((id) => !isValidIANATimezone(id))).toEqual([]);
  });
});

describe("isValidLocation", () => {
  it("accepts a valid location", () => {
    expect(isValidLocation({ latitude: 37.7749, longitude: -122.4194, accuracy: 10 })).toBe(true);
  });

  it("accepts boundary values", () => {
    expect(isValidLocation({ latitude: -90, longitude: -180, accuracy: 0.1 })).toBe(true);
    expect(isValidLocation({ latitude: 90, longitude: 180, accuracy: 1 })).toBe(true);
  });

  it("rejects out-of-range latitude", () => {
    expect(isValidLocation({ latitude: 91, longitude: 0, accuracy: 10 })).toBe(false);
    expect(isValidLocation({ latitude: -91, longitude: 0, accuracy: 10 })).toBe(false);
  });

  it("rejects out-of-range longitude", () => {
    expect(isValidLocation({ latitude: 0, longitude: 181, accuracy: 10 })).toBe(false);
    expect(isValidLocation({ latitude: 0, longitude: -181, accuracy: 10 })).toBe(false);
  });

  it("rejects zero or negative accuracy", () => {
    expect(isValidLocation({ latitude: 0, longitude: 0, accuracy: 0 })).toBe(false);
    expect(isValidLocation({ latitude: 0, longitude: 0, accuracy: -1 })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isValidLocation(null)).toBe(false);
    expect(isValidLocation(undefined)).toBe(false);
    expect(isValidLocation("string")).toBe(false);
    expect(isValidLocation(42)).toBe(false);
  });

  it("rejects objects with missing fields", () => {
    expect(isValidLocation({ latitude: 0, longitude: 0 })).toBe(false);
    expect(isValidLocation({ latitude: 0 })).toBe(false);
    expect(isValidLocation({})).toBe(false);
  });
});

describe("isValidTimezone", () => {
  it("accepts a valid timezone", () => {
    expect(isValidTimezone({ identifier: "America/Los_Angeles", offset: 480, dstOffset: 60 })).toBe(
      true
    );
  });

  it("accepts Etc/GMT timezone", () => {
    expect(isValidTimezone({ identifier: "Etc/GMT+5", offset: -300, dstOffset: 0 })).toBe(true);
  });

  it("rejects invalid identifier", () => {
    expect(isValidTimezone({ identifier: "invalid", offset: 0, dstOffset: 0 })).toBe(false);
  });

  it("rejects non-number offset", () => {
    expect(
      isValidTimezone({ identifier: "America/Los_Angeles", offset: "480", dstOffset: 0 })
    ).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isValidTimezone(null)).toBe(false);
    expect(isValidTimezone("string")).toBe(false);
  });
});

describe("isValidSettings", () => {
  const validSettings = {
    enabled: false,
    location: null,
    timezone: null,
    locationName: null,
    webrtcProtection: false,
    onboardingCompleted: false,
    version: "1.0",
    lastUpdated: Date.now(),
  };

  it("accepts valid default settings", () => {
    expect(isValidSettings(validSettings)).toBe(true);
  });

  it("accepts settings with valid location and timezone", () => {
    expect(
      isValidSettings({
        ...validSettings,
        enabled: true,
        location: { latitude: 37.7749, longitude: -122.4194, accuracy: 10 },
        timezone: { identifier: "America/Los_Angeles", offset: 480, dstOffset: 60 },
        locationName: { city: "San Francisco", country: "USA", displayName: "San Francisco, USA" },
      })
    ).toBe(true);
  });

  it("rejects when enabled is not boolean", () => {
    expect(isValidSettings({ ...validSettings, enabled: "yes" })).toBe(false);
  });

  it("rejects invalid location", () => {
    expect(
      isValidSettings({ ...validSettings, location: { latitude: 999, longitude: 0, accuracy: 10 } })
    ).toBe(false);
  });

  it("rejects invalid timezone", () => {
    expect(
      isValidSettings({
        ...validSettings,
        timezone: { identifier: "bad", offset: 0, dstOffset: 0 },
      })
    ).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isValidSettings(null)).toBe(false);
    expect(isValidSettings(undefined)).toBe(false);
    expect(isValidSettings("string")).toBe(false);
  });

  it("rejects when required fields are missing", () => {
    expect(isValidSettings({ enabled: true })).toBe(false);
  });
});
