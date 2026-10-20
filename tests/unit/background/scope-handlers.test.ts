/**
 * Unit tests for the site-scoping message handlers (Site-Scoping, task 7):
 * `handleSetScopeMode`, `handleAddScopeSite`, and `handleRemoveScopeSite`.
 *
 * Each handler follows the SET_DEBUG_LOGGING / favorites pattern: persist via
 * `updateSettings`, then re-broadcast per-tab settings and refresh the badge.
 *
 *   - SET_SCOPE_MODE persists the new mode then re-broadcasts + re-badges
 *     (Req 9.1); STORAGE_ERROR leaves the delivered state unchanged (Req 9.5).
 *   - ADD_SCOPE_SITE parses the entered pattern (INVALID_PATTERN on reject,
 *     Req 14.4), is idempotent against existing canonical entries (Req 14.2),
 *     and returns STORAGE_ERROR on persistence failure (Req 14.5).
 *   - REMOVE_SCOPE_SITE removes the matching canonical pattern (Req 9.2).
 *
 * Validates: Requirements 9.1, 9.2, 9.5, 14.5, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6
 */

import { describe, test, expect, vi } from "vitest";
import type { Settings } from "@/shared/types/settings";
import type { Message, ScopeResponse } from "@/shared/types/messages";

function makeSettings(overrides?: Partial<Settings>): Settings {
  return {
    enabled: true,
    location: { latitude: 37.7749, longitude: -122.4194, accuracy: 10 },
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
    accuracySeed: 0,
    locationPrecision: { mode: "exact" },
    precisionSeed: 0,
    precisionCadence: "never" as const,
    localeSpoofing: { mode: "off" as const },
    siteLocations: [],
    ...overrides,
  };
}

/**
 * Import the background module with a fixed persisted Settings object and a
 * single open tab so the per-tab broadcast and badge refresh have something to
 * act on. `setImpl` lets a test force the storage write to fail.
 */
async function importBackgroundWith(
  s: Settings,
  setImpl?: (obj: Record<string, unknown>) => Promise<void>
) {
  vi.clearAllMocks();
  vi.resetModules();

  browser.storage.local.get = vi.fn().mockResolvedValue({ settings: s });
  const setSpy = vi.fn(setImpl ?? ((_obj: Record<string, unknown>) => Promise.resolve()));
  browser.storage.local.set = setSpy;
  browser.tabs.query = vi.fn().mockResolvedValue([{ id: 1, url: "https://example.com/" }]);

  const broadcasts: Array<Message<Record<string, unknown>>> = [];
  browser.tabs.sendMessage = vi
    .fn()
    .mockImplementation((_tabId: number, message: Message<Record<string, unknown>>) => {
      if (message.type === "UPDATE_SETTINGS") {
        broadcasts.push(message);
      }
      return Promise.resolve();
    });

  const setBadgeText = vi.fn().mockResolvedValue(undefined);
  browser.action.setBadgeText = setBadgeText;
  browser.action.setBadgeBackgroundColor = vi.fn().mockResolvedValue(undefined);

  const mod = await import("@/background");
  return { ...mod, broadcasts, setBadgeText, setSpy };
}

/** The Settings object passed to the most recent storage.local.set call. */
function lastPersistedSettings(setSpy: ReturnType<typeof vi.fn>): Settings {
  const calls = setSpy.mock.calls;
  return (calls[calls.length - 1][0] as { settings: Settings }).settings;
}

describe("handleSetScopeMode (task 7)", () => {
  test("persists the new mode, re-broadcasts, and refreshes the badge", async () => {
    const s = makeSettings({ scopeMode: "all" });
    const { handleSetScopeMode, broadcasts, setBadgeText, setSpy } = await importBackgroundWith(s);

    const response = await handleSetScopeMode({ scopeMode: "denylist" });

    expect(response).toEqual({ success: true });
    expect(lastPersistedSettings(setSpy).scopeMode).toBe("denylist");
    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    expect(setBadgeText).toHaveBeenCalled();
  });

  test("routes through handleMessage SET_SCOPE_MODE case", async () => {
    const s = makeSettings({ scopeMode: "all" });
    const { handleMessage, setSpy } = await importBackgroundWith(s);

    const response = (await handleMessage(
      { type: "SET_SCOPE_MODE", payload: { scopeMode: "allowlist" } },
      {}
    )) as ScopeResponse;

    expect(response).toEqual({ success: true });
    expect(lastPersistedSettings(setSpy).scopeMode).toBe("allowlist");
  });

  test("returns STORAGE_ERROR and leaves delivered enabled/badge unchanged on persistence failure", async () => {
    const s = makeSettings({ scopeMode: "all" });
    const { handleSetScopeMode, broadcasts, setBadgeText } = await importBackgroundWith(s, () =>
      Promise.reject(new Error("Storage failure"))
    );

    const response = await handleSetScopeMode({ scopeMode: "denylist" });

    expect(response).toEqual({ error: "STORAGE_ERROR" });
    // No re-broadcast and no badge refresh when the persist fails.
    expect(broadcasts.length).toBe(0);
    expect(setBadgeText).not.toHaveBeenCalled();
  });
});

