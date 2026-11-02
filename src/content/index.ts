/**
 * Content Script
 * Injects override code into page context and manages settings.
 *
 * Communicates with the background script via browser.runtime messaging
 * and with the injected page-context script via CustomEvent (CSP-safe).
 */

import type { Location, Timezone, AccuracySetting } from "@/shared/types/settings";
import type { GetSettingsPayload, UpdateSettingsPayload } from "@/shared/types/messages";
import type { SpoofedLocalePayload } from "@/shared/locale/resolver";
import { createLogger, setDebugEnabled, setVerbosityLevel } from "@/shared/utils/debug-logger";
import { now } from "@/shared/utils/safe-time";

const logger = createLogger("CS");

// Settings received from background script
let spoofingEnabled = false;
let spoofedLocation: Location | null = null;
let timezoneOverride: Timezone | null = null;
/**
 * The user's chosen accuracy setting and per-install seed. Threaded
 * through from the background so the injected page-world script
 * resolves `GeolocationCoordinates.accuracy` from the user's choice
 * rather than always falling back to auto mode. Left undefined until
 * the first settings message arrives; the injected Resolver defaults
 * to auto / seed 0 in that window (same as before any settings land).
 */
let accuracySetting: AccuracySetting | undefined;
let accuracySeed: number | undefined;
let debugLogging = false;
let verbosityLevel = "INFO";
/**
 * Mirrors `Settings.webrtcProtection`. Forwarded into the injected
 * script via the CustomEvent so its RTCPeerConnection wrapper knows
 * whether to block ICE gathering. Defaults to false (no protection)
 * until settings arrive from the background — the injected script's
 * `waitForSettings()` path ensures no RTC call is intercepted before
 * the first settings event lands.
 */
let webrtcProtection = false;

/**
 * Mirrors `Settings.preserveGeolocationPrompt`. Forwarded into the injected
 * script via the CustomEvent so its geolocation/permissions overrides know
 * whether to surface the native permission prompt (and report the real
 * permission state) rather than auto-granting spoofed coords. Defaults to false.
 */
let preserveGeolocationPrompt = false;

/**
 * Mirrors the background-resolved Reported Language, or null when the real
 * locale should be reported. Forwarded to the injected script so its
 * `navigator` / `Intl` / `toLocale*` overrides know which tag to report. The
 * background does all the resolving, so this is already Pro-gated and already
 * checked against the engine's locale data.
 */
let spoofedLocale: SpoofedLocalePayload | null = null;

// Event name for settings updates (configurable for stealth)
const EVENT_NAME: string = process.env.EVENT_NAME || "__x_evt";

/**
 * Event name for worker-fetch announcements from the injected script.
 * Must match the `ANNOUNCE_EVENT_NAME` constant in
 * `src/content/injected/state.ts`.
 */
const ANNOUNCE_EVENT_NAME: string = (process.env.EVENT_NAME || "__x_evt") + "_announce";

// Listen for worker-fetch announcements from the injected (page-world)
// script and forward them to the background. The injected script can't
// call browser.runtime.sendMessage from MAIN world, so it dispatches a
// CustomEvent on window which we catch here and relay.
window.addEventListener(ANNOUNCE_EVENT_NAME, ((event: CustomEvent<{ url: string }>) => {
  const url = event.detail?.url;
  if (typeof url !== "string" || !url) return;
  // Fire-and-forget — don't await, don't fail the worker construction
  // if the background is slow to respond. If the message is lost the
  // worker will just not get the payload prepended, which degrades
  // gracefully to the pre-feature behaviour.
  void browser.runtime
    .sendMessage({ type: "ANNOUNCE_WORKER_FETCH", payload: { url } })
    .catch((err: unknown) => {
      logger.debug("Failed to forward ANNOUNCE_WORKER_FETCH:", err);
    });
}) as EventListener);

/** Data dispatched to the injected script via CustomEvent. */
interface SettingsEventDetail {
  enabled: boolean;
  /**
   * The spoofed location, widened to carry the optional accuracy
   * resolution inputs the injected Resolver reads off `location`
   * (see SpoofedLocation in src/content/injected/types.ts). When
   * spoofing has no location these fields are irrelevant and the
   * value is null.
   */
  location: (Location & { accuracySetting?: AccuracySetting; accuracySeed?: number }) | null;
  timezone: Timezone | null;
  debugLogging: boolean;
  verbosityLevel: string;
  webrtcProtection: boolean;
  preserveGeolocationPrompt: boolean;
  /** Resolved Reported Language, or null to leave the real locale alone. */
  locale: SpoofedLocalePayload | null;
}

/**
 * Declare Firefox-specific `cloneInto` helper that makes objects accessible
 * across content-script / page-context boundaries.
 */
