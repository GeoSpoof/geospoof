/**
 * Unit Tests for the Three-State Per-Tab Badge
 * Feature: site-scoping
 *
 * Covers:
 *  - badgeStateFor across all master/effective combinations (Req 12.1–12.3)
 *  - setBadgeForTab writing the expected color/text per state
 *  - updateBadge computing Effective_Enabled per tab, including restricted
 *    URLs mapping to the out-of-scope state (Req 12.5)
 */

import { DEFAULT_SETTINGS, type Settings } from "@/shared/types/settings";
import {
  badgeStateFor,
  setBadgeForTab,
  setTitleForTab,
  tabTitleFor,
  updateBadge,
} from "@/background/badge";
import { resolveSiteSettings } from "@/shared/utils/site-locations";
import { isRestrictedUrl } from "@/background/restricted-url";
import { storageData } from "../../setup";
import { ENTRY_DUBLIN, ENTRY_MEXICO_CITY, makeSiteLocation } from "../../helpers/site-locations";

function seedSettings(overrides: Partial<Settings>): void {
  storageData.settings = { ...DEFAULT_SETTINGS, ...overrides };
}

describe("badgeStateFor", () => {
  /**
   * Master on + effective true ⇒ active (Req 12.1).
   */
  test("returns 'active' when master on and effective enabled", () => {
    expect(badgeStateFor(true, true)).toBe("active");
  });

  /**
   * Master on + effective false ⇒ out-of-scope (Req 12.2, 12.5).
   */
  test("returns 'out-of-scope' when master on but effective disabled", () => {
    expect(badgeStateFor(true, false)).toBe("out-of-scope");
  });

  /**
   * Master off ⇒ master-off regardless of effective value (Req 12.3).
   */
  test("returns 'master-off' when master off (effective false)", () => {
    expect(badgeStateFor(false, false)).toBe("master-off");
  });

  test("returns 'master-off' when master off even if effective true", () => {
    expect(badgeStateFor(false, true)).toBe("master-off");
  });
});

describe("setBadgeForTab", () => {
  test("writes green checkmark for 'active'", () => {
    setBadgeForTab(7, "active");

    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: "green",
      tabId: 7,
    });
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: "✓", tabId: 7 });
  });

  test("writes muted slate dot for 'out-of-scope'", () => {
    setBadgeForTab(8, "out-of-scope");

    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: "#5b7083",
      tabId: 8,
    });
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: "•", tabId: 8 });
  });

  test("writes gray empty text for 'master-off'", () => {
    setBadgeForTab(9, "master-off");

    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: "gray",
      tabId: 9,
    });
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: "", tabId: 9 });
  });
});

