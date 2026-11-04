/**
 * Shared VPN re-sync gate.
 *
 * Several independent "the network might have just changed" triggers funnel
 * into this one place:
 *   - `proxy.settings.onChange`  (proxy-watcher.ts)  — proxy-API VPNs
 *   - tab navigation / idle→active (activity-watcher.ts) — everything else,
 *     including Firefox onRequest VPNs and OS/desktop VPNs that no browser
 *     event can observe.
 *
 * Centralizing the gate means every trigger shares:
 *   1. one debounce window (coalesces bursts, and lets a VPN exit-node switch
 *      settle before we look),
 *   2. one steady-state minimum-interval floor (so a chatty trigger — rapid
 *      navigation, or a misbehaving VPN — can't drive the rate-limited
 *      IP-detection dependency into block territory),
 *   3. one in-flight guard (overlapping triggers can't race), and
 *   4. one IP-diff check, so the (relatively expensive, rate-limited)
 *      geolocation + apply step only runs when the exit IP actually moved.
 *
 * There is deliberately no interval timer here: an idle browser does zero work.
 * A stale spoofed location only matters when a page reads geolocation, which
 * only happens while the browser is active — which is exactly when the activity
 * triggers fire.
 */

import { createLogger } from "@/shared/utils/debug-logger";
import { loadSettings } from "./settings";
import {
  syncVpnLocation,
  detectPublicIp,
  getLastSyncedIp,
  clearEndpointCooldowns,
} from "./vpn-sync";
import { handleSetLocation } from "./messages";
import { looksRateLimited } from "./endpoint-cooldown";

const logger = createLogger("BG");

/**
 * Debounce window. Coalesces a burst of triggers (e.g. the several
 * `proxy.settings` writes a single reconnect produces, or the flurry of
 * tab-update events on a page load) into one check. Also gives a VPN exit-node
 * switch a moment to settle before we sample the IP.
 *
 * This is burst-coalescing only, NOT the rate-limit guard (that's
 * `MIN_CHECK_INTERVAL_MS`) — so it's kept short to minimize the delay between a
 * navigation and the spoofed location updating.
 */
const RESYNC_DEBOUNCE_MS = 1500;

/**
 * Steady-state floor between two checks, shared across every trigger source.
 * This throttles the (effectively unlimited) ipify IP-detection call so a
 * chatty trigger can't spam it. The rate-limited geolocation services are
 * protected separately by the IP-diff gate + 30-day cache (they only fire on an
 * actual exit-IP change), so this floor can stay relatively low without
 * exposing them.
 */
const MIN_CHECK_INTERVAL_MS = 10000;

/**
 * Switch-gap guard. When a check sees a *changed* exit IP, we re-detect after
 * this delay and require the same value twice before applying. During a VPN
 * exit-node switch the real ISP IP can briefly surface (the kill-switch window —
 * observed in the field as the real IP flashing between VPN IPs); requiring the
 * new IP to hold steady prevents us from ever syncing the user's spoofed
 * location to their real location mid-switch.
 */
const SWITCH_SETTLE_MS = 2500;

/**
 * Circuit breaker. The per-endpoint cooldowns in vpn-sync.ts already absorb a
 * single IP-echo provider or geo service throttling us (they're dropped from
 * the failover/race for a minute and the siblings carry the sync). This breaker
 * is the last line: it only trips on a *total* failure — every IP-echo provider
 * rate-limited (429/403), or a sync that comes back `IP_BLOCKED` (every geo
 * service rejecting this exit IP). In that case we pause the *automatic* path
 * briefly so chatty activity/proxy triggers don't keep re-running the full
 * detect+geo cycle. Kept short (1 min) because it's IP-specific: a VPN switch
 * to a fresh exit IP should resume syncing quickly. (Manual "Sync with VPN" and
 * startup sync go through vpn-sync directly and bypass this gate entirely —
 * they're user-initiated and low-frequency.)
 */
const RATE_LIMIT_BACKOFF_MS = 60 * 1000; // 1 minute

let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _lastCheckAt = 0;
/** Epoch ms until which automatic checks are suspended after a rate-limit/block. */
let _backoffUntil = 0;
/** Serializes overlapping checks so a second trigger mid-check can't race. */
let _checkInFlight: Promise<void> | null = null;

/**
 * Request a re-sync check. Safe to call as often as you like — calls are
 * debounced and rate-limited. `reason` is used only for logging.
 */
export function triggerResyncCheck(reason: string): void {
  logger.debug("[RESYNC] Trigger:", reason);
  if (_debounceTimer !== null) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    void runCheck();
  }, RESYNC_DEBOUNCE_MS);
}

function runCheck(): Promise<void> {
  if (_checkInFlight !== null) {
    logger.debug("[RESYNC] Check already in flight; skipping re-entrant run");
    return _checkInFlight;
  }
  _checkInFlight = doCheck().finally(() => {
    _checkInFlight = null;
  });
  return _checkInFlight;
}

