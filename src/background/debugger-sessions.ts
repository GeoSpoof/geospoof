/**
 * CDP session bookkeeping for Engine-level Spoofing (Chromium): the tabs
 * GeoSpoof holds a `chrome.debugger` session on, and the child sessions Chrome
 * auto-attaches for their cross-site iframes.
 *
 * Chrome's timezone override is per renderer process. A cross-site iframe runs
 * in its own process under site isolation and is its own CDP target, so the
 * tab's root session doesn't reach it. `Target.setAutoAttach` (flat sessions,
 * Chrome 125+) attaches each such iframe as a child of the root session, and
 * the zone is set there as soon as it attaches; the workers it starts share its
 * process and follow it. It isn't paused for that (see {@link
 * CHILD_AUTO_ATTACH}), so its first scripts can run with the real zone. Its
 * Date/Intl report the page's zone either way through the injected fallback
 * (see `engineTimezone` in `page-payload.ts`); this adds its workers and the
 * engine-level surfaces once it's running.
 *
 * No `chrome` or `__CHROMIUM__` here: every function takes a {@link
 * DebuggerLike}, so the logic runs under Vitest with a fake. `debugger-spoof.ts`
 * wires it to `chrome.debugger` behind its guards.
 */

import { createLogger } from "@/shared/utils/debug-logger";
import { isOlderRevision } from "@/shared/settings-revision";

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
  targetInfo: { type: string };
  waitingForDebugger: boolean;
}

/** The fields of CDP's `Target.detachedFromTarget` read here. */
export interface DetachedFromTargetParams {
  sessionId: string;
}

/**
 * Auto-attach every cross-site iframe as a flat child session.
 *
 * New targets are NOT paused (`waitForDebuggerOnStart: false`), so a frame's
 * first scripts can run before its zone is set; its later reads and the
 * workers it starts get it. Pausing was measured and dropped: Chrome 156 then
 * also pauses the session's new dedicated workers, whatever the filter says,
 * and when another extension's frame on the page makes Chrome end the session,
 * nothing resumes them. In the harness about one page load in five on such a
 * page left every dedicated worker hung.
 */
export const CHILD_AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: "iframe", exclude: false }],
} as const;

/** The bound on each step of setting up an attached child, before any resume. */
export const CHILD_RESUME_TIMEOUT_MS = 1000;

/**
 * The bound on how long a page delivery waits for older zone commands to its
 * tab. A delivery that reaches it goes out unsettled (see {@link
 * TabSessionTracker.deliver}).
 */
export const DELIVERY_WAIT_TIMEOUT_MS = 1000;

/**
 * A zone for a tab and the settings revision it comes from (absent when
 * unknown): what a reconcile sets on the tab's sessions, or what a page
 * delivery's settings give the tab. A null zone is none (a revert).
 */
export interface TabPlan {
  revision?: number;
  zone: string | null;
}

/** A zone command in flight to one of a tab's sessions, and the plan it came from. */
interface ZoneCommand {
  plan: TabPlan;
  done: Promise<unknown>;
}

interface TabSessions {
  /** A root command we sent succeeded, so the session is ours. */
  held: boolean;
  /** Auto-attach was requested on the root session. */
  autoAttach: boolean;
  /**
   * The zone the tab's newest reconcile set on the root, which a child that
   * attaches now gets; null while the tab is being reverted. Absent until a
   * reconcile in this worker's lifetime sets one.
   */
  zone?: string | null;
  /** The settings revision `zone` came from. */
  zoneRevision?: number;
  /** Child session ids. Nothing else about a frame (its URL) is kept. */
  children: Set<string>;
}

/**
 * In-memory, per tab: whether GeoSpoof holds the tab's session, the zone it
 * set, and its child sessions. An active debugger session keeps the
 * extension's service worker alive (Chrome 118+), so this lives as long as
 * anything is attached. After a forced worker restart it starts empty; {@link
 * ensureChildAutoAttach} rediscovers a held tab's children.
 *
 * It also numbers each tab's reconciles (see {@link TabSessionTracker.begin})
 * so the newest one is always the last to write, and records the settings
 * revision last delivered to each tab's page (see {@link
 * TabSessionTracker.deliver}) so a reconcile that read older settings can't
 * change the zone under a page that has the newer ones.
 */
