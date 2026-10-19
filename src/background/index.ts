/**
 * Background Script — Entry Point
 * Wires up initialization, event listeners, and re-exports all modules.
 *
 * MV3 event-page lifecycle: all listeners registered synchronously at the
 * top level; initialization runs inside onInstalled / onStartup callbacks.
 * Timer-based retry logic uses browser.alarms instead of setTimeout.
 */

import type { Runtime, Tabs, Alarms } from "webextension-polyfill";
import type { Message } from "@/shared/types/messages";
import { loadSettings, saveSettings } from "./settings";
import { setDebugEnabled, setVerbosityLevel, createLogger } from "@/shared/utils/debug-logger";
import { now } from "@/shared/utils/safe-time";
import { setWebRTCProtection } from "./webrtc";
import { updateBadge, setBadgeForTab, badgeStateFor } from "./badge";
import {
  broadcastSettingsToTabs,
  sendSettingsToTab,
  isRestrictedUrl,
  checkTabInjection,
} from "./tabs";
import { computeEffectiveEnabled } from "@/shared/utils/scope";
import { computeEffectiveLocationPrecision } from "@/shared/precision/offset";
import { isTimeCadence, validatePrecisionCadence } from "@/shared/precision/cadence";
import { installAcceptLanguageRewriter, updateAcceptLanguageSettings } from "./accept-language";
import { handleMessage, handleSetLocation } from "./messages";
import { syncVpnLocation } from "./vpn-sync";
import { installProxyWatcher } from "./proxy-watcher";
import { installActivityWatcher } from "./activity-watcher";
import { adoptPendingSettingsFromApp } from "./app-bridge";
import { removeLegacyMainWorldRegistration } from "./legacy-main-world-cleanup";
import { updateBootstrapRegistration } from "./bootstrap-register";
import {
  PRECISION_ROLLOVER_ALARM,
  advanceHeldBucketToClock,
  ensurePrecisionRollover,
  reschedulePrecisionRollover,
} from "./precision-cadence";
import { buildPagePayload } from "./page-payload";
import { installDebuggerWatchers, syncDebuggerSpoofing, ensureTabSpoofed } from "./debugger-spoof";
import {
  installWorkerRequestFilter,
  updateWorkerFilterSettings,
  isWorkerFilterSupported,
} from "./worker-request-filter";

const logger = createLogger("BG");

// Record the moment the background script first evaluates. Used to
// correlate content-script request timestamps with background-worker
// boot timestamps during cold-start diagnostics — when the worker was
// asleep, this log line appears just before `onMessage` fires for the
// first time; when the worker was warm, the log is absent from the
// run entirely. Routed through the logger so it's only visible when
// debug logging is enabled.
const BG_BOOT_AT = now();
logger.debug(`Background script loading (t=${BG_BOOT_AT.toFixed(1)}ms since worker start)`);

// Restore logger verbosity synchronously on EVERY background spawn.
//
// The logger's `_enabled` / `_level` flags are module-level state that resets
// to defaults (disabled / INFO) every time the MV3 background is torn down and
// respawned. `initialize()` restores them — but it only runs from
// onInstalled / onStartup, which do NOT fire on the ordinary event-driven
// respawns (an incoming message, a webRequest, an alarm). On those respawns
// the background would run with logging silently off until something happened
// to call initialize() again, so BG info/debug lines never appeared in the
// console even with debug mode enabled in settings.
//
// Kicking the restore off here, at the top level, means it runs on every
// spawn. There's a small async window before storage resolves (a handful of
// early log lines on a cold wake may still be suppressed), but from that point
// on BG logging honours the persisted setting. initialize() still calls these
// too, which is harmless (idempotent).
void loadSettings()
  .then((s) => {
    setDebugEnabled(s.debugLogging);
    setVerbosityLevel(s.verbosityLevel);
    // Location-precision cadence: on every spawn, make sure an hour/day
    // rollover alarm exists. An existing one that's well overdue (missed during
    // sleep, or stuck) is run here, and its reschedule replaces it. Neither
    // promise rejects. No-op under never/session.
    void ensurePrecisionRollover(s, loadSettings).then((overdue) => {
      if (overdue) void onPrecisionRolloverAlarm();
    });
  })
  .catch(() => {
    /* storage unavailable this early — initialize() will restore later */
  });

