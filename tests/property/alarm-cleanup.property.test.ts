/**
 * Property-Based Tests for Alarm Cleanup on Re-navigation
 * Feature: mv3-manifest-compat, Property 6: Alarm cleanup on re-navigation
 *
 * Validates: Requirements 7.6
 *
 * For any tab ID that has pending injection-check alarms, when a new navigation
 * event (tabs.onUpdated with status: "loading") fires for that same tab, all
 * previously scheduled alarms for that tab should be cleared before new alarms
 * are created.
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
  fc.constant("http://localhost:3000")
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

describe("Property 6: Alarm cleanup on re-navigation", () => {
  test("re-navigation clears old alarms before creating new ones", async () => {
    const settings = makeSettings({ enabled: true });
    const listener = await captureOnUpdatedListener(settings);

    await fc.assert(
      fc.asyncProperty(tabIdArb, validUrlArb, validUrlArb, async (tabId, url1, url2) => {
        vi.clearAllMocks();
        browser.storage.local.get = vi.fn().mockResolvedValue({ settings });

        // First navigation — schedules alarms
        listener(tabId, { status: "loading" }, { id: tabId, url: url1 } as browser.tabs.Tab);
        await flushMicrotasks();

        const firstCreateCalls = (browser.alarms.create as ReturnType<typeof vi.fn>).mock.calls
          .length;
        expect(firstCreateCalls).toBe(3);

        // Record clear calls before second navigation
        const clearCallsBefore = (browser.alarms.clear as ReturnType<typeof vi.fn>).mock.calls
          .length;

        // Second navigation (re-navigation) — should clear old alarms first
        listener(tabId, { status: "loading" }, { id: tabId, url: url2 } as browser.tabs.Tab);
        await flushMicrotasks();

        const clearCalls = (browser.alarms.clear as ReturnType<typeof vi.fn>).mock.calls as Array<
          [string]
        >;

        // Should have cleared alarms for this tab (3 attempts cleared)
        const newClearCalls = clearCalls.slice(clearCallsBefore);
        const clearedForTab = newClearCalls.filter((c) =>
          c[0].startsWith(`injection-check:${tabId}:`)
        );
        expect(clearedForTab.length).toBe(3);

        // Verify all 3 attempt alarms were cleared
        for (let i = 0; i <= 2; i++) {
          expect(clearedForTab.some((c) => c[0] === `injection-check:${tabId}:${i}`)).toBe(true);
        }

        // New alarms should also be created after clearing
        const totalCreateCalls = (browser.alarms.create as ReturnType<typeof vi.fn>).mock.calls
          .length;
        expect(totalCreateCalls).toBe(6); // 3 from first + 3 from second
      }),
      { numRuns: 100 }
    );
  });

  test("clearing alarms for one tab does not affect other tabs", async () => {
    const settings = makeSettings({ enabled: true });
    const listener = await captureOnUpdatedListener(settings);

    await fc.assert(
      fc.asyncProperty(
        tabIdArb,
        tabIdArb.filter((id) => id > 5000), // ensure different tab IDs
        validUrlArb,
        async (tabId1, tabId2Raw, url) => {
          // Ensure tab IDs are different
          const tabId2 = tabId1 === tabId2Raw ? tabId2Raw + 1 : tabId2Raw;

          vi.clearAllMocks();
          browser.storage.local.get = vi.fn().mockResolvedValue({ settings });

          // Navigate tab 1
          listener(tabId1, { status: "loading" }, { id: tabId1, url } as browser.tabs.Tab);
          await flushMicrotasks();

          // Navigate tab 2
          listener(tabId2, { status: "loading" }, { id: tabId2, url } as browser.tabs.Tab);
          await flushMicrotasks();

          // Re-navigate tab 1 — should only clear tab 1's alarms
          const clearCallsBefore = (browser.alarms.clear as ReturnType<typeof vi.fn>).mock.calls
            .length;

          listener(tabId1, { status: "loading" }, { id: tabId1, url } as browser.tabs.Tab);
          await flushMicrotasks();

          const clearCalls = (browser.alarms.clear as ReturnType<typeof vi.fn>).mock.calls as Array<
            [string]
          >;
          const newClearCalls = clearCalls.slice(clearCallsBefore);

          // Only tab 1's alarms should be cleared
          for (const call of newClearCalls) {
            expect(call[0]).toContain(`injection-check:${tabId1}:`);
            expect(call[0]).not.toContain(`injection-check:${tabId2}:`);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
