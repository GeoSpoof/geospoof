/**
 * Unit tests for the sender-split, scoped GET_SETTINGS handler
 * (Site-Scoping, task 6).
 *
 * The GET_SETTINGS handler branches on `_sender.tab`:
 *   - Popup (`_sender.tab == null`) receives the full Settings object so it can
 *     render the selected scope mode and both site lists (Req 13.2).
 *   - Content scripts receive a list-free `UpdateSettingsPayload` whose
 *     `enabled` is the per-tab Effective_Enabled computed from the sender tab's
 *     top-level URL (Req 6.6, 6.7, 8.5, 8.7, 10.1).
 *
 * Privacy regression: the allowlist/denylist arrays must never appear in any
 * page-bound payload — neither the content-script GET_SETTINGS response nor the
 * per-tab broadcast payloads.
 *
 * Validates: Requirements 6.6, 6.7, 8.5, 8.7, 10.1
 */

import { describe, test, expect, vi } from "vitest";
import type { Settings } from "@/shared/types/settings";
import type { Message } from "@/shared/types/messages";
import { computeEffectiveEnabled } from "@/shared/utils/scope";

function makeSettings(overrides?: Partial<Settings>): Settings {
  return {
    enabled: true,
    location: { latitude: 37.7749, longitude: -122.4194, accuracy: 10 },
    timezone: { identifier: "America/Los_Angeles", offset: 480, dstOffset: 60 },
    locationName: { city: "San Francisco", country: "US", displayName: "San Francisco, US" },
    webrtcProtection: false,
    preserveGeolocationPrompt: false,
    onboardingCompleted: true,
    version: "1.1",
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
    allowlist: ["allowed.com"],
    denylist: ["blocked.com"],
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

async function importBackgroundWith(s: Settings) {
  vi.clearAllMocks();
  vi.resetModules();
  browser.storage.local.get = vi.fn().mockResolvedValue({ settings: s });
  browser.storage.local.set = vi.fn().mockResolvedValue(undefined);
  return import("@/background");
}

const senderFor = (id: number, url: string | undefined): browser.runtime.MessageSender => ({
  tab: { id, url } as browser.tabs.Tab,
});

describe("Scoped GET_SETTINGS by sender (task 6)", () => {
  describe("content-script branch (sender.tab present)", () => {
    test("response contains no allowlist/denylist keys", async () => {
      const s = makeSettings({ scopeMode: "denylist", denylist: ["blocked.com"] });
      const { handleMessage } = await importBackgroundWith(s);

      const response = (await handleMessage(
        { type: "GET_SETTINGS" },
        senderFor(5, "https://example.com/page")
      )) as Record<string, unknown>;

      expect(response).not.toHaveProperty("allowlist");
      expect(response).not.toHaveProperty("denylist");
      expect(response).not.toHaveProperty("siteLocations");
      // It is the scoped payload shape, not the full Settings object.
      expect(response).not.toHaveProperty("scopeMode");
      expect(response).not.toHaveProperty("favorites");
      expect(response).toHaveProperty("enabled");
      expect(response).toHaveProperty("location");
      expect(response).toHaveProperty("timezone");
      expect(response).toHaveProperty("webrtcProtection");
    });

    test("enabled equals computeEffectiveEnabled for the sender tab URL (in scope)", async () => {
      const s = makeSettings({ scopeMode: "allowlist", allowlist: ["allowed.com"] });
      const { handleMessage, isRestrictedUrl } = await importBackgroundWith(s);

      const url = "https://app.allowed.com/x";
      const response = (await handleMessage({ type: "GET_SETTINGS" }, senderFor(6, url))) as Record<
        string,
        unknown
      >;

      const expected = computeEffectiveEnabled({
        masterEnabled: s.enabled,
        scopeMode: s.scopeMode,
        allowlist: s.allowlist,
        denylist: s.denylist,
        topLevelUrl: url,
        isRestricted: isRestrictedUrl,
      });
      expect(response.enabled).toBe(true);
      expect(response.enabled).toBe(expected);
    });

    test("out-of-scope sender tab yields enabled: false", async () => {
      const s = makeSettings({ scopeMode: "allowlist", allowlist: ["allowed.com"] });
      const { handleMessage } = await importBackgroundWith(s);

      const response = (await handleMessage(
        { type: "GET_SETTINGS" },
        senderFor(7, "https://notlisted.com/page")
      )) as Record<string, unknown>;

      expect(response.enabled).toBe(false);
    });

    test("unresolvable sender tab URL yields enabled: false", async () => {
      const s = makeSettings({ scopeMode: "all" });
      const { handleMessage } = await importBackgroundWith(s);

      const response = (await handleMessage(
        { type: "GET_SETTINGS" },
        senderFor(8, undefined)
      )) as Record<string, unknown>;

      expect(response.enabled).toBe(false);
      expect(response).not.toHaveProperty("allowlist");
      expect(response).not.toHaveProperty("denylist");
      expect(response).not.toHaveProperty("siteLocations");
    });

    test("non-scope fields equal the persisted Settings values", async () => {
      const s = makeSettings({ scopeMode: "all", debugLogging: true, verbosityLevel: "DEBUG" });
      const { handleMessage } = await importBackgroundWith(s);

      const response = (await handleMessage(
        { type: "GET_SETTINGS" },
        senderFor(9, "https://example.com/")
      )) as Record<string, unknown>;

      expect(response.location).toEqual(s.location);
      expect(response.timezone).toEqual(s.timezone);
      expect(response.debugLogging).toBe(s.debugLogging);
      expect(response.verbosityLevel).toBe(s.verbosityLevel);
      expect(response.webrtcProtection).toBe(s.webrtcProtection);
    });

    test("scoped payload carries accuracySetting and accuracySeed", async () => {
      // The content-script payload must thread the accuracy resolution inputs
      // so the injected Resolver uses the user's chosen setting rather than
      // always falling back to auto/0 (the wiring bug this fixes).
      const s = makeSettings({
        scopeMode: "all",
        accuracySetting: { mode: "fixed", meters: 250 },
        accuracySeed: 1234567,
      });
      const { handleMessage } = await importBackgroundWith(s);

      const response = (await handleMessage(
        { type: "GET_SETTINGS" },
        senderFor(10, "https://example.com/")
      )) as Record<string, unknown>;

      expect(response.accuracySetting).toEqual({ mode: "fixed", meters: 250 });
      expect(response.accuracySeed).toBe(1234567);
    });
  });

  describe("popup branch (sender.tab == null)", () => {
    test("returns the full Settings object including the lists", async () => {
      const s = makeSettings({
        scopeMode: "allowlist",
        allowlist: ["allowed.com", "two.com"],
        denylist: ["blocked.com"],
      });
      const { handleMessage } = await importBackgroundWith(s);

      const response = (await handleMessage({ type: "GET_SETTINGS" }, {})) as Settings;

      expect(response.scopeMode).toBe("allowlist");
      expect(response.allowlist).toEqual(["allowed.com", "two.com"]);
      expect(response.denylist).toEqual(["blocked.com"]);
      expect(response.enabled).toBe(true);
    });
  });

  // On Android (Quetta, Firefox for Android) the action popup opens as a real
  // TAB, so `_sender.tab` is populated even though the page is still our own
  // extension UI. The handler must detect the extension origin and serve the
  // full Settings object — otherwise the popup receives the content-script
  // payload (no `onboardingCompleted`, `enabled` from the restricted extension
  // URL), which re-shows onboarding on every reload and breaks the toggles.
  describe("popup branch (extension page opened as a tab — Android)", () => {
    test("returns full Settings when sender.url is the extension popup page", async () => {
      const s = makeSettings({
        scopeMode: "allowlist",
        allowlist: ["allowed.com"],
        denylist: ["blocked.com"],
        onboardingCompleted: true,
      });
      const { handleMessage } = await importBackgroundWith(s);

      const sender: browser.runtime.MessageSender = {
        url: browser.runtime.getURL("popup/popup.html"),
        tab: { id: 99, url: browser.runtime.getURL("popup/popup.html") } as browser.tabs.Tab,
      };
      const response = (await handleMessage({ type: "GET_SETTINGS" }, sender)) as Settings;

      // Full Settings shape, not the scoped content-script payload.
      expect(response.scopeMode).toBe("allowlist");
      expect(response.allowlist).toEqual(["allowed.com"]);
      expect(response.denylist).toEqual(["blocked.com"]);
      expect(response.onboardingCompleted).toBe(true);
      // `enabled` is the master switch, not the per-(extension)-tab effective value.
      expect(response.enabled).toBe(true);
    });

    test("returns full Settings when only sender.tab.url is the extension page", async () => {
      const s = makeSettings({ scopeMode: "all", onboardingCompleted: true });
      const { handleMessage } = await importBackgroundWith(s);

      const sender: browser.runtime.MessageSender = {
        tab: { id: 42, url: browser.runtime.getURL("popup/popup.html") } as browser.tabs.Tab,
      };
      const response = (await handleMessage({ type: "GET_SETTINGS" }, sender)) as Settings;

      expect(response).toHaveProperty("onboardingCompleted", true);
      expect(response).toHaveProperty("scopeMode", "all");
      expect(response).toHaveProperty("favorites");
      expect(response.enabled).toBe(true);
    });
  });

  describe("privacy regression: broadcast payloads contain no list keys", () => {
    test("every per-tab UPDATE_SETTINGS payload omits allowlist/denylist", async () => {
      const s = makeSettings({
        scopeMode: "denylist",
        allowlist: ["allowed.com"],
        denylist: ["blocked.com"],
        accuracySetting: { mode: "range", min: 30, max: 90 },
        accuracySeed: 42,
      });
      const { broadcastSettingsToTabs, isRestrictedUrl } = await importBackgroundWith(s);

      const tabs = [
        { id: 1, url: "https://blocked.com/page" },
        { id: 2, url: "https://allowed.example/x" },
        { id: 3, url: undefined },
      ];
      browser.tabs.query = vi.fn().mockResolvedValue(tabs);

      const sent: Array<{ tabId: number; payload: Record<string, unknown> }> = [];
      browser.tabs.sendMessage = vi
        .fn()
        .mockImplementation((tabId: number, message: Message<Record<string, unknown>>) => {
          if (message.type === "UPDATE_SETTINGS") {
            sent.push({ tabId, payload: message.payload as Record<string, unknown> });
          }
          return Promise.resolve();
        });

      await broadcastSettingsToTabs(s);

      expect(sent.length).toBe(3);
      for (const { tabId, payload } of sent) {
        expect(payload).not.toHaveProperty("allowlist");
        expect(payload).not.toHaveProperty("denylist");
        expect(payload).not.toHaveProperty("scopeMode");

        // Accuracy resolution inputs must be present in every broadcast
        // payload so live content scripts re-resolve with the user's choice.
        expect(payload.accuracySetting).toEqual({ mode: "range", min: 30, max: 90 });
        expect(payload.accuracySeed).toBe(42);

        const tab = tabs.find((t) => t.id === tabId)!;
        const expected = computeEffectiveEnabled({
          masterEnabled: s.enabled,
          scopeMode: s.scopeMode,
          allowlist: s.allowlist,
          denylist: s.denylist,
          topLevelUrl: tab.url,
          isRestricted: isRestrictedUrl,
        });
        expect(payload.enabled).toBe(expected);
      }
    });
  });
});
