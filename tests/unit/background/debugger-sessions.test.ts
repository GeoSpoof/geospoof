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
  reconcileTab,
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
  // holdNext(method): the next call of `method` settles only when released,
  // and rejects if released with an error.
  const held: { method: string; gate: Promise<void> }[] = [];
  const holdNext = (method: string): ((error?: Error) => void) => {
    let release!: (error?: Error) => void;
    const gate = new Promise<void>((resolve, reject) => {
      release = (error) => (error ? reject(error) : resolve());
    });
    held.push({ method, gate });
    return release;
  };
  const gateFor = (method: string): Promise<void> | null => {
    const i = held.findIndex((h) => h.method === method);
    return i < 0 ? null : held.splice(i, 1)[0].gate;
  };
  const dbg: DebuggerLike = {
    attach: vi.fn((target: ChromeDebugger.Debuggee) => {
      calls.push({ target, method: "attach" });
      return Promise.resolve();
    }),
    detach: vi.fn((target: ChromeDebugger.Debuggee) => {
      calls.push({ target, method: "detach" });
      return gateFor("detach") ?? Promise.resolve();
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
        const gate = gateFor(method);
        if (gate) return gate.then(() => undefined);
        return Promise.resolve(undefined);
      }
    ),
  };
  return { dbg, calls, holdNext };
}

/** A promise and the function that resolves it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** The zones sent to one session, in order ("" is a revert). */
function zonesSentTo(calls: Call[], target: ChromeDebugger.DebuggerSession): unknown[] {
  return calls
    .filter(
      (c) =>
        c.method === "Emulation.setTimezoneOverride" &&
        c.target.tabId === target.tabId &&
        c.target.sessionId === target.sessionId
    )
    .map((c) => c.params?.timezoneId);
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
    expect(await setTabZone(dbg, tracker, TAB, "Europe/Paris", tracker.begin(TAB))).toBe(true);
    expect(calls.map((c) => [c.target, c.params])).toEqual([
      [ROOT, { timezoneId: "Europe/Paris" }],
      [{ tabId: TAB, sessionId: "S1" }, { timezoneId: "Europe/Paris" }],
      [{ tabId: TAB, sessionId: "S2" }, { timezoneId: "Europe/Paris" }],
    ]);
  });

  test("setTabZone: a refused root returns false (the tab isn't ours)", async () => {
    const { dbg } = fakeDebugger({ "Emulation.setTimezoneOverride": "reject" });
    const tracker = new TabSessionTracker();
    expect(await setTabZone(dbg, tracker, TAB, "Asia/Tokyo", tracker.begin(TAB))).toBe(false);
  });

  test("revertAndDetachTab: children reverted before the root, then detach, then forgotten", async () => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    tracker.markHeld(TAB);
    tracker.addChild(TAB, "S1");
    await revertAndDetachTab(dbg, tracker, TAB, tracker.begin(TAB));
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
    await expect(
      revertAndDetachTab(dbg, tracker, TAB, tracker.begin(TAB))
    ).resolves.toBeUndefined();
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
    expect(await holdTab(dbg, tracker, TAB, "Asia/Tokyo", tracker.begin(TAB), OPTS)).toBe(true);
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
    await holdTab(dbg, tracker, TAB, "Asia/Tokyo", tracker.begin(TAB), OPTS);
    calls.length = 0;
    expect(await holdTab(dbg, tracker, TAB, "America/Los_Angeles", tracker.begin(TAB), OPTS)).toBe(
      true
    );
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
    expect(await holdTab(dbg, tracker, TAB, "Asia/Tokyo", tracker.begin(TAB), OPTS)).toBe(false);
    expect(tracker.isHeld(TAB)).toBe(false);
  });

  test("a held tab whose session is gone is attached again once", async () => {
    const { dbg, calls } = fakeDebugger({}, new Set(["Emulation.setTimezoneOverride"]));
    const tracker = new TabSessionTracker();
    tracker.markHeld(TAB);
    expect(await holdTab(dbg, tracker, TAB, "Asia/Tokyo", tracker.begin(TAB), OPTS)).toBe(true);
    expect(calls.map((c) => c.method).slice(0, 3)).toEqual([
      "Emulation.setTimezoneOverride",
      "attach",
      "Emulation.setTimezoneOverride",
    ]);
    expect(tracker.isHeld(TAB)).toBe(true);
  });
});