async function doCheck(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.vpnSyncEnabled) {
    logger.debug("[RESYNC] VPN sync not enabled; ignoring trigger");
    return;
  }

  // Safari only: automatic background sync is a Pro feature on iOS. The iOS app
  // sets autoSyncBlocked=true when the user isn't entitled (non-Pro, or the
  // "Automatic Background Sync" toggle is off). Fail-open — defaults false, so
  // macOS Safari / Chrome / Firefox / Android Firefox are never affected and a
  // Pro subscriber is never wrongly blocked. (__SAFARI__ can't tell iOS from
  // macOS at build time, so the iOS-vs-macOS distinction comes from the app.)
  if (__SAFARI__ && settings.autoSyncBlocked) {
    logger.debug("[RESYNC] Automatic sync blocked by app (non-Pro iOS); ignoring trigger");
    return;
  }

  const now = Date.now();
  if (now < _backoffUntil) {
    logger.debug(
      "[RESYNC] In rate-limit backoff for another",
      Math.round((_backoffUntil - now) / 1000),
      "s; skipping check"
    );
    return;
  }

  const sinceLast = now - _lastCheckAt;
  if (_lastCheckAt !== 0 && sinceLast < MIN_CHECK_INTERVAL_MS) {
    logger.debug(
      "[RESYNC] Skipping — only",
      sinceLast,
      "ms since last check (min",
      MIN_CHECK_INTERVAL_MS + "ms)"
    );
    return;
  }
  _lastCheckAt = now;

  let currentIp: string;
  try {
    currentIp = await detectPublicIp();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A 429/403 from the IP-detection endpoint means we're being rate-limited /
    // blocked — back off the automatic path so we don't keep hammering it.
    if (looksRateLimited(message)) {
      _backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
      logger.warn(
        "[RESYNC] IP detection rate-limited/blocked; backing off automatic checks for",
        RATE_LIMIT_BACKOFF_MS / 1000,
        "s"
      );
      return;
    }
    // Transient failure right after a switch (kill-switch window) is expected;
    // the next trigger will retry. Don't escalate.
    logger.debug("[RESYNC] IP detection failed (VPN may be mid-switch):", message);
    return;
  }

  const lastIp = await getLastSyncedIp();
  if (lastIp !== undefined && lastIp === currentIp) {
    logger.debug("[RESYNC] Exit IP unchanged (", currentIp, "); no re-sync needed");
    return;
  }

  // Switch-gap guard: require the changed IP to hold steady across a short
  // settle window before spending a geolocation call and moving the location.
  await new Promise((resolve) => setTimeout(resolve, SWITCH_SETTLE_MS));
  let confirmIp: string;
  try {
    confirmIp = await detectPublicIp();
  } catch (error) {
    logger.debug(
      "[RESYNC] Confirmation IP detection failed; deferring re-sync:",
      error instanceof Error ? error.message : String(error)
    );
    return;
  }
  if (confirmIp !== currentIp) {
    logger.debug(
      "[RESYNC] Exit IP still settling (",
      currentIp,
      "→",
      confirmIp,
      "); deferring re-sync to a later trigger"
    );
    return;
  }

  logger.info(
    "[RESYNC] Exit IP changed (",
    lastIp ?? "none",
    "→",
    confirmIp,
    ") — re-syncing location"
  );

  // The exit IP genuinely changed — clear per-endpoint cooldowns so every
  // geo provider gets a fresh shot (same behavior as manual sync). This is
  // safe because we only reach here on a *confirmed* IP change (not on
  // every trigger), so the rate of actual geolocation requests stays low.
  clearEndpointCooldowns();

  // forceRefresh so we re-detect rather than serve a stale in-flight promise.
  // The 30-day persistent IP→geo cache still makes a previously-seen exit IP
  // resolve without a fresh geolocation request.
  const result = await syncVpnLocation(true);
  if ("error" in result) {
    // If the sync was blocked/rate-limited, back off the automatic path too.
    if (result.error === "IP_BLOCKED" || looksRateLimited(result.message)) {
      _backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
      logger.warn(
        "[RESYNC] Re-sync blocked/rate-limited; backing off automatic checks for",
        RATE_LIMIT_BACKOFF_MS / 1000,
        "s"
      );
      return;
    }
    logger.warn("[RESYNC] Re-sync failed:", result.error, result.message);
    return;
  }

  // onlyWhileVpnSync re-checks vpnSyncEnabled inside the write, so a manual
  // location or a Disable made during the calls above is kept. The check at the
  // top stays as a cheap pre-check.
  const wrote = await handleSetLocation(
    { latitude: result.latitude, longitude: result.longitude },
    {
      fromVpnSync: true,
      onlyWhileVpnSync: true,
      timezoneHint: result.timezone,
      locationName: {
        city: result.city,
        country: result.country,
        displayName:
          result.city && result.country
            ? `${result.city}, ${result.country}`
            : result.city ||
              result.country ||
              `${result.latitude.toFixed(5)}, ${result.longitude.toFixed(5)}`,
      },
    }
  );
  if (wrote) {
    logger.info("[RESYNC] Location re-synced to", result.city || confirmIp);
  }
}

// Exported for testing
export { RESYNC_DEBOUNCE_MS, MIN_CHECK_INTERVAL_MS, SWITCH_SETTLE_MS, RATE_LIMIT_BACKOFF_MS };

/**
 * Reset internal gate state (for testing only).
 */
export function _resetResyncCoreState(): void {
  if (_debounceTimer !== null) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  _lastCheckAt = 0;
  _backoffUntil = 0;
  _checkInFlight = null;
}
