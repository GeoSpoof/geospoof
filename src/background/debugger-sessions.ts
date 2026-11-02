/**
 * CDP session bookkeeping for Engine-level Spoofing (Chromium): the tabs
 * GeoSpoof holds a `chrome.debugger` session on, and the child sessions Chrome
 * auto-attaches for their cross-site iframes.
 *
 * Chrome's timezone override is per renderer process. A cross-site iframe runs
 * in its own process under site isolation and is its own CDP target, so the
 * tab's root session doesn't reach it. `Target.setAutoAttach` (flat sessions,
 * Chrome 125+) attaches each such iframe as a child of the root session,
 * paused before its first script, so the zone is set there first; the workers
 * it starts share its process and follow it. A frame the child session can't
 * reach still reports the page's zone through the injected fallback (see
 * `engineTimezone` in `page-payload.ts`); this adds its earliest scripts and
 * its workers.
 *
 * No `chrome` or `__CHROMIUM__` here: every function takes a {@link
 * DebuggerLike}, so the logic runs under Vitest with a fake. `debugger-spoof.ts`
 * wires it to `chrome.debugger` behind its guards.
 */

import { createLogger } from "@/shared/utils/debug-logger";

const logger = createLogger("BG");

/** The slice of `chrome.debugger` these functions call. */
export interface DebuggerLike {
  attach(target: ChromeDebugger.Debuggee, requiredVersion: string): Promise<void>;
  detach(target: ChromeDebugger.Debuggee): Promise<void>;
  sendCommand(
    target: ChromeDebugger.DebuggerSession,
    method: string,
    commandParams?: { [name: string]: unknown }
  ): Promise<{ [name: string]: unknown } | undefined>;
}

/** The fields of CDP's `Target.attachedToTarget` read here. */
export interface AttachedToTargetParams {
  sessionId: string;
  targetInfo: { targetId: string; type: string; url: string };
  waitingForDebugger: boolean;
}

/** The fields of CDP's `Target.detachedFromTarget` read here. */
export interface DetachedFromTargetParams {
  sessionId: string;
}

/**
 * Auto-attach every cross-site iframe as a flat child session, paused before
 * its first script until `Runtime.runIfWaitingForDebugger`.
 *
 * Dedicated workers are listed too, though nothing is set on them (they share
 * their frame's process and follow its zone): Chrome 156 pauses a session's new
 * dedicated workers whenever `waitForDebuggerOnStart` is set, whatever the
 * filter says, and without an attach event nothing would resume them. Measured
 * in the harness: with iframes alone, every dedicated worker hung.
 */
export const CHILD_AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [
    { type: "iframe", exclude: false },
    { type: "worker", exclude: false },
  ],
} as const;

/** How long an attached child may stay paused while its zone is set. */
export const CHILD_RESUME_TIMEOUT_MS = 1000;

interface ChildSession {
  targetId: string;
  url: string;
}

interface TabSessions {
  /** A root command we sent succeeded, so the session is ours. */
  held: boolean;
  /** Auto-attach was requested on the root session. */
  autoAttach: boolean;
  children: Map<string, ChildSession>;
}

/**
 * In-memory, per tab: whether GeoSpoof holds the tab's session, and its child
 * sessions. An active debugger session keeps the extension's service worker
 * alive (Chrome 118+), so this lives as long as anything is attached. After a
 * forced worker restart it starts empty; {@link ensureChildAutoAttach}
 * rediscovers a held tab's children.
 */
export class TabSessionTracker {
  private readonly tabs = new Map<number, TabSessions>();

  private entry(tabId: number): TabSessions {
    let e = this.tabs.get(tabId);
    if (!e) {
      e = { held: false, autoAttach: false, children: new Map() };
      this.tabs.set(tabId, e);
    }
    return e;
  }

  markHeld(tabId: number): void {
    this.entry(tabId).held = true;
  }

  isHeld(tabId: number): boolean {
    return this.tabs.get(tabId)?.held === true;
  }

  /** Mark auto-attach as requested; false if it already was. */
  claimAutoAttach(tabId: number): boolean {
    const e = this.entry(tabId);
    if (e.autoAttach) return false;
    e.autoAttach = true;
    return true;
  }

  releaseAutoAttach(tabId: number): void {
    const e = this.tabs.get(tabId);
    if (e) e.autoAttach = false;
  }

  addChild(tabId: number, sessionId: string, child: ChildSession): void {
    this.entry(tabId).children.set(sessionId, child);
  }

  removeChild(tabId: number, sessionId: string): void {
    this.tabs.get(tabId)?.children.delete(sessionId);
  }

  /** The tab's child session ids. */
  children(tabId: number): string[] {
    return [...(this.tabs.get(tabId)?.children.keys() ?? [])];
  }

  clearTab(tabId: number): void {
    this.tabs.delete(tabId);
  }
}

/** Resolve with `p`, or with `fallback` after `ms`, whichever is first. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A child session attached (`Target.attachedToTarget`). For an iframe: track
 * it, set the tab's zone on it, and ask it to auto-attach its own cross-site
 * iframes (auto-attach isn't recursive). Then resume it if it's paused. Each
 * step before the resume is bounded by `timeoutMs`, and the resume runs in a
 * `finally`, so no failure or hang leaves a frame paused. Never throws.
 *
 * The child is addressed as `{ tabId, sessionId }` with the ROOT tab id, which
 * holds for a nested child too: its `source` carries its parent's session id.
 */
