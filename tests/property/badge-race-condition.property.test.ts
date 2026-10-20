/**
 * Property-Based Tests for Badge Race Condition
 *
 * Property 1: Bug Condition (MUST FAIL on unfixed code)
 *   Validates: Requirements 1.1, 1.2, 1.3, 1.4
 * Property 2: Preservation (MUST PASS on unfixed code)
 *   Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5
 *
 * Updated for MV3 alarm-based retry logic: the onUpdated listener schedules
 * browser.alarms; badge updates happen in the onAlarm handler.
 */

import fc from "fast-check";
import type { Settings } from "@/shared/types/settings";

function makeSettings(overrides?: Partial<Settings>): Settings {
  return {
    enabled: true,
    location: { latitude: 37.7749, longitude: -122.4194, accuracy: 10 },
    timezone: { identifier: "America/Los_Angeles", offset: 480, dstOffset: 60 },
    locationName: { city: "San Francisco", country: "US", displayName: "San Francisco, US" },
    webrtcProtection: false,
    preserveGeolocationPrompt: false,
    onboardingCompleted: true,
    version: "1.0",
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

const urlArb = fc.oneof(
  fc.webUrl().map((u) => u.replace(/^https?:\/\/addons\.mozilla\.org.*/, "https://example.com")),
  fc.constant("https://example.com/page"),
  fc.constant("https://www.youtube.com/watch?v=abc"),
  fc.constant("https://github.com/user/repo")
);

const tidArb = fc.integer({ min: 1, max: 10000 });

type Listener = (
  tabId: number,
  changeInfo: browser.tabs._OnUpdatedChangeInfo,
  tab: browser.tabs.Tab
) => void;

type AlarmHandler = (alarm: browser.alarms.Alarm) => void;

interface CapturedHandlers {
  onUpdated: Listener;
  onAlarm: AlarmHandler;
}

async function captureHandlers(s: Settings): Promise<CapturedHandlers> {
  vi.clearAllMocks();
  vi.resetModules();
  browser.storage.local.get = vi.fn().mockResolvedValue({ settings: s });
  browser.storage.local.set = vi.fn().mockResolvedValue(undefined);
  await import("@/background");

  const updatedMock = browser.tabs.onUpdated as unknown as Record<string, ReturnType<typeof vi.fn>>;
  expect(updatedMock["addListener"]).toHaveBeenCalled();
  // The background registers multiple tabs.onUpdated listeners (activity-watcher
  // resync trigger, worker-filter URL cache, and the badge/injection-alarm
  // handler). The browser fires all of them on a navigation, so invoke every
  // captured listener — matching real behavior and staying robust to the order
  // in which the modules happen to register.
  const updatedListeners = updatedMock["addListener"].mock.calls.map((c) => c[0] as Listener);
  const onUpdated: Listener = (tabId, changeInfo, tab) => {
    for (const l of updatedListeners) l(tabId, changeInfo, tab);
  };

  const alarmMock = browser.alarms.onAlarm as unknown as Record<string, ReturnType<typeof vi.fn>>;
  expect(alarmMock["addListener"]).toHaveBeenCalled();
  const onAlarm = alarmMock["addListener"].mock.calls[0][0] as AlarmHandler;

  return { onUpdated, onAlarm };
}

/** Flush microtasks so the listener's inner async IIFE completes */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

const restrictedUrlArb = fc.oneof(
  fc.constant("about:blank"),
  fc.constant("about:home"),
  fc.constant("about:newtab"),
  fc.constant("moz-extension://some-uuid/popup.html"),
  fc.constant("chrome://settings"),
  fc.constant("resource://gre/modules/foo.js"),
  fc.constant("view-source:https://example.com"),
  fc.constant("data:text/html,<h1>hi</h1>"),
  fc.constant("blob:https://example.com/uuid"),
  fc.constant("file:///home/user/doc.html"),
  fc.constant("https://addons.mozilla.org/en-US/firefox/addon/geospoof/"),
  fc.constant("https://addons.mozilla.org/"),
  fc.constant("https://accounts.firefox.com/signin"),
  fc.constant("https://testpilot.firefox.com/experiments")
);

// ---------------------------------------------------------------------------
// Property 1 -- Bug Condition (MUST FAIL on unfixed code)
// ---------------------------------------------------------------------------

describe("Property 1: Bug Condition", () => {
  let handlers: CapturedHandlers;

  beforeEach(async () => {
    handlers = await captureHandlers(makeSettings());
  });

  test("badge converges to green when content script becomes ready after initial failure", async () => {
    await fc.assert(
      fc.asyncProperty(tidArb, urlArb, async (tabId, url) => {
        vi.clearAllMocks();
        const s = makeSettings();
        browser.storage.local.get = vi.fn().mockResolvedValue({ settings: s });
        let callCount = 0;
        browser.tabs.sendMessage = vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.reject(new Error("no connection"));
          return Promise.resolve({ pong: true });
        });

        // Trigger navigation — schedules alarms
        handlers.onUpdated(tabId, { status: "loading" }, { id: tabId, url } as browser.tabs.Tab);
        await flushMicrotasks();

        // Simulate alarm 0 firing (first check fails, second succeeds via sendMessage mock)
        handlers.onAlarm({ name: `injection-check:${tabId}:0`, scheduledTime: Date.now() });
        await flushMicrotasks();

        // Simulate alarm 1 firing (injection now succeeds)
        handlers.onAlarm({ name: `injection-check:${tabId}:1`, scheduledTime: Date.now() });
        await flushMicrotasks();

        const calls = (browser.action.setBadgeText as ReturnType<typeof vi.fn>).mock.calls as Array<
          [{ text: string; tabId: number }]
        >;
        const last = [...calls].reverse().find((c) => c[0].tabId === tabId);
        expect(last).toBeDefined();
        expect(last![0].text).toBe("\u2713");
      }),
      { numRuns: 20 }
    );
  });

  test("badge recovers to green when content script sends GET_SETTINGS", async () => {
    await fc.assert(
      fc.asyncProperty(tidArb, urlArb, async (tabId, url) => {
        vi.clearAllMocks();
        const s = makeSettings();
        browser.storage.local.get = vi.fn().mockResolvedValue({ settings: s });
        browser.tabs.sendMessage = vi.fn().mockRejectedValue(new Error("no connection"));

        handlers.onUpdated(tabId, { status: "loading" }, { id: tabId, url } as browser.tabs.Tab);
        await flushMicrotasks();

        (browser.action.setBadgeText as ReturnType<typeof vi.fn>).mockClear();
        (browser.action.setBadgeBackgroundColor as ReturnType<typeof vi.fn>).mockClear();

        // Import handleMessage directly (already cached from captureHandlers)
        const { handleMessage } = await import("@/background");
        await handleMessage(
          { type: "GET_SETTINGS" },
          { tab: { id: tabId, url } as browser.tabs.Tab }
        );
        await flushMicrotasks();

        const calls = (browser.action.setBadgeText as ReturnType<typeof vi.fn>).mock.calls as Array<
          [{ text: string; tabId: number }]
        >;
        const recovery = calls.find((c) => c[0].tabId === tabId);
        expect(recovery).toBeDefined();
        expect(recovery![0].text).toBe("\u2713");
      }),
      { numRuns: 20 }
    );
  });

  test("popup injection check uses live PING, not stale badge text", async () => {
    await fc.assert(
      fc.asyncProperty(tidArb, urlArb, async (tabId, url) => {
        vi.clearAllMocks();
        vi.resetModules();
        const mockDoc = {
          getElementById: vi.fn((id: string) => {
            if (id === "injectionWarning") return { style: { display: "none" } };
            if (id === "restrictedPageNotice") return { style: { display: "none" } };
            return null;
          }),
          addEventListener: vi.fn(),
        };
        vi.stubGlobal("document", mockDoc);
        browser.tabs.query = vi.fn().mockResolvedValue([{ id: tabId, url }]);
        browser.action.getBadgeText = vi.fn().mockResolvedValue("!");
        browser.runtime.sendMessage = vi.fn().mockImplementation((msg: { type: string }) => {
          if (msg.type === "GET_SETTINGS") return Promise.resolve(makeSettings());
          if (msg.type === "CHECK_TAB_INJECTION")
            return Promise.resolve({ injected: true, error: null });
          return Promise.resolve();
        });
        const popupSettings = await import("@/popup/settings");
        await popupSettings.checkInjectionStatus();
        expect(browser.action.getBadgeText as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      }),
      { numRuns: 10 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2 -- Preservation (MUST PASS on unfixed code)
// ---------------------------------------------------------------------------

describe("Property 2: Preservation", () => {
  // 2a. Protection disabled -> badge is gray with no text
  test("disabled protection: badge is always gray/empty for any URL", async () => {
    const disabled = makeSettings({ enabled: false });
    const handlers = await captureHandlers(disabled);

    await fc.assert(
      fc.asyncProperty(tidArb, urlArb, async (tabId, url) => {
        (browser.action.setBadgeText as ReturnType<typeof vi.fn>).mockClear();
        (browser.action.setBadgeBackgroundColor as ReturnType<typeof vi.fn>).mockClear();
        browser.storage.local.get = vi.fn().mockResolvedValue({ settings: disabled });

        handlers.onUpdated(tabId, { status: "loading" }, { id: tabId, url } as browser.tabs.Tab);
        await flushMicrotasks();

        const textCalls = (browser.action.setBadgeText as ReturnType<typeof vi.fn>).mock
          .calls as Array<[{ text: string; tabId: number }]>;
        const colorCalls = (browser.action.setBadgeBackgroundColor as ReturnType<typeof vi.fn>).mock
          .calls as Array<[{ color: string; tabId: number }]>;
        const lastText = [...textCalls].reverse().find((c) => c[0].tabId === tabId);
        const lastColor = [...colorCalls].reverse().find((c) => c[0].tabId === tabId);

        expect(lastText).toBeDefined();
        expect(lastText![0].text).toBe("");
        expect(lastColor).toBeDefined();
        expect(lastColor![0].color).toBe("gray");
      }),
      { numRuns: 30 }
    );
  });

  // 2b. Restricted URL three-state badge (Req 12.3, 12.5):
  //   - master OFF      -> gray / empty   (master-off state)
  //   - master ON       -> "#5b7083" / "•" (out-of-scope state; a Restricted_URL
  //                         has Effective_Enabled false but master is on)
  test("restricted URL: master-off is gray/empty, master-on is out-of-scope", async () => {
    const enabled = makeSettings({ enabled: true });
    const handlers = await captureHandlers(enabled);

    await fc.assert(
      fc.asyncProperty(tidArb, restrictedUrlArb, fc.boolean(), async (tabId, url, prot) => {
        (browser.action.setBadgeText as ReturnType<typeof vi.fn>).mockClear();
        (browser.action.setBadgeBackgroundColor as ReturnType<typeof vi.fn>).mockClear();
        const s = makeSettings({ enabled: prot });
        browser.storage.local.get = vi.fn().mockResolvedValue({ settings: s });

        handlers.onUpdated(tabId, { status: "loading" }, { id: tabId, url } as browser.tabs.Tab);
        await flushMicrotasks();

        const textCalls = (browser.action.setBadgeText as ReturnType<typeof vi.fn>).mock
          .calls as Array<[{ text: string; tabId: number }]>;
        const colorCalls = (browser.action.setBadgeBackgroundColor as ReturnType<typeof vi.fn>).mock
          .calls as Array<[{ color: string; tabId: number }]>;
        const lastText = [...textCalls].reverse().find((c) => c[0].tabId === tabId);
        const lastColor = [...colorCalls].reverse().find((c) => c[0].tabId === tabId);

        expect(lastText).toBeDefined();
        expect(lastColor).toBeDefined();
        if (prot) {
          // master ON + Restricted_URL -> out-of-scope badge (Req 12.5)
          expect(lastText![0].text).toBe("\u2022");
          expect(lastColor![0].color).toBe("#5b7083");
        } else {
          // master OFF -> master-off badge regardless of URL (Req 12.3)
          expect(lastText![0].text).toBe("");
          expect(lastColor![0].color).toBe("gray");
        }
      }),
      { numRuns: 30 }
    );
  });

  // 2c. Genuine failure -> badge is orange "!"
  test("genuine failure: badge is orange '!' when sendMessage always rejects", async () => {
    const enabled = makeSettings({ enabled: true });
    const handlers = await captureHandlers(enabled);

    await fc.assert(
      fc.asyncProperty(tidArb, urlArb, async (tabId, url) => {
        (browser.action.setBadgeText as ReturnType<typeof vi.fn>).mockClear();
        (browser.action.setBadgeBackgroundColor as ReturnType<typeof vi.fn>).mockClear();
        browser.storage.local.get = vi.fn().mockResolvedValue({ settings: enabled });
        browser.tabs.sendMessage = vi.fn().mockRejectedValue(new Error("no connection"));

        // Trigger navigation
        handlers.onUpdated(tabId, { status: "loading" }, { id: tabId, url } as browser.tabs.Tab);
        await flushMicrotasks();

        // Simulate all 3 alarm attempts firing and failing
        for (let i = 0; i <= 2; i++) {
          handlers.onAlarm({ name: `injection-check:${tabId}:${i}`, scheduledTime: Date.now() });
          await flushMicrotasks();
        }

        const textCalls = (browser.action.setBadgeText as ReturnType<typeof vi.fn>).mock
          .calls as Array<[{ text: string; tabId: number }]>;
        const colorCalls = (browser.action.setBadgeBackgroundColor as ReturnType<typeof vi.fn>).mock
          .calls as Array<[{ color: string; tabId: number }]>;
        const lastText = [...textCalls].reverse().find((c) => c[0].tabId === tabId);
        const lastColor = [...colorCalls].reverse().find((c) => c[0].tabId === tabId);

        expect(lastText).toBeDefined();
        expect(lastText![0].text).toBe("!");
        expect(lastColor).toBeDefined();
        expect(lastColor![0].color).toBe("orange");
      }),
      { numRuns: 30 }
    );
  });

  // 2d. Immediate success -> badge is green checkmark
  test("immediate success: badge is green when sendMessage resolves on first try", async () => {
    const enabled = makeSettings({ enabled: true });
    const handlers = await captureHandlers(enabled);

    await fc.assert(
      fc.asyncProperty(tidArb, urlArb, async (tabId, url) => {
        (browser.action.setBadgeText as ReturnType<typeof vi.fn>).mockClear();
        (browser.action.setBadgeBackgroundColor as ReturnType<typeof vi.fn>).mockClear();
        browser.storage.local.get = vi.fn().mockResolvedValue({ settings: enabled });
        browser.tabs.sendMessage = vi.fn().mockResolvedValue(undefined);

        // Trigger navigation
        handlers.onUpdated(tabId, { status: "loading" }, { id: tabId, url } as browser.tabs.Tab);
        await flushMicrotasks();

        // Simulate first alarm firing — injection succeeds
        handlers.onAlarm({ name: `injection-check:${tabId}:0`, scheduledTime: Date.now() });
        await flushMicrotasks();

        const textCalls = (browser.action.setBadgeText as ReturnType<typeof vi.fn>).mock
          .calls as Array<[{ text: string; tabId: number }]>;
        const colorCalls = (browser.action.setBadgeBackgroundColor as ReturnType<typeof vi.fn>).mock
          .calls as Array<[{ color: string; tabId: number }]>;
        const lastText = [...textCalls].reverse().find((c) => c[0].tabId === tabId);
        const lastColor = [...colorCalls].reverse().find((c) => c[0].tabId === tabId);

        expect(lastText).toBeDefined();
        expect(lastText![0].text).toBe("\u2713");
        expect(lastColor).toBeDefined();
        expect(lastColor![0].color).toBe("green");
      }),
      { numRuns: 30 }
    );
  });
});
