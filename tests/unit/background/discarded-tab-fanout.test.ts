/**
 * Regression tests for the tab fan-out message storm (issue #75).
 *
 * A user with ~100 discarded tabs across Firefox tab groups saw 13,000+
 * "Could not establish connection. Receiving end does not exist." errors and a
 * multi-second browser stall on startup and on "Sync Now". Two defects combined:
 *
 *  1. Every settings broadcast messaged EVERY tab returned by `tabs.query({})`,
 *     including discarded (unloaded) ones that by definition have no content
 *     script and can never receive it.
 *  2. Each of those guaranteed failures logged via `logger.warn`, which is
 *     un-gated for the `BG` component, and a since-removed background→page log
 *     relay re-broadcast every emitted log line to every tab. That turned N
 *     failures into N x tabs messages — quadratic in tab count.
 *
 * These tests pin the invariants that keep both from returning:
 *  - discarded tabs are never messaged;
 *  - total message count stays linear in the number of loaded tabs;
 *  - an unreachable tab produces no console output at default settings, and
 *    never a warn/error (those bypass the debug toggle for BG).
 */

import type { Settings } from "@/shared/types/settings";
import { broadcastSettingsToTabs, injectContentScriptIntoExistingTabs } from "@/background/tabs";
import { setDebugEnabled, setVerbosityLevel } from "@/shared/utils/debug-logger";

function makeSettings(partial: Partial<Settings> = {}): Settings {
  return {
    enabled: true,
    location: { latitude: 40.7, longitude: -74, accuracy: 50 },
    timezone: { identifier: "America/New_York", offset: -300, dstOffset: 60 },
    locationName: null,
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
    theme: "system" as const,
    uiLanguage: "",
    favorites: [],
    scopeMode: "all" as const,
    allowlist: [],
    denylist: [],
    accuracySetting: { mode: "auto" },
    accuracySeed: 0,
    locationPrecision: { mode: "exact" },
    precisionSeed: 0,
    precisionCadence: "never" as const,
    localeSpoofing: { mode: "off" as const },
    ...partial,
  };
}

/** A loaded tab: has a document, so it can host a content script. */
function loadedTab(id: number) {
  return { id, url: `https://example${id}.com/`, discarded: false };
}

/** A discarded tab: restored lazily, no document, no content script. */
function discardedTab(id: number) {
  return { id, url: `https://example${id}.com/`, discarded: true };
}

