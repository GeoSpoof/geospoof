/**
 * Engine-level Spoofing's listeners and settings sync, driven through
 * `debugger-spoof.ts` with the Chromium build flags stubbed and a fake
 * `chrome.debugger`: the newest event for a tab must be the last to write,
 * whichever lookup finishes first. (The session logic itself is tested in
 * `debugger-sessions.test.ts`.)
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { Settings } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import { storageData, sessionStorageData } from "../../setup";
import { ENTRY_DUBLIN, TOKYO, TOKYO_TZ } from "../../helpers/site-locations";

type DebuggerSpoof = typeof import("@/background/debugger-spoof");

interface Call {
  target: ChromeDebugger.DebuggerSession;
  method: string;
  params?: Record<string, unknown>;
}

/** A promise and the function that resolves it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const TAB = 7;
const ROOT = { tabId: TAB };
const MAIN_URL = "https://example.com/";
const DUBLIN_URL = "https://chatgpt.com/c/1";
const LA = { identifier: "America/Los_Angeles", offset: -480, dstOffset: 60 };

function target(url: string, attached: boolean): ChromeDebugger.TargetInfo {
  return { type: "page", id: "T7", tabId: TAB, url, attached, title: "" };
}

function fakeChromeDebugger() {
  const calls: Call[] = [];
  const gates: { method: string; settle: Promise<void> }[] = [];
  /** The next `method` command settles when the returned function is called: with an error, it rejects. */
  const holdNext = (method: string): ((error?: Error) => void) => {
    let settle!: (error?: Error) => void;
    const p = new Promise<void>((resolve, reject) => {
      settle = (error) => (error ? reject(error) : resolve());
    });
    gates.push({ method, settle: p });
    return settle;
  };
  const gateFor = (method: string): Promise<void> | null => {
    const i = gates.findIndex((g) => g.method === method);
    return i < 0 ? null : gates.splice(i, 1)[0].settle;
  };
  /** Lists queued for the next getTargets() calls; after them, `targets`. */
  const lists: Promise<ChromeDebugger.TargetInfo[]>[] = [];
  const state = { targets: [] as ChromeDebugger.TargetInfo[] };
  const dbg = {
    attach: vi.fn((t: ChromeDebugger.Debuggee) => {
      calls.push({ target: t, method: "attach" });
      return Promise.resolve();
    }),
    detach: vi.fn((t: ChromeDebugger.Debuggee) => {
      calls.push({ target: t, method: "detach" });
      return Promise.resolve();
    }),
    sendCommand: vi.fn(
      (t: ChromeDebugger.DebuggerSession, method: string, params?: Record<string, unknown>) => {
        calls.push({ target: t, method, params });
        const gate = gateFor(method);
        return gate ? gate.then(() => undefined) : Promise.resolve(undefined);
      }
    ),
    getTargets: vi.fn(() => lists.shift() ?? Promise.resolve(state.targets)),
    onDetach: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() },
    onEvent: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() },
  };
  /** Hold the next getTargets() call until the returned resolver gets its list. */
  const holdTargets = (): ((list: ChromeDebugger.TargetInfo[]) => void) => {
    const d = deferred<ChromeDebugger.TargetInfo[]>();
    lists.push(d.promise);
    return d.resolve;
  };
  return { dbg, calls, holdNext, holdTargets, state };
}

/** The zones sent to one session, in order ("" is a revert). */
function zonesSentTo(calls: Call[], to: ChromeDebugger.DebuggerSession): unknown[] {
  return calls
    .filter(
      (c) =>
        c.method === "Emulation.setTimezoneOverride" &&
        c.target.tabId === to.tabId &&
        c.target.sessionId === to.sessionId
    )
    .map((c) => c.params?.timezoneId);
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    debuggerModeEnabled: true,
    location: TOKYO,
    timezone: TOKYO_TZ,
    siteLocations: [ENTRY_DUBLIN],
    ...overrides,
  };
}

let fake: ReturnType<typeof fakeChromeDebugger>;

/** Fresh modules (so a fresh session tracker) with Chromium's globals. */
async function load(): Promise<DebuggerSpoof> {
  vi.resetModules();
  vi.stubGlobal("__CHROMIUM__", true);
  vi.stubGlobal("__FIREFOX__", false);
  fake = fakeChromeDebugger();
  vi.stubGlobal("chrome", {
    ...(globalThis as unknown as { chrome: object }).chrome,
    debugger: fake.dbg,
  });
  return import("@/background/debugger-spoof");
}

type UpdatedListener = (
  tabId: number,
  changeInfo: { url?: string },
  tab: { id: number; url: string }
) => void;
type EventListener = (
  source: ChromeDebugger.DebuggerSession,
  method: string,
  params?: object
) => void;