export class TabSessionTracker {
  private readonly tabs = new Map<number, TabSessions>();
  /** Per tab, its newest reconcile. Kept apart from `tabs`, which `clearTab` drops. */
  private readonly generations = new Map<number, number>();
  private lastGeneration = 0;
  /**
   * Per tab, the newest settings revision delivered to its page and the zone
   * those settings give the tab. Kept apart from `tabs` too: the page stays
   * when a session ends.
   */
  private readonly delivered = new Map<number, TabPlan>();
  /** Per tab, the zone commands in flight to its sessions. */
  private readonly inFlight = new Map<number, Set<ZoneCommand>>();

  /**
   * Start a reconcile of the tab (a navigation, a settings change, a
   * teardown) and return its generation. Call it when the event arrives,
   * before any await. Every reconcile of the tab started before it is stale
   * from then on and sends nothing more, so the one started last is the last
   * to write, whichever lookup finishes first.
   */
  begin(tabId: number): number {
    const generation = this.reserve();
    this.generations.set(tabId, generation);
    return generation;
  }

  /**
   * A generation for a reconcile that doesn't know its tabs yet (a settings
   * sync, before it lists them). Take it when the event arrives, then {@link
   * claim} each tab with it.
   */
  reserve(): number {
    return ++this.lastGeneration;
  }

  /**
   * Make `generation`, from {@link reserve}, the tab's newest reconcile,
   * unless the tab already has it or a reconcile of the tab started after it
   * was reserved: that one decides the tab. Returns whether the tab is now
   * `generation`'s.
   */
  claim(tabId: number, generation: number): boolean {
    if ((this.generations.get(tabId) ?? 0) >= generation) return false;
    this.generations.set(tabId, generation);
    return true;
  }

  /** The tab's newest reconcile, if one has started. */
  generation(tabId: number): number | undefined {
    return this.generations.get(tabId);
  }

  /** Whether `generation` is still the tab's newest reconcile. */
  isCurrent(tabId: number, generation: number): boolean {
    return this.generations.get(tabId) === generation;
  }

  /**
   * A page delivery to the tab is about to go out, built from settings
   * `plan.revision` that give the tab `plan.zone`. Call it before the send:
   * the page may keep native Date/Intl because its engine already reports
   * that zone, so from now on a reconcile that read older settings sends
   * nothing to the tab that would set another zone (see {@link allows}).
   * Waits, at most `timeoutMs`, for the commands such reconciles already have
   * in flight to the tab. Resolves true when none of them can still land
   * (none was in flight, or they all settled), so the page checks its engine
   * after they did. Resolves false when one is still in flight at the bound:
   * it can land after the page has checked its engine, so the delivery must
   * not let a frame keep native Date/Intl (`engineTimezoneSettled` false). A
   * delivery with no revision, or an older one than the tab already had,
   * isn't recorded. Never rejects.
   */
  deliver(tabId: number, plan: TabPlan, timeoutMs = DELIVERY_WAIT_TIMEOUT_MS): Promise<boolean> {
    if (
      plan.revision !== undefined &&
      !isOlderRevision(plan.revision, this.delivered.get(tabId)?.revision)
    ) {
      this.delivered.set(tabId, plan);
    }
    const older = [...(this.inFlight.get(tabId) ?? [])]
      .filter((c) => !this.allows(tabId, c.plan))
      .map((c) => c.done);
    if (older.length === 0) return Promise.resolve(true);
    return withTimeout(
      Promise.allSettled(older).then(() => true),
      timeoutMs,
      false
    );
  }

  /**
   * Whether a reconcile may still set `plan.zone` on the tab: yes unless the
   * tab's page was delivered newer settings than `plan.revision` that give it
   * another zone. The newer settings' own zone stays allowed, so a newer save
   * that leaves the zone alone (a logging toggle) doesn't stop an older
   * settings change from reaching the engine.
   */
  allows(tabId: number, plan: TabPlan): boolean {
    const d = this.delivered.get(tabId);
    return !d || !isOlderRevision(plan.revision, d.revision) || plan.zone === d.zone;
  }

