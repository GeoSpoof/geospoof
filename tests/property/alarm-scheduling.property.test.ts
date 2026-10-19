/**
 * Property-Based Tests for Alarm Scheduling on Navigation
 * Feature: mv3-manifest-compat, Property 4: Alarm scheduling on navigation
 *
 * Validates: Requirements 7.2
 *
 * For any tab ID and non-restricted URL, when a tabs.onUpdated event fires
 * with status: "loading" and protection is enabled, the background script
 * should create browser.alarms alarms with names containing that tab ID.
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

const tabIdArb = fc.integer({ min: 1, max: 10000 });

const validUrlArb = fc.oneof(
  fc.constant("https://example.com"),
  fc.constant("https://www.youtube.com/watch?v=abc"),
  fc.constant("https://github.com/user/repo"),
  fc.constant("http://localhost:3000"),
  fc.webUrl().map((u) => u.replace(/^https?:\/\/addons\.mozilla\.org.*/, "https://example.com"))
);

type Listener = (
  tabId: number,
  changeInfo: browser.tabs._OnUpdatedChangeInfo,
  tab: browser.tabs.Tab
) => void;

async function captureOnUpdatedListener(settings: Settings): Promise<Listener> {
  vi.clearAllMocks();
  vi.resetModules();
  browser.storage.local.get = vi.fn().mockResolvedValue({ settings });
  browser.storage.local.set = vi.fn().mockResolvedValue(undefined);
  await import("@/background");
  const mock = browser.tabs.onUpdated as unknown as Record<string, ReturnType<typeof vi.fn>>;
  expect(mock["addListener"]).toHaveBeenCalled();
  // The background registers multiple tabs.onUpdated listeners (activity-watcher
  // resync trigger, worker-filter URL cache, and the badge/injection-alarm
  // handler). The browser fires all of them on a navigation, so invoke every
  // captured listener — matching real behavior and staying robust to the order
  // in which the modules happen to register.
  const listeners = mock["addListener"].mock.calls.map((c) => c[0] as Listener);
  return (tabId, changeInfo, tab) => {
    for (const l of listeners) l(tabId, changeInfo, tab);
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("Property 4: Alarm scheduling on navigation", () => {
  test("alarms are created for non-restricted URLs when protection is enabled", async () => {
    const settings = makeSettings({ enabled: true });
    const listener = await captureOnUpdatedListener(settings);

    await fc.assert(
      fc.asyncProperty(tabIdArb, validUrlArb, async (tabId, url) => {
        (browser.alarms.create as ReturnType<typeof vi.fn>).mockClear();
        browser.storage.local.get = vi.fn().mockResolvedValue({ settings });

        listener(tabId, { status: "loading" }, { id: tabId, url } as browser.tabs.Tab);
        await flushMicrotasks();

        const createCalls = (browser.alarms.create as ReturnType<typeof vi.fn>).mock.calls as Array<
          [string, { delayInMinutes: number }]
        >;

        // At least one alarm should be created
        expect(createCalls.length).toBeGreaterThanOrEqual(1);

        // All created alarms should contain the tab ID in their name
        for (const call of createCalls) {
          expect(call[0]).toContain(`injection-check:${tabId}:`);
        }

        // Exactly 3 alarms should be created (one per retry delay)
        expect(createCalls.length).toBe(3);

        // Alarm names should follow the pattern injection-check:{tabId}:{attempt}
        for (let i = 0; i < 3; i++) {
          expect(createCalls[i][0]).toBe(`injection-check:${tabId}:${i}`);
        }
      }),
      { numRuns: 100 }
    );
  });

  test("no alarms created when protection is disabled", async () => {
    const settings = makeSettings({ enabled: false });
    const listener = await captureOnUpdatedListener(settings);

    await fc.assert(
      fc.asyncProperty(tabIdArb, validUrlArb, async (tabId, url) => {
        (browser.alarms.create as ReturnType<typeof vi.fn>).mockClear();
        browser.storage.local.get = vi.fn().mockResolvedValue({ settings });

        listener(tabId, { status: "loading" }, { id: tabId, url } as browser.tabs.Tab);
        await flushMicrotasks();

        const createCalls = (browser.alarms.create as ReturnType<typeof vi.fn>).mock.calls;
        expect(createCalls.length).toBe(0);
      }),
      { numRuns: 100 }
    );
  });

  test("no alarms created for restricted URLs", async () => {
    const settings = makeSettings({ enabled: true });
    const listener = await captureOnUpdatedListener(settings);

    const restrictedUrlArb = fc.oneof(
      fc.constant("about:blank"),
      fc.constant("moz-extension://some-uuid/popup.html"),
      fc.constant("chrome://settings"),
      fc.constant("https://addons.mozilla.org/en-US/firefox/addon/geospoof/")
    );

    await fc.assert(
      fc.asyncProperty(tabIdArb, restrictedUrlArb, async (tabId, url) => {
        (browser.alarms.create as ReturnType<typeof vi.fn>).mockClear();
        browser.storage.local.get = vi.fn().mockResolvedValue({ settings });

        listener(tabId, { status: "loading" }, { id: tabId, url } as browser.tabs.Tab);
        await flushMicrotasks();

        const createCalls = (browser.alarms.create as ReturnType<typeof vi.fn>).mock.calls;
        expect(createCalls.length).toBe(0);
      }),
      { numRuns: 100 }
    );
  });
});
