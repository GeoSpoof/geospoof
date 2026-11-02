/**
 * Browser-level TIMEZONE spoofing via the Chrome DevTools Protocol
 * (`chrome.debugger`).
 *
 * This is the Chromium-only alternative to the page-world content-script
 * timezone overrides. Instead of patching Date/Intl from inside each page, it
 * attaches the `chrome.debugger` client to every in-scope http/https tab and
 * drives `Emulation.setTimezoneOverride`, which sets the zone for Date and Intl
 * in the tab's renderer process: the page, its same-process frames, and the
 * workers there (incl. URL/module workers), which the Chromium content-script
 * path can't reach (no `webRequest.filterResponseData` on Chromium MV3). A
 * cross-site iframe runs in its own process, so it gets its own child session
 * (`Target.setAutoAttach`, see `debugger-sessions.ts`) that sets the zone
 * before its first script. Applied on `webNavigation.onBeforeNavigate` (or the
 * `tabs.onUpdated` fallback), which narrows the cold-start race but doesn't
 * close it: the calls are asynchronous (Known Limitations 3 and 15 in
 * docs/API.md).
 *
 * SCOPE: geolocation is deliberately NOT handled here. CDP can only spoof
 * geolocation by setting an override behind the normal permission flow, which
 * races the page's first `getCurrentPosition` (a grant has to land before the
 * call) — so it can't guarantee the prompt-free behaviour users expect. The
 * content-script injection *replaces* `getCurrentPosition`, so it's reliably
 * prompt-free, race-free, and already per-tab scope-aware. Therefore, even in
 * debugger mode, geolocation stays on the injected path. The payload still
 * carries each page's zone, flagged `engineTimezone`: a frame keeps native
 * Date/Intl where its engine already reports that zone and installs the
 * injected timezone overrides where it doesn't (see `page-payload.ts`). The
 * cost is Chrome's persistent "GeoSpoof started debugging this browser" bar, so
 * the feature is strictly opt-in (`Settings.debuggerModeEnabled`).
 *
 * MV3 design notes:
 *   - Settings are read fresh from storage in every event handler, and
 *     `chrome.debugger.getTargets()` is the source of truth for which tabs are
 *     attached. The only memory is the {@link TabSessionTracker}: which tabs we
 *     hold and their child sessions. An attached debugger session keeps the
 *     service worker alive (Chrome 118+), and after a forced restart a held
 *     tab's children are rediscovered (`ensureChildAutoAttach`).
 *   - Listeners are registered at the top level (see `installDebuggerWatchers`,
 *     called from `index.ts` alongside `installResyncWatchers`) so they
 *     re-bind on every SW respawn.
 *
 * Entirely guarded by `__CHROMIUM__` (compiled out of Firefox/Safari) and by
 * the presence of `chrome.debugger` (the `debugger` permission is declared
 * required on the Chromium build, so it's present there).
 */

import type { Tabs } from "webextension-polyfill";
import type { Settings } from "@/shared/types/settings";
import { computeEffectiveSiteLocations } from "@/shared/utils/scope";
import { resolveSiteSettings } from "@/shared/utils/site-locations";
import { chromiumMajorFromUserAgent } from "@/shared/native-offset-precision";
import { loadSettings } from "./settings";
import { isRestrictedUrl, sendSettingsToTab } from "./tabs";
import {
  TabSessionTracker,
  createDebuggerEventHandler,
  holdTab,
  onTopFrame,
  revertAndDetachTab,
} from "./debugger-sessions";
import { createLogger } from "@/shared/utils/debug-logger";

const logger = createLogger("BG");

/** CDP version string passed to chrome.debugger.attach. */
const PROTOCOL_VERSION = "1.3";

/**
 * The tabs we hold a session on, and their child sessions. Pure, so Firefox
 * and Safari builds, where nothing reads it, drop it.
 */
const tracker = /* @__PURE__ */ new TabSessionTracker();

/** Flat child sessions (`sendCommand` with a `sessionId`) need Chrome 125+. */
function childSessionsSupported(): boolean {
  return (chromiumMajorFromUserAgent(navigator.userAgent) ?? 0) >= 125;
}

/** Resolved override values for one tab. */
interface Overrides {
  timezoneId: string;
}

/** Top-level listeners installed once per service-worker lifetime. */
let watchersInstalled = false;

