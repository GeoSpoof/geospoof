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
import { DELIVERY_WAIT_TIMEOUT_MS } from "@/background/debugger-sessions";

type DebuggerSpoof = typeof import("@/background/debugger-spoof");

interface Call {
  target: ChromeDebugger.DebuggerSession;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * What a tab saw, in order: a zone command landing on one of its sessions,
 * or a page delivery (push or GET_SETTINGS reply) and whether it lets the
 * frames keep native Date/Intl (`native`: the realm's rule in
 * settings-listener.ts, `engineTimezone` and `engineTimezoneSettled` not
 * false).
 */
type TimelineEntry =
  | { kind: "land"; target: ChromeDebugger.DebuggerSession; zone: unknown }
  | { kind: "deliver"; tabId: number; zone: unknown; native: boolean };

/** The timeline entry for a page payload delivered to `tabId`. */
function deliveryEntry(
  tabId: number,
  payload:
    | {
        timezone?: { identifier?: string } | null;
        engineTimezone?: boolean;
        engineTimezoneSettled?: boolean;
      }
    | undefined
): TimelineEntry {
  return {
    kind: "deliver",
    tabId,
    zone: payload?.timezone?.identifier,
    native: payload?.engineTimezone === true && payload.engineTimezoneSettled !== false,
  };
}

/**
 * The zones that landed on the tab's sessions after a delivery that let its
 * frames keep native Date/Intl, and differ from that delivery's zone: frames
 * that trust their engine would then report another zone than their page's.
 */
function landedUnderNativeFrames(timeline: TimelineEntry[], tabId: number): unknown[] {
  let page: Extract<TimelineEntry, { kind: "deliver" }> | undefined;
  const wrong: unknown[] = [];
  for (const e of timeline) {
    if (e.kind === "deliver") {
      if (e.tabId === tabId) page = e;
    } else if (e.target.tabId === tabId && page?.native && e.zone !== page.zone) {
      wrong.push(e.zone);
    }
  }
  return wrong;
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
  /** Zone commands land here when they succeed; tests add page deliveries. */
  const timeline: TimelineEntry[] = [];
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
        const done = gate ? gate.then(() => undefined) : Promise.resolve(undefined);
        if (method === "Emulation.setTimezoneOverride") {
          void done.then(
            () => timeline.push({ kind: "land", target: t, zone: params?.timezoneId }),
            () => undefined
          );
        }
        return done;
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
  return { dbg, calls, timeline, holdNext, holdTargets, state };
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

describe("a newer change delivered to a page while an older sync is in flight", () => {
  const OTHER_TAB = 8;
  const CHILD = { tabId: TAB, sessionId: "S1" };
  const LA_POINT = { latitude: 34.0522, longitude: -118.2437 };
  const NAME = { city: "", country: "", displayName: "test" };
  const LA_ID = "America/Los_Angeles";

  type Sent = { tabId: number; zone: unknown };
  let restoreTabs: () => void = () => {};

  afterEach(() => {
    vi.useRealTimers();
    restoreTabs();
  });

  /** The real `setTimeout`, kept for {@link runUntil} while fake timers stand in for it. */
  const realSetTimeout = globalThis.setTimeout;

  /** Let pending work run, without moving the fake clock, until `done()`. */
  async function runUntil(done: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !done(); i++) {
      await new Promise((resolve) => realSetTimeout(resolve, 0));
    }
    expect(done()).toBe(true);
  }

  /**
   * A held tab whose engine already reports LA, with a cross-site iframe's
   * child session; both zones cached, so no lookup goes to the network. A
   * second tab is open. `hold(n)` makes the second tab's n-th delivery wait
   * until the returned function is called.
   */
  async function heldOnLa() {
    const mod = await load();
    mod.installDebuggerWatchers();
    const onEvent = fake.dbg.onEvent.addListener.mock.calls[0][0] as EventListener;
    const messages = await import("@/background/messages");
    const { getCacheKey } = await import("@/background/geocoding");
    sessionStorageData[`cache:timezone:${getCacheKey(TOKYO.latitude, TOKYO.longitude)}`] = TOKYO_TZ;
    sessionStorageData[`cache:timezone:${getCacheKey(LA_POINT.latitude, LA_POINT.longitude)}`] = LA;

    const la = makeSettings({ timezone: LA, siteLocations: [] });
    storageData.settings = la;
    fake.state.targets = [target(MAIN_URL, false)];
    await mod.syncDebuggerSpoofing(la);
    onEvent(ROOT, "Target.attachedToTarget", {
      sessionId: "S1",
      targetInfo: { type: "iframe" },
      waitingForDebugger: false,
    });
    await vi.waitFor(() => expect(zonesSentTo(fake.calls, CHILD)).toEqual([LA_ID]));
    fake.state.targets = [target(MAIN_URL, true)];

    const sent: Sent[] = [];
    const held = new Map<number, Promise<undefined>>();
    let otherSends = 0;
    const { query, sendMessage } = browser.tabs;
    browser.tabs.query = vi.fn().mockResolvedValue([
      { id: TAB, url: MAIN_URL },
      { id: OTHER_TAB, url: "https://other.example/" },
    ]);
    browser.tabs.sendMessage = vi.fn(
      (tabId: number, message: { payload?: Parameters<typeof deliveryEntry>[1] }) => {
        sent.push({ tabId, zone: message.payload?.timezone?.identifier });
        fake.timeline.push(deliveryEntry(tabId, message.payload));
        if (tabId !== OTHER_TAB) return Promise.resolve(undefined);
        return held.get(++otherSends) ?? Promise.resolve(undefined);
      }
    );
    restoreTabs = () => {
      browser.tabs.query = query;
      browser.tabs.sendMessage = sendMessage;
    };
    const hold = (n: number): (() => void) => {
      const d = deferred<undefined>();
      held.set(n, d.promise);
      return () => d.resolve(undefined);
    };
    const setLocation = (point: { latitude: number; longitude: number }): Promise<boolean> =>
      messages.handleSetLocation(
        { latitude: point.latitude, longitude: point.longitude },
        { fromVpnSync: true, locationName: NAME }
      );
    /** The tab's top frame asks for its settings; the reply goes on the timeline when it arrives. */
    const getSettings = async () => {
      const reply = (await messages.handleMessage(
        { type: "GET_SETTINGS", payload: { topFrame: true } },
        { frameId: 0, url: MAIN_URL, tab: { id: TAB, url: MAIN_URL } as browser.tabs.Tab }
      )) as Parameters<typeof deliveryEntry>[1];
      fake.timeline.push(deliveryEntry(TAB, reply));
      return reply;
    };
    return { sent, hold, setLocation, getSettings };
  }

  const delivered = (sent: Sent[], tabId: number, zone: string): boolean =>
    sent.some((s) => s.tabId === tabId && s.zone === zone);

  test("the older sync read its settings before the newer save: no older root or child command after", async () => {
    const { sent, hold, setLocation } = await heldOnLa();
    const releaseTargets = fake.holdTargets();
    // The older change (Tokyo) is delivered, then its sync reads Tokyo and
    // waits for the tab list.
    const older = setLocation(TOKYO);
    await vi.waitFor(() => expect(fake.dbg.getTargets).toHaveBeenCalledTimes(2));
    const atOlderSync = fake.calls.length;

    // The newer change (LA) reaches the tab, whose engine already reports LA,
    // so its frames keep native Date/Intl. Its handler then waits on the other
    // tab, before its own sync starts.
    const releaseOther = hold(2);
    const newer = setLocation(LA_POINT);
    await vi.waitFor(() => expect(delivered(sent, TAB, LA_ID)).toBe(true));
    await vi.waitFor(() => expect(delivered(sent, OTHER_TAB, LA_ID)).toBe(true));

    releaseTargets([target(MAIN_URL, true)]);
    await older;
    const olderWrites = fake.calls
      .slice(atOlderSync)
      .filter((c) => c.method === "Emulation.setTimezoneOverride" || c.method === "detach");
    expect(olderWrites).toEqual([]);

    releaseOther();
    await newer;
    expect(zonesSentTo(fake.calls, ROOT).at(-1)).toBe(LA_ID);
    expect(zonesSentTo(fake.calls, CHILD).at(-1)).toBe(LA_ID);
    expect(zonesSentTo(fake.calls.slice(atOlderSync), ROOT)).not.toContain("Asia/Tokyo");
    expect(zonesSentTo(fake.calls.slice(atOlderSync), CHILD)).not.toContain("Asia/Tokyo");
  });

  test("the older sync's root command is in flight: the newer delivery waits for it, and its child pass is skipped", async () => {
    const { sent, setLocation } = await heldOnLa();
    const atStart = fake.calls.length;
    const releaseRoot = fake.holdNext("Emulation.setTimezoneOverride");
    const older = setLocation(TOKYO);
    await vi.waitFor(() => expect(zonesSentTo(fake.calls, ROOT).at(-1)).toBe("Asia/Tokyo"));

    const newer = setLocation(LA_POINT);
    // The other tab has the newer payload; this tab's waits on the older command.
    await vi.waitFor(() => expect(delivered(sent, OTHER_TAB, LA_ID)).toBe(true));
    expect(delivered(sent, TAB, LA_ID)).toBe(false);

    releaseRoot();
    await vi.waitFor(() => expect(delivered(sent, TAB, LA_ID)).toBe(true));
    await older;
    await newer;
    expect(zonesSentTo(fake.calls.slice(atStart), CHILD)).not.toContain("Asia/Tokyo");
    expect(zonesSentTo(fake.calls, ROOT).at(-1)).toBe(LA_ID);
    expect(zonesSentTo(fake.calls, CHILD).at(-1)).toBe(LA_ID);
  });

  test("the older sync's root command lands after the newer push stopped waiting for it: that push lets no frame keep native Date/Intl", async () => {
    const { sent, hold, setLocation, getSettings } = await heldOnLa();
    const releaseRoot = fake.holdNext("Emulation.setTimezoneOverride");
    const older = setLocation(TOKYO);
    await vi.waitFor(() => expect(zonesSentTo(fake.calls, ROOT).at(-1)).toBe("Asia/Tokyo"));

    // The newer change (LA) waits on the other tab before its own sync, and
    // its push to this tab waits on the older root command, past the bound.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const releaseOther = hold(2);
    const newer = setLocation(LA_POINT);
    await runUntil(() => delivered(sent, OTHER_TAB, LA_ID));
    await vi.advanceTimersByTimeAsync(DELIVERY_WAIT_TIMEOUT_MS - 1);
    expect(delivered(sent, TAB, LA_ID)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await runUntil(() => delivered(sent, TAB, LA_ID));
    vi.useRealTimers();
    expect(fake.timeline.filter((e) => e.kind === "deliver" && e.tabId === TAB).at(-1)).toEqual({
      kind: "deliver",
      tabId: TAB,
      zone: LA_ID,
      native: false,
    });

    // The older root command lands only now, then the newer sync runs.
    releaseRoot();
    await older;
    releaseOther();
    await newer;
    expect(landedUnderNativeFrames(fake.timeline, TAB)).toEqual([]);
    expect(zonesSentTo(fake.calls, ROOT).at(-1)).toBe(LA_ID);
    expect(zonesSentTo(fake.calls, CHILD).at(-1)).toBe(LA_ID);
    // With nothing older in flight, a delivery lets frames check their engine again.
    expect((await getSettings())?.engineTimezoneSettled).toBe(true);
  });

  test("the older sync's root command lands after a GET_SETTINGS reply stopped waiting for it: that reply lets no frame keep native Date/Intl", async () => {
    const { sent, hold, setLocation, getSettings } = await heldOnLa();
    const releaseRoot = fake.holdNext("Emulation.setTimezoneOverride");
    const older = setLocation(TOKYO);
    await vi.waitFor(() => expect(zonesSentTo(fake.calls, ROOT).at(-1)).toBe("Asia/Tokyo"));

    // The newer change (LA) is stored; its broadcast reaches only the other
    // tab and waits there, before its own sync.
    vi.mocked(browser.tabs.query).mockResolvedValueOnce([
      { id: OTHER_TAB, url: "https://other.example/" },
    ] as browser.tabs.Tab[]);
    const releaseOther = hold(2);
    const newer = setLocation(LA_POINT);
    await vi.waitFor(() => expect(delivered(sent, OTHER_TAB, LA_ID)).toBe(true));

    // The tab's top frame asks for its settings meanwhile. The reply waits on
    // the older root command, past the bound.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let replied = false;
    const reply = getSettings().finally(() => {
      replied = true;
    });
    await vi.advanceTimersByTimeAsync(DELIVERY_WAIT_TIMEOUT_MS - 1);
    expect(replied).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await runUntil(() => replied);
    vi.useRealTimers();
    expect(await reply).toMatchObject({
      timezone: { identifier: LA_ID },
      engineTimezone: true,
      engineTimezoneSettled: false,
    });

    // The older root command lands only now, then the newer sync runs.
    releaseRoot();
    await older;
    releaseOther();
    await newer;
    expect(landedUnderNativeFrames(fake.timeline, TAB)).toEqual([]);
    expect(zonesSentTo(fake.calls, ROOT).at(-1)).toBe(LA_ID);
    expect(zonesSentTo(fake.calls, CHILD).at(-1)).toBe(LA_ID);
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