export async function handleChildAttached(
  dbg: DebuggerLike,
  zoneForTab: (tabId: number) => Promise<string | null>,
  tracker: TabSessionTracker,
  source: ChromeDebugger.DebuggerSession,
  params: AttachedToTargetParams,
  { timeoutMs = CHILD_RESUME_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<void> {
  const tabId = source.tabId;
  if (tabId == null || !params?.sessionId) return;
  const child: ChromeDebugger.DebuggerSession = { tabId, sessionId: params.sessionId };
  try {
    if (params.targetInfo?.type === "iframe") {
      tracker.addChild(tabId, params.sessionId, {
        targetId: params.targetInfo.targetId,
        url: params.targetInfo.url,
      });
      const zone = await withTimeout(
        zoneForTab(tabId).catch(() => null),
        timeoutMs,
        null
      );
      if (zone) {
        await withTimeout(
          dbg
            .sendCommand(child, "Emulation.setTimezoneOverride", { timezoneId: zone })
            .catch((error: unknown) => {
              // E.g. "Timezone override is already in effect" when Chrome put
              // this frame in a process another session already set.
              logger.debug(`child setTimezoneOverride failed (tab ${tabId}):`, error);
              return undefined;
            }),
          timeoutMs,
          undefined
        );
      }
      await withTimeout(
        dbg
          .sendCommand(child, "Target.setAutoAttach", { ...CHILD_AUTO_ATTACH })
          .catch(() => undefined),
        timeoutMs,
        undefined
      );
    }
  } finally {
    if (params.waitingForDebugger) {
      try {
        await dbg.sendCommand(child, "Runtime.runIfWaitingForDebugger");
      } catch (error) {
        logger.debug(`runIfWaitingForDebugger failed (tab ${tabId}):`, error);
      }
    }
  }
}

/** A child session ended (`Target.detachedFromTarget`). */
export function handleChildDetached(
  tracker: TabSessionTracker,
  source: ChromeDebugger.DebuggerSession,
  params: DetachedFromTargetParams
): void {
  if (source.tabId == null || !params?.sessionId) return;
  tracker.removeChild(source.tabId, params.sessionId);
}

/**
 * Set `timezoneId` on the tab's root session, then on every tracked child
 * (`""` reverts). Returns whether the root command succeeded, which is what
 * makes a tab count as held. Never throws.
 */
export async function setTabZone(
  dbg: DebuggerLike,
  tracker: TabSessionTracker,
  tabId: number,
  timezoneId: string
): Promise<boolean> {
  let rootOk = false;
  try {
    await dbg.sendCommand({ tabId }, "Emulation.setTimezoneOverride", { timezoneId });
    rootOk = true;
  } catch (error) {
    logger.debug(`setTimezoneOverride failed for tab ${tabId}:`, error);
  }
  await Promise.allSettled(
    tracker
      .children(tabId)
      .map((sessionId) =>
        dbg.sendCommand({ tabId, sessionId }, "Emulation.setTimezoneOverride", { timezoneId })
      )
  );
  return rootOk;
}

/**
 * Turn on child auto-attach for a tab, once per tracked tab. It's toggled off
 * first: when the tracker is new but the session isn't (a service-worker
 * restart), that makes Chrome report the tab's existing children again. No-op
 * when flat sessions aren't supported (`supported` false, Chrome before 125).
 * Never throws.
 */
export async function ensureChildAutoAttach(
  dbg: DebuggerLike,
  tracker: TabSessionTracker,
  tabId: number,
  supported: boolean
): Promise<void> {
  if (!supported || !tracker.claimAutoAttach(tabId)) return;
  try {
    await dbg.sendCommand({ tabId }, "Target.setAutoAttach", {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await dbg.sendCommand({ tabId }, "Target.setAutoAttach", { ...CHILD_AUTO_ATTACH });
  } catch (error) {
    tracker.releaseAutoAttach(tabId);
    logger.debug(`Target.setAutoAttach failed for tab ${tabId}:`, error);
  }
}

/**
 * Revert the zone on the tab's children, then its root, then detach and forget
 * the tab. Reverting explicitly matters: detaching alone doesn't reliably
 * revert the override on an already-loaded document. Never throws.
 */
export async function revertAndDetachTab(
  dbg: DebuggerLike,
  tracker: TabSessionTracker,
  tabId: number
): Promise<void> {
  await Promise.allSettled(
    tracker
      .children(tabId)
      .map((sessionId) =>
        dbg.sendCommand({ tabId, sessionId }, "Emulation.setTimezoneOverride", { timezoneId: "" })
      )
  );
  try {
    await dbg.sendCommand({ tabId }, "Emulation.setTimezoneOverride", { timezoneId: "" });
  } catch {
    /* not attached / no override — fine */
  }
  try {
    await dbg.detach({ tabId });
  } catch {
    // Wasn't attached (the common case) — nothing to do.
  }
  tracker.clearTab(tabId);
}

/** What {@link createDebuggerEventHandler}'s listener needs. */
export interface DebuggerEventDeps {
  dbg: DebuggerLike;
  tracker: TabSessionTracker;
  zoneForTab: (tabId: number) => Promise<string | null>;
  timeoutMs?: number;
}

/** The `chrome.debugger.onEvent` listener: routes child-session events. */
export function createDebuggerEventHandler(
  deps: DebuggerEventDeps
): (source: ChromeDebugger.DebuggerSession, method: string, params?: object) => void {
  return (source, method, params) => {
    if (method === "Target.attachedToTarget") {
      void handleChildAttached(
        deps.dbg,
        deps.zoneForTab,
        deps.tracker,
        source,
        params as AttachedToTargetParams,
        { timeoutMs: deps.timeoutMs }
      );
    } else if (method === "Target.detachedFromTarget") {
      handleChildDetached(deps.tracker, source, params as DetachedFromTargetParams);
    }
  };
}
