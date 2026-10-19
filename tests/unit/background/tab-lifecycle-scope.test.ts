/**
 * Unit tests for per-tab scope resolution in the tab-lifecycle handlers
 * (Site-Scoping, task 5.3).
 *
 * The `onCreated` handler and the `onAlarm` injection-confirmation path must
 * deliver each tab its own `Effective_Enabled` value — computed from the tab's
 * top-level URL via the shared `computeEffectiveEnabled` source of truth —
 * instead of the global `enabled` flag. A navigated tab (`onUpdated`) schedules
 * injection-check alarms whose confirmation send flows through `onAlarm`, so
 * the late-injected delivery is exercised end-to-end via that path.
 *
 * Validates: Requirements 7.5, 8.4, 9.3
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

type Listener = (
  tabId: number,
  changeInfo: browser.tabs._OnUpdatedChangeInfo,
  tab: browser.tabs.Tab
) => void;
type CreatedListener = (tab: browser.tabs.Tab) => void;
type AlarmHandler = (alarm: browser.alarms.Alarm) => void;

interface CapturedHandlers {
  onCreated: CreatedListener;
  onUpdated: Listener;
  onAlarm: AlarmHandler;
}

async function captureHandlers(s: Settings): Promise<CapturedHandlers> {
  vi.clearAllMocks();
  vi.resetModules();
  browser.storage.local.get = vi.fn().mockResolvedValue({ settings: s });
  browser.storage.local.set = vi.fn().mockResolvedValue(undefined);
  await import("@/background");

  const createdMock = browser.tabs.onCreated as unknown as Record<string, ReturnType<typeof vi.fn>>;
  expect(createdMock["addListener"]).toHaveBeenCalled();
  const onCreated = createdMock["addListener"].mock.calls[0][0] as CreatedListener;

  const updatedMock = browser.tabs.onUpdated as unknown as Record<string, ReturnType<typeof vi.fn>>;
  expect(updatedMock["addListener"]).toHaveBeenCalled();
  const updatedListeners = updatedMock["addListener"].mock.calls.map((c) => c[0] as Listener);
  const onUpdated: Listener = (tabId, changeInfo, tab) => {
    for (const l of updatedListeners) l(tabId, changeInfo, tab);
  };

  const alarmMock = browser.alarms.onAlarm as unknown as Record<string, ReturnType<typeof vi.fn>>;
  expect(alarmMock["addListener"]).toHaveBeenCalled();
  const onAlarm = alarmMock["addListener"].mock.calls[0][0] as AlarmHandler;

  return { onCreated, onUpdated, onAlarm };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

/** Capture only the UPDATE_SETTINGS messages delivered to each tab id. */
function captureUpdateMessages(): Map<number, Message<Settings>> {
  const byTab = new Map<number, Message<Settings>>();
  browser.tabs.sendMessage = vi
    .fn()
    .mockImplementation((tabId: number, message: Message<Settings>) => {
      if (message.type === "UPDATE_SETTINGS") {
        byTab.set(tabId, message);
      }
      return Promise.resolve();
    });
  return byTab;
}

function expectedEnabled(
  s: Settings,
  url: string | undefined,
  isRestricted: (u: string) => boolean
) {
  return computeEffectiveEnabled({
    masterEnabled: s.enabled,
    scopeMode: s.scopeMode,
    allowlist: s.allowlist,
    denylist: s.denylist,
    topLevelUrl: url,
    isRestricted,
  });
}

