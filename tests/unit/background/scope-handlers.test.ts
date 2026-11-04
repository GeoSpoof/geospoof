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

import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Settings } from "@/shared/types/settings";
import type { Message, ScopeResponse } from "@/shared/types/messages";
import {
  installLocalStore,
  responseAt,
  routeFetch,
  storedGroup,
  storedGroups,
  type LocalStore,
} from "../../helpers/site-groups";

/** Site groups are available unless a test turns the Safari gate off. */
const gate = vi.hoisted(() => ({ available: true }));
vi.mock("@/shared/site-groups/availability", () => ({
  siteGroupsAvailable: () => gate.available,
}));

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

describe("site group, exact and link entries", () => {
  const LINK_URL = "https://lists.example.org/rules/direct-list.txt";
  const LINK = `list:${LINK_URL}`;

  let store: LocalStore;

  /** Import the background over a multi-key store (group data lives beside settings). */
  async function bootWithStore(s: Settings, data?: Record<string, unknown>) {
    vi.clearAllMocks();
    vi.resetModules();
    store = installLocalStore({ settings: s, ...(data ? { siteGroupData: data } : {}) });
    browser.tabs.query = vi.fn().mockResolvedValue([{ id: 1, url: "https://www.google.com/" }]);
    const broadcasts: Array<Message<Record<string, unknown>>> = [];
    browser.tabs.sendMessage = vi
      .fn()
      .mockImplementation((_tabId: number, message: Message<Record<string, unknown>>) => {
        if (message.type === "UPDATE_SETTINGS") broadcasts.push(message);
        return Promise.resolve();
      });
    browser.action.setBadgeText = vi.fn().mockResolvedValue(undefined);
    browser.action.setBadgeBackgroundColor = vi.fn().mockResolvedValue(undefined);
    const mod = await import("@/background");
    return { ...mod, broadcasts };
  }

  const stored = (): Settings => store.data.settings as Settings;

  beforeEach(() => {
    gate.available = true;
    routeFetch();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  test("a group add stores its data before the settings, then delivers", async () => {
    const bg = await bootWithStore(makeSettings({ scopeMode: "allowlist", allowlist: [] }));

    const response = await bg.handleAddScopeSite({
      list: "allowlist",
      pattern: " GeoSite:Google ",
    });

    expect(response).toEqual({ success: true, siteGroup: { count: 3, skipped: 2 } });
    expect(store.writes.slice(0, 2)).toEqual(["siteGroupData", "settings"]);
    expect(stored().allowlist).toEqual(["geosite:google"]);
    expect(storedGroups(store)["geosite:google"].n).toBe(3);
    // The open tab is in a group on the allowlist now.
    expect(bg.broadcasts.at(-1)!.payload!.enabled).toBe(true);
  });

  test.each([
    ["geosite:nosuchlist", "UNKNOWN_GROUP"],
    ["geosite:google@ads", "EMPTY_GROUP"],
  ])("%s answers %s and stores nothing", async (pattern, error) => {
    const bg = await bootWithStore(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
    const response = await bg.handleAddScopeSite({ list: "allowlist", pattern });
    expect(response).toEqual({ error, token: pattern });
    expect(store.writes).toEqual([]);
    expect(bg.broadcasts).toHaveLength(0);
  });

  test("a link add answers its counts, including skipped rules", async () => {
    const bg = await bootWithStore(makeSettings({ scopeMode: "denylist", denylist: [] }));
    routeFetch({ [LINK_URL]: (url) => responseAt(url, "example.com\nregexp:^a\nkeyword:b\n") });
    const response = await bg.handleAddScopeSite({ list: "denylist", pattern: LINK });
    expect(response).toEqual({ success: true, siteGroup: { count: 1, skipped: 2 } });
    expect(stored().denylist).toEqual([LINK]);
  });

  test.each([
    ["an empty list", "regexp:^a\n", { error: "LINK_EMPTY", skipped: 1 }],
    ["a failed download", null, { error: "LINK_FAILED" }],
  ])("%s answers its error and stores nothing", async (_name, body, expected) => {
    const bg = await bootWithStore(makeSettings({ scopeMode: "denylist", denylist: [] }));
    routeFetch(body === null ? {} : { [LINK_URL]: (url) => responseAt(url, body) });
    const response = await bg.handleAddScopeSite({ list: "denylist", pattern: LINK });
    expect(response).toEqual({ ...expected, token: LINK });
    expect(store.writes).toEqual([]);
  });

  test("STORAGE_FULL when the group data would pass its cap", async () => {
    const big = "geosite:big";
    const bg = await bootWithStore(makeSettings({ scopeMode: "allowlist", allowlist: [big] }), {
      v: 1,
      groups: { [big]: { ...storedGroup([]), d: `\n${"a".repeat(4_999_990)}\n`, n: 1 } },
    });
    const response = await bg.handleAddScopeSite({ list: "allowlist", pattern: "geosite:google" });
    expect(response).toEqual({ error: "STORAGE_FULL", token: "geosite:google" });
    expect(stored().allowlist).toEqual([big]);
  });

  test("an exact entry is stored in its canonical form without group data", async () => {
    const bg = await bootWithStore(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
    const response = await bg.handleAddScopeSite({
      list: "allowlist",
      pattern: "=Mail.Example.com",
    });
    expect(response).toEqual({ success: true });
    expect(stored().allowlist).toEqual(["=mail.example.com"]);
    expect(store.writes).toEqual(["settings"]);
  });

  test("a duplicate group add is a success that writes nothing", async () => {
    const bg = await bootWithStore(
      makeSettings({ scopeMode: "allowlist", allowlist: ["geosite:google"] }),
      { v: 1, groups: { "geosite:google": storedGroup(["google.com"]) } }
    );
    const response = await bg.handleAddScopeSite({ list: "allowlist", pattern: "geosite:google" });
    expect(response).toEqual({ success: true, siteGroup: { count: 1, skipped: 0 } });
    expect(store.writes).toEqual([]);
  });

  test("removing a group drops its data", async () => {
    const bg = await bootWithStore(
      makeSettings({ scopeMode: "allowlist", allowlist: ["geosite:google", "example.com"] }),
      { v: 1, groups: { "geosite:google": storedGroup(["google.com"]) } }
    );
    const response = await bg.handleRemoveScopeSite({
      list: "allowlist",
      pattern: "GEOSITE:GOOGLE",
    });
    expect(response).toEqual({ success: true });
    expect(stored().allowlist).toEqual(["example.com"]);
    await vi.waitFor(() => expect(storedGroups(store)).toEqual({}));
  });

  describe("where site groups aren't available (Safari)", () => {
    beforeEach(() => {
      gate.available = false;
    });

    test.each(["geosite:google", LINK, "=mail.example.com"])(
      "%s is rejected as INVALID_PATTERN with nothing stored or fetched",
      async (pattern) => {
        const bg = await bootWithStore(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
        const fetchMock = routeFetch();
        const response = await bg.handleAddScopeSite({ list: "allowlist", pattern });
        expect(response).toEqual({ error: "INVALID_PATTERN" });
        expect(store.writes).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
      }
    );

    test("typed patterns still add, and a stored token can still be removed", async () => {
      const bg = await bootWithStore(
        makeSettings({ scopeMode: "allowlist", allowlist: ["geosite:google"] })
      );
      expect(await bg.handleAddScopeSite({ list: "allowlist", pattern: "*.ru" })).toEqual({
        success: true,
      });
      expect(
        await bg.handleRemoveScopeSite({ list: "allowlist", pattern: "geosite:google" })
      ).toEqual({ success: true });
      expect(stored().allowlist).toEqual(["*.ru"]);
    });
  });
});