// Re-export everything so `import("@/background")` keeps working for tests
export { DEFAULT_SETTINGS } from "@/shared/types/settings";
export { isValidIANATimezone } from "@/shared/utils/type-guards";
export {
  loadSettings,
  saveSettings,
  getSettings,
  updateSettings,
  validateSettings,
} from "./settings";
export {
  geocodeQuery,
  reverseGeocode,
  fetchWithRetry,
  getCacheKey,
  GEOCODING_TIMEOUT,
  MAX_RETRIES,
} from "./geocoding";
export { getTimezoneForCoordinates, clearTimezoneCache, computeOffsets } from "./timezone";
export { setWebRTCProtection } from "./webrtc";
export { updateBadge, setBadgeForTab, badgeStateFor } from "./badge";
export type { BadgeState } from "./badge";
export { broadcastSettingsToTabs, isRestrictedUrl, checkTabInjection } from "./tabs";
export {
  handleMessage,
  handleSetLocation,
  handleSetProtectionStatus,
  handleSetWebRTCProtection,
  handleCompleteOnboarding,
  handleSetScopeMode,
  handleAddScopeSite,
  handleRemoveScopeSite,
} from "./messages";
export {
  isValidIpAddress,
  detectPublicIp,
  syncVpnLocation,
  clearIpGeoCache,
  clearEndpointCooldowns,
  resetRateLimiter,
  getLastSyncedIp,
  setLastSyncedIp,
  MIN_REQUEST_INTERVAL,
  REQUEST_TIMEOUT,
  GEO_TIMEOUT,
} from "./vpn-sync";
export type { IpGeolocationResult, VpnSyncError, VpnSyncResponse } from "./vpn-sync";
export {
  installProxyWatcher,
  isProxyWatcherSupported,
  PROXY_CHANGE_DEBOUNCE_MS,
  MIN_CHECK_INTERVAL_MS,
  _resetProxyWatcherState,
} from "./proxy-watcher";
export {
  installActivityWatcher,
  isActivityWatcherSupported,
  _resetActivityWatcherState,
} from "./activity-watcher";
export {
  triggerResyncCheck,
  RESYNC_DEBOUNCE_MS,
  SWITCH_SETTLE_MS,
  _resetResyncCoreState,
} from "./resync-core";

// --- Alarm constants ---

/** Prefix for injection-check alarm names */
const ALARM_PREFIX = "injection-check:";

/** Cumulative delays (ms) for injection check retries */
const ALARM_DELAYS = [500, 1500, 3500];

/** Maximum attempt index (0-based) */
const MAX_ATTEMPT = ALARM_DELAYS.length - 1;

export { ALARM_PREFIX, ALARM_DELAYS, MAX_ATTEMPT };

// --- Alarm helpers ---

/**
 * Build an alarm name encoding tab ID and attempt number.
 */
export function buildAlarmName(tabId: number, attempt: number): string {
  return `${ALARM_PREFIX}${tabId}:${attempt}`;
}

/**
 * Parse an injection-check alarm name. Returns null if the name doesn't match.
 */
export function parseAlarmName(name: string): { tabId: number; attempt: number } | null {
  if (!name.startsWith(ALARM_PREFIX)) return null;
  const rest = name.slice(ALARM_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length !== 2) return null;
  const tabId = parseInt(parts[0], 10);
  const attempt = parseInt(parts[1], 10);
  if (isNaN(tabId) || isNaN(attempt)) return null;
  return { tabId, attempt };
}

/**
 * Clear all pending injection-check alarms for a given tab.
 */
async function clearAlarmsForTab(tabId: number): Promise<void> {
  for (let i = 0; i <= MAX_ATTEMPT; i++) {
    try {
      await browser.alarms.clear(buildAlarmName(tabId, i));
    } catch {
      // Alarm may not exist; ignore
    }
  }
}

export { clearAlarmsForTab };

// --- Initialization ---