describe("Tab fan-out is bounded and skips discarded tabs (issue #75)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browser.tabs.sendMessage.mockResolvedValue(undefined);
    browser.scripting.executeScript.mockResolvedValue([]);
    // Default user state: debug logging off.
    setDebugEnabled(false);
    setVerbosityLevel("INFO");
  });

  afterEach(() => {
    setDebugEnabled(false);
    setVerbosityLevel("INFO");
  });

  describe("broadcastSettingsToTabs", () => {
    it("does not message discarded tabs", async () => {
      browser.tabs.query.mockResolvedValue([discardedTab(1), discardedTab(2), discardedTab(3)]);

      await broadcastSettingsToTabs(makeSettings());

      expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
    });

    it("messages loaded tabs and skips discarded ones in a mixed set", async () => {
      browser.tabs.query.mockResolvedValue([
        loadedTab(1),
        discardedTab(2),
        loadedTab(3),
        discardedTab(4),
      ]);

      await broadcastSettingsToTabs(makeSettings());

      const messagedIds = browser.tabs.sendMessage.mock.calls.map(
        (call: unknown[]) => call[0] as number
      );
      expect(messagedIds.sort()).toEqual([1, 3]);
    });

    it("still messages a loaded tab whose `discarded` flag is absent (fails open)", async () => {
      // Engines that don't report `discarded` leave it undefined. The filter must
      // treat that as "not discarded" and preserve the previous behaviour rather
      // than silently dropping every tab.
      browser.tabs.query.mockResolvedValue([
        { id: 1, url: "https://example.com/" },
        { id: 2, url: "https://other.com/" },
      ]);

      await broadcastSettingsToTabs(makeSettings());

      expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("still messages loaded tabs with restricted or undeterminable URLs", async () => {
      // These must NOT be filtered out. `enabled` resolves to false for them and
      // that message is what turns spoofing OFF in a tab that just left scope,
      // so dropping it would trade this noise bug for a silent leak (Req 8.1).
      browser.tabs.query.mockResolvedValue([
        { id: 1, url: "about:blank", discarded: false },
        { id: 2, url: undefined, discarded: false },
        { id: 3, url: "moz-extension://abcd/options.html", discarded: false },
      ]);

      await broadcastSettingsToTabs(makeSettings());

      expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(3);
      for (const call of browser.tabs.sendMessage.mock.calls) {
        const payload = (call[1] as { payload: { enabled: boolean } }).payload;
        expect(payload.enabled).toBe(false);
      }
    });

    it("sends exactly one message per loaded tab — no fan-out amplification", async () => {
      // The quadratic guard. If a per-log-line broadcast relay is ever
      // reintroduced, or any per-tab failure triggers another broadcast, the
      // total send count stops matching the loaded-tab count and this fails.
      const tabCount = 60;
      const tabs = Array.from({ length: tabCount }, (_, i) => loadedTab(i + 1));
      browser.tabs.query.mockResolvedValue(tabs);
      // Every send fails, exactly as it does for a tab with no content script.
      browser.tabs.sendMessage.mockRejectedValue(
        new Error("Could not establish connection. Receiving end does not exist.")
      );

      await broadcastSettingsToTabs(makeSettings());

      expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(tabCount);
      // A single query for the broadcast — not one per emitted log line.
      expect(browser.tabs.query).toHaveBeenCalledTimes(1);
    });

    it("emits no console output for unreachable tabs at default settings", async () => {
      // What the reporter actually saw: per-tab failure lines printed with debug
      // logging OFF. `logger.warn`/`logger.error` are un-gated for BG and bare
      // `console.*` calls bypass the toggle entirely, so an unreachable tab must
      // use neither.
      const spies = {
        log: vi.spyOn(console, "log").mockImplementation(() => {}),
        info: vi.spyOn(console, "info").mockImplementation(() => {}),
        debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
        warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
        error: vi.spyOn(console, "error").mockImplementation(() => {}),
      };

      try {
        browser.tabs.query.mockResolvedValue(
          Array.from({ length: 25 }, (_, i) => loadedTab(i + 1))
        );
        browser.tabs.sendMessage.mockRejectedValue(
          new Error("Could not establish connection. Receiving end does not exist.")
        );

        await broadcastSettingsToTabs(makeSettings());

        expect(spies.warn).not.toHaveBeenCalled();
        expect(spies.error).not.toHaveBeenCalled();
        expect(spies.log).not.toHaveBeenCalled();
        expect(spies.info).not.toHaveBeenCalled();
        expect(spies.debug).not.toHaveBeenCalled();
      } finally {
        for (const spy of Object.values(spies)) spy.mockRestore();
      }
    });

    it("summarises failures in one bounded line rather than one per tab", async () => {
      // With debug logging on, the default-verbosity output must stay O(1) in
      // tab count: a single summary, not a line per unreachable tab.
      setDebugEnabled(true);
      setVerbosityLevel("DEBUG");

      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        browser.tabs.query.mockResolvedValue(
          Array.from({ length: 40 }, (_, i) => loadedTab(i + 1))
        );
        browser.tabs.sendMessage.mockRejectedValue(
          new Error("Could not establish connection. Receiving end does not exist.")
        );

        await broadcastSettingsToTabs(makeSettings());

        // One summary line, regardless of the 40 failures.
        expect(debugSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).not.toHaveBeenCalled();
        // The summary carries the counts needed to diagnose without per-tab spam.
        const summary = debugSpy.mock.calls[0];
        expect(JSON.stringify(summary)).toContain("failed");
        // The pre-broadcast info line is also a single line.
        expect(infoSpy).toHaveBeenCalledTimes(1);
      } finally {
        debugSpy.mockRestore();
        infoSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });

  describe("injectContentScriptIntoExistingTabs", () => {
    it("never pings or injects into a discarded tab", async () => {
      // Injecting into a discarded tab is useless, and on an engine that resolves
      // the target by waking the tab it could force-load a whole restored
      // session at once.
      browser.tabs.query.mockResolvedValue([discardedTab(1), discardedTab(2), discardedTab(3)]);

      await injectContentScriptIntoExistingTabs();

      expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
      expect(browser.scripting.executeScript).not.toHaveBeenCalled();
    });

    it("injects into a loaded tab that has no content script yet", async () => {
      browser.tabs.query.mockResolvedValue([loadedTab(1), discardedTab(2)]);
      browser.tabs.sendMessage.mockRejectedValue(new Error("no receiver"));

      await injectContentScriptIntoExistingTabs();

      expect(browser.scripting.executeScript).toHaveBeenCalledTimes(1);
      expect(browser.scripting.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({ target: { tabId: 1 } })
      );
    });

    it("does not re-inject a loaded tab that already responds to PING", async () => {
      browser.tabs.query.mockResolvedValue([loadedTab(1)]);
      browser.tabs.sendMessage.mockResolvedValue({ pong: true });

      await injectContentScriptIntoExistingTabs();

      expect(browser.scripting.executeScript).not.toHaveBeenCalled();
    });

    it("skips non-http(s) tabs, which cannot host the content script", async () => {
      browser.tabs.query.mockResolvedValue([
        { id: 1, url: "about:blank", discarded: false },
        { id: 2, url: "moz-extension://abcd/options.html", discarded: false },
      ]);

      await injectContentScriptIntoExistingTabs();

      expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
      expect(browser.scripting.executeScript).not.toHaveBeenCalled();
    });
  });
});