/**
 * {@link load}, through the background entry, so its listeners are bound:
 * `onUpdated` fires every `tabs.onUpdated` listener, `onEvent` is the
 * debugger's event listener.
 */
async function loadBackground(): Promise<{
  mod: DebuggerSpoof;
  onUpdated: UpdatedListener;
  onEvent: EventListener;
}> {
  await load();
  await import("@/background");
  const mod = await import("@/background/debugger-spoof");
  const onUpdatedMock = browser.tabs.onUpdated as unknown as Record<
    string,
    ReturnType<typeof vi.fn>
  >;
  const updated = onUpdatedMock["addListener"].mock.calls.map((c) => c[0] as UpdatedListener);
  const onEvent = fake.dbg.onEvent.addListener.mock.calls[0][0] as EventListener;
  return {
    mod,
    onUpdated: (tabId, changeInfo, tab) => {
      for (const l of updated) l(tabId, changeInfo, tab);
    },
    onEvent,
  };
}

beforeEach(() => {
  storageData.settings = makeSettings();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a settings sync is ordered by when it starts", () => {
  test("a navigation while the sync lists the tabs keeps its zone", async () => {
    const mod = await load();
    const releaseTargets = fake.holdTargets();
    const sync = mod.syncDebuggerSpoofing(makeSettings());
    // The tab moves to a Dublin page while getTargets() is pending.
    await mod.claimTab(TAB)(DUBLIN_URL);
    expect(zonesSentTo(fake.calls, ROOT)).toEqual(["Europe/Dublin"]);
    // The sync's list still shows the page the tab was on.
    releaseTargets([target(MAIN_URL, true)]);
    await sync;
    expect(zonesSentTo(fake.calls, ROOT)).toEqual(["Europe/Dublin"]);
  });

  test("an older sync whose list arrives last sends nothing", async () => {
    const mod = await load();
    const releaseOlder = fake.holdTargets();
    const older = mod.syncDebuggerSpoofing(makeSettings());
    fake.state.targets = [target(MAIN_URL, false)];
    const la = makeSettings({ timezone: LA });
    storageData.settings = la;
    await mod.syncDebuggerSpoofing(la);
    expect(zonesSentTo(fake.calls, ROOT)).toEqual(["America/Los_Angeles"]);
    releaseOlder([target(MAIN_URL, true)]);
    await older;
    expect(zonesSentTo(fake.calls, ROOT)).toEqual(["America/Los_Angeles"]);
  });

  test("an older mode-off sync whose list arrives last can't detach the newer session", async () => {
    const mod = await load();
    const releaseOff = fake.holdTargets();
    const off = makeSettings({ debuggerModeEnabled: false });
    storageData.settings = off;
    const offSync = mod.syncDebuggerSpoofing(off);
    // The mode-off sync's settings read lands before the mode is turned on.
    await vi.waitFor(() => expect(fake.dbg.getTargets).toHaveBeenCalledTimes(1));
    fake.state.targets = [target(MAIN_URL, false)];
    storageData.settings = makeSettings();
    await mod.syncDebuggerSpoofing(makeSettings());
    releaseOff([target(MAIN_URL, true)]);
    await offSync;
    expect(zonesSentTo(fake.calls, ROOT)).toEqual(["Asia/Tokyo"]);
    expect(fake.calls.map((c) => c.method)).not.toContain("detach");
  });

  test("it applies the settings stored when it starts, not the snapshot it was given", async () => {
    const mod = await load();
    fake.state.targets = [target(MAIN_URL, false)];
    storageData.settings = makeSettings({ timezone: LA });
    await mod.syncDebuggerSpoofing(makeSettings());
    expect(zonesSentTo(fake.calls, ROOT)).toEqual(["America/Los_Angeles"]);
  });

  test("a sync still supersedes a navigation that started before it", async () => {
    const mod = await load();
    fake.state.targets = [target(MAIN_URL, false)];
    // The navigation's settings read is still pending when the sync starts.
    const nav = mod.claimTab(TAB)(DUBLIN_URL);
    await mod.syncDebuggerSpoofing(makeSettings());
    await nav;
    expect(zonesSentTo(fake.calls, ROOT).at(-1)).toBe("Asia/Tokyo");
  });
});