describe("updateBadge", () => {
  test("shows master-off on every tab when master switch is off", async () => {
    seedSettings({ enabled: false });
    browser.tabs.query.mockResolvedValue([
      { id: 1, url: "https://example.com" },
      { id: 2, url: "https://other.com" },
    ]);

    await updateBadge();

    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: "gray",
      tabId: 1,
    });
    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: "gray",
      tabId: 2,
    });
  });

  test("shows active for an in-scope tab in 'all' mode", async () => {
    seedSettings({ enabled: true, scopeMode: "all" });
    browser.tabs.query.mockResolvedValue([{ id: 1, url: "https://example.com" }]);

    await updateBadge();

    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: "green",
      tabId: 1,
    });
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: "✓", tabId: 1 });
  });

  test("shows out-of-scope for a restricted URL even when master on (Req 12.5)", async () => {
    seedSettings({ enabled: true, scopeMode: "all" });
    browser.tabs.query.mockResolvedValue([{ id: 1, url: "about:blank" }]);

    await updateBadge();

    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: "#5b7083",
      tabId: 1,
    });
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: "•", tabId: 1 });
  });

  test("shows out-of-scope for a tab not on the allowlist", async () => {
    seedSettings({ enabled: true, scopeMode: "allowlist", allowlist: ["example.com"] });
    browser.tabs.query.mockResolvedValue([{ id: 1, url: "https://not-listed.com" }]);

    await updateBadge();

    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: "#5b7083",
      tabId: 1,
    });
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: "•", tabId: 1 });
  });

  test("applies per-tab states across a mixed set of tabs", async () => {
    seedSettings({ enabled: true, scopeMode: "denylist", denylist: ["blocked.com"] });
    browser.tabs.query.mockResolvedValue([
      { id: 1, url: "https://example.com" }, // active
      { id: 2, url: "https://blocked.com" }, // out-of-scope (denylisted)
      { id: 3, url: "chrome://settings" }, // out-of-scope (restricted)
    ]);

    await updateBadge();

    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: "green",
      tabId: 1,
    });
    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: "#5b7083",
      tabId: 2,
    });
    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: "#5b7083",
      tabId: 3,
    });
  });
});
describe("per-tab title (site locations)", () => {
  const SITES = [ENTRY_DUBLIN, ENTRY_MEXICO_CITY];

  test("updateBadge names the site location on matched tabs and resets the rest", async () => {
    seedSettings({ enabled: true, scopeMode: "all", siteLocations: SITES });
    browser.tabs.query.mockResolvedValue([
      { id: 1, url: "https://chatgpt.com/c/1" },
      { id: 2, url: "https://www.twitch.tv/x" },
      { id: 3, url: "https://example.com/" },
    ]);
    await updateBadge();
    expect(browser.action.setTitle).toHaveBeenCalledWith({
      title: "GeoSpoof: Dublin on chatgpt.com",
      tabId: 1,
    });
    expect(browser.action.setTitle).toHaveBeenCalledWith({
      title: "GeoSpoof: Mexico City on www.twitch.tv",
      tabId: 2,
    });
    expect(browser.action.setTitle).toHaveBeenCalledWith({ title: "GeoSpoof", tabId: 3 });
    // Badge colors and states are unchanged: a site-location tab is just active.
    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: "green",
      tabId: 1,
    });
  });

  test("an out-of-scope matched tab gets the plain title", async () => {
    seedSettings({
      enabled: true,
      scopeMode: "denylist",
      denylist: ["chatgpt.com"],
      siteLocations: SITES,
    });
    browser.tabs.query.mockResolvedValue([{ id: 1, url: "https://chatgpt.com/" }]);
    await updateBadge();
    expect(browser.action.setTitle).toHaveBeenCalledWith({ title: "GeoSpoof", tabId: 1 });
  });

  test("tabTitleFor uses the localized string when one exists", () => {
    const original = (browser as unknown as { i18n?: unknown }).i18n;
    const getMessage = vi.fn((key: string, subs?: string[]) =>
      key === "badge_titleSiteLocation" ? `GS ${subs?.[0]} @ ${subs?.[1]}` : ""
    );
    (browser as unknown as { i18n?: unknown }).i18n = { getMessage };
    try {
      const settings = { ...DEFAULT_SETTINGS, enabled: true, siteLocations: SITES };
      const url = "https://chatgpt.com/";
      expect(tabTitleFor(resolveSiteSettings(settings, url, isRestrictedUrl), url)).toBe(
        "GS Dublin @ chatgpt.com"
      );
      // An empty string (missing key) falls back to the English default.
      const other = "https://example.com/";
      expect(tabTitleFor(resolveSiteSettings(settings, other, isRestrictedUrl), other)).toBe(
        "GeoSpoof"
      );
    } finally {
      (browser as unknown as { i18n?: unknown }).i18n = original;
    }
  });

  test("tabTitleFor prefers the entry's label", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      enabled: true,
      siteLocations: [makeSiteLocation({ patterns: ["chatgpt.com"], label: "EU privacy" })],
    };
    const url = "https://chatgpt.com/";
    expect(tabTitleFor(resolveSiteSettings(settings, url, isRestrictedUrl), url)).toBe(
      "GeoSpoof: EU privacy on chatgpt.com"
    );
  });

  test("a missing setTitle is tolerated", async () => {
    const action = browser.action as unknown as Record<string, unknown>;
    const original = action.setTitle;
    delete action.setTitle;
    try {
      expect(() => setTitleForTab(1, "GeoSpoof")).not.toThrow();
      seedSettings({ enabled: true, siteLocations: SITES });
      browser.tabs.query.mockResolvedValue([{ id: 1, url: "https://chatgpt.com/" }]);
      await expect(updateBadge()).resolves.toBeUndefined();
      expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: "✓", tabId: 1 });
    } finally {
      action.setTitle = original;
    }
  });

  test("a setTitle rejection is swallowed", async () => {
    browser.action.setTitle.mockRejectedValueOnce(new Error("No tab with id: 1"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      setTitleForTab(1, "GeoSpoof");
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
