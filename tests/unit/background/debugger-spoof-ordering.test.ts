/**
 * Engine-level Spoofing's listeners and settings sync, driven through
 * `debugger-spoof.ts` with `__CHROMIUM__` stubbed on and a fake
 * `chrome.debugger`: the newest event for a tab must be the last to write,
 * whichever lookup finishes first. (The session logic itself is tested in
 * `debugger-sessions.test.ts`.)
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { Settings } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import { storageData } from "../../setup";
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
  fake = fakeChromeDebugger();
  vi.stubGlobal("chrome", {
    ...(globalThis as unknown as { chrome: object }).chrome,
    debugger: fake.dbg,
  });
  return import("@/background/debugger-spoof");
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
    const LA = { identifier: "America/Los_Angeles", offset: -480, dstOffset: 60 };
    await mod.syncDebuggerSpoofing(makeSettings({ timezone: LA }));
    expect(zonesSentTo(fake.calls, ROOT)).toEqual(["America/Los_Angeles"]);
    releaseOlder([target(MAIN_URL, true)]);
    await older;
    expect(zonesSentTo(fake.calls, ROOT)).toEqual(["America/Los_Angeles"]);
  });

  test("an older mode-off sync whose list arrives last can't detach the newer session", async () => {
    const mod = await load();
    const releaseOff = fake.holdTargets();
    const off = mod.syncDebuggerSpoofing(makeSettings({ debuggerModeEnabled: false }));
    fake.state.targets = [target(MAIN_URL, false)];
    await mod.syncDebuggerSpoofing(makeSettings());
    releaseOff([target(MAIN_URL, true)]);
    await off;
    expect(zonesSentTo(fake.calls, ROOT)).toEqual(["Asia/Tokyo"]);
    expect(fake.calls.map((c) => c.method)).not.toContain("detach");
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