async function initialize(): Promise<void> {
  // Safari only: adopt any location the containing app queued in the shared
  // App Group first, so a location set in the app takes effect as soon as
  // Safari launches — no popup interaction needed. Done before loadSettings so
  // the rest of init broadcasts the adopted state.
  await adoptPendingSettingsFromApp();

  const settings = await loadSettings();

  // One-time migration persistence (Req 13.2, 13.6, and the site-scoping
  // Req 3.9 failure semantics). loadSettings() returns the validated/upgraded
  // in-memory Settings but does not itself write. To satisfy Req 13.6 we detect
  // whether the stored object was on an older/absent schema by reading the raw
  // stored `version` (the value before validation): a present settings object
  // whose version is not "1.2" was migrated to "1.2" by validateSettings(). When
  // that is the case we persist the upgraded object exactly once. A fresh
  // install with no stored settings object is skipped, so we never needlessly
  // write on first run. If persistence fails we keep the in-memory upgraded
  // Settings for the session and surface the error rather than crashing init;
  // the next successful save persists the migration.
  try {
    const stored = await browser.storage.local.get("settings");
    const rawSettings: unknown = stored.settings;
    const migrationOccurred =
      rawSettings != null &&
      typeof rawSettings === "object" &&
      (rawSettings as { version?: unknown }).version !== "1.2";
    if (migrationOccurred) {
      try {
        await saveSettings(settings);
      } catch (error) {
        logger.error("Failed to persist migrated settings on startup:", error);
      }
    }
  } catch (error) {
    logger.error("Failed to check stored settings for migration persistence:", error);
  }

  // Restore logger state from persisted settings
  setDebugEnabled(settings.debugLogging);
  setVerbosityLevel(settings.verbosityLevel);

  // Firefox: (re-)register the document_start bootstrap user script from the
  // persisted settings so the synchronous-timezone cold-start race is closed
  // on the very next navigation, even when nothing has changed this session
  // (registrations may not survive a browser restart). No-op elsewhere.
  if (__FIREFOX__) {
    await updateBootstrapRegistration(settings);
  }

  // Prime the worker-request-filter cache and install the listener
  // on engines that support webRequest.filterResponseData (Firefox
  // only). The listener itself short-circuits based on whether
  // spoofing is enabled and a timezone is configured, so the install
  // itself is unconditional on Firefox.
  updateWorkerFilterSettings(settings);
  await installWorkerRequestFilter();
  logger.debug(`[init] worker-request-filter support: ${isWorkerFilterSupported() ? "yes" : "no"}`);

  // Prime the Accept-Language snapshot and (on Chromium/Safari) install the DNR
  // rule, so the header is aligned from the first request after a cold start
  // rather than only after the next settings change.
  updateAcceptLanguageSettings(settings);

  if (settings.webrtcProtection) {
    try {
      await setWebRTCProtection(true);
    } catch (error) {
      logger.error("Failed to apply WebRTC protection on startup:", error);
    }
  }

  if (settings.enabled && settings.location) {
    await broadcastSettingsToTabs(settings);
  }

  // Reconcile browser-level (chrome.debugger) spoofing with the persisted
  // settings: when debugger mode + protection are on, attach to existing tabs
  // and apply the CDP overrides. No-op on non-Chromium / when the mode is off.
  await syncDebuggerSpoofing(settings);

  await updateBadge();

  // Auto-sync VPN location on startup if enabled. On Safari this is gated by
  // the app's autoSyncBlocked signal — startup re-sync is "automatic", so it's
  // Pro-only on iOS (fail-open; macOS/Chrome/Firefox unaffected).
  if (settings.vpnSyncEnabled && !(__SAFARI__ && settings.autoSyncBlocked)) {
    try {
      const result = await syncVpnLocation(false);
      if (!("error" in result)) {
        await handleSetLocation(
          { latitude: result.latitude, longitude: result.longitude },
          { fromVpnSync: true, timezoneHint: result.timezone }
        );
      }
    } catch (error) {
      logger.warn("VPN auto-sync on startup failed:", error);
    }
  }

  // NOTE: the proxy-change and activity-driven resync watchers are installed
  // at the TOP LEVEL of this module (see installResyncWatchers() below), NOT
  // here. initialize() only runs from onInstalled/onStartup, but on a
  // non-persistent MV3 background (Firefox event page, Chromium service worker)
  // the background is torn down when idle and respawned by ordinary events
  // (e.g. an incoming message) without firing onStartup — so anything wired up
  // only inside initialize() is lost on the first respawn. Persistent wake
  // listeners must also be registered synchronously during the top-level run.
  // Installing the watchers at top level satisfies both. The install functions
  // are idempotent, so there's no harm if initialize() runs afterward.
}