describe("a settings read that fails leaves the sessions as they are", () => {
  const CHILD = { tabId: TAB, sessionId: "S1" };

  /** A held tab on Tokyo with a cross-site iframe's child session; returns the call count then. */
  async function heldTab(mod: DebuggerSpoof): Promise<number> {
    mod.installDebuggerWatchers();
    const onEvent = fake.dbg.onEvent.addListener.mock.calls[0][0] as EventListener;
    fake.state.targets = [target(MAIN_URL, false)];
    await mod.syncDebuggerSpoofing(makeSettings());
    onEvent(ROOT, "Target.attachedToTarget", {
      sessionId: "S1",
      targetInfo: { type: "iframe" },
      waitingForDebugger: false,
    });
    await vi.waitFor(() => expect(zonesSentTo(fake.calls, CHILD)).toEqual(["Asia/Tokyo"]));
    // The child's own auto-attach is the last step of its setup.
    await vi.waitFor(() =>
      expect(fake.calls.at(-1)).toMatchObject({ target: CHILD, method: "Target.setAutoAttach" })
    );
    fake.state.targets = [target(MAIN_URL, true)];
    return fake.calls.length;
  }

  /** The next storage.local.get rejects (via the index signature, as session-cache.test.ts does). */
  function failNextSettingsRead(): void {
    const local = browser.storage.local as unknown as Record<string, unknown>;
    (local["get"] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("read failed"));
  }

  test("a settings sync sends no revert and no detach", async () => {
    const mod = await load();
    const before = await heldTab(mod);
    failNextSettingsRead();
    // The caller's snapshot is valid; only the sync's own read fails.
    await mod.syncDebuggerSpoofing(makeSettings());
    expect(fake.calls.slice(before)).toEqual([]);
  });

  test("a navigation's reconcile sends no revert and no detach", async () => {
    const mod = await load();
    const before = await heldTab(mod);
    failNextSettingsRead();
    await mod.claimTab(TAB)(MAIN_URL);
    expect(fake.calls.slice(before)).toEqual([]);
  });
});

describe("settings changes whose handlers reach the sync out of order", () => {
  const SLOW_TAB = 8;
  const CHILD = { tabId: TAB, sessionId: "S1" };
  const LA_POINT = { latitude: 34.0522, longitude: -118.2437 };
  const PARIS_TZ = { identifier: "Europe/Paris", offset: 60, dstOffset: 60 };
  const NAME = { city: "", country: "", displayName: "test" };

  test("an older location change held in its broadcast sends no old zone after a newer one", async () => {
    const mod = await load();
    mod.installDebuggerWatchers();
    const onEvent = fake.dbg.onEvent.addListener.mock.calls[0][0] as EventListener;
    const messages = await import("@/background/messages");
    const { getCacheKey } = await import("@/background/geocoding");
    // Both zones are cached, so no lookup goes to the network.
    sessionStorageData[`cache:timezone:${getCacheKey(TOKYO.latitude, TOKYO.longitude)}`] = TOKYO_TZ;
    sessionStorageData[`cache:timezone:${getCacheKey(LA_POINT.latitude, LA_POINT.longitude)}`] = LA;

    // A held tab on Paris with a cross-site iframe's child session.
    const paris = makeSettings({ timezone: PARIS_TZ, siteLocations: [] });
    storageData.settings = paris;
    fake.state.targets = [target(MAIN_URL, false)];
    await mod.syncDebuggerSpoofing(paris);
    onEvent(ROOT, "Target.attachedToTarget", {
      sessionId: "S1",
      targetInfo: { type: "iframe" },
      waitingForDebugger: false,
    });
    await vi.waitFor(() => expect(zonesSentTo(fake.calls, CHILD)).toEqual(["Europe/Paris"]));

    // Another tab answers the first broadcast late.
    const { query, sendMessage } = browser.tabs;
    const slow = deferred<undefined>();
    let slowSends = 0;
    browser.tabs.query = vi.fn().mockResolvedValue([
      { id: TAB, url: MAIN_URL },
      { id: SLOW_TAB, url: "https://slow.example/" },
    ]);
    browser.tabs.sendMessage = vi.fn((tabId: number) =>
      tabId === SLOW_TAB && slowSends++ === 0 ? slow.promise : Promise.resolve(undefined)
    );
    try {
      // The older change (Tokyo) waits on that tab; the newer one (LA) finishes.
      const older = messages.handleSetLocation(
        { latitude: TOKYO.latitude, longitude: TOKYO.longitude },
        { fromVpnSync: true, locationName: NAME }
      );
      await vi.waitFor(() => expect(slowSends).toBe(1));
      await messages.handleSetLocation(LA_POINT, { fromVpnSync: true, locationName: NAME });
      expect(zonesSentTo(fake.calls, ROOT).at(-1)).toBe("America/Los_Angeles");
      expect(zonesSentTo(fake.calls, CHILD).at(-1)).toBe("America/Los_Angeles");
      const atNewer = fake.calls.length;

      slow.resolve(undefined);
      await older;
      const later = fake.calls
        .slice(atNewer)
        .filter((c) => c.method === "Emulation.setTimezoneOverride")
        .map((c) => c.params?.timezoneId);
      expect(later).not.toContain("Asia/Tokyo");
      expect(zonesSentTo(fake.calls, ROOT).at(-1)).toBe("America/Los_Angeles");
      expect(zonesSentTo(fake.calls, CHILD).at(-1)).toBe("America/Los_Angeles");
    } finally {
      browser.tabs.query = query;
      browser.tabs.sendMessage = sendMessage;
    }
  });
});

