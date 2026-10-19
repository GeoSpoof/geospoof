/**
 * Task 5 test: the SET_PRECISION message handler validates the incoming
 * LocationPrecision, persists it, and re-broadcasts to tabs. Malformed input is
 * repaired via the shared validation path; the precision seed is untouched.
 */

import { describe, test, expect, vi } from "vitest";
import type { Settings } from "@/shared/types/settings";

function makeSettings(overrides?: Partial<Settings>): Settings {
  return {
    enabled: true,
    location: { latitude: 37.7749, longitude: -122.4194, accuracy: 42 },
    timezone: { identifier: "America/Los_Angeles", offset: 480, dstOffset: 60 },
    locationName: { city: "San Francisco", country: "US", displayName: "San Francisco, US" },
    webrtcProtection: false,
    preserveGeolocationPrompt: false,
    onboardingCompleted: true,
    version: "1.2",
    lastUpdated: Date.now(),
    vpnSyncEnabled: false,
    debuggerModeEnabled: false,
    autoSyncBlocked: false,
    proFeaturesBlocked: false,
    debugLogging: false,
    verbosityLevel: "INFO",
    theme: "system",
    uiLanguage: "",
    favorites: [],
    scopeMode: "all",
    allowlist: [],
    denylist: [],
    accuracySetting: { mode: "auto" },
    accuracySeed: 777,
    locationPrecision: { mode: "exact" },
    precisionSeed: 123456789,
    precisionCadence: "never" as const,
    localeSpoofing: { mode: "off" as const },
    siteLocations: [],
    ...overrides,
  };
}

/** Captures the settings object written by the most recent storage.local.set. */
let persisted: Settings | null = null;

async function importBackgroundWith(s: Settings) {
  vi.clearAllMocks();
  vi.resetModules();
  persisted = null;
  browser.storage.local.get = vi.fn().mockResolvedValue({ settings: s });
  browser.storage.local.set = vi.fn().mockImplementation((obj: { settings: Settings }) => {
    persisted = obj.settings;
    return Promise.resolve();
  });
  browser.tabs.query = vi.fn().mockResolvedValue([{ id: 1, url: "https://example.com" }]);
  browser.tabs.sendMessage = vi.fn().mockResolvedValue(undefined);
  return import("@/background");
}

describe("SET_PRECISION handler", () => {
  test("persists a valid approximate setting and broadcasts", async () => {
    const { handleMessage } = await importBackgroundWith(makeSettings());

    const res = (await handleMessage(
      {
        type: "SET_PRECISION",
        payload: { precision: { mode: "approximate", radiusMeters: 2000 } },
      },
      {}
    )) as { success?: boolean };

    expect(res.success).toBe(true);
    expect(persisted?.locationPrecision).toEqual({ mode: "approximate", radiusMeters: 2000 });
    // Re-broadcast so live tabs pick up the new reported location.
    expect(browser.tabs.sendMessage).toHaveBeenCalled();
  });

  test("repairs a malformed setting to exact", async () => {
    const { handleMessage } = await importBackgroundWith(makeSettings());

    await handleMessage({ type: "SET_PRECISION", payload: { precision: { mode: "wobble" } } }, {});

    expect(persisted?.locationPrecision).toEqual({ mode: "exact" });
  });

  test("clamps an out-of-range approximate radius", async () => {
    const { handleMessage } = await importBackgroundWith(makeSettings());

    await handleMessage(
      {
        type: "SET_PRECISION",
        payload: { precision: { mode: "approximate", radiusMeters: 10_000_000 } },
      },
      {}
    );

    const lp = persisted?.locationPrecision;
    expect(lp?.mode).toBe("approximate");
    if (lp?.mode === "approximate") {
      expect(lp.radiusMeters).toBe(50000); // MAX_PRECISION_RADIUS_M
    }
  });

  test("does not touch precisionSeed when only precision changes", async () => {
    const { handleMessage } = await importBackgroundWith(makeSettings({ precisionSeed: 555 }));

    await handleMessage(
      {
        type: "SET_PRECISION",
        payload: { precision: { mode: "approximate", radiusMeters: 500 } },
      },
      {}
    );

    expect(persisted?.precisionSeed).toBe(555);
  });
});