  /** Keep `done`, a zone command to one of the tab's sessions, in flight until it settles. */
  track<T>(tabId: number, plan: TabPlan, done: Promise<T>): Promise<T> {
    let commands = this.inFlight.get(tabId);
    if (!commands) {
      commands = new Set();
      this.inFlight.set(tabId, commands);
    }
    const command: ZoneCommand = { plan, done };
    commands.add(command);
    const settle = (): void => {
      commands.delete(command);
      if (commands.size === 0 && this.inFlight.get(tabId) === commands) {
        this.inFlight.delete(tabId);
      }
    };
    done.then(settle, settle);
    return done;
  }

  setZone(tabId: number, zone: string | null, revision?: number): void {
    const e = this.entry(tabId);
    e.zone = zone;
    e.zoneRevision = revision;
  }

  /** See {@link TabSessions.zone}; undefined when no reconcile has set one. */
  zone(tabId: number): string | null | undefined {
    return this.tabs.get(tabId)?.zone;
  }

  /** The tab's zone (see {@link zone}) and the settings revision it came from; undefined when no reconcile has set one. */
  zonePlan(tabId: number): TabPlan | undefined {
    const e = this.tabs.get(tabId);
    return e?.zone === undefined ? undefined : { revision: e.zoneRevision, zone: e.zone };
  }