/**
 * Install the VPN-resync watchers. Called synchronously at the top level (not
 * from initialize()) so the listeners survive MV3 background respawns and are
 * registered as persistent wake listeners on every engine.
 *
 * - proxy-change watcher: a browser-based VPN (e.g. the Proton VPN extension)
 *   switching exit nodes mutates `proxy.settings`, firing an event-driven
 *   re-sync. Feature-detects the proxy API and no-ops where unavailable
 *   (Safari, Firefox Android).
 * - activity-driven watcher (tab navigation + idle→active): covers the VPN
 *   classes the proxy watcher can't see — Firefox onRequest VPNs and OS/desktop
 *   VPNs — by re-checking the exit IP on real browser activity.
 *
 * Both watchers feed the same debounced, rate-limited, IP-diff gate, so they
 * coalesce rather than double up, and both self-gate on `vpnSyncEnabled` at
 * fire time. Both install functions are idempotent.
 */
function installResyncWatchers(): void {
  installProxyWatcher();
  installActivityWatcher();
}

export { installResyncWatchers };

// Register the resync watchers synchronously at module load. This top-level
// call runs on every background (re)spawn — including the message-driven
// respawns where onStartup/onInstalled (and therefore initialize()) never
// fire — which is what keeps the VPN auto-resync alive across the event-page /
// service-worker lifecycle.
installResyncWatchers();

// Register the browser-level (chrome.debugger) spoofing listeners synchronously
// at module load, for the same MV3 reason as the resync watchers above: the
// onBeforeNavigate / tabs.onUpdated / debugger.onDetach handlers must be bound
// on every service-worker (re)spawn to survive idle teardown. Idempotent and
// compiled out on non-Chromium builds.
installDebuggerWatchers();

// Register the worker-request-filter webRequest listeners synchronously at
// module load, for the same reason. These listeners must exist before the
// first worker-script request so Firefox can wake the background and attach
// the response filter; if they were only installed inside initialize() they'd
// be lost on the first idle respawn and URL-based worker patching would
// silently stop (the symptom: ANNOUNCE_WORKER_FETCH still arrives but no
// `[worker-filter] attach filter` ever logs). The function is idempotent, so
// the initialize() call is a harmless no-op after this. Fire-and-forget — the
// listeners register synchronously inside before any await.
void installWorkerRequestFilter();

// Same reasoning as the worker filter above: register the blocking
// Accept-Language listener at top level so it survives an idle respawn of the
// background script. Idempotent, and a no-op on non-Firefox engines (which use
// the declarativeNetRequest path instead).
installAcceptLanguageRewriter();

// Safari 18+ injects the page engine only through the static manifest. Remove
// the persisted dynamic registration left by the previous compatibility path
// before it can continue double-installing the same overrides after an update.
// This is cleanup only: it never registers or executes a content script.
if (__SAFARI__) void removeLegacyMainWorldRegistration();

export { initialize };

// --- Alarm handler ---

/**
 * Best-effort per-tab action-badge write for the injection-check alarm path
 * (the green "✓" / orange "!" states, which aren't part of the scope-based
 * BadgeState in badge.ts). Feature-detects the action API and swallows any
 * rejection so a closed tab — or a mobile engine without a toolbar to host a
 * per-tab badge, e.g. Chromium-based Android browsers like Quetta — can't leak
 * an "Uncaught (in promise) No tab with id ..." rejection that wedges the
 * background worker.
 */
function setActionBadge(tabId: number, color: string, text: string): void {
  const action = browser.action;
  if (!action?.setBadgeText) {
    return;
  }
  const swallow = (error: unknown): void => {
    logger.debug(`Badge update skipped for tab ${tabId}:`, error);
  };
  void action.setBadgeBackgroundColor({ color, tabId }).catch(swallow);
  void action.setBadgeText({ text, tabId }).catch(swallow);
}

