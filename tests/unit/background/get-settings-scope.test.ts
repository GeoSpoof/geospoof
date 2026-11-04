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
import type { Message, UpdateSettingsPayload } from "@/shared/types/messages";
import { computeEffectiveEnabled } from "@/shared/utils/scope";
import { makeSiteLocation, TOKYO, TOKYO_NAME, TOKYO_TZ } from "../../helpers/site-locations";

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

  // A page Chrome prerenders runs in the tab the user is still looking at, so
  // `tab.url` is the page being left. Its outermost frame has a non-zero
  // frameId; the content script's `topFrame` claim, honored only while the
  // document is prerendering, says it's a top-level document.
  describe("prerendered and top-frame senders", () => {
    const A_URL = "https://a.test/";
    const B_URL = "https://b.test/page";
    const settingsForB = (): Settings =>
      makeSettings({
        scopeMode: "allowlist",
        allowlist: ["b.test"],
        siteLocations: [
          makeSiteLocation({
            patterns: ["b.test"],
            location: TOKYO,
            timezone: TOKYO_TZ,
            locationName: TOKYO_NAME,
          }),
        ],
      });
    const prerenderSender = (tabId: number): browser.runtime.MessageSender =>
      ({
        frameId: 7,
        documentLifecycle: "prerender",
        url: B_URL,
        tab: { id: tabId, url: A_URL } as browser.tabs.Tab,
      }) as browser.runtime.MessageSender;

    test("a prerendered page on site B while tab.url is site A gets B's values", async () => {
      const { handleMessage } = await importBackgroundWith(settingsForB());

      const response = (await handleMessage(
        { type: "GET_SETTINGS", payload: { topFrame: true } },
        prerenderSender(21)
      )) as UpdateSettingsPayload;

      expect(response.enabled).toBe(true);
      expect(response.timezone?.identifier).toBe("Asia/Tokyo");
      expect(response.location?.latitude).toBe(TOKYO.latitude);
      expect(response.location?.longitude).toBe(TOKYO.longitude);
    });

    test("a prerendered subframe (no top-frame claim) still follows the tab", async () => {
      const { handleMessage } = await importBackgroundWith(settingsForB());

      const response = (await handleMessage(
        { type: "GET_SETTINGS", payload: { topFrame: false } },
        prerenderSender(22)
      )) as UpdateSettingsPayload;

      expect(response.enabled).toBe(false);
      expect(response.timezone?.identifier).not.toBe("Asia/Tokyo");
    });

    test("the badge for a prerendered page keeps describing the visible page", async () => {
      const { handleMessage } = await importBackgroundWith(settingsForB());

      await handleMessage(
        { type: "GET_SETTINGS", payload: { topFrame: true } },
        prerenderSender(23)
      );

      // a.test isn't allowlisted, so the visible tab is out of scope ("•"),
      // even though the prerendered b.test document is in scope.
      expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ text: "•", tabId: 23 });
    });

    // Engine-level spoofing (Chromium debugger mode) flags the payload so each
    // frame keeps native Date/Intl where the engine already reports the zone,
    // but CDP is attached to the tab, which still shows A, so it doesn't reach
    // a page being prerendered: that document gets the plain injected path.
    test("Engine-level spoofing flags the zone, except for a prerendering document", async () => {
      const { buildPagePayload } = await import("@/background/page-payload");
      const s = { ...settingsForB(), debuggerModeEnabled: true };

      const active = await buildPagePayload(s, B_URL, { engineTimezone: true });
      const prerendering = await buildPagePayload(s, B_URL, {
        engineTimezone: true,
        prerendering: true,
      });

      expect(active.timezone?.identifier).toBe("Asia/Tokyo");
      expect(active.engineTimezone).toBe(true);
      expect(prerendering.timezone).toEqual(active.timezone);
      expect(prerendering.engineTimezone).toBe(false);
      expect(prerendering.location).toEqual(active.location);
    });

    test("GET_SETTINGS tells the payload builder whether the sender is prerendering", async () => {
      const seen: unknown[] = [];
      vi.doMock("@/background/page-payload", async (importOriginal) => {
        const mod = await importOriginal<typeof import("@/background/page-payload")>();
        return {
          ...mod,
          buildPagePayload: (...args: Parameters<typeof mod.buildPagePayload>) => {
            seen.push(args[2]);
            return mod.buildPagePayload(...args);
          },
        };
      });
      try {
        const { handleMessage } = await importBackgroundWith(settingsForB());
        await handleMessage(
          { type: "GET_SETTINGS", payload: { topFrame: true } },
          prerenderSender(25)
        );
        await handleMessage(
          { type: "GET_SETTINGS", payload: { topFrame: true } },
          { frameId: 0, url: B_URL, tab: { id: 26, url: B_URL } as browser.tabs.Tab }
        );
      } finally {
        vi.doUnmock("@/background/page-payload");
      }

      expect(seen).toEqual([
        { prerendering: true, withoutSiteLocation: false, engineTimezoneSettled: true },
        { prerendering: false, withoutSiteLocation: false, engineTimezoneSettled: true },
      ]);
    });

    // The reverse case: visible A owns an entry, and hidden prerendered B
    // doesn't. B's subframe is judged by A (its sender names no parent), so it
    // follows A's Filters decision and gets the main location, never A's
    // entry. Once B is shown the subframe asks again and gets B's own values.
    describe("visible A owns a site location; a subframe of prerendered B", () => {
      const settingsForA = (overrides: Partial<Settings> = {}): Settings =>
        makeSettings({
          localeSpoofing: { mode: "match" },
          siteLocations: [
            makeSiteLocation({
              patterns: ["a.test"],
              location: TOKYO,
              timezone: TOKYO_TZ,
              locationName: TOKYO_NAME,
            }),
          ],
          ...overrides,
        });
      const subframe = (tabId: number, lifecycle: string, tabUrl: string) =>
        ({
          frameId: 8,
          documentLifecycle: lifecycle,
          url: "https://b.test/frame",
          tab: { id: tabId, url: tabUrl } as browser.tabs.Tab,
        }) as browser.runtime.MessageSender;
      const ask = (
        handleMessage: Awaited<ReturnType<typeof importBackgroundWith>>["handleMessage"],
        sender: browser.runtime.MessageSender
      ) =>
        handleMessage(
          { type: "GET_SETTINGS", payload: { topFrame: false } },
          sender
        ) as Promise<UpdateSettingsPayload>;
      const expectNoTokyo = (payload: UpdateSettingsPayload): void => {
        expect(payload.location?.latitude).not.toBe(TOKYO.latitude);
        expect(payload.location?.longitude).not.toBe(TOKYO.longitude);
        expect(payload.timezone?.identifier).not.toBe("Asia/Tokyo");
        expect(payload.locale?.tag).not.toMatch(/^ja/);
      };

      test("unmatched B: the main location before and after it's shown", async () => {
        const s = settingsForA();
        const { handleMessage } = await importBackgroundWith(s);

        const before = await ask(handleMessage, subframe(31, "prerender", A_URL));
        expectNoTokyo(before);
        expect(before.enabled).toBe(true);
        expect(before.location?.latitude).toBe(s.location!.latitude);
        expect(before.timezone?.identifier).toBe("America/Los_Angeles");
        expect(before.locale?.tag).toBe("en-US");

        const after = await ask(handleMessage, subframe(31, "active", B_URL));
        expect(after.enabled).toBe(true);
        expect(after.location?.latitude).toBe(s.location!.latitude);
        expect(after.timezone?.identifier).toBe("America/Los_Angeles");
      });

      test("out-of-scope B: never A's entry, and off once it's shown", async () => {
        const { handleMessage } = await importBackgroundWith(
          settingsForA({ scopeMode: "denylist", denylist: ["b.test"] })
        );

        // Filters still follow the page being left until B is shown.
        const before = await ask(handleMessage, subframe(32, "prerender", A_URL));
        expectNoTokyo(before);
        expect(before.timezone?.identifier).toBe("America/Los_Angeles");

        const after = await ask(handleMessage, subframe(32, "active", B_URL));
        expect(after.enabled).toBe(false);
        expectNoTokyo(after);
      });

      test("A's own active subframe still gets A's entry", async () => {
        const { handleMessage } = await importBackgroundWith(settingsForA());
        const own = await ask(handleMessage, {
          frameId: 3,
          documentLifecycle: "active",
          url: "https://embed.test/",
          tab: { id: 33, url: A_URL } as browser.tabs.Tab,
        } as browser.runtime.MessageSender);
        expect(own.timezone?.identifier).toBe("Asia/Tokyo");
      });
    });

    test("an active top frame whose own URL is B while tab.url is A resolves B", async () => {
      const { handleMessage } = await importBackgroundWith(settingsForB());

      const response = (await handleMessage(
        { type: "GET_SETTINGS", payload: { topFrame: true } },
        { frameId: 0, url: B_URL, tab: { id: 24, url: A_URL } as browser.tabs.Tab }
      )) as UpdateSettingsPayload;

      expect(response.enabled).toBe(true);
      expect(response.timezone?.identifier).toBe("Asia/Tokyo");
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