describe("handleAddScopeSite (task 7)", () => {
  test("canonicalizes and appends a new pattern, then re-broadcasts and re-badges", async () => {
    const s = makeSettings({ scopeMode: "allowlist", allowlist: [] });
    const { handleAddScopeSite, broadcasts, setBadgeText, setSpy } = await importBackgroundWith(s);

    // Scheme + host lowercased, query/fragment dropped, path case preserved,
    // port kept, `www.` NOT stripped.
    const response = await handleAddScopeSite({
      list: "allowlist",
      pattern: "HTTPS://WWW.Example.com:8443/Path?q=1#h",
    });

    expect(response).toEqual({ success: true });
    expect(lastPersistedSettings(setSpy).allowlist).toEqual(["https://www.example.com:8443/Path"]);
    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    expect(setBadgeText).toHaveBeenCalled();
  });

  test("adds to the denylist when targeted", async () => {
    const s = makeSettings({ scopeMode: "denylist", denylist: ["blocked.com"] });
    const { handleAddScopeSite, setSpy } = await importBackgroundWith(s);

    const response = await handleAddScopeSite({ list: "denylist", pattern: "*.ru" });

    expect(response).toEqual({ success: true });
    expect(lastPersistedSettings(setSpy).denylist).toEqual(["blocked.com", "*.ru"]);
  });

  test("rejects an invalid pattern with INVALID_PATTERN and does not persist", async () => {
    const s = makeSettings({ scopeMode: "allowlist", allowlist: [] });
    const { handleAddScopeSite, broadcasts, setSpy } = await importBackgroundWith(s);

    const response = await handleAddScopeSite({ list: "allowlist", pattern: "no-dot-host" });

    expect(response).toEqual({ error: "INVALID_PATTERN" });
    expect(setSpy).not.toHaveBeenCalled();
    expect(broadcasts.length).toBe(0);
  });

  test("is idempotent: a duplicate canonical entry reports success without re-persisting", async () => {
    const s = makeSettings({ scopeMode: "allowlist", allowlist: ["example.com"] });
    const { handleAddScopeSite, broadcasts, setSpy } = await importBackgroundWith(s);

    // "EXAMPLE.COM" canonicalizes to the existing "example.com".
    const response = await handleAddScopeSite({
      list: "allowlist",
      pattern: "EXAMPLE.COM",
    });

    expect(response).toEqual({ success: true });
    expect(setSpy).not.toHaveBeenCalled();
    expect(broadcasts.length).toBe(0);
  });

  test("returns STORAGE_ERROR and retains the last-persisted list on persistence failure", async () => {
    const s = makeSettings({ scopeMode: "allowlist", allowlist: ["example.com"] });
    const { handleAddScopeSite, broadcasts, setBadgeText } = await importBackgroundWith(s, () =>
      Promise.reject(new Error("Storage failure"))
    );

    const response = await handleAddScopeSite({ list: "allowlist", pattern: "new.example" });

    expect(response).toEqual({ error: "STORAGE_ERROR" });
    expect(broadcasts.length).toBe(0);
    expect(setBadgeText).not.toHaveBeenCalled();
  });
});

describe("handleRemoveScopeSite (task 7)", () => {
  test("removes the matching canonical pattern, then re-broadcasts and re-badges", async () => {
    const s = makeSettings({
      scopeMode: "allowlist",
      allowlist: ["example.com", "keep.com"],
    });
    const { handleRemoveScopeSite, broadcasts, setBadgeText, setSpy } =
      await importBackgroundWith(s);

    // Raw input canonicalizes to "example.com" before matching.
    const response = await handleRemoveScopeSite({
      list: "allowlist",
      pattern: "EXAMPLE.COM",
    });

    expect(response).toEqual({ success: true });
    expect(lastPersistedSettings(setSpy).allowlist).toEqual(["keep.com"]);
    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    expect(setBadgeText).toHaveBeenCalled();
  });

  test("is a no-op (still success) when the pattern is absent", async () => {
    const s = makeSettings({ scopeMode: "denylist", denylist: ["blocked.com"] });
    const { handleRemoveScopeSite, setSpy } = await importBackgroundWith(s);

    const response = await handleRemoveScopeSite({ list: "denylist", pattern: "absent.com" });

    expect(response).toEqual({ success: true });
    expect(lastPersistedSettings(setSpy).denylist).toEqual(["blocked.com"]);
  });

  test("returns STORAGE_ERROR and retains the last-persisted list on persistence failure", async () => {
    const s = makeSettings({ scopeMode: "allowlist", allowlist: ["example.com"] });
    const { handleRemoveScopeSite, broadcasts, setBadgeText } = await importBackgroundWith(s, () =>
      Promise.reject(new Error("Storage failure"))
    );

    const response = await handleRemoveScopeSite({ list: "allowlist", pattern: "example.com" });

    expect(response).toEqual({ error: "STORAGE_ERROR" });
    expect(broadcasts.length).toBe(0);
    expect(setBadgeText).not.toHaveBeenCalled();
  });
});