describe("Tab-lifecycle per-tab scope resolution (task 5.3)", () => {
  describe("onCreated", () => {
    test("newly created tab receives its per-tab enabled, not the global enabled", async () => {
      // allowlist mode: master on but the tab's domain is NOT listed, so the
      // per-tab Effective_Enabled is false even though global enabled is true.
      const s = makeSettings({ scopeMode: "allowlist", allowlist: ["allowed.com"] });
      const { onCreated } = await captureHandlers(s);
      const { isRestrictedUrl } = await import("@/background");
      const byTab = captureUpdateMessages();

      const tab = { id: 7, url: "https://notlisted.com/page" } as browser.tabs.Tab;
      onCreated(tab);
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 150)); // onCreated defers the send 100ms
      await flushMicrotasks();

      const message = byTab.get(7);
      expect(message).toBeDefined();
      const payload = message!.payload as unknown as Record<string, unknown>;
      expect(payload.enabled).toBe(false);
      expect(payload.enabled).toBe(expectedEnabled(s, tab.url, isRestrictedUrl));
      // Privacy invariant: lists never leak into a page-bound payload.
      expect(payload).not.toHaveProperty("allowlist");
      expect(payload).not.toHaveProperty("denylist");
    });

    test("newly created in-scope tab receives enabled: true", async () => {
      const s = makeSettings({ scopeMode: "allowlist", allowlist: ["allowed.com"] });
      const { onCreated } = await captureHandlers(s);
      const byTab = captureUpdateMessages();

      const tab = { id: 8, url: "https://app.allowed.com/x" } as browser.tabs.Tab;
      onCreated(tab);
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 150));
      await flushMicrotasks();

      const payload = byTab.get(8)!.payload as unknown as Record<string, unknown>;
      expect(payload.enabled).toBe(true);
    });

    test("newly created tab with an undeterminable URL receives enabled: false", async () => {
      const s = makeSettings({ scopeMode: "all" });
      const { onCreated } = await captureHandlers(s);
      const byTab = captureUpdateMessages();

      const tab = { id: 9, url: undefined } as browser.tabs.Tab;
      onCreated(tab);
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 150));
      await flushMicrotasks();

      const payload = byTab.get(9)!.payload as unknown as Record<string, unknown>;
      expect(payload.enabled).toBe(false);
    });
  });

  describe("onAlarm injection-confirmation (late-injected tab)", () => {
    test("late-injected tab receives its per-tab enabled from its top-level URL", async () => {
      // denylist mode: master on, the tab's domain IS listed, so the per-tab
      // Effective_Enabled is false despite global enabled being true.
      const s = makeSettings({ scopeMode: "denylist", denylist: ["blocked.com"] });
      const { onAlarm } = await captureHandlers(s);
      const { isRestrictedUrl } = await import("@/background");

      const tabId = 21;
      const url = "https://sub.blocked.com/path";
      browser.tabs.get = vi.fn().mockResolvedValue({ id: tabId, url });
      const byTab = captureUpdateMessages(); // PING + UPDATE_SETTINGS both resolve

      onAlarm({ name: `injection-check:${tabId}:0`, scheduledTime: Date.now() });
      await flushMicrotasks();

      const message = byTab.get(tabId);
      expect(message).toBeDefined();
      const payload = message!.payload as unknown as Record<string, unknown>;
      expect(payload.enabled).toBe(false);
      expect(payload.enabled).toBe(expectedEnabled(s, url, isRestrictedUrl));
      expect(payload).not.toHaveProperty("allowlist");
      expect(payload).not.toHaveProperty("denylist");
    });

    test("late-injected in-scope tab receives enabled: true", async () => {
      const s = makeSettings({ scopeMode: "denylist", denylist: ["blocked.com"] });
      const { onAlarm } = await captureHandlers(s);

      const tabId = 22;
      const url = "https://allowed.example/path";
      browser.tabs.get = vi.fn().mockResolvedValue({ id: tabId, url });
      const byTab = captureUpdateMessages();

      onAlarm({ name: `injection-check:${tabId}:0`, scheduledTime: Date.now() });
      await flushMicrotasks();

      const payload = byTab.get(tabId)!.payload as unknown as Record<string, unknown>;
      expect(payload.enabled).toBe(true);
    });

    test("late-injected tab whose URL cannot be resolved receives enabled: false", async () => {
      const s = makeSettings({ scopeMode: "all" });
      const { onAlarm } = await captureHandlers(s);

      const tabId = 23;
      browser.tabs.get = vi.fn().mockRejectedValue(new Error("no such tab"));
      const byTab = captureUpdateMessages();

      onAlarm({ name: `injection-check:${tabId}:0`, scheduledTime: Date.now() });
      await flushMicrotasks();

      const payload = byTab.get(tabId)!.payload as unknown as Record<string, unknown>;
      expect(payload.enabled).toBe(false);
    });
  });

  describe("onUpdated → onAlarm (navigation then late injection)", () => {
    test("a navigated tab's confirmation delivers per-tab enabled for the new URL", async () => {
      const s = makeSettings({ scopeMode: "allowlist", allowlist: ["allowed.com"] });
      const { onUpdated, onAlarm } = await captureHandlers(s);
      const { isRestrictedUrl } = await import("@/background");

      const tabId = 31;
      const url = "https://notlisted.org/page";
      browser.tabs.get = vi.fn().mockResolvedValue({ id: tabId, url });
      const byTab = captureUpdateMessages();

      // Navigation schedules injection-check alarms.
      onUpdated(tabId, { status: "loading" }, { id: tabId, url } as browser.tabs.Tab);
      await flushMicrotasks();

      // The first alarm fires; injection confirmed → per-tab payload delivered.
      onAlarm({ name: `injection-check:${tabId}:0`, scheduledTime: Date.now() });
      await flushMicrotasks();

      const payload = byTab.get(tabId)!.payload as unknown as Record<string, unknown>;
      expect(payload.enabled).toBe(false);
      expect(payload.enabled).toBe(expectedEnabled(s, url, isRestrictedUrl));
    });
  });

  describe("onUpdated same-document (SPA) navigation re-evaluation (task 10)", () => {
    test("a History-API URL change pushes the recomputed per-tab enabled and re-badges", async () => {
      // Path-scoped allowlist: only /app/* is in scope.
      const s = makeSettings({ scopeMode: "allowlist", allowlist: ["example.com/app/*"] });
      const { onUpdated } = await captureHandlers(s);
      const { isRestrictedUrl } = await import("@/background");
      const byTab = captureUpdateMessages();
      const setBadgeText = vi.fn().mockResolvedValue(undefined);
      browser.action.setBadgeText = setBadgeText;
      browser.action.setBadgeBackgroundColor = vi.fn().mockResolvedValue(undefined);

      const tabId = 41;

      // In-scope route via a same-document navigation: changeInfo.url is set but
      // there is no "loading" status (the content script is not reloaded).
      const inScope = "https://example.com/app/dashboard";
      onUpdated(tabId, { url: inScope }, { id: tabId, url: inScope } as browser.tabs.Tab);
      await flushMicrotasks();

      let payload = byTab.get(tabId)!.payload as unknown as Record<string, unknown>;
      expect(payload.enabled).toBe(true);
      expect(payload.enabled).toBe(expectedEnabled(s, inScope, isRestrictedUrl));
      // Privacy invariant holds on the pushed payload too.
      expect(payload).not.toHaveProperty("allowlist");
      expect(payload).not.toHaveProperty("denylist");
      expect(setBadgeText).toHaveBeenCalled();

      // Navigate within the same document to an out-of-scope route: the pushed
      // decision flips to disabled without a reload.
      const outScope = "https://example.com/settings";
      onUpdated(tabId, { url: outScope }, { id: tabId, url: outScope } as browser.tabs.Tab);
      await flushMicrotasks();

      payload = byTab.get(tabId)!.payload as unknown as Record<string, unknown>;
      expect(payload.enabled).toBe(false);
      expect(payload.enabled).toBe(expectedEnabled(s, outScope, isRestrictedUrl));
    });

    test("a full navigation (status 'loading') is not handled by the SPA push branch", async () => {
      // The SPA branch is gated on changeInfo.url WITHOUT a loading status; a
      // full navigation must not push UPDATE_SETTINGS here (the reloading content
      // script re-requests settings, and the injection-confirmation alarm path
      // delivers the value). So no UPDATE_SETTINGS is sent for the loading event.
      const s = makeSettings({ scopeMode: "all" });
      const { onUpdated } = await captureHandlers(s);
      const byTab = captureUpdateMessages();
      browser.action.setBadgeText = vi.fn().mockResolvedValue(undefined);
      browser.action.setBadgeBackgroundColor = vi.fn().mockResolvedValue(undefined);

      const tabId = 42;
      const url = "https://example.com/page";
      onUpdated(tabId, { status: "loading", url }, { id: tabId, url } as browser.tabs.Tab);
      await flushMicrotasks();

      expect(byTab.has(tabId)).toBe(false);
    });
  });
});
