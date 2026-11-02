/**
 * Settings event listener and waitForSettings utility.
 *
 * Registers a CustomEvent listener on `window` that receives spoofing
 * settings from the content script and updates shared state accordingly.
 * Also provides `waitForSettings()` for modules that need to defer
 * until settings have arrived.
 */

import type { SettingsEventDetail } from "./types";
import {
  EVENT_NAME,
  SETTINGS_WAIT_TIMEOUT,
  settingsReceived,
  setSpoofingEnabled,
  setSpoofedLocation,
  setTimezoneData,
  setSettingsReceived,
  setDebugEnabled as setStateDebugEnabled,
  setWebRTCProtectionEnabled,
  setPreserveGeolocationPrompt,
  setLocaleData,
  setEngineTimezoneMode,
  setEngineTimezoneData,
} from "./state";
import { engineReportsZone, validateTimezoneData } from "./timezone-helpers";
import { validateLocaleData } from "./locale-helpers";
import {
  setDebugEnabled as setLoggerDebugEnabled,
  setVerbosityLevel as setLoggerVerbosityLevel,
  createLogger,
} from "@/shared/utils/debug-logger";
import { now } from "@/shared/utils/safe-time";

const logger = createLogger("INJ");

/**
 * Returns a promise that resolves when settings arrive, or rejects if the
 * timeout expires before settings are received.
 *
 * Callers that need to fall through to the real API when spoofing is
 * disabled should check `spoofingEnabled` after the promise resolves.
 * Callers must NOT fall through to the real API on rejection (timeout) —
 * that would leak the user's real location to pages that call the
 * geolocation API early (e.g. in a <head> script) before the content
 * script has had a chance to dispatch settings.
 */
export function waitForSettings(): Promise<{ timedOut: boolean }> {
  if (settingsReceived) return Promise.resolve({ timedOut: false });
  return new Promise<{ timedOut: boolean }>((resolve) => {
    const waitStart = now();
    const onSettings = (): void => {
      window.removeEventListener(EVENT_NAME, onSettings);
      logger.debug(`waitForSettings resolved via event after ${(now() - waitStart).toFixed(1)}ms`);
      resolve({ timedOut: false });
    };
    window.addEventListener(EVENT_NAME, onSettings);
    setTimeout(() => {
      window.removeEventListener(EVENT_NAME, onSettings);
      logger.warn(
        `waitForSettings timed out after ${(now() - waitStart).toFixed(1)}ms — settings never arrived`
      );
      resolve({ timedOut: true });
    }, SETTINGS_WAIT_TIMEOUT);
  });
}

/**
 * Install the settings event listener on `window`.
 *
 * Listens for the CustomEvent dispatched by the content script, updates
 * shared spoofing state, and validates timezone data before applying it.
 */
export function installSettingsListener(): void {
  window.addEventListener(EVENT_NAME, ((event: CustomEvent<SettingsEventDetail>) => {
    if (event.detail) {
      const receivedAt = now();
      logger.debug(
        `Settings event received at ${receivedAt.toFixed(1)}ms — enabled:${String(event.detail.enabled)} hasLocation:${String(!!event.detail.location)}`
      );
      setSpoofingEnabled(event.detail.enabled);
      setSpoofedLocation(event.detail.location);
      setWebRTCProtectionEnabled(event.detail.webrtcProtection === true);
      setPreserveGeolocationPrompt(event.detail.preserveGeolocationPrompt === true);
      setSettingsReceived(true);

      const debugFlag = event.detail.debugLogging ?? false;
      setStateDebugEnabled(debugFlag);
      setLoggerDebugEnabled(debugFlag);

      const verbosity = event.detail.verbosityLevel ?? "INFO";
      setLoggerVerbosityLevel(verbosity);

      // Engine-level Spoofing sets the page's zone in the engine. This realm
      // keeps native Date/Intl only if its engine already reports that zone;
      // otherwise (a cross-site iframe in its own process, a refused or
      // cancelled session, an override that hasn't landed) it installs the
      // overrides for it, so every realm reports its top-level page's zone.
      // Re-checked on every settings event.
      const engineMode = event.detail.engineTimezone === true;
      setEngineTimezoneMode(engineMode);
      if (event.detail.timezone) {
        if (validateTimezoneData(event.detail.timezone)) {
          const engineOwned = engineMode && engineReportsZone(event.detail.timezone.identifier);
          setTimezoneData(engineOwned ? null : event.detail.timezone);
          // `document.lastModified` sits below the engine's emulation, so its
          // override still needs the zone where the engine owns Date/Intl.
          setEngineTimezoneData(engineOwned ? event.detail.timezone : null);
          logger.debug("Timezone data updated:", event.detail.timezone, { engineOwned });
        } else {
          logger.error("Invalid timezone data received, timezone spoofing disabled");
          setTimezoneData(null);
          setEngineTimezoneData(null);
        }
      } else {
        setTimezoneData(null);
        setEngineTimezoneData(null);
      }

      // Reported Language. Validated before adoption for the same reason as
      // timezone data: a malformed value must disable the locale override rather
      // than half-apply it, since a locale the engine can't honor would make
      // navigator.language contradict the actual formatting behavior.
      if (event.detail.locale) {
        if (validateLocaleData(event.detail.locale)) {
          setLocaleData(event.detail.locale);
          logger.debug("Locale data updated:", event.detail.locale);
        } else {
          logger.error("Invalid locale data received, locale spoofing disabled");
          setLocaleData(null);
        }
      } else {
        setLocaleData(null);
      }

      logger.info("Settings updated via event:", {
        enabled: event.detail.enabled,
        location: event.detail.location,
        timezone: event.detail.timezone,
        debugLogging: debugFlag,
        webrtcProtection: event.detail.webrtcProtection === true,
      });
    }
  }) as EventListener);
}