declare function cloneInto<T>(obj: T, targetScope: typeof globalThis): T;

let firstDispatchDone = false;

/**
 * Retry offsets (ms) for the first real-settings dispatch.
 *
 * Both scripts run at document_start with no ordering guarantee, and
 * CustomEvents have no subscription backlog — if the content script
 * dispatches before the injected script has installed its listener
 * the event is lost. `dispatchEvent` into a window with no listener
 * succeeds silently (no exception), so the only way to cover the
 * race is to redispatch a few times.
 *
 * These retries are safe because they only start after the content
 * script has real settings from the background — every dispatch
 * sends the same values, so even if multiple retries all land on
 * a live listener, the injected script just re-applies the same
 * state each time.
 */
const INITIAL_DISPATCH_RETRIES_MS: ReadonlyArray<number> = [16, 50, 120];

/**
 * Build the fresh event detail from current module-scope settings.
 */
function buildSettingsEventDetail(): SettingsEventDetail {
  return {
    enabled: spoofingEnabled,
    location: spoofedLocation ? { ...spoofedLocation, accuracySetting, accuracySeed } : null,
    timezone: timezoneOverride,
    debugLogging,
    verbosityLevel,
    webrtcProtection,
    preserveGeolocationPrompt,
    locale: spoofedLocale,
  };
}

/**
 * Dispatch a single CustomEvent with the latest settings from module scope.
 */
function dispatchSettingsEvent(): void {
  const settingsData = buildSettingsEventDetail();
  // For Firefox, use cloneInto to make the object accessible in page context
  const detail = typeof cloneInto !== "undefined" ? cloneInto(settingsData, window) : settingsData;
  const event = new CustomEvent(EVENT_NAME, { detail });
  try {
    window.dispatchEvent(event);
  } catch (error) {
    logger.error("Failed to dispatch settings update:", error);
  }
}

/**
 * Dispatch current spoofing settings to the injected page-context script.
 *
 * On the first call (after GET_SETTINGS resolves), schedules a few
 * retries to cover the document_start race against the injected
 * script's listener installation. Subsequent calls (settings-change
 * events from the background) dispatch once because by then the
 * listener is definitely live.
 */
function updateInjectedScript(): void {
  const dispatchAt = now();
  dispatchSettingsEvent();
  if (!firstDispatchDone) {
    logger.debug(
      `First settings dispatched to injected script (t=${dispatchAt.toFixed(1)}ms, enabled=${String(spoofingEnabled)}, hasLocation=${String(!!spoofedLocation)})`
    );
    firstDispatchDone = true;
    // Retries for the document_start race. These send the same
    // values as the first call (module-scope state is only
    // mutated inside the GET_SETTINGS .then and the UPDATE_SETTINGS
    // handler — never between the first dispatch and its retries in
    // normal flow), so even if every retry lands on a live listener
    // the injected script just re-applies identical state.
    for (const delay of INITIAL_DISPATCH_RETRIES_MS) {
      setTimeout(() => {
        dispatchSettingsEvent();
      }, delay);
    }
  } else {
    logger.info("Dispatched settings to injected script:", buildSettingsEventDetail());
  }
}

// On both Firefox and Chromium, the injected script is loaded by the manifest
// as a content script with world: "MAIN" and run_at: "document_start", so it
// runs synchronously before any page scripts — no XHR injection needed.
// Firefox 128+ supports world: "MAIN"; our minimum is Firefox 140.
logger.info("Injected script loaded via manifest world:MAIN");

// NOTE: we deliberately do NOT call updateInjectedScript() here at
// module load. At this point our module-scope settings variables are
// still defaults (enabled=false, location=null, …) because we haven't
// yet asked the background for the real values. Dispatching those
// defaults would force the injected script to adopt an "off" state,
// and then moments later when the GET_SETTINGS response returns with
// real settings we'd dispatch a second time to correct it — producing
// a visible flicker of unspoofed behavior in between.
//
// Instead, we only dispatch once GET_SETTINGS resolves (below). The
// injected script's `waitForSettings()` path handles calls that
// arrive during this short window by deferring them until settings
// land, so nothing leaks.

/**
 * The page payload as it arrives, from a GET_SETTINGS reply or an
 * UPDATE_SETTINGS push. `applySettings` defaults the optional fields.
 */
interface ReceivedSettings {
  enabled: boolean;
  location: Location | null;
  timezone: Timezone | null;
  debugLogging: boolean;
  verbosityLevel: string;
  webrtcProtection?: boolean;
  preserveGeolocationPrompt?: boolean;
  accuracySetting?: AccuracySetting;
  accuracySeed?: number;
  locale?: SpoofedLocalePayload | null;
}