/**
 * Whether the `webNavigation.onBeforeNavigate` listener is actually bound. This
 * is NOT the same as `chrome.webNavigation` merely existing: the permission can
 * be granted at runtime *after* the SW started (so the namespace appears but
 * our listener was never added). The `tabs.onUpdated` fallback gates on this
 * flag so exactly one early-attach path is ever live.
 */
let webNavRegistered = false;

/**
 * Browser-level timezone spoofing runs only with the mode on, protection on,
 * and some timezone to apply: the main one or a site location's. (Geolocation
 * is handled by the injected path, so it doesn't gate this.)
 */
function shouldSpoof(settings: Settings): boolean {
  return (
    __CHROMIUM__ &&
    settings.debuggerModeEnabled &&
    settings.enabled &&
    (settings.timezone != null ||
      computeEffectiveSiteLocations(settings.siteLocations, settings.proFeaturesBlocked).length > 0)
  );
}

function isSpoofableTabUrl(url: string | undefined): boolean {
  return !!url && (url.startsWith("http://") || url.startsWith("https://"));
}

/**
 * The CDP overrides for one tab, or null when the tab shouldn't be held. Pure.
 *
 * Honours the same per-site resolution the content-script payload uses, so
 * debugger mode agrees with injection mode: a denylisted site is never
 * attached, an allowlisted-only site is the only one attached, and a site
 * location's page gets that site's zone. Null for non-http(s) URLs, out-of-scope
 * tabs, and tabs with no zone to apply.
 */
export function buildOverridesForTab(
  settings: Settings,
  url: string | undefined
): Overrides | null {
  if (!isSpoofableTabUrl(url)) return null;
  const r = resolveSiteSettings(settings, url, isRestrictedUrl);
  if (!r.enabled || !r.settings.timezone) return null;
  return { timezoneId: r.settings.timezone.identifier };
}

/**
 * Ensure we hold `tabId`, then apply the override to its root session and its
 * child sessions (`holdTab`). A tab we already hold isn't attached again. If the
 * tab can't be attached (it shows another extension's frame, a restricted
 * target) the apply fails harmlessly and the page falls back to the injected
 * timezone. A successful root apply marks the tab held and turns on child
 * auto-attach for its cross-site iframes. Never throws.
 */
async function attachAndApplyTab(tabId: number, overrides: Overrides): Promise<void> {
  const dbg = chrome.debugger;
  if (!dbg) return;
  await holdTab(dbg, tracker, tabId, overrides.timezoneId, {
    protocolVersion: PROTOCOL_VERSION,
    childSessions: childSessionsSupported(),
  });
}

/**
 * The zone a child session of `tabId` gets: the tab's committed top-level
 * page's, from fresh settings, so a frame follows its page. Null when the tab
 * shouldn't be spoofed.
 */
async function zoneForTab(tabId: number): Promise<string | null> {
  const settings = await loadSettings();
  if (!shouldSpoof(settings)) return null;
  const tab = await browser.tabs.get(tabId);
  return buildOverridesForTab(settings, tab.url)?.timezoneId ?? null;
}

/**
 * Read settings fresh and reconcile a single tab: attach+apply if in scope,
 * else detach. Exported so the navigation handler can reconcile a tab on a
 * same-document (History API) navigation — which fires no network request and
 * therefore no `onBeforeNavigate`, so a CDP-spoofed tab would otherwise go
 * stale when an in-page route crosses a scope boundary (Req 11).
 */
export async function ensureTabSpoofed(tabId: number, url: string | undefined): Promise<void> {
  const settings = await loadSettings();
  const overrides = shouldSpoof(settings) ? buildOverridesForTab(settings, url) : null;
  if (overrides === null) {
    // Out of scope (or spoofing off, or no zone here) — make sure we're not
    // holding a stale session on this tab (e.g. it navigated from an
    // allowlisted page away).
    await detachTab(tabId);
    return;
  }
  await attachAndApplyTab(tabId, overrides);
}

/**
 * Revert our timezone override on one tab (its child sessions first) so it
 * reads the real zone live, then detach. We clear explicitly (empty timezoneId
 * disables the override) rather than relying on detach's implicit teardown,
 * which doesn't reliably revert `Emulation.setTimezoneOverride` on the
 * already-loaded document. Best-effort; never throws.
 */
async function detachTab(tabId: number): Promise<void> {
  const dbg = chrome.debugger;
  if (!dbg) return;
  await revertAndDetachTab(dbg, tracker, tabId);
}

