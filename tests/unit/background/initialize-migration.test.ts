/**
 * Unit Tests for one-time migration persistence in initialize()
 * Feature: site-scoping
 * Validates: Requirements 3.6, 3.9
 *
 * loadSettings() returns the validated/upgraded in-memory Settings but does not
 * itself write. initialize() detects a migration (stored schema version other
 * than "1.2") and persists the upgraded object exactly once. If persistence
 * fails, the in-memory upgraded Settings are retained for the session and the
 * error is surfaced without crashing init.
 */

import { storageData } from "../../setup";
import { importBackground } from "../../helpers/import-background";

beforeEach(() => {
  // Re-establish the default in-memory write behavior (a prior test may have
  // swapped the implementation to simulate a storage failure).
  browser.storage.local.set.mockImplementation((obj: Record<string, unknown>) => {
    if (obj.settings) {
      storageData.settings = obj.settings;
    }
    return Promise.resolve();
  });
});

describe("initialize() one-time migration persistence", () => {
  /**
   * Startup persists the upgraded object when the stored schema is older.
   * Validates: Requirement 3.6
   */
  test("persists the upgraded Settings object on startup when stored schema is pre-1.2", async () => {
    // Stored object on an older schema: version "1.0" and no scope fields.
    storageData.settings = {
      enabled: true,
      location: null,
      timezone: null,
      webrtcProtection: false,
      onboardingCompleted: true,
      version: "1.0",
      lastUpdated: 123,
      vpnSyncEnabled: false,
      debugLogging: false,
      verbosityLevel: "ERROR",
      theme: "system",
      favorites: [],
    };

    const setSpy = vi.mocked(
      (browser.storage.local as unknown as Record<string, unknown>)[
        "set"
      ] as typeof browser.storage.local.set
    );
    setSpy.mockClear();

    const { initialize, loadSettings } = await importBackground();
    await initialize();

    // The upgraded object was persisted via saveSettings → storage.local.set.
    expect(setSpy).toHaveBeenCalled();
    const savedSettings = setSpy.mock.calls
      .map((c) => (c[0] as { settings?: { version?: string } }).settings)
      .find((s) => s != null);
    expect(savedSettings?.version).toBe("1.2");

    // Storage now holds the upgraded "1.2" object with scope defaults, and all
    // pre-existing fields are preserved.
    const persisted = await loadSettings();
    expect(persisted.version).toBe("1.2");
    expect(persisted.scopeMode).toBe("all");
    expect(persisted.allowlist).toEqual([]);
    expect(persisted.denylist).toEqual([]);
    expect(persisted.enabled).toBe(true);
  });

  /**
   * A fresh install (no stored settings object) is not needlessly written.
   * Validates: Requirement 3.6
   */
  test("does not persist when there is no stored settings object (fresh install)", async () => {
    // storageData.settings is undefined (cleared by global beforeEach).
    const setSpy = vi.mocked(
      (browser.storage.local as unknown as Record<string, unknown>)[
        "set"
      ] as typeof browser.storage.local.set
    );
    setSpy.mockClear();

    const { initialize } = await importBackground();
    await initialize();

    expect(setSpy).not.toHaveBeenCalled();
  });

  /**
   * A storage failure during migration persistence retains the in-memory
   * upgraded Settings and surfaces the error without crashing init.
   * Validates: Requirement 3.9
   */
  test("retains the upgraded in-memory Settings and surfaces the error when saveSettings fails", async () => {
    storageData.settings = {
      enabled: false,
      version: "1.0",
      vpnSyncEnabled: false,
      verbosityLevel: "ERROR",
    };

    const setSpy = vi.mocked(
      (browser.storage.local as unknown as Record<string, unknown>)[
        "set"
      ] as typeof browser.storage.local.set
    );
    // Every write fails (covers the Safari remove+set retry path too).
    setSpy.mockRejectedValue(new Error("storage unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { initialize, loadSettings } = await importBackground();

    // initialize() must not crash despite the persistence failure.
    await expect(initialize()).resolves.toBeUndefined();

    // The error was surfaced.
    expect(errorSpy).toHaveBeenCalled();

    // The in-memory upgraded Settings are retained for the session: loadSettings
    // still re-derives the migrated "1.2" shape (the failed write never landed,
    // so validation re-applies on read).
    const inMemory = await loadSettings();
    expect(inMemory.version).toBe("1.2");
    expect(inMemory.scopeMode).toBe("all");
    expect(inMemory.allowlist).toEqual([]);
    expect(inMemory.denylist).toEqual([]);

    errorSpy.mockRestore();
  });

  /**
   * Adding precisionCadence needs no migration: a stored 1.2 object without the
   * field loads as "never" and initialize() writes nothing (AC4).
   */
  test("a stored 1.2 object without precisionCadence triggers no write and loads as never", async () => {
    storageData.settings = {
      enabled: true,
      location: null,
      timezone: null,
      locationName: null,
      webrtcProtection: false,
      preserveGeolocationPrompt: false,
      onboardingCompleted: true,
      version: "1.2",
      lastUpdated: 123,
      vpnSyncEnabled: false,
      debuggerModeEnabled: false,
      autoSyncBlocked: false,
      proFeaturesBlocked: false,
      debugLogging: false,
      verbosityLevel: "ERROR",
      theme: "system",
      uiLanguage: "",
      favorites: [],
      scopeMode: "all",
      allowlist: [],
      denylist: [],
      accuracySetting: { mode: "auto" },
      accuracySeed: 777,
      locationPrecision: { mode: "approximate", radiusMeters: 2000 },
      precisionSeed: 123456789,
      localeSpoofing: { mode: "off" },
    };

    const setSpy = vi.mocked(
      (browser.storage.local as unknown as Record<string, unknown>)[
        "set"
      ] as typeof browser.storage.local.set
    );
    setSpy.mockClear();

    const { initialize, loadSettings } = await importBackground();
    await initialize();

    expect(setSpy).not.toHaveBeenCalled();
    const loaded = await loadSettings();
    expect(loaded.precisionCadence).toBe("never");
    expect(loaded.version).toBe("1.2");
  });
});