/** Copy a received payload into module scope. The caller dispatches it. */
function applySettings(settings: ReceivedSettings, logLabel: string): void {
  spoofingEnabled = settings.enabled;
  spoofedLocation = settings.location;
  timezoneOverride = settings.timezone;
  accuracySetting = settings.accuracySetting;
  accuracySeed = settings.accuracySeed;
  debugLogging = settings.debugLogging;
  verbosityLevel = settings.verbosityLevel ?? "INFO";
  webrtcProtection = settings.webrtcProtection ?? false;
  preserveGeolocationPrompt = settings.preserveGeolocationPrompt ?? false;
  spoofedLocale = settings.locale ?? null;
  setDebugEnabled(debugLogging);
  setVerbosityLevel(verbosityLevel);
  logger.debug(logLabel, {
    enabled: spoofingEnabled,
    location: spoofedLocation,
    timezone: timezoneOverride,
    debugLogging,
    verbosityLevel,
    webrtcProtection,
  });
}

// Listen for settings updates from background script
browser.runtime.onMessage.addListener(
  (message: { type: string; payload?: UpdateSettingsPayload }) => {
    logger.debug("Received message from background:", {
      type: message.type,
      payload: message.payload,
    });

    if (message.type === "UPDATE_SETTINGS" && message.payload) {
      applySettings(message.payload, "Settings updated:");
      updateInjectedScript();
    } else if (message.type === "PING") {
      // Respond to ping to confirm content script is injected
      return Promise.resolve({ pong: true });
    }
  }
);

/**
 * Whether this document is its tab's top frame. Sent with GET_SETTINGS so the
 * background can judge a page Chrome is prerendering by its own URL (its
 * `frameId` isn't 0 yet). Read in the isolated world, so the page sees nothing.
 */
function isTopFrame(): boolean {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

/** Why settings are being requested: first load, a bfcache restore, or prerender activation. */
type SettingsRequestReason = "load" | "pageshow" | "prerenderingchange";

/** Incremented per request, so only the newest reply is applied. */
let settingsRequestSeq = 0;

/**
 * Ask the background for this page's settings and dispatch the reply.
 *
 * A reply that arrives after a newer request was sent is dropped, so two
 * refreshes resolved out of order can't leave the older values in place. A
 * reply can still overwrite an UPDATE_SETTINGS push computed after it, until
 * the next push or a reload; every settings change has that race (Known
 * Limitation "Rollover race" in docs/API.md).
 */
function requestSettings(reason: SettingsRequestReason): void {
  const seq = ++settingsRequestSeq;
  // Timing probes for cold-start diagnosis. Routed through logger.debug
  // so they're silent by default and surface when debug logging is on.
  const sentAt = now();
  logger.debug(
    `Sending GET_SETTINGS to background (reason=${reason}, page-start=${sentAt.toFixed(1)}ms)`
  );
  const payload: GetSettingsPayload = { topFrame: isTopFrame() };
  browser.runtime
    .sendMessage({ type: "GET_SETTINGS", payload })
    .then((settings: ReceivedSettings) => {
      const roundTrip = now() - sentAt;
      logger.debug(
        `GET_SETTINGS resolved (reason=${reason}, round-trip=${roundTrip.toFixed(1)}ms, enabled=${String(settings.enabled)}, hasLocation=${String(!!settings.location)})`
      );
      if (seq !== settingsRequestSeq) {
        logger.debug(`Dropped a GET_SETTINGS reply superseded by a newer request (${reason})`);
        return;
      }
      applySettings(
        settings,
        reason === "load" ? "Initial settings loaded:" : "Settings refreshed:"
      );
      updateInjectedScript();
    })
    .catch((error: unknown) => {
      logger.error(
        `GET_SETTINGS (${reason}) rejected after ${(now() - sentAt).toFixed(1)}ms:`,
        error
      );
    });
}

// A page restored from the back/forward cache keeps this content script, but
// it was cached while pushes couldn't reach it, so it asks again when shown.
// A refresh dispatches once on the same per-build event (the document_start
// retries ran on the first dispatch), and unchanged settings re-apply
// identical state. Registered with addEventListener in the isolated world:
// never `window.onpageshow`, which the page could read.
window.addEventListener("pageshow", (event: Event) => {
  if ((event as PageTransitionEvent).persisted === true) {
    requestSettings("pageshow");
  }
});

// A page Chrome prerenders gets its settings while hidden, and its subframes
// are judged by the page being left (Known Limitation 14). Ask again when it's
// shown. `document.prerendering` is Chrome-only and undefined elsewhere, so
// nothing is registered there.
if ((document as Document & { prerendering?: boolean }).prerendering === true) {
  document.addEventListener(
    "prerenderingchange",
    () => {
      requestSettings("prerenderingchange");
    },
    { once: true }
  );
}

// Request initial settings on load
logger.info("Content script loaded, requesting initial settings");
requestSettings("load");
