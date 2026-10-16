/**
 * Unit Tests for Settings Management
 * Feature: geolocation-spoof-extension-mvp
 */

import { storageData } from "../../setup";
import { importBackground } from "../../helpers/import-background";

beforeEach(() => {
  // Override storage.set to simulate quota exceeded for large data
  browser.storage.local.set.mockImplementation((obj: Record<string, unknown>) => {
    if (obj.settings) {
      const dataSize = JSON.stringify(obj.settings).length;
      if (dataSize > 100000) {
        return Promise.reject(new Error("QuotaExceededError: Storage quota exceeded"));
      }
      storageData.settings = obj.settings;
    }
    return Promise.resolve();
  });
});

describe("Settings Edge Cases", () => {
  /**
   * Test corrupted settings data recovery
   * Validates: Requirements 6.7
   */
  test("should recover from corrupted settings data", async () => {
    const { loadSettings, DEFAULT_SETTINGS } = await importBackground();

    // Set corrupted data in storage
    storageData.settings = {
      enabled: "not a boolean", // Invalid type
      location: {
        latitude: 200, // Out of range
        longitude: -500, // Out of range
        accuracy: "invalid",
      },
      timezone: "not an object", // Invalid type
      webrtcProtection: null, // Invalid type
      version: 123, // Invalid type
    };

    // Load settings should return defaults for invalid fields
    const settings = await loadSettings();

    expect(settings.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(settings.location).toBeNull(); // Invalid coordinates should be reset
    expect(settings.timezone).toBeNull(); // Invalid timezone should be reset
    expect(settings.webrtcProtection).toBe(DEFAULT_SETTINGS.webrtcProtection);
    expect(settings.version).toBe(DEFAULT_SETTINGS.version);
  });

  /**
   * Test storage quota exceeded handling
   * Validates: Requirements 6.7
   */
  test("should handle storage quota exceeded error", async () => {
    const { saveSettings, DEFAULT_SETTINGS } = await importBackground();

    // Create settings with very large data that will exceed quota
    const largeSettings = {
      ...DEFAULT_SETTINGS,
      enabled: true,
      location: { latitude: 37.7749, longitude: -122.4194, accuracy: 10 },
      timezone: { identifier: "America/Los_Angeles", offset: 480, dstOffset: 60 },
      locationName: {
        city: "A".repeat(50000), // Very large string
        country: "B".repeat(50000),
        displayName: "C".repeat(50000),
      },
      webrtcProtection: false,
    };

    // Attempt to save should throw error
    await expect(saveSettings(largeSettings)).rejects.toThrow("Storage quota exceeded");
  });

  /**
   * Test default values when storage is empty
   * Validates: Requirements 6.7
   */
  test("should return default values when storage is empty", async () => {
    const { loadSettings, DEFAULT_SETTINGS } = await importBackground();

    // Ensure storage is empty
    await browser.storage.local.clear();

    const settings = await loadSettings();

    expect(settings.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(settings.location).toBeNull();
    expect(settings.timezone).toBeNull();
    expect(settings.locationName).toBeNull();
    expect(settings.webrtcProtection).toBe(DEFAULT_SETTINGS.webrtcProtection);
    expect(settings.version).toBe(DEFAULT_SETTINGS.version);
  });

  /**
   * Test partial corruption recovery
   */
  test("should recover valid fields from partially corrupted settings", async () => {
    const { loadSettings } = await importBackground();

    // Set partially corrupted data
    storageData.settings = {
      enabled: true, // Valid
      location: {
        latitude: 37.7749, // Valid
        longitude: -122.4194, // Valid
        accuracy: 10, // Valid
      },
      timezone: "invalid", // Invalid - should be reset
      locationName: {
        city: "San Francisco", // Valid
        country: "USA", // Valid
        displayName: "San Francisco, CA, USA", // Valid
      },
      webrtcProtection: "yes", // Invalid - should be reset
      version: "1.0", // Valid
    };

    const settings = await loadSettings();

    // Valid fields should be preserved
    expect(settings.enabled).toBe(true);
    expect(settings.location).not.toBeNull();
    expect(settings.location!.latitude).toBe(37.7749);
    expect(settings.location!.longitude).toBe(-122.4194);
    expect(settings.locationName).not.toBeNull();
    expect(settings.locationName!.city).toBe("San Francisco");
    expect(settings.version).toBe("1.2");

    // Invalid fields should be reset to defaults
    expect(settings.timezone).toBeNull();
    expect(settings.webrtcProtection).toBe(false);
  });

  /**
   * Test coordinate boundary validation
   */
  test("should reject coordinates outside valid ranges", async () => {
    const { loadSettings } = await importBackground();

    // Test latitude out of range
    storageData.settings = {
      enabled: true,
      location: {
        latitude: 91, // Out of range
        longitude: 0,
        accuracy: 10,
      },
    };

    let settings = await loadSettings();
    expect(settings.location).toBeNull();

    // Test longitude out of range
    storageData.settings = {
      enabled: true,
      location: {
        latitude: 0,
        longitude: -181, // Out of range
        accuracy: 10,
      },
    };

    settings = await loadSettings();
    expect(settings.location).toBeNull();
  });

  /**
   * Test settings with missing required fields
   */
  test("should handle settings with missing fields", async () => {
    const { loadSettings, DEFAULT_SETTINGS } = await importBackground();

    // Set incomplete settings
    storageData.settings = {
      enabled: true,
      // Missing all other fields
    };

    const settings = await loadSettings();

    expect(settings.enabled).toBe(true);
    expect(settings.location).toBeNull();
    expect(settings.timezone).toBeNull();
    expect(settings.locationName).toBeNull();
    expect(settings.webrtcProtection).toBe(DEFAULT_SETTINGS.webrtcProtection);
    expect(settings.version).toBe(DEFAULT_SETTINGS.version);
  });
});

describe("Scope Settings Validation", () => {
  /**
   * scopeMode is preserved when it is one of the three permitted values.
   * Validates: Requirements 2.1
   */
  test.each(["all", "allowlist", "denylist"] as const)(
    "should preserve valid scopeMode %s",
    async (mode) => {
      const { validateSettings } = await importBackground();

      const validated = validateSettings({ scopeMode: mode });

      expect(validated.scopeMode).toBe(mode);
    }
  );

  /**
   * scopeMode defaults to "all" when missing.
   * Validates: Requirements 2.2, 1.6
   */
  test("should default scopeMode to 'all' when missing", async () => {
    const { validateSettings } = await importBackground();

    const validated = validateSettings({ enabled: true });

    expect(validated.scopeMode).toBe("all");
  });

  /**
   * scopeMode defaults to "all" when present but invalid.
   * Validates: Requirements 2.2
   */
  test.each([
    ["unknown string", "everywhere"],
    ["empty string", ""],
    ["wrong type (number)", 3],
    ["wrong type (null)", null],
    ["wrong type (object)", {}],
  ])("should default scopeMode to 'all' when invalid: %s", async (_label, badMode) => {
    const { validateSettings } = await importBackground();

    const validated = validateSettings({
      scopeMode: badMode,
    } as unknown as Parameters<typeof validateSettings>[0]);

    expect(validated.scopeMode).toBe("all");
  });

  /**
   * Non-array allowlist/denylist values are reset to empty arrays.
   * Validates: Requirements 2.4
   */
  test.each([
    ["string", "example.com"],
    ["number", 42],
    ["object", { foo: "bar" }],
    ["null", null],
  ])("should reset corrupt non-array lists to [] (%s)", async (_label, badValue) => {
    const { validateSettings } = await importBackground();

    const validated = validateSettings({
      allowlist: badValue,
      denylist: badValue,
    } as unknown as Parameters<typeof validateSettings>[0]);

    expect(validated.allowlist).toEqual([]);
    expect(validated.denylist).toEqual([]);
  });

  /**
   * Missing allowlist/denylist default to empty arrays.
   * Validates: Requirements 1.7, 2.4
   */
  test("should default missing lists to []", async () => {
    const { validateSettings } = await importBackground();

    const validated = validateSettings({ enabled: true });

    expect(validated.allowlist).toEqual([]);
    expect(validated.denylist).toEqual([]);
  });

  /**
   * Non-string entries are dropped from the list.
   * Validates: Requirements 2.6
   */
  test("should drop non-string entries", async () => {
    const { validateSettings } = await importBackground();

    const validated = validateSettings({
      allowlist: ["example.com", 123, null, {}, "test.org", true],
    } as unknown as Parameters<typeof validateSettings>[0]);

    expect(validated.allowlist).toEqual(["example.com", "test.org"]);
  });

  /**
   * Invalid entries (per the Pattern_Parser) are dropped. Note that under
   * Advanced Filtering `localhost` and `*.example.com` are now VALID patterns,
   * so the invalid cases here are a bad label, a group metacharacter, and a
   * bare single-label host.
   * Validates: Requirements 13.4
   */
  test("should drop entries the Pattern_Parser reports as invalid", async () => {
    const { validateSettings } = await importBackground();

    const validated = validateSettings({
      // "bad_domain.com" has an illegal underscore, "exa(mple).com" has a group
      // metacharacter, "no-dot" is a single-label bare host (not localhost).
      allowlist: ["bad_domain.com", "exa(mple).com", "no-dot", "valid.com"],
    });

    expect(validated.allowlist).toEqual(["valid.com"]);
  });

  /**
   * Retained entries are replaced with their canonical Pattern form.
   * Validates: Requirements 13.4, 14.1
   */
  test("should canonicalize retained entries", async () => {
    const { validateSettings } = await importBackground();

    const validated = validateSettings({
      allowlist: ["HTTPS://WWW.Example.COM/some/path?q=1#frag", "  Test.ORG:8443  "],
    });

    // Scheme/host lowercased, query + fragment dropped, path case preserved,
    // port kept; `www.` is NOT stripped (a bare host already covers www).
    expect(validated.allowlist).toEqual(["https://www.example.com/some/path", "test.org:8443"]);
  });

  /**
   * Duplicate canonical entries are removed keeping the first occurrence,
   * producing a deterministically ordered list.
   * Validates: Requirements 13.4, 14.1, 14.2
   */
  test("should dedupe canonical entries keeping first occurrence", async () => {
    const { validateSettings } = await importBackground();

    const validated = validateSettings({
      allowlist: [
        "example.com",
        "EXAMPLE.com", // canonicalizes to example.com (dup)
        "Example.Com", // canonicalizes to example.com (dup)
        "test.org",
        "TEST.ORG", // canonicalizes to test.org (dup)
        "alpha.com",
      ],
    });

    expect(validated.allowlist).toEqual(["example.com", "test.org", "alpha.com"]);
  });
});

describe("Scope Settings Migration (1.0/1.1 -> 1.2)", () => {
  /**
   * A stored "1.0" object migrates to "1.2" while preserving `enabled`
   * and all other existing field values.
   * Validates: Requirements 13.2, 13.7
   */
  test("should migrate version '1.0' to '1.2' preserving enabled and other fields", async () => {
    const { validateSettings } = await importBackground();

    const validated = validateSettings({
      enabled: true,
      webrtcProtection: true,
      version: "1.0",
      location: { latitude: 37.7749, longitude: -122.4194, accuracy: 10 },
    });

    expect(validated.version).toBe("1.2");
    expect(validated.enabled).toBe(true);
    expect(validated.webrtcProtection).toBe(true);
    expect(validated.location).toEqual({
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 10,
    });
    // Missing scope fields take the backward-compatible defaults.
    expect(validated.scopeMode).toBe("all");
    expect(validated.allowlist).toEqual([]);
    expect(validated.denylist).toEqual([]);
  });

  /**
   * An object with an absent version field migrates to "1.2".
   * Validates: Requirements 13.2
   */
  test("should stamp version '1.2' when version is absent", async () => {
    const { validateSettings } = await importBackground();

    const validated = validateSettings({ enabled: false });

    expect(validated.version).toBe("1.2");
  });

  /**
   * Already-array lists are preserved entry-for-entry and in order during
   * migration (valid, already-normalized entries pass through unchanged).
   * Validates: Requirements 3.4
   */
  test("should preserve already-array lists entry-for-entry and in order", async () => {
    const { validateSettings } = await importBackground();

    const validated = validateSettings({
      version: "1.0",
      allowlist: ["alpha.com", "beta.com", "gamma.com"],
      denylist: ["one.org", "two.org"],
    });

    expect(validated.allowlist).toEqual(["alpha.com", "beta.com", "gamma.com"]);
    expect(validated.denylist).toEqual(["one.org", "two.org"]);
  });

  /**
   * A present-but-non-array list is replaced with an empty array during
   * migration.
   * Validates: Requirements 3.7
   */
  test("should replace present-but-non-array list with [] during migration", async () => {
    const { validateSettings } = await importBackground();

    const validated = validateSettings({
      version: "1.0",
      allowlist: "example.com",
      denylist: { foo: "bar" },
    } as unknown as Parameters<typeof validateSettings>[0]);

    expect(validated.allowlist).toEqual([]);
    expect(validated.denylist).toEqual([]);
  });

  /**
   * A present-but-invalid scopeMode falls back to "all" during migration.
   * Validates: Requirements 3.8
   */
  test("should fall back scopeMode to 'all' during migration when invalid", async () => {
    const { validateSettings } = await importBackground();

    const validated = validateSettings({
      version: "1.0",
      scopeMode: "bogus",
    } as unknown as Parameters<typeof validateSettings>[0]);

    expect(validated.scopeMode).toBe("all");
  });

  /**
   * A valid scopeMode present in a "1.0" object is preserved during migration.
   * Validates: Requirements 3.5
   */
  test("should preserve a valid scopeMode during migration", async () => {
    const { validateSettings } = await importBackground();

    const validated = validateSettings({
      version: "1.0",
      scopeMode: "denylist",
      denylist: ["blocked.com"],
    });

    expect(validated.version).toBe("1.2");
    expect(validated.scopeMode).toBe("denylist");
    expect(validated.denylist).toEqual(["blocked.com"]);
  });
});

describe("Advanced Filtering migration (1.1 -> 1.2)", () => {
  /**
   * A stored "1.1" object migrates to "1.2" with its hostname lists carried
   * forward losslessly — every schema-1.1 hostname is a valid bare-host Pattern
   * with identical (apex + subdomain) matching meaning.
   * Validates: Requirements 13.2, 13.3, 13.7
   */
  test("should migrate '1.1' to '1.2' preserving hostname lists losslessly", async () => {
    const { validateSettings } = await importBackground();

    const validated = validateSettings({
      enabled: true,
      version: "1.1",
      scopeMode: "allowlist",
      allowlist: ["example.com", "sub.example.org"],
      denylist: ["blocked.net"],
    });

    expect(validated.version).toBe("1.2");
    expect(validated.enabled).toBe(true);
    expect(validated.scopeMode).toBe("allowlist");
    expect(validated.allowlist).toEqual(["example.com", "sub.example.org"]);
    expect(validated.denylist).toEqual(["blocked.net"]);
  });

  /**
   * Advanced glob patterns (wildcard TLD, `*.` subdomain, port, and path) are
   * retained through sanitization as their canonical forms.
   * Validates: Requirements 13.4, 14.1
   */
  test("should retain wildcard, port, and path patterns as canonical forms", async () => {
    const { validateSettings } = await importBackground();

    const validated = validateSettings({
      version: "1.2",
      scopeMode: "denylist",
      denylist: ["*.ru", "*.example.com", "localhost:3000", "example.com/tracking/*"],
    });

    expect(validated.denylist).toEqual([
      "*.ru",
      "*.example.com",
      "localhost:3000",
      "example.com/tracking/*",
    ]);
  });
});

describe("precisionCadence validation (AC1)", () => {
  // Valid seeds so validateSettings mints nothing random and two runs compare equal.
  const base = {
    enabled: true,
    version: "1.2",
    accuracySeed: 777,
    precisionSeed: 123456789,
    locationPrecision: { mode: "approximate" as const, radiusMeters: 2000 },
  };

  test("absent cadence defaults to never", async () => {
    const { validateSettings } = await importBackground();
    expect(validateSettings({}).precisionCadence).toBe("never");
  });

  test.each([undefined, null, 1, {}, "page", "weekly"])(
    "repairs %j to never without touching any other field",
    async (junk) => {
      const { validateSettings } = await importBackground();
      const repaired = validateSettings({ ...base, precisionCadence: junk as never });
      expect(repaired.precisionCadence).toBe("never");
      expect(repaired).toEqual(validateSettings({ ...base }));
    }
  );

  test.each(["never", "session", "hour", "day"] as const)("%s round-trips", async (c) => {
    const { validateSettings } = await importBackground();
    expect(validateSettings({ ...base, precisionCadence: c }).precisionCadence).toBe(c);
  });
});

describe("ensureValidPrecisionSeed", () => {
  test("returns a valid seed unchanged", async () => {
    vi.resetModules();
    const { ensureValidPrecisionSeed } = await import("@/background/settings");
    expect(ensureValidPrecisionSeed(555)).toBe(555);
  });

  test.each([0, NaN, undefined, "x"])("mints a finite non-zero seed for %j", async (bad) => {
    vi.resetModules();
    const { ensureValidPrecisionSeed } = await import("@/background/settings");
    const seed = ensureValidPrecisionSeed(bad);
    expect(Number.isFinite(seed)).toBe(true);
    // Math.random could in principle produce 0; the generator's range makes that
    // a 1-in-2^31 event, which the validator would then re-mint on load.
    expect(seed).not.toBe(0);
  });
});