  private entry(tabId: number): TabSessions {
    let e = this.tabs.get(tabId);
    if (!e) {
      e = { held: false, autoAttach: false, children: new Set() };
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

  addChild(tabId: number, sessionId: string): void {
    this.entry(tabId).children.add(sessionId);
  }

  removeChild(tabId: number, sessionId: string): void {
    this.tabs.get(tabId)?.children.delete(sessionId);
  }

  hasChild(tabId: number, sessionId: string): boolean {
    return this.tabs.get(tabId)?.children.has(sessionId) === true;
  }

  /** The tab's child session ids. */
  children(tabId: number): string[] {
    return [...(this.tabs.get(tabId)?.children ?? [])];
  }

  clearTab(tabId: number): void {
    this.tabs.delete(tabId);
  }

  /**
   * The user cancelled the debugging bar (`chrome.debugger.onDetach` with
   * `canceled_by_user`): forget the tab and stop every reconcile of it in
   * flight, so none of them attaches again and brings the bar back. A
   * reconcile that starts later (the next navigation) still can.
   */
  endSession(tabId: number): void {
    this.begin(tabId);
    this.clearTab(tabId);
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
 * `finally`, so no failure or hang before it keeps a frame paused. Never
 * throws.
 *
 * The zone is the one the tab's newest reconcile set on the root, sent at
 * once, so the child matches its page and a later reconcile's own pass over
 * the children overwrites it in order. Only when no reconcile in this
 * worker's lifetime has set one (just after a restart) is it looked up with
 * `zoneForTab`, and that answer is dropped if the child detached or a newer
 * reconcile started meanwhile: that reconcile reaches this child itself.
 * Either way it isn't sent if the tab's page has been delivered newer
 * settings with another zone ({@link TabSessionTracker.allows}); the
 * reconcile for those settings reaches this child in its pass.
 *
 * The child is addressed as `{ tabId, sessionId }` with the ROOT tab id, which
 * holds for a nested child too: its `source` carries its parent's session id.
 */
export async function handleChildAttached(
  dbg: DebuggerLike,
  zoneForTab: (tabId: number) => Promise<TabPlan>,
  tracker: TabSessionTracker,
  source: ChromeDebugger.DebuggerSession,
  params: AttachedToTargetParams,
  { timeoutMs = CHILD_RESUME_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<void> {
  const tabId = source.tabId;
  const sessionId = params?.sessionId;
  if (tabId == null || !sessionId) return;
  const child: ChromeDebugger.DebuggerSession = { tabId, sessionId };
  const none: TabPlan = { zone: null };
  try {
    if (params.targetInfo?.type === "iframe") {
      tracker.addChild(tabId, sessionId);
      let plan = tracker.zonePlan(tabId);
      if (plan === undefined) {
        const generation = tracker.generation(tabId);
        plan = await withTimeout(
          zoneForTab(tabId).catch(() => none),
          timeoutMs,
          none
        );
        if (!tracker.hasChild(tabId, sessionId) || tracker.generation(tabId) !== generation) {
          plan = none;
        }
      }
      if (plan.zone && tracker.allows(tabId, plan)) {
        await withTimeout(
          tracker
            .track(
              tabId,
              plan,
              dbg.sendCommand(child, "Emulation.setTimezoneOverride", { timezoneId: plan.zone })
            )
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
 * Whether reconcile `generation` of the tab, applying `plan`, may still send:
 * it's the tab's newest reconcile, and the tab's page hasn't been delivered
 * newer settings with another zone.
 */
function mayWrite(
  tracker: TabSessionTracker,
  tabId: number,
  generation: number,
  plan: TabPlan
): boolean {
  return tracker.isCurrent(tabId, generation) && tracker.allows(tabId, plan);
}

/**
 * Set `timezoneId`, from settings `revision`, on the tab's root session, then
 * on every tracked child, as reconcile `generation` of the tab. Nothing is
 * sent from the first step at which a newer reconcile has started (that one
 * writes after this one) or the tab's page has been delivered newer settings
 * with another zone (see {@link TabSessionTracker.allows}). Returns whether
 * the root command succeeded, which is what makes a tab count as held. Never
 * throws.
 */
export async function setTabZone(
  dbg: DebuggerLike,
  tracker: TabSessionTracker,
  tabId: number,
  timezoneId: string,
  generation: number,
  revision?: number
): Promise<boolean> {
  const plan: TabPlan = { revision, zone: timezoneId };
  if (!mayWrite(tracker, tabId, generation, plan)) return false;
  // A child that attaches from now on gets this zone (handleChildAttached).
  tracker.setZone(tabId, timezoneId, revision);
  let rootOk = false;
  try {
    await tracker.track(
      tabId,
      plan,
      dbg.sendCommand({ tabId }, "Emulation.setTimezoneOverride", { timezoneId })
    );
    rootOk = true;
  } catch (error) {
    logger.debug(`setTimezoneOverride failed for tab ${tabId}:`, error);
  }
  if (!mayWrite(tracker, tabId, generation, plan)) return rootOk;
  await Promise.allSettled(
    tracker
      .children(tabId)
      .map((sessionId) =>
        tracker.track(
          tabId,
          plan,
          dbg.sendCommand({ tabId, sessionId }, "Emulation.setTimezoneOverride", { timezoneId })
        )
      )
  );
  return rootOk;
}

/** What {@link holdTab} needs besides the tab. */
export interface HoldOptions {
  protocolVersion: string;
  /** Flat child sessions are supported (Chrome 125+). */
  childSessions: boolean;
}

/**
 * Attach to `tabId` if it isn't held yet, then set `timezoneId` on it and its
 * children, and on success mark it held and turn on child auto-attach, all as
 * reconcile `generation` of the tab (see {@link TabSessionTracker.begin}).
 *
 * A held tab skips the `attach`: it would only be rejected after an IPC round
 * trip, and that delay is spent before the zone is set. If the zone can't be
 * set on a tab we thought we held (the session ended without us noticing), the
 * tab is forgotten and attached again once. A failed `attach` is tolerated: a
 * rejection can't tell "already ours" from "someone else's", which is why only
 * a root command that succeeds marks a tab held. Once a newer reconcile of the
 * tab has started, or the tab's page has been delivered settings newer than
 * `revision` with another zone, nothing more is sent or recorded. Returns
 * whether this reconcile set the zone on the root and still owns the tab.
 * Never throws.
 */
export async function holdTab(
  dbg: DebuggerLike,
  tracker: TabSessionTracker,
  tabId: number,
  timezoneId: string,
  generation: number,
  { protocolVersion, childSessions }: HoldOptions,
  revision?: number
): Promise<boolean> {
  const current = (): boolean =>
    mayWrite(tracker, tabId, generation, { revision, zone: timezoneId });
  const attach = async (): Promise<void> => {
    try {
      await dbg.attach({ tabId }, protocolVersion);
    } catch (error) {
      // Expected when already attached, or when the tab can't be attached.
      logger.debug(`attach tab ${tabId}:`, error);
    }
  };
  const held = tracker.isHeld(tabId);
  if (!held) {
    if (!current()) return false;
    await attach();
  }
  let ok = await setTabZone(dbg, tracker, tabId, timezoneId, generation, revision);
  if (!ok && held && current()) {
    tracker.clearTab(tabId);
    await attach();
    ok = await setTabZone(dbg, tracker, tabId, timezoneId, generation, revision);
  }
  if (!ok || !current()) return false;
  tracker.markHeld(tabId);
  await ensureChildAutoAttach(dbg, tracker, tabId, childSessions);
  return true;
}

/**
 * Reconcile one tab as its reconcile `generation`, taken with {@link
 * TabSessionTracker.begin} when the event arrived: hold it with the zone
 * `lookup` resolves to, or revert and detach it when that's null (out of
 * scope, spoofing off), as the settings revision the lookup read. If a newer
 * reconcile of the tab started while `lookup` ran, nothing is sent: that one
 * decides. Never throws.
 */
export async function reconcileTab(
  dbg: DebuggerLike,
  tracker: TabSessionTracker,
  tabId: number,
  generation: number,
  lookup: () => Promise<TabPlan>,
  options: HoldOptions
): Promise<void> {
  let plan: TabPlan;
  try {
    plan = await lookup();
  } catch (error) {
    logger.debug(`zone lookup for tab ${tabId} failed:`, error);
    return;
  }
  if (!tracker.isCurrent(tabId, generation)) return;
  if (plan.zone) await holdTab(dbg, tracker, tabId, plan.zone, generation, options, plan.revision);
  else await revertAndDetachTab(dbg, tracker, tabId, generation, plan.revision);
}

/**
 * Wrap a `webNavigation` listener so it only sees top-level navigations
 * (`frameId` 0); the zone follows the tab's top-level page.
 */
export function onTopFrame<T extends { frameId: number }>(
  handler: (details: T) => void
): (details: T) => void {
  return (details) => {
    if (details.frameId === 0) handler(details);
  };
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
 * the tab, as reconcile `generation` of the tab, from settings `revision`.
 * Reverting explicitly matters: detaching alone doesn't reliably revert the
 * override on an already-loaded document. If a newer reconcile starts partway,
 * or the tab's page is delivered newer settings that give it a zone, the
 * remaining steps are skipped, so a teardown can't detach a session that
 * reconcile is using or take the zone from under that page. Never throws.
 */
export async function revertAndDetachTab(
  dbg: DebuggerLike,
  tracker: TabSessionTracker,
  tabId: number,
  generation: number,
  revision?: number
): Promise<void> {
  const plan: TabPlan = { revision, zone: null };
  const current = (): boolean => mayWrite(tracker, tabId, generation, plan);
  if (!current()) return;
  // A child that attaches from now on gets no zone.
  tracker.setZone(tabId, null, revision);
  await Promise.allSettled(
    tracker.children(tabId).map((sessionId) =>
      tracker.track(
        tabId,
        plan,
        dbg.sendCommand({ tabId, sessionId }, "Emulation.setTimezoneOverride", {
          timezoneId: "",
        })
      )
    )
  );
  if (!current()) return;
  try {
    await tracker.track(
      tabId,
      plan,
      dbg.sendCommand({ tabId }, "Emulation.setTimezoneOverride", { timezoneId: "" })
    );
  } catch {
    /* not attached / no override — fine */
  }
  if (!current()) return;
  try {
    // Tracked too: detaching can revert the override.
    await tracker.track(tabId, plan, dbg.detach({ tabId }));
  } catch {
    // Wasn't attached (the common case) — nothing to do.
  }
  // The session is gone, so forget it unless a newer reconcile is using the tab.
  if (tracker.isCurrent(tabId, generation)) tracker.clearTab(tabId);
}

/** What {@link createDebuggerEventHandler}'s listener needs. */
export interface DebuggerEventDeps {
  dbg: DebuggerLike;
  tracker: TabSessionTracker;
  zoneForTab: (tabId: number) => Promise<TabPlan>;
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