describe("the newest reconcile of a tab writes last", () => {
  const OPTS = { protocolVersion: "1.3", childSessions: false };
  const CHILD = { tabId: TAB, sessionId: "S1" };
  const LA = "America/Los_Angeles";

  test("generations stay unique and current across clearTab", () => {
    const tracker = new TabSessionTracker();
    const g1 = tracker.begin(TAB);
    tracker.clearTab(TAB);
    expect(tracker.isCurrent(TAB, g1)).toBe(true);
    const g2 = tracker.begin(TAB);
    expect(g2).not.toBe(g1);
    expect(tracker.isCurrent(TAB, g1)).toBe(false);
  });

  test("a reserved generation claims a tab only if nothing newer started on it", () => {
    const tracker = new TabSessionTracker();
    tracker.begin(TAB);
    const sync = tracker.reserve();
    expect(tracker.claim(TAB, sync)).toBe(true);
    expect(tracker.isCurrent(TAB, sync)).toBe(true);
    // Once per tab: a second claim of the same tab with it is refused.
    expect(tracker.claim(TAB, sync)).toBe(false);
    // A navigation that starts while the sync lists the tabs keeps its tab.
    const OTHER = TAB + 1;
    const late = tracker.reserve();
    const nav = tracker.begin(OTHER);
    expect(tracker.claim(OTHER, late)).toBe(false);
    expect(tracker.isCurrent(OTHER, nav)).toBe(true);
  });

  test("a child attaching after a reconcile set the zone gets it at once, with no lookup", async () => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    await holdTab(dbg, tracker, TAB, "Asia/Tokyo", tracker.begin(TAB), OPTS);
    calls.length = 0;
    const zoneForTab = vi.fn(tokyo);
    const done = handleChildAttached(dbg, zoneForTab, tracker, ROOT, iframeAttached("S1", false));
    // Sent before the handler's first await.
    expect(zonesSentTo(calls, CHILD)).toEqual(["Asia/Tokyo"]);
    await done;
    expect(zoneForTab).not.toHaveBeenCalled();
  });

  test("a child's lookup that finishes after a newer reconcile is dropped", async () => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    const lookup = deferred<string | null>();
    const child = handleChildAttached(
      dbg,
      () => lookup.promise,
      tracker,
      ROOT,
      iframeAttached("S1", false)
    );
    await reconcileTab(dbg, tracker, TAB, tracker.begin(TAB), () => Promise.resolve(LA), OPTS);
    lookup.resolve("Asia/Tokyo");
    await child;
    expect(zonesSentTo(calls, CHILD)).toEqual([LA]);
  });

  test("a child's lookup that finishes after a teardown is dropped", async () => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    tracker.markHeld(TAB);
    const lookup = deferred<string | null>();
    const child = handleChildAttached(
      dbg,
      () => lookup.promise,
      tracker,
      ROOT,
      iframeAttached("S1", false)
    );
    await revertAndDetachTab(dbg, tracker, TAB, tracker.begin(TAB));
    lookup.resolve("Asia/Tokyo");
    await child;
    expect(zonesSentTo(calls, CHILD)).toEqual([""]);
    expect(calls.at(-1)?.method).not.toBe("Emulation.setTimezoneOverride");
  });

  test("a child attaching while the tab is reverted gets no zone", async () => {
    const { dbg, calls, holdNext } = fakeDebugger();
    const tracker = new TabSessionTracker();
    await holdTab(dbg, tracker, TAB, "Asia/Tokyo", tracker.begin(TAB), OPTS);
    const release = holdNext("Emulation.setTimezoneOverride");
    const teardown = revertAndDetachTab(dbg, tracker, TAB, tracker.begin(TAB));
    await handleChildAttached(dbg, tokyo, tracker, ROOT, iframeAttached("S1", false));
    release();
    await teardown;
    expect(zonesSentTo(calls, CHILD)).toEqual([]);
  });

  test("a child that attaches mid-reconcile ends on the newest zone", async () => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    await holdTab(dbg, tracker, TAB, "Asia/Tokyo", tracker.begin(TAB), OPTS);
    const lookup = deferred<string | null>();
    const nav = reconcileTab(dbg, tracker, TAB, tracker.begin(TAB), () => lookup.promise, OPTS);
    await handleChildAttached(dbg, tokyo, tracker, ROOT, iframeAttached("S1", false));
    lookup.resolve(LA);
    await nav;
    expect(zonesSentTo(calls, CHILD)).toEqual(["Asia/Tokyo", LA]);
  });

  test("navigations: an older lookup that finishes last sends nothing", async () => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    const older = deferred<string | null>();
    const first = reconcileTab(dbg, tracker, TAB, tracker.begin(TAB), () => older.promise, OPTS);
    await reconcileTab(dbg, tracker, TAB, tracker.begin(TAB), () => Promise.resolve(LA), OPTS);
    older.resolve("Asia/Tokyo");
    await first;
    expect(zonesSentTo(calls, ROOT)).toEqual([LA]);
    expect(tracker.zone(TAB)).toBe(LA);
  });

  test("navigations: an older out-of-scope lookup can't detach the newer page's session", async () => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    const older = deferred<string | null>();
    const first = reconcileTab(dbg, tracker, TAB, tracker.begin(TAB), () => older.promise, OPTS);
    await reconcileTab(dbg, tracker, TAB, tracker.begin(TAB), () => Promise.resolve(LA), OPTS);
    older.resolve(null);
    await first;
    expect(calls.map((c) => c.method)).not.toContain("detach");
    expect(tracker.isHeld(TAB)).toBe(true);
  });

  test("a lookup that throws sends nothing", async () => {
    const { dbg, calls } = fakeDebugger();
    const tracker = new TabSessionTracker();
    await expect(
      reconcileTab(
        dbg,
        tracker,
        TAB,
        tracker.begin(TAB),
        () => Promise.reject(new Error("storage")),
        OPTS
      )
    ).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("a settings change during an older root command: the older reconcile skips the children", async () => {
    const { dbg, calls, holdNext } = fakeDebugger();
    const tracker = new TabSessionTracker();
    tracker.markHeld(TAB);
    tracker.addChild(TAB, "S1");
    const release = holdNext("Emulation.setTimezoneOverride");
    const older = holdTab(dbg, tracker, TAB, "Asia/Tokyo", tracker.begin(TAB), OPTS);
    expect(await holdTab(dbg, tracker, TAB, LA, tracker.begin(TAB), OPTS)).toBe(true);
    release();
    expect(await older).toBe(false);
    expect(zonesSentTo(calls, ROOT)).toEqual(["Asia/Tokyo", LA]);
    expect(zonesSentTo(calls, CHILD)).toEqual([LA]);
  });

  test("a teardown during a hold: the hold stops and the tab isn't marked held", async () => {
    const { dbg, calls, holdNext } = fakeDebugger();
    const tracker = new TabSessionTracker();
    const release = holdNext("Emulation.setTimezoneOverride");
    const hold = holdTab(dbg, tracker, TAB, "Asia/Tokyo", tracker.begin(TAB), {
      ...OPTS,
      childSessions: true,
    });
    await vi.waitFor(() => expect(zonesSentTo(calls, ROOT)).toEqual(["Asia/Tokyo"]));
    await revertAndDetachTab(dbg, tracker, TAB, tracker.begin(TAB));
    const afterDetach = calls.length;
    release();
    expect(await hold).toBe(false);
    expect(calls.slice(afterDetach)).toEqual([]);
    expect(tracker.isHeld(TAB)).toBe(false);
  });

  test("a reconcile that starts during a teardown keeps its session", async () => {
    const { dbg, calls, holdNext } = fakeDebugger();
    const tracker = new TabSessionTracker();
    tracker.markHeld(TAB);
    tracker.addChild(TAB, "S1");
    const release = holdNext("Emulation.setTimezoneOverride");
    const teardown = revertAndDetachTab(dbg, tracker, TAB, tracker.begin(TAB));
    expect(await holdTab(dbg, tracker, TAB, LA, tracker.begin(TAB), OPTS)).toBe(true);
    release();
    await teardown;
    expect(calls.map((c) => c.method)).not.toContain("detach");
    expect(zonesSentTo(calls, ROOT)).toEqual([LA]);
    expect(zonesSentTo(calls, CHILD)).toEqual(["", LA]);
    expect(tracker.isHeld(TAB)).toBe(true);
  });

  test("a cancelled session (endSession) stops a hold whose root command then fails: no attach again", async () => {
    const { dbg, calls, holdNext } = fakeDebugger();
    const tracker = new TabSessionTracker();
    tracker.markHeld(TAB);
    const fail = holdNext("Emulation.setTimezoneOverride");
    const hold = holdTab(dbg, tracker, TAB, "Asia/Tokyo", tracker.begin(TAB), OPTS);
    await vi.waitFor(() => expect(zonesSentTo(calls, ROOT)).toEqual(["Asia/Tokyo"]));
    tracker.endSession(TAB);
    fail(new Error("Debugger is not attached to the tab with id: 7."));
    expect(await hold).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["Emulation.setTimezoneOverride"]);
    expect(tracker.isHeld(TAB)).toBe(false);
  });

  test("a reconcile that starts during the detach: the teardown doesn't forget the tab", async () => {
    const { dbg, calls, holdNext } = fakeDebugger();
    const tracker = new TabSessionTracker();
    tracker.markHeld(TAB);
    const release = holdNext("detach");
    const teardown = revertAndDetachTab(dbg, tracker, TAB, tracker.begin(TAB));
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toContain("detach"));
    const g = tracker.begin(TAB);
    release();
    await teardown;
    // The newer reconcile finds the tab still marked held; its root command
    // fails on the detached session and it attaches again (holdTab's retry).
    expect(tracker.isHeld(TAB)).toBe(true);
    expect(tracker.isCurrent(TAB, g)).toBe(true);
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