/** Clear the timezone override on, and detach from, every page target we hold. */
async function detachAll(): Promise<void> {
  const dbg = chrome.debugger;
  if (!dbg) return;

  let targets: ChromeDebugger.TargetInfo[] = [];
  try {
    targets = await dbg.getTargets();
  } catch (error) {
    logger.debug("getTargets failed during detachAll:", error);
    return;
  }

  const attached = targets.filter((t) => t.type === "page" && t.tabId != null && t.attached);
  await Promise.allSettled(attached.map((t) => detachTab(t.tabId!)));
}

/**
 * Reconcile the live debugger state with the current settings. Idempotent — the
 * single entry point to call after any settings change that could affect
 * browser-level spoofing (mode toggle, protection toggle, location/timezone
 * change, VPN sync) and on background startup.
 *
 * Active → attach to every in-scope open tab and (re)apply the timezone
 * override. Inactive → detach everything. No-op on non-Chromium builds.
 */
export async function syncDebuggerSpoofing(settings: Settings): Promise<void> {
  if (!__CHROMIUM__) return;

  const dbg = chrome.debugger;
  if (!dbg) {
    if (shouldSpoof(settings)) {
      // Mode is on but the `debugger` API isn't available (permission revoked
      // from chrome://extensions, or a non-Chromium engine reaching here).
      logger.warn("[debugger] mode enabled but chrome.debugger is unavailable; skipping");
    }
    return;
  }

  if (!shouldSpoof(settings)) {
    await detachAll();
    return;
  }

  let targets: ChromeDebugger.TargetInfo[] = [];
  try {
    targets = await dbg.getTargets();
  } catch (error) {
    logger.warn("[debugger] getTargets failed; cannot apply debugger spoofing:", error);
    return;
  }

  const pageTargets = targets.filter((t) => t.type === "page" && t.tabId != null);
  // Each tab gets its own overrides (a site location's page has its own zone).
  const planned = pageTargets.map((t) => ({
    target: t,
    overrides: buildOverridesForTab(settings, t.url),
  }));
  const apply = planned.filter((p) => p.overrides !== null);
  // Tabs we currently hold that fell out of scope (e.g. scope just changed) must
  // be released so an excluded site isn't left spoofed.
  const staleAttached = planned.filter((p) => p.overrides === null && p.target.attached);

  logger.info("[debugger] applying browser-level timezone spoofing", {
    apply: apply.length,
    detach: staleAttached.length,
  });

  await Promise.allSettled([
    ...apply.map((p) => attachAndApplyTab(p.target.tabId!, p.overrides!)),
    ...staleAttached.map((p) => detachTab(p.target.tabId!)),
  ]);
}

/**
 * React to a debug session ending. When the user cancels Chrome's debugging
 * bar, the tab's engine override may or may not revert on the loaded document,
 * so the tab's payload is sent again: each frame re-checks whether its engine
 * still reports the page's zone and falls back to the injected overrides if it
 * doesn't. It still doesn't re-attach: re-spawning the bar the user just
 * dismissed would be hostile. Other reasons (the tab closed) need nothing.
 * Never throws.
 */
export async function handleDebuggerDetach(
  reason: ChromeDebugger.DetachReason,
  tabId: number | undefined,
  resend: (tabId: number) => Promise<void>
): Promise<void> {
  if (reason !== "canceled_by_user" || tabId == null) return;
  try {
    await resend(tabId);
  } catch (error) {
    logger.debug(`re-sending tab ${tabId}'s settings after a cancelled session failed:`, error);
  }
}

/** Send one tab its current payload. */
async function resendTabPayload(tabId: number): Promise<void> {
  const settings = await loadSettings();
  const tab = await browser.tabs.get(tabId);
  await sendSettingsToTab(tab, settings);
}

// --- Top-level listeners (MV3: registered synchronously, re-bind on respawn) ---

/** A debug session ended (tab closed, DevTools opened, user dismissed the bar). */
function onDebuggerDetach(
  source: ChromeDebugger.Debuggee,
  reason: ChromeDebugger.DetachReason
): void {
  logger.debug(`debugger detached from tab ${source.tabId ?? "?"} (${reason})`);
  if (source.tabId != null) tracker.clearTab(source.tabId);
  void handleDebuggerDetach(reason, source.tabId, resendTabPayload);
}