async function onAlarm(alarm: Alarms.Alarm): Promise<void> {
  const parsed = parseAlarmName(alarm.name);
  if (!parsed) return;

  const { tabId, attempt } = parsed;

  const settings = await loadSettings();

  try {
    const result = await checkTabInjection(tabId);
    if (result.injected) {
      // Clear remaining alarms for this tab
      await clearAlarmsForTab(tabId);

      // Resolve the per-tab Effective_Enabled for this late-injected tab from
      // its top-level URL via the shared source of truth (Req 7.5, 8.4, 9.3),
      // instead of delivering the global `enabled`. The alarm carries only the
      // tab id, so look up the tab's current URL; if the tab can't be resolved
      // the URL is undefined and computeEffectiveEnabled returns false.
      let tabUrl: string | undefined;
      try {
        const tab = await browser.tabs.get(tabId);
        tabUrl = tab.url;
      } catch {
        tabUrl = undefined;
      }
      // Built by the shared page-payload module, never inline here. Duplicated
      // builders once delivered the raw precision anchor on this path (a user
      // who enabled approximate location still got their EXACT coordinates),
      // and a consumer someone forgot to update is the likeliest bug for any
      // per-tab feature, so every page-bound payload goes through
      // `page-payload.ts`.
      const scopedPayload = await buildPagePayload(settings, tabUrl);

      try {
        await browser.tabs.sendMessage(tabId, {
          type: "UPDATE_SETTINGS",
          payload: scopedPayload,
        });
      } catch {
        // Tab may have closed; ignore
      }

      setActionBadge(tabId, "green", "✓");
    } else if (attempt >= MAX_ATTEMPT) {
      // Final attempt failed
      setActionBadge(tabId, "orange", "!");
    }
  } catch {
    // Tab closed during check
    if (attempt >= MAX_ATTEMPT) {
      setActionBadge(tabId, "orange", "!");
    }
  }
}

export { onAlarm };

/**
 * Location-precision cadence rollover (the `precision-rollover` alarm, or a
 * spawn that finds that alarm well overdue). Under an hour/day cadence, moves
 * the held bucket to the clock's and, when it changed, pushes the new point to
 * every tab and the Firefox bootstrap. Always reschedules the next alarm.
 *
 * The handler never rejects, so both `void` call sites (the alarm listener and
 * the spawn check) are total: `loadSettings` returns defaults on a failed read,
 * `advanceHeldBucketToClock` reaches only never-rejecting storage helpers,
 * `Promise.allSettled` absorbs a push failure, and the reschedule job catches.
 */
export async function onPrecisionRolloverAlarm(): Promise<void> {
  const initial = await loadSettings();
  const c = validatePrecisionCadence(initial.precisionCadence);
  if (isTimeCadence(c)) {
    const changed = await advanceHeldBucketToClock(c, initial.precisionSeed);
    // Re-read AFTER the last await: a save (SET_LOCATION, VPN resync,
    // SET_PRECISION…) that completed during the advance has already pushed; a
    // stale snapshot here would revert tabs and the bootstrap.
    const settings = await loadSettings();
    const effective = computeEffectiveLocationPrecision(
      settings.locationPrecision,
      settings.proFeaturesBlocked
    );
    // Protection off, no location, or effective Exact: the payload wouldn't
    // change, so skip the push. The held bucket still advanced, so turning
    // protection on or switching to Approximate later delivers the current one.
    if (changed && settings.enabled && settings.location && effective.mode === "approximate") {
      // allSettled, not all: wait for both pushes to finish even when one
      // fails, so the reschedule below runs after them. broadcastSettingsToTabs
      // can reject (tabs.query); the bootstrap registration never does.
      const results = await Promise.allSettled([
        updateBootstrapRegistration(settings),
        broadcastSettingsToTabs(settings),
      ]);
      for (const r of results) {
        if (r.status === "rejected") {
          logger.warn("[cadence] rollover push failed:", r.reason as unknown);
        }
      }
    }
  }
  // Unconditional: the fired one-shot alarm is gone. Under a non-time cadence
  // this clears a stray alarm. The job reads settings when it runs, so a cadence
  // save that lands during this handler can't leave an alarm for the old one.
  await reschedulePrecisionRollover(loadSettings);
}

// --- Event Listeners (registered synchronously at top level) ---

