/**
 * Engine-level Spoofing's CDP session logic, against a fake `chrome.debugger`
 * that records every command in order and can reject or hang chosen methods.
 * (`__CHROMIUM__` is false under Vitest, so `debugger-spoof.ts`'s wiring is
 * compiled out; this module takes the debugger as a parameter.)
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import {
  CHILD_AUTO_ATTACH,
  TabSessionTracker,
  createDebuggerEventHandler,
  ensureChildAutoAttach,
  handleChildAttached,
  handleChildDetached,
  holdTab,
  onTopFrame,
  revertAndDetachTab,
  setTabZone,
  type AttachedToTargetParams,
  type DebuggerLike,
} from "@/background/debugger-sessions";

interface Call {
  target: ChromeDebugger.DebuggerSession;
  method: string;
  params?: Record<string, unknown>;
}

function fakeDebugger(
  behavior: Record<string, "reject" | "hang"> = {},
  rejectOnce = new Set<string>()
) {
  const calls: Call[] = [];
  const dbg: DebuggerLike = {
    attach: vi.fn((target: ChromeDebugger.Debuggee) => {
      calls.push({ target, method: "attach" });
      return Promise.resolve();
    }),
    detach: vi.fn((target: ChromeDebugger.Debuggee) => {
      calls.push({ target, method: "detach" });
      return Promise.resolve();
    }),
    sendCommand: vi.fn(
      (
        target: ChromeDebugger.DebuggerSession,
        method: string,
        params?: Record<string, unknown>
      ) => {
        calls.push({ target, method, params });
        if (rejectOnce.delete(method)) return Promise.reject(new Error(`${method} failed once`));
        const b = behavior[method];
        if (b === "reject") return Promise.reject(new Error(`${method} refused`));
        if (b === "hang") return new Promise<undefined>(() => {});
        return Promise.resolve(undefined);
      }
    ),
  };
  return { dbg, calls };
}

const TAB = 7;
const ROOT = { tabId: TAB };

function iframeAttached(sessionId = "S1", waitingForDebugger = true): AttachedToTargetParams {
  return {
    sessionId,
    targetInfo: { type: "iframe" },
    waitingForDebugger,
  };
}

const tokyo = () => Promise.resolve("Asia/Tokyo");

afterEach(() => {
  vi.useRealTimers();
});

describe("handleChildAttached", () => {
  test("an iframe on a Tokyo tab: zone, then nested auto-attach, then resume, on the child", async () => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    await handleChildAttached(dbg, tokyo, tracker, ROOT, iframeAttached());
    const child = { tabId: TAB, sessionId: "S1" };
    expect(calls).toEqual([
      {
        target: child,
        method: "Emulation.setTimezoneOverride",
        params: { timezoneId: "Asia/Tokyo" },
      },
      { target: child, method: "Target.setAutoAttach", params: { ...CHILD_AUTO_ATTACH } },
      { target: child, method: "Runtime.runIfWaitingForDebugger", params: undefined },
    ]);
    expect(tracker.children(TAB)).toEqual(["S1"]);
  });

  test("out of scope (no zone): no override, still nested auto-attach and resume", async () => {
    const { dbg, calls } = fakeDebugger();
    await handleChildAttached(
      dbg,
      () => Promise.resolve(null),
      new TabSessionTracker(),
      ROOT,
      iframeAttached()
    );
    expect(calls.map((c) => c.method)).toEqual([
      "Target.setAutoAttach",
      "Runtime.runIfWaitingForDebugger",
    ]);
  });

  test("the override is refused: nested auto-attach and resume are still sent", async () => {
    const { dbg, calls } = fakeDebugger({ "Emulation.setTimezoneOverride": "reject" });
    await handleChildAttached(dbg, tokyo, new TabSessionTracker(), ROOT, iframeAttached());
    expect(calls.map((c) => c.method)).toEqual([
      "Emulation.setTimezoneOverride",
      "Target.setAutoAttach",
      "Runtime.runIfWaitingForDebugger",
    ]);
  });

  test("the zone lookup never resolves: resumed after timeoutMs", async () => {
    vi.useFakeTimers();
    const { dbg, calls } = fakeDebugger();
    const done = handleChildAttached(
      dbg,
      () => new Promise<string | null>(() => {}),
      new TabSessionTracker(),
      ROOT,
      iframeAttached(),
      { timeoutMs: 1000 }
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(calls.map((c) => c.method)).not.toContain("Runtime.runIfWaitingForDebugger");
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(calls.map((c) => c.method)).toEqual([
      "Target.setAutoAttach",
      "Runtime.runIfWaitingForDebugger",
    ]);
  });

  test("the override hangs: resumed after timeoutMs", async () => {
    vi.useFakeTimers();
    const { dbg, calls } = fakeDebugger({ "Emulation.setTimezoneOverride": "hang" });
    const done = handleChildAttached(dbg, tokyo, new TabSessionTracker(), ROOT, iframeAttached(), {
      timeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(calls.at(-1)?.method).toBe("Runtime.runIfWaitingForDebugger");
  });

  test("the zone lookup rejects: treated as no zone, still resumed", async () => {
    const { dbg, calls } = fakeDebugger();
    await handleChildAttached(
      dbg,
      () => Promise.reject(new Error("No tab with id")),
      new TabSessionTracker(),
      ROOT,
      iframeAttached()
    );
    expect(calls.map((c) => c.method)).toEqual([
      "Target.setAutoAttach",
      "Runtime.runIfWaitingForDebugger",
    ]);
  });

  test("not paused (waitingForDebugger false): no resume", async () => {
    const { dbg, calls } = fakeDebugger();
    await handleChildAttached(
      dbg,
      tokyo,
      new TabSessionTracker(),
      ROOT,
      iframeAttached("S1", false)
    );
    expect(calls.map((c) => c.method)).toEqual([
      "Emulation.setTimezoneOverride",
      "Target.setAutoAttach",
    ]);
  });

  test.each(["worker", "other"])("a %s target: no override, resumed if paused", async (type) => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    await handleChildAttached(dbg, tokyo, tracker, ROOT, {
      sessionId: "W1",
      targetInfo: { type },
      waitingForDebugger: true,
    });
    expect(calls).toEqual([
      {
        target: { tabId: TAB, sessionId: "W1" },
        method: "Runtime.runIfWaitingForDebugger",
        params: undefined,
      },
    ]);
    expect(tracker.children(TAB)).toEqual([]);
  });

  test("a nested child (source carries the parent's session) uses the root tab id", async () => {
    const { dbg, calls } = fakeDebugger();
    const zoneForTab = vi.fn(tokyo);
    await handleChildAttached(
      dbg,
      zoneForTab,
      new TabSessionTracker(),
      { tabId: TAB, sessionId: "S1" },
      iframeAttached("S2")
    );
    expect(zoneForTab).toHaveBeenCalledWith(TAB);
    for (const c of calls) expect(c.target).toEqual({ tabId: TAB, sessionId: "S2" });
  });

  test("no tab id on the source: nothing sent", async () => {
    const { dbg, calls } = fakeDebugger();
    await handleChildAttached(dbg, tokyo, new TabSessionTracker(), {}, iframeAttached());
    expect(calls).toEqual([]);
  });
});

describe("TabSessionTracker and the tab-wide commands", () => {
  test("an attach tracks the child and detachedFromTarget removes it", async () => {
    const { dbg } = fakeDebugger();
    const tracker = new TabSessionTracker();
    await handleChildAttached(dbg, tokyo, tracker, ROOT, iframeAttached("S1"));
    await handleChildAttached(dbg, tokyo, tracker, ROOT, iframeAttached("S2"));
    expect(tracker.children(TAB)).toEqual(["S1", "S2"]);
    handleChildDetached(tracker, ROOT, { sessionId: "S1" });
    expect(tracker.children(TAB)).toEqual(["S2"]);
  });

  test("setTabZone reaches the root, then each child, and reports the root's outcome", async () => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    tracker.addChild(TAB, "S1");
    tracker.addChild(TAB, "S2");
    expect(await setTabZone(dbg, tracker, TAB, "Europe/Paris")).toBe(true);
    expect(calls.map((c) => [c.target, c.params])).toEqual([
      [ROOT, { timezoneId: "Europe/Paris" }],
      [{ tabId: TAB, sessionId: "S1" }, { timezoneId: "Europe/Paris" }],
      [{ tabId: TAB, sessionId: "S2" }, { timezoneId: "Europe/Paris" }],
    ]);
  });

  test("setTabZone: a refused root returns false (the tab isn't ours)", async () => {
    const { dbg } = fakeDebugger({ "Emulation.setTimezoneOverride": "reject" });
    expect(await setTabZone(dbg, new TabSessionTracker(), TAB, "Asia/Tokyo")).toBe(false);
  });

  test("revertAndDetachTab: children reverted before the root, then detach, then forgotten", async () => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    tracker.markHeld(TAB);
    tracker.addChild(TAB, "S1");
    await revertAndDetachTab(dbg, tracker, TAB);
    expect(calls).toEqual([
      {
        target: { tabId: TAB, sessionId: "S1" },
        method: "Emulation.setTimezoneOverride",
        params: { timezoneId: "" },
      },
      { target: ROOT, method: "Emulation.setTimezoneOverride", params: { timezoneId: "" } },
      { target: ROOT, method: "detach" },
    ]);
    expect(tracker.isHeld(TAB)).toBe(false);
    expect(tracker.children(TAB)).toEqual([]);
  });

  test("revertAndDetachTab tolerates every step failing", async () => {
    const { dbg } = fakeDebugger({ "Emulation.setTimezoneOverride": "reject" });
    (dbg.detach as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("not attached"));
    const tracker = new TabSessionTracker();
    tracker.addChild(TAB, "S1");
    await expect(revertAndDetachTab(dbg, tracker, TAB)).resolves.toBeUndefined();
    expect(tracker.children(TAB)).toEqual([]);
  });
});

describe("ensureChildAutoAttach", () => {
  test("toggles off then on, once per tab", async () => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    await ensureChildAutoAttach(dbg, tracker, TAB, true);
    await ensureChildAutoAttach(dbg, tracker, TAB, true);
    expect(calls).toEqual([
      {
        target: ROOT,
        method: "Target.setAutoAttach",
        params: { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
      },
      { target: ROOT, method: "Target.setAutoAttach", params: { ...CHILD_AUTO_ATTACH } },
    ]);
  });

  test("nothing is sent when flat sessions aren't supported", async () => {
    const { dbg, calls } = fakeDebugger();
    await ensureChildAutoAttach(dbg, new TabSessionTracker(), TAB, false);
    expect(calls).toEqual([]);
  });

  test("a refused request is retried on the next call", async () => {
    const { dbg, calls } = fakeDebugger({ "Target.setAutoAttach": "reject" });
    const tracker = new TabSessionTracker();
    await ensureChildAutoAttach(dbg, tracker, TAB, true);
    await ensureChildAutoAttach(dbg, tracker, TAB, true);
    expect(calls.filter((c) => c.method === "Target.setAutoAttach")).toHaveLength(2);
  });

  test("a cleared tab (session ended) asks again", async () => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    await ensureChildAutoAttach(dbg, tracker, TAB, true);
    tracker.clearTab(TAB);
    await ensureChildAutoAttach(dbg, tracker, TAB, true);
    expect(calls.filter((c) => c.method === "Target.setAutoAttach")).toHaveLength(4);
  });
});

describe("holdTab", () => {
  const OPTS = { protocolVersion: "1.3", childSessions: true };

  test("a new tab: attach, zone, auto-attach; then marked held", async () => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    expect(await holdTab(dbg, tracker, TAB, "Asia/Tokyo", OPTS)).toBe(true);
    expect(calls.map((c) => c.method)).toEqual([
      "attach",
      "Emulation.setTimezoneOverride",
      "Target.setAutoAttach",
      "Target.setAutoAttach",
    ]);
    expect(tracker.isHeld(TAB)).toBe(true);
  });

  test("a held tab gets no attach", async () => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    await holdTab(dbg, tracker, TAB, "Asia/Tokyo", OPTS);
    calls.length = 0;
    expect(await holdTab(dbg, tracker, TAB, "America/Los_Angeles", OPTS)).toBe(true);
    expect(calls).toEqual([
      {
        target: ROOT,
        method: "Emulation.setTimezoneOverride",
        params: { timezoneId: "America/Los_Angeles" },
      },
    ]);
  });

  test("a tab is marked held only after a root command succeeds", async () => {
    const { dbg } = fakeDebugger({ "Emulation.setTimezoneOverride": "reject" });
    (dbg.attach as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Another debugger"));
    const tracker = new TabSessionTracker();
    expect(await holdTab(dbg, tracker, TAB, "Asia/Tokyo", OPTS)).toBe(false);
    expect(tracker.isHeld(TAB)).toBe(false);
  });

  test("a held tab whose session is gone is attached again once", async () => {
    const { dbg, calls } = fakeDebugger({}, new Set(["Emulation.setTimezoneOverride"]));
    const tracker = new TabSessionTracker();
    tracker.markHeld(TAB);
    expect(await holdTab(dbg, tracker, TAB, "Asia/Tokyo", OPTS)).toBe(true);
    expect(calls.map((c) => c.method).slice(0, 3)).toEqual([
      "Emulation.setTimezoneOverride",
      "attach",
      "Emulation.setTimezoneOverride",
    ]);
    expect(tracker.isHeld(TAB)).toBe(true);
  });
});

describe("onTopFrame", () => {
  test("passes frame 0 through and ignores subframes", () => {
    const seen: number[] = [];
    const listener = onTopFrame((d: { frameId: number; tabId: number }) => seen.push(d.tabId));
    listener({ frameId: 0, tabId: 1 });
    listener({ frameId: 3, tabId: 2 });
    listener({ frameId: 0, tabId: 3 });
    expect(seen).toEqual([1, 3]);
  });
});

describe("CHILD_AUTO_ATTACH", () => {
  // With pausing, Chrome 156 also paused new dedicated workers, and nothing
  // resumed them when another extension's frame made Chrome end the session.
  test("doesn't pause new targets, and attaches iframes only", () => {
    expect(CHILD_AUTO_ATTACH.waitForDebuggerOnStart).toBe(false);
    expect(CHILD_AUTO_ATTACH.flatten).toBe(true);
    expect(CHILD_AUTO_ATTACH.filter).toEqual([{ type: "iframe", exclude: false }]);
  });
});

describe("createDebuggerEventHandler", () => {
  test("routes attachedToTarget and detachedFromTarget, ignores the rest", async () => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    const onEvent = createDebuggerEventHandler({ dbg, tracker, zoneForTab: tokyo });
    onEvent(ROOT, "Target.attachedToTarget", iframeAttached("S1"));
    await vi.waitFor(() =>
      expect(calls.map((c) => c.method)).toContain("Runtime.runIfWaitingForDebugger")
    );
    expect(tracker.children(TAB)).toEqual(["S1"]);
    onEvent(ROOT, "Target.detachedFromTarget", { sessionId: "S1" });
    expect(tracker.children(TAB)).toEqual([]);
    const before = calls.length;
    onEvent(ROOT, "Network.requestWillBeSent", {});
    expect(calls).toHaveLength(before);
  });
});