/**
 * Fired before a navigation's network request — the earliest hook, though an
 * override sent now doesn't reach a cross-site document before its first
 * scripts (Known Limitation 15). Top-level frames only (bound through
 * `onTopFrame`). Requires the optional `webNavigation` permission (the popup
 * requests it when the mode is enabled); absent that, `onTabUpdated` is the
 * fallback.
 */
function onBeforeNavigate(details: ChromeWebNavigation.OnBeforeNavigateDetails): void {
  void ensureTabSpoofed(details.tabId, details.url);
}

/**
 * A top-level navigation committed: re-apply for the URL that actually
 * committed. `onBeforeNavigate` fires once per navigation with the first URL,
 * so after a cross-site redirect the tab would otherwise keep the pre-redirect
 * URL's zone.
 */
function onCommitted(details: ChromeWebNavigation.OnCommittedDetails): void {
  void ensureTabSpoofed(details.tabId, details.url);
}

/**
 * A top-level navigation failed or became a download / 204, so the page that
 * was showing stays. `onBeforeNavigate` already switched the tab to the
 * abandoned URL's zone; switch it back to the page's.
 */
function onErrorOccurred(details: ChromeWebNavigation.OnErrorOccurredDetails): void {
  void browser.tabs.get(details.tabId).then(
    (tab) => ensureTabSpoofed(details.tabId, tab.url),
    () => undefined // the tab closed
  );
}

/**
 * Fallback attach path used only when `onBeforeNavigate` isn't bound (i.e. the
 * `webNavigation` permission hasn't been granted). Later than onBeforeNavigate,
 * so a brand-new tab's first page can briefly race, but once attached the
 * override persists.
 */
function onTabUpdated(
  tabId: number,
  changeInfo: Tabs.OnUpdatedChangeInfoType,
  tab: Tabs.Tab
): void {
  if (webNavRegistered) return; // onBeforeNavigate is handling early attach
  if (changeInfo.status !== "loading") return;
  void ensureTabSpoofed(tabId, tab.url);
}

/**
 * Bind `onBeforeNavigate` if the `webNavigation` permission is held and we
 * haven't already. Idempotent. Called at install time AND from
 * `permissions.onAdded`, because the permission is optional and is typically
 * granted at runtime (when the user enables debugger mode) — after the SW has
 * already started. Without the runtime path the listener would stay unbound
 * until the next SW respawn, silently leaving the cold-start race open.
 */
function registerWebNavigationListener(): void {
  if (webNavRegistered) return;
  const nav = chrome.webNavigation;
  if (nav?.onBeforeNavigate) {
    nav.onBeforeNavigate.addListener(onTopFrame(onBeforeNavigate));
    nav.onCommitted?.addListener(onTopFrame(onCommitted));
    nav.onErrorOccurred?.addListener(onTopFrame(onErrorOccurred));
    webNavRegistered = true;
    logger.debug("[debugger] webNavigation listeners bound");
  }
}

/** Minimal shape of `browser.permissions.onAdded` (absent from the FF polyfill types we use). */
interface PermissionsOnAdded {
  onAdded?: { addListener: (cb: (p: { permissions?: string[] }) => void) => void };
}

/**
 * Register the debugger-spoofing listeners at the top level so they survive MV3
 * service-worker respawns. Idempotent within a worker lifetime; safe to call on
 * every (re)spawn. No-op on non-Chromium builds.
 */
export function installDebuggerWatchers(): void {
  if (!__CHROMIUM__) return;
  if (watchersInstalled) return;
  watchersInstalled = true;

  if (chrome.debugger) {
    chrome.debugger.onDetach.addListener(onDebuggerDetach);
    // Child sessions for cross-site iframes (Target.attachedToTarget / detachedFromTarget).
    chrome.debugger.onEvent.addListener(
      createDebuggerEventHandler({ dbg: chrome.debugger, tracker, zoneForTab })
    );
  }

  // Bind onBeforeNavigate now if webNavigation is already granted (e.g. on a SW
  // respawn after the user opted in on a previous run).
  registerWebNavigationListener();

  // …and bind it the instant webNavigation is granted at runtime, so enabling
  // debugger mode takes full effect without waiting for a SW restart.
  const perms = (browser as unknown as { permissions?: PermissionsOnAdded }).permissions;
  perms?.onAdded?.addListener((p) => {
    if (p?.permissions?.includes("webNavigation")) registerWebNavigationListener();
  });

  // Always register the fallback; it self-gates via `webNavRegistered`.
  browser.tabs.onUpdated.addListener(onTabUpdated);
}