browser.runtime.onMessage.addListener((message: Message, sender: Runtime.MessageSender) => {
  // Timing probe to diagnose cold-start latency. Logs the gap between
  // worker boot and message arrival so we can tell if the delay users
  // see on "Settings not received in time" is the worker waking up,
  // the handler running, or the round-trip reply.
  const t0 = now();
  logger.debug(
    `onMessage fired (type=${message.type}, since-boot=${(t0 - BG_BOOT_AT).toFixed(1)}ms)`
  );
  const result = handleMessage(message, sender);
  // `handleMessage` always returns a Promise (it's an async function).
  // Attach a passive probe to log when the handler actually settles
  // so we can correlate handler-time with round-trip time.
  void result.then(
    () => {
      logger.debug(
        `onMessage handler resolved (type=${message.type}, handler-time=${(now() - t0).toFixed(1)}ms)`
      );
    },
    (err: unknown) => {
      logger.debug(
        `onMessage handler rejected (type=${message.type}, handler-time=${(now() - t0).toFixed(1)}ms): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  );
  return result;
});

browser.runtime.onInstalled.addListener((details: Runtime.OnInstalledDetailsType) => {
  if (details.reason === "install") {
    logger.info("Extension installed - onboarding will be displayed");
  }
  void initialize();
});

browser.runtime.onStartup.addListener(() => {
  void initialize();
});

// Safari only: app → extension pending-location bridge.
// onStartup is unreliable on iOS Safari, so adopt on background boot AND on
// tab activation/navigation — i.e. whenever the user is actually browsing.
// adoptPendingSettingsFromApp() dedups by timestamp, so repeated calls no-op
// once a change has been applied.
if (__SAFARI__) {
  void adoptPendingSettingsFromApp();

  // NOTE: the VPN resync watchers are armed unconditionally at the top level
  // via installResyncWatchers() above, so they're alive on Safari too (where
  // onStartup is unreliable). No Safari-specific install is needed here.

  if (browser.tabs?.onActivated) {
    browser.tabs.onActivated.addListener(() => {
      void adoptPendingSettingsFromApp();
    });
  }

  if (browser.tabs?.onUpdated) {
    browser.tabs.onUpdated.addListener(
      (_tabId: number, changeInfo: Tabs.OnUpdatedChangeInfoType) => {
        if (changeInfo.status === "loading") {
          void adoptPendingSettingsFromApp();
        }
      }
    );
  }
}

browser.alarms.onAlarm.addListener((alarm: Alarms.Alarm) => {
  if (alarm.name === PRECISION_ROLLOVER_ALARM) {
    void onPrecisionRolloverAlarm();
    return;
  }
  void onAlarm(alarm);
});

// Firefox only: the synchronous-timezone cold-start fix relies on the
// `userScripts` API, which is an *optional-only* permission the user grants at
// runtime via the popup. React to grant/revoke so the document_start bootstrap
// script is (re)registered the instant the permission is added and torn down
// when it's removed — without needing the popup to round-trip a message.
if (__FIREFOX__ && browser.permissions) {
  const refreshBootstrap = (perms: { permissions?: string[] }): void => {
    if (!perms.permissions || !perms.permissions.includes("userScripts")) return;
    void (async () => {
      try {
        const settings = await loadSettings();
        await updateBootstrapRegistration(settings);
      } catch (error) {
        logger.warn("[bootstrap] failed to refresh registration on permission change:", error);
      }
    })();
  };
  browser.permissions.onAdded?.addListener(refreshBootstrap);
  browser.permissions.onRemoved?.addListener(refreshBootstrap);
}

if (browser.tabs && browser.tabs.onCreated) {
  browser.tabs.onCreated.addListener((tab: Tabs.Tab) => {
    // Session restore fires onCreated for EVERY restored tab, including the
    // discarded (unloaded) ones that populate tab groups. Those have no document
    // and no content script, so the push below cannot be received; bail before
    // loading settings and building a payload for each of them. A restored tab
    // configures itself through the manifest content script's own GET_SETTINGS
    // request, so nothing is missed. Mirrors the filter in
    // `broadcastSettingsToTabs` — see issue #75. Undefined (engine doesn't
    // report it) is falsy, so this fails open to the previous behaviour.
    if (tab.discarded) {
      return;
    }

    void (async () => {
      const settings = await loadSettings();

      setTimeout(() => {
        void (async () => {
          try {
            // Built at send time, not when the event fired, so a cadence
            // rollover inside the 100ms delay can't leave this tab on the
            // previous period's point. `enabled` is resolved from the new
            // tab's top-level URL (Req 8.4, 9.3); a missing URL resolves to
            // false.
            //
            // Built by the shared page-payload module, never inline here.
            // Duplicated builders once delivered the raw precision anchor on
            // this path, and a consumer someone forgot to update is the
            // likeliest bug for any per-tab feature, so every page-bound
            // payload goes through `page-payload.ts`.
            const scopedPayload = await buildPagePayload(settings, tab.url);
            await browser.tabs.sendMessage(tab.id!, {
              type: "UPDATE_SETTINGS",
              payload: scopedPayload,
            });
          } catch (error) {
            // Expected when the tab navigated, closed, or landed somewhere we
            // can't inject during the 100ms delay. TRACE keeps this from being
            // an O(tabs) console dump for every user; see `sendSettingsToTab`.
            logger.trace(`Could not send settings to new tab ${tab.id}:`, error);
          }
        })();
      }, 100);
    })();
  });
}

if (browser.tabs && browser.tabs.onUpdated) {
  browser.tabs.onUpdated.addListener(
    (tabId: number, changeInfo: Tabs.OnUpdatedChangeInfoType, tab: Tabs.Tab) => {
      // Same-document (History API pushState/replaceState) navigation: the
      // address-bar URL changes without a "loading" status, so the content
      // script is NOT reloaded and will not re-request settings. Push the
      // recomputed per-tab decision so path-scoped filtering turns on/off as the
      // user moves between in-scope and out-of-scope routes, and re-badge (Req
      // 8.1, 8.2, 9.3). Full navigations (status "loading") are handled below;
      // the fresh content script re-requests settings on load. No new
      // permission is used — this rides tabs.onUpdated (Req 8.6).
      if (changeInfo.url && changeInfo.status !== "loading") {
        void (async () => {
          const settings = await loadSettings();
          await sendSettingsToTab(tab, settings);

          const effectiveEnabled = computeEffectiveEnabled({
            masterEnabled: settings.enabled,
            scopeMode: settings.scopeMode,
            allowlist: settings.allowlist,
            denylist: settings.denylist,
            proFeaturesBlocked: settings.proFeaturesBlocked,
            topLevelUrl: tab.url,
            isRestricted: isRestrictedUrl,
          });
          setBadgeForTab(tabId, badgeStateFor(settings.enabled, effectiveEnabled));

          // Chromium debugger mode (CDP): a same-document navigation fires no
          // network request, so onBeforeNavigate never runs and the tab's
          // browser-level timezone override would go stale across a scope
          // boundary. Reconcile just this tab against the new URL — attach+apply
          // if now in scope, detach (clearing the override) if not — so path
          // scoping is consistent whether or not debugger mode is on (Req 11).
          // Compiled out on Firefox/Safari.
          if (__CHROMIUM__ && settings.debuggerModeEnabled) {
            await ensureTabSpoofed(tabId, tab.url);
          }
        })();
        return;
      }

      if (changeInfo.status === "loading") {
        void (async () => {
          const settings = await loadSettings();

          // Resolve the tab's Effective_Enabled from its top-level URL via the
          // shared source of truth, then map to the three-state badge (Req
          // 12.1–12.5). Restricted/out-of-scope URLs resolve to false inside
          // computeEffectiveEnabled and therefore show the out-of-scope badge.
          const effectiveEnabled = computeEffectiveEnabled({
            masterEnabled: settings.enabled,
            scopeMode: settings.scopeMode,
            allowlist: settings.allowlist,
            denylist: settings.denylist,
            proFeaturesBlocked: settings.proFeaturesBlocked,
            topLevelUrl: tab.url,
            isRestricted: isRestrictedUrl,
          });

          setBadgeForTab(tabId, badgeStateFor(settings.enabled, effectiveEnabled));

          // Nothing to verify when spoofing isn't effectively enabled for this
          // tab (master off, restricted, or out of scope), so skip scheduling
          // injection checks — this also avoids the alarm path overwriting the
          // out-of-scope/master-off badge with the active state.
          if (!effectiveEnabled) {
            return;
          }

          // Clear existing alarms for this tab (re-navigation cleanup)
          await clearAlarmsForTab(tabId);

          // Schedule injection checks via browser.alarms
          for (let i = 0; i < ALARM_DELAYS.length; i++) {
            try {
              void browser.alarms.create(buildAlarmName(tabId, i), {
                delayInMinutes: ALARM_DELAYS[i] / 60000,
              });
            } catch (error) {
              logger.trace(`Failed to create alarm for tab ${tabId} attempt ${i}:`, error);
            }
          }
        })();
      }
    }
  );
}