describe("a same-document navigation finishes the reconcile it claims", () => {
  const CHILD = { tabId: TAB, sessionId: "S1" };

  test("with the mode off, it finishes the teardown it interrupted", async () => {
    const { mod, onUpdated, onEvent } = await loadBackground();
    // A held tab with a cross-site iframe's child session.
    fake.state.targets = [target(MAIN_URL, false)];
    await mod.syncDebuggerSpoofing(makeSettings());
    onEvent(ROOT, "Target.attachedToTarget", {
      sessionId: "S1",
      targetInfo: { type: "iframe" },
      waitingForDebugger: false,
    });
    await vi.waitFor(() => expect(zonesSentTo(fake.calls, CHILD)).toEqual(["Asia/Tokyo"]));

    // The mode is turned off; the teardown waits on the child's revert.
    const off = makeSettings({ debuggerModeEnabled: false });
    storageData.settings = off;
    fake.state.targets = [target(MAIN_URL, true)];
    const releaseChild = fake.holdNext("Emulation.setTimezoneOverride");
    const teardown = mod.syncDebuggerSpoofing(off);
    await vi.waitFor(() => expect(zonesSentTo(fake.calls, CHILD)).toEqual(["Asia/Tokyo", ""]));

    // An in-page route change lands meanwhile.
    const next = "https://example.com/next";
    onUpdated(TAB, { url: next }, { id: TAB, url: next });
    await vi.waitFor(() => expect(fake.calls.map((c) => c.method)).toContain("detach"));
    releaseChild();
    await teardown;

    expect(zonesSentTo(fake.calls, ROOT)).toEqual(["Asia/Tokyo", ""]);
    expect(fake.calls.filter((c) => c.method === "detach")).toEqual([
      { target: ROOT, method: "detach" },
    ]);
  });
});

describe("a session Chrome ends", () => {
  type DetachListener = (
    source: ChromeDebugger.Debuggee,
    reason: ChromeDebugger.DetachReason
  ) => void;

  /**
   * A held tab whose navigation to the Dublin page is waiting on its root
   * command; `end(reason)` ends the session, then fails that command.
   */
  async function heldTabMidNavigation() {
    const mod = await load();
    mod.installDebuggerWatchers();
    const onDetach = fake.dbg.onDetach.addListener.mock.calls[0][0] as DetachListener;
    fake.state.targets = [target(MAIN_URL, false)];
    await mod.syncDebuggerSpoofing(makeSettings());
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    browser.tabs.sendMessage = sendMessage;
    browser.tabs.get = vi.fn().mockResolvedValue({ id: TAB, url: DUBLIN_URL });
    const fail = fake.holdNext("Emulation.setTimezoneOverride");
    const nav = mod.claimTab(TAB)(DUBLIN_URL);
    await vi.waitFor(() =>
      expect(zonesSentTo(fake.calls, ROOT)).toEqual(["Asia/Tokyo", "Europe/Dublin"])
    );
    const atEnd = fake.calls.length;
    const end = async (reason: ChromeDebugger.DetachReason): Promise<void> => {
      onDetach(ROOT, reason);
      fail(new Error("Debugger is not attached to the tab with id: 7."));
      await nav;
    };
    return { mod, sendMessage, atEnd, end };
  }

  test("cancelled by the user: the reconcile in flight stops (no attach, no zone, not held)", async () => {
    const { mod, sendMessage, atEnd, end } = await heldTabMidNavigation();
    await end("canceled_by_user");

    expect(fake.calls.slice(atEnd)).toEqual([]);
    // The tab is still sent its settings again.
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        TAB,
        expect.objectContaining({ type: "UPDATE_SETTINGS" })
      )
    );
    // Not left marked held: the next navigation attaches first.
    await mod.claimTab(TAB)(MAIN_URL);
    expect(fake.calls[atEnd]?.method).toBe("attach");
  });

  test("target_closed: the navigation in flight attaches again and sets its zone", async () => {
    // On a page with another extension's frame, Chrome ends the session while
    // the tab navigates; this attach, on the new document, is what sets it.
    const { sendMessage, atEnd, end } = await heldTabMidNavigation();
    await end("target_closed");

    expect(fake.calls.slice(atEnd).map((c) => [c.method, c.params?.timezoneId])).toEqual([
      ["attach", undefined],
      ["Emulation.setTimezoneOverride", "Europe/Dublin"],
    ]);
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        TAB,
        expect.objectContaining({ type: "UPDATE_SETTINGS" })
      )
    );
  });
});
