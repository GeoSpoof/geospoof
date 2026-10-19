/**
 * Message Handling
 * Central message router for inter-component communication.
 */

import type {
  Message,
  SetLocationPayload,
  SetProtectionStatusPayload,
  SetWebRTCProtectionPayload,
  SetPreserveGeoPromptPayload,
  SetDebuggerModePayload,
  AnnounceWorkerFetchPayload,
  GeocodeQueryPayload,
  CheckTabInjectionPayload,
  SyncVpnPayload,
  SetDebugLoggingPayload,
  SetVerbosityLevelPayload,
  SetThemePayload,
  SetUiLanguagePayload,
  SaveFavoritePayload,
  RemoveFavoritePayload,
  RenameFavoritePayload,
  FavoriteResponse,
  SetScopeModePayload,
  ScopeSitePayload,
  ScopeResponse,
  SetAccuracyPayload,
  SetPrecisionPayload,
  SetPrecisionCadencePayload,
  SetLocaleSpoofingPayload,
} from "@/shared/types/messages";
import type { LocationName, PrecisionCadence, Settings } from "@/shared/types/settings";
import { MAX_FAVORITES } from "@/shared/types/settings";
import { resolveAccuracy } from "@/shared/accuracy/resolver";
import { detectDeviceClass } from "@/shared/accuracy/device-class";
import { isTimeCadence, validatePrecisionCadence } from "@/shared/precision/cadence";
import { setDebugEnabled, setVerbosityLevel, createLogger } from "@/shared/utils/debug-logger";
import { parsePattern } from "@/shared/utils/scope";
import {
  ensureValidPrecisionSeed,
  loadSettings,
  updateSettings,
  validateAccuracySetting,
  validateLocationPrecision,
  validateLocaleSpoofing,
} from "./settings";

const logger = createLogger("BG");

import { geocodeQuery, reverseGeocode } from "./geocoding";
import { getTimezoneForCoordinates } from "./timezone";
import { setWebRTCProtection } from "./webrtc";
import { updateBadge, applyTabIndicator } from "./badge";
import {
  broadcastSettingsToTabs,
  injectContentScriptIntoExistingTabs,
  checkTabInjection,
} from "./tabs";
import { buildPagePayload } from "./page-payload";
import { syncVpnLocation, clearIpGeoCache, clearEndpointCooldowns } from "./vpn-sync";
import { adoptPendingSettingsFromApp } from "./app-bridge";
import { allowlistWorkerUrl, isSameOriginWorker, tabPageUrlCache } from "./worker-request-filter";
import { syncDebuggerSpoofing } from "./debugger-spoof";
import { updateBootstrapRegistration } from "./bootstrap-register";
import { adoptClockBucket, reschedulePrecisionRollover } from "./precision-cadence";

export async function handleMessage(
  message: Message,
  _sender: browser.runtime.MessageSender
): Promise<unknown> {
  try {
    logger.info("Received message:", message.type, message.payload);

    switch (message.type) {
      case "GET_SETTINGS": {
        // Popup branch: return the full Settings object so the popup can render
        // the selected scope mode and both site lists (Req 13.2).
        // Content-script branch returns a scoped, list-free payload.
        //
        // The popup is normally a toolbar panel with no associated tab, so
        // `_sender.tab` is null. But on Android browsers (Quetta, Firefox for
        // Android) the action popup opens as an ordinary TAB, so `_sender.tab`
        // is populated even though the page is still our own extension UI
        // served from the extension origin. Relying on `_sender.tab == null`
        // alone would route that popup into the content-script branch, which
        // returns a payload with NO `onboardingCompleted` (→ falsy → onboarding
        // re-shows on every settings reload) and an `enabled` computed from the
        // extension page's own restricted URL (→ always false). Detect our own
        // pages by origin so the popup always gets the full Settings object.
        const senderUrl = _sender.url ?? _sender.tab?.url ?? "";
        const isExtensionPage = senderUrl.startsWith(browser.runtime.getURL(""));
        if (_sender.tab == null || isExtensionPage) {
          // Safari: adopt the app's pending snapshot first so the popup
          // reflects what the user set in the containing app — without it the
          // popup can show stale "off" state until a tab event triggers
          // adoption.
          if (__SAFARI__) {
            await adoptPendingSettingsFromApp();
          }

          const settings = await loadSettings();
          logger.debug("Loaded settings (popup):", settings);
          return settings;
        }

        // Content-script branch: the Background is the sole gatekeeper. It
        // resolves Effective_Enabled for the requesting tab's top-level URL via
        // the shared source of truth and returns a payload typed as
        // UpdateSettingsPayload, which structurally has NO allowlist/denylist
        // keys — the lists cannot leak into a page (Req 6.6, 6.7, 8.5, 8.7).

        // Safari: adopt the app's pending snapshot before reading settings.
        // Without this, a content script's GET_SETTINGS can race the fire-and-
        // forget adoptPendingSettingsFromApp() triggered by tabs.onUpdated and
        // read stale storage — causing the page to display the previous spoofed
        // location until a manual refresh. The native round-trip is fast (~1-5ms
        // on-device) and adoptPendingSettingsFromApp no-ops immediately when
        // there's nothing new, so the overhead is negligible.
        if (__SAFARI__) {
          await adoptPendingSettingsFromApp();
        }

        const settings = await loadSettings();
        logger.debug("Loaded settings (content script):", settings);

        const senderTabId = _sender.tab.id;

        // Effective_Enabled resolves to false when the URL is missing,
        // unparseable, restricted, or out of scope (Req 8.7). The shared
        // builder also withholds the timezone in Chromium debugger mode, as the
        // broadcast path does.
        const payload = await buildPagePayload(settings, _sender.tab.url);

        // Badge recovery: a content-script GET_SETTINGS confirms the script is
        // alive. Reflect the per-tab decision via the shared three-state badge
        // mapping using the payload's Effective_Enabled (Req 12.1–12.3). The
        // badge reflects whether protection is active for the tab, so it stays
        // on in debugger mode even though the injected path is suppressed.
        // `applyTabIndicator` resolves through the same `resolveSiteSettings`
        // as the payload, so its badge agrees with `payload.enabled`, and it
        // also sets the title that names an applied site location.
        if (senderTabId != null) {
          applyTabIndicator(senderTabId, settings, _sender.tab.url);
        }

        return payload;
      }

      case "SET_LOCATION":
        logger.debug("Setting location:", message.payload);
        await handleSetLocation(message.payload as SetLocationPayload);
        return { success: true };

      case "SET_PROTECTION_STATUS":
        logger.debug("Setting protection status:", message.payload);
        await handleSetProtectionStatus(message.payload as SetProtectionStatusPayload);
        return { success: true };

      case "SET_WEBRTC_PROTECTION":
        logger.debug("Setting WebRTC protection:", message.payload);
        await handleSetWebRTCProtection(message.payload as SetWebRTCProtectionPayload);
        return { success: true };

      case "SET_PRESERVE_GEO_PROMPT":
        logger.debug("Setting preserve-geolocation-prompt:", message.payload);
        await handleSetPreserveGeoPrompt(message.payload as SetPreserveGeoPromptPayload);
        return { success: true };

      case "SET_DEBUGGER_MODE":
        logger.debug("Setting debugger mode:", message.payload);
        await handleSetDebuggerMode(message.payload as SetDebuggerModePayload);
        return { success: true };

      case "ANNOUNCE_WORKER_FETCH": {
        const payload = message.payload as AnnounceWorkerFetchPayload;
        if (typeof payload?.url === "string") {
          const tabId = _sender.tab?.id;
          const tabPageUrl = tabId != null ? tabPageUrlCache.get(tabId) : undefined;
          // Only allowlist same-origin workers — cross-origin workers
          // (e.g. Cloudflare Turnstile, Stripe) must not be patched.
          if (isSameOriginWorker(payload.url, tabPageUrl)) {
            allowlistWorkerUrl(payload.url);
          }
        }
        // Fire-and-forget — the content script doesn't await the result
        // because blocking the worker construction on a background
        // round-trip would regress cold-start performance.
        return { success: true };
      }

      case "GEOCODE_QUERY": {
        const results = await geocodeQuery((message.payload as GeocodeQueryPayload).query);
        logger.debug("Geocode results:", results);
        return { results };
      }

      case "COMPLETE_ONBOARDING":
        await handleCompleteOnboarding();
        return { success: true };

      case "SYNC_VPN": {
        const payload = message.payload as SyncVpnPayload | undefined;
        const syncMsgStart = Date.now();
        logger.info("[MSG] SYNC_VPN received, forceRefresh:", payload?.forceRefresh ?? false);
        // User-initiated sync: give every endpoint a fresh shot by dropping any
        // per-endpoint cooldowns parked by the automatic path.
        clearEndpointCooldowns();
        const result = await syncVpnLocation(payload?.forceRefresh ?? false);

        if ("error" in result) {
          logger.warn("[MSG] SYNC_VPN failed after", Date.now() - syncMsgStart, "ms:", result);
          return result;
        }

        logger.debug("[MSG] SYNC_VPN result:", result);
        const setLocStart = Date.now();
        // Pass city/country from freeipapi directly — no need for separate Nominatim call
        await handleSetLocation(
          { latitude: result.latitude, longitude: result.longitude },
          {
            fromVpnSync: true,
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
        logger.debug("[MSG] handleSetLocation completed in", Date.now() - setLocStart, "ms");
        await updateSettings({ vpnSyncEnabled: true });

        logger.info("[MSG] SYNC_VPN total time:", Date.now() - syncMsgStart, "ms");
        return result;
      }

      case "DISABLE_VPN_SYNC": {
        logger.info("Disabling VPN sync");
        await clearIpGeoCache();
        await updateSettings({
          vpnSyncEnabled: false,
          location: null,
          timezone: null,
          locationName: null,
        });
        const disabledSettings = await loadSettings();
        await broadcastSettingsToTabs(disabledSettings);
        await syncDebuggerSpoofing(disabledSettings);
        return { success: true };
      }

      case "CLEAR_LOCATION": {
        logger.info("Clearing location");
        const clearedSettings = await updateSettings({
          location: null,
          timezone: null,
          locationName: null,
        });
        await broadcastSettingsToTabs(clearedSettings);
        await syncDebuggerSpoofing(clearedSettings);
        return { success: true };
      }

      case "CHECK_TAB_INJECTION": {
        const injectionStatus = await checkTabInjection(
          (message.payload as CheckTabInjectionPayload).tabId
        );
        return injectionStatus;
      }

      case "SET_DEBUG_LOGGING": {
        const { enabled } = message.payload as SetDebugLoggingPayload;
        const beforeSettings = await loadSettings();
        const settings = await updateSettings({ debugLogging: enabled });
        setDebugEnabled(enabled);
        logger.debug("Debug logging toggled:", {
          before: beforeSettings.debugLogging,
          after: enabled,
        });
        await broadcastSettingsToTabs(settings);
        return { success: true };
      }

      case "SET_VERBOSITY_LEVEL": {
        const { level } = message.payload as SetVerbosityLevelPayload;
        setVerbosityLevel(level);
        const settings = await updateSettings({ verbosityLevel: level });
        await broadcastSettingsToTabs(settings);
        return { success: true };
      }

      case "SET_THEME": {
        const { theme } = message.payload as SetThemePayload;
        await updateSettings({ theme });
        return { success: true };
      }

      case "SET_UI_LANGUAGE": {
        const { language } = message.payload as SetUiLanguagePayload;
        // Persist only; the popup applies the language itself and no tab or
        // background behavior depends on it. validateSettings sanitizes the
        // value against the supported-locale whitelist on the next load.
        await updateSettings({ uiLanguage: language });
        return { success: true };
      }

      case "SAVE_FAVORITE":
        return await handleSaveFavorite(message.payload as SaveFavoritePayload);

      case "REMOVE_FAVORITE":
        return await handleRemoveFavorite(message.payload as RemoveFavoritePayload);

      case "RENAME_FAVORITE":
        return await handleRenameFavorite(message.payload as RenameFavoritePayload);

      case "SET_SCOPE_MODE":
        return await handleSetScopeMode(message.payload as SetScopeModePayload);

      case "ADD_SCOPE_SITE":
        return await handleAddScopeSite(message.payload as ScopeSitePayload);

      case "REMOVE_SCOPE_SITE":
        return await handleRemoveScopeSite(message.payload as ScopeSitePayload);

      case "SET_ACCURACY":
        return await handleSetAccuracy(message.payload as SetAccuracyPayload);

      case "SET_PRECISION":
        return await handleSetPrecision(message.payload as SetPrecisionPayload);

      case "SET_PRECISION_CADENCE":
        return await handleSetPrecisionCadence(message.payload as SetPrecisionCadencePayload);

      case "SET_LOCALE_SPOOFING":
        return await handleSetLocaleSpoofing(message.payload as SetLocaleSpoofingPayload);

      default:
        logger.warn("Unknown message type:", message.type);
        return { error: "Unknown message type" };
    }
  } catch (error) {
    logger.error("Error handling message:", error);
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function handleSetLocation(
  payload: SetLocationPayload,
  options?: { fromVpnSync?: boolean; locationName?: LocationName; timezoneHint?: string }
): Promise<void> {
  const { latitude, longitude } = payload;

  logger.debug("Resolving timezone for coordinates:", { latitude, longitude });
  const timezone = await getTimezoneForCoordinates(latitude, longitude, options?.timezoneHint);
  logger.debug("Timezone resolved:", timezone);

  // Don't persist a fallback timezone to storage — it's a longitude estimate
  // with no DST awareness (Etc/GMT±N), produced when the geo-tz data fetch
  // fails transiently. Saving null means the next browser session will retry
  // the real lookup rather than loading a wrong timezone from storage.
  const timezoneToSave = timezone.fallback ? null : timezone;

  const currentSettings = await loadSettings();

  // If VPN sync was active and a manual location is being set,
  // disable VPN sync and clear the IP geolocation cache (Req 9.3).
  // Skip this when the call originates from VPN sync itself.
  const vpnUpdates: Record<string, unknown> = {};
  if (currentSettings.vpnSyncEnabled && !options?.fromVpnSync) {
    await clearIpGeoCache();
    vpnUpdates.vpnSyncEnabled = false;
  }

  // If locationName was provided (e.g., from VPN sync), use it directly
  if (options?.locationName) {
    const accuracy = resolveAccuracy({
      setting: currentSettings.accuracySetting,
      deviceClass: detectDeviceClass(),
      seed: currentSettings.accuracySeed,
      latitude,
      longitude,
    });
    const settings = await updateSettings({
      location: { latitude, longitude, accuracy },
      timezone: timezoneToSave,
      locationName: options.locationName,
      ...vpnUpdates,
    });
    logger.debug("Settings updated with provided locationName:", settings);
    await broadcastSettingsToTabs(settings);
    await syncDebuggerSpoofing(settings);
    return;
  }

  // Reverse geocode to get the location name (blocking so popup shows it immediately)
  let locationName = null;
  try {
    locationName = await reverseGeocode(latitude, longitude);
    logger.debug("Reverse geocode result:", locationName);
  } catch (error) {
    logger.warn("Reverse geocoding failed:", error);
  }

  const accuracy = resolveAccuracy({
    setting: currentSettings.accuracySetting,
    deviceClass: detectDeviceClass(),
    seed: currentSettings.accuracySeed,
    latitude,
    longitude,
  });

  const settings = await updateSettings({
    location: { latitude, longitude, accuracy },
    timezone: timezoneToSave,
    locationName,
    ...vpnUpdates,
  });

  logger.debug("Settings updated after SET_LOCATION:", settings);
  await broadcastSettingsToTabs(settings);
  await syncDebuggerSpoofing(settings);
}

export async function handleSetProtectionStatus(
  payload: SetProtectionStatusPayload
): Promise<void> {
  const { enabled } = payload;

  const settings = await updateSettings({ enabled });
  logger.info("Protection status updated:", { enabled });

  if (enabled) {
    await injectContentScriptIntoExistingTabs();
  }

  await updateBadge();

  await broadcastSettingsToTabs(settings);
  await syncDebuggerSpoofing(settings);
}

/**
 * Toggle browser-level (chrome.debugger / CDP) spoofing. Persists the flag,
 * reconciles the live debugger state (attach + apply when turning on, detach
 * when turning off), then re-broadcasts so the content-script geo/timezone
 * injection is suppressed/restored to match (WebRTC injection is unaffected).
 * Chromium-only in effect; a no-op spoof sync on other engines.
 */
export async function handleSetDebuggerMode(payload: SetDebuggerModePayload): Promise<void> {
  const { enabled } = payload;

  const settings = await updateSettings({ debuggerModeEnabled: enabled });
  logger.info("Debugger mode updated:", { enabled });

  // Drive the popup's one-time "how to hide the debugging bar" note: reset it
  // (show again) on each enable, clear it on disable. Persisted so it survives
  // the popup closing when Chrome shows the webNavigation permission prompt.
  try {
    await browser.storage.local.set({ debuggerBannerHelpDismissed: !enabled });
  } catch (error) {
    logger.debug("Failed to set debuggerBannerHelpDismissed flag:", error);
  }

  // Reconcile CDP attachments first so that, when turning the mode OFF, tabs are
  // detached before the re-broadcast re-enables the injected path (no gap), and
  // when turning it ON, overrides are applied before injection is suppressed.
  await syncDebuggerSpoofing(settings);

  await broadcastSettingsToTabs(settings);
}

export async function handleSetWebRTCProtection(
  payload: SetWebRTCProtectionPayload
): Promise<void> {
  const { enabled } = payload;

  await setWebRTCProtection(enabled);
  const settings = await updateSettings({ webrtcProtection: enabled });
  logger.info("WebRTC protection updated:", { enabled });

  // Push the new flag to every live content script so the injected
  // RTCPeerConnection wrapper flips state without needing a reload.
  await broadcastSettingsToTabs(settings);
}

/**
 * Toggle the "preserve permission prompts" geolocation behavior. Persists the
 * flag and re-broadcasts so the injected geolocation/permissions overrides flip
 * between auto-granting spoofed coords and surfacing the native prompt — no page
 * reload needed. Engine-independent (pure content-script behavior).
 */
export async function handleSetPreserveGeoPrompt(
  payload: SetPreserveGeoPromptPayload
): Promise<void> {
  const { enabled } = payload;

  const settings = await updateSettings({ preserveGeolocationPrompt: enabled });
  logger.info("Preserve geolocation prompt updated:", { enabled });

  await broadcastSettingsToTabs(settings);
}

export async function handleCompleteOnboarding(): Promise<void> {
  await updateSettings({ onboardingCompleted: true });
  logger.info("Onboarding completed");
}

export async function handleSaveFavorite(payload: SaveFavoritePayload): Promise<FavoriteResponse> {
  const settings = await loadSettings();

  // Capacity check (Req 2.6, 8.5)
  if (settings.favorites.length >= MAX_FAVORITES) {
    return { error: "AT_CAPACITY" };
  }

  // Deduplication by coordinates rounded to 4dp (Req 10.1)
  const roundCoord = (v: number) => Math.round(v * 10000) / 10000;
  const roundedLat = roundCoord(payload.latitude);
  const roundedLon = roundCoord(payload.longitude);
  const isDuplicate = settings.favorites.some(
    (f) => roundCoord(f.latitude) === roundedLat && roundCoord(f.longitude) === roundedLon
  );
  if (isDuplicate) {
    return { success: true };
  }

  // Append new favorite (Req 2.2, 8.4)
  const newFavorite = {
    id: payload.id,
    latitude: payload.latitude,
    longitude: payload.longitude,
    city: payload.city,
    country: payload.country,
    displayName: payload.displayName.slice(0, 100),
    label: payload.label,
  };

  try {
    await updateSettings({ favorites: [...settings.favorites, newFavorite] });
  } catch {
    return { error: "STORAGE_ERROR" };
  }

  return { success: true };
}

export async function handleRemoveFavorite(
  payload: RemoveFavoritePayload
): Promise<FavoriteResponse> {
  const settings = await loadSettings();

  // Filter out matching id — no-op if not found (Req 2.3, 2.4, 8.6, 8.7)
  const filtered = settings.favorites.filter((f) => f.id !== payload.id);

  try {
    await updateSettings({ favorites: filtered });
  } catch {
    return { error: "STORAGE_ERROR" };
  }

  return { success: true };
}

export async function handleRenameFavorite(
  payload: RenameFavoritePayload
): Promise<FavoriteResponse> {
  const settings = await loadSettings();

  // No-op if id not found (Req 8.8)
  const match = settings.favorites.find((f) => f.id === payload.id);
  if (!match) {
    return { success: true };
  }

  const updated = settings.favorites.map((f) =>
    f.id === payload.id ? { ...f, label: payload.label } : f
  );

  try {
    await updateSettings({ favorites: updated });
  } catch {
    return { error: "STORAGE_ERROR" };
  }

  return { success: true };
}

/**
 * SET_SCOPE_MODE handler (Req 9.1, 9.5). Persist the new scope mode, then
 * re-evaluate and re-deliver per-tab Effective_Enabled and re-badge every tab.
 * On storage failure the persisted mode is left unchanged, no re-broadcast or
 * badge refresh occurs, and STORAGE_ERROR is returned (Req 9.5).
 */
export async function handleSetScopeMode(payload: SetScopeModePayload): Promise<ScopeResponse> {
  let settings;
  try {
    settings = await updateSettings({ scopeMode: payload.scopeMode });
  } catch {
    return { error: "STORAGE_ERROR" };
  }

  await broadcastSettingsToTabs(settings);
  await updateBadge();
  await syncDebuggerSpoofing(settings);
  return { success: true };
}

/**
 * ADD_SCOPE_SITE handler (Req 14.1–14.5). Parse the entered pattern to its
 * canonical form, append it to the target list (idempotent against existing
 * canonical entries), persist, then re-broadcast and re-badge. Returns
 * INVALID_PATTERN for input the Pattern_Parser rejects and STORAGE_ERROR on
 * persistence failure.
 */
export async function handleAddScopeSite(payload: ScopeSitePayload): Promise<ScopeResponse> {
  const canonical = parsePattern(payload.pattern);
  if (canonical === null) {
    return { error: "INVALID_PATTERN" };
  }

  const settings = await loadSettings();
  const list = settings[payload.list];

  // Idempotent: a duplicate add reports success without re-persisting (Req
  // 14.2).
  if (list.includes(canonical)) {
    return { success: true };
  }

  let updated;
  try {
    updated = await updateSettings({ [payload.list]: [...list, canonical] });
  } catch {
    return { error: "STORAGE_ERROR" };
  }

  await broadcastSettingsToTabs(updated);
  await updateBadge();
  await syncDebuggerSpoofing(updated);
  return { success: true };
}

/**
 * REMOVE_SCOPE_SITE handler (Req 9.2). Remove the matching canonical pattern
 * from the target list, persist, then re-broadcast and re-badge. Falls back to
 * the raw pattern when parsing fails so legacy/odd entries can still be removed.
 * Returns STORAGE_ERROR on persistence failure.
 */
export async function handleRemoveScopeSite(payload: ScopeSitePayload): Promise<ScopeResponse> {
  const canonical = parsePattern(payload.pattern) ?? payload.pattern;

  const settings = await loadSettings();
  const filtered = settings[payload.list].filter((entry) => entry !== canonical);

  let updated;
  try {
    updated = await updateSettings({ [payload.list]: filtered });
  } catch {
    return { error: "STORAGE_ERROR" };
  }

  await broadcastSettingsToTabs(updated);
  await updateBadge();
  await syncDebuggerSpoofing(updated);
  return { success: true };
}

/**
 * SET_ACCURACY handler (Req 9.2, 7.3, 7.4). Validate the incoming
 * AccuracySetting via the same repair path used at load-time, persist it, then
 * broadcast updated settings to tabs so the content scripts pick up the change.
 */
export async function handleSetAccuracy(
  payload: SetAccuracyPayload
): Promise<{ success: true } | { error: string }> {
  // Validate the incoming payload through the same validation path used during
  // settings load — this repairs malformed/out-of-range values (Req 7.3, 7.4).
  const accuracySetting = validateAccuracySetting(payload?.accuracySetting);

  let settings;
  try {
    settings = await updateSettings({ accuracySetting });
  } catch {
    return { error: "STORAGE_ERROR" };
  }

  await broadcastSettingsToTabs(settings);
  // Re-apply the CDP geolocation override so its accuracy matches the new
  // setting while debugger mode is active (no-op otherwise).
  await syncDebuggerSpoofing(settings);
  return { success: true };
}

/**
 * SET_PRECISION handler. Validate the incoming LocationPrecision via the same
 * repair path used at load-time, persist it, then broadcast so live tabs pick
 * up the new Reported_Location without a reload. No `syncDebuggerSpoofing` is
 * needed: geolocation is never driven through the CDP path, so the injected
 * (offset-aware) delivery already covers every engine.
 */
export async function handleSetPrecision(
  payload: SetPrecisionPayload
): Promise<{ success: true } | { error: string }> {
  // Repair malformed/out-of-range input through the shared validation path.
  const locationPrecision = validateLocationPrecision(payload?.precision);

  let settings;
  try {
    settings = await updateSettings({ locationPrecision });
  } catch {
    return { error: "STORAGE_ERROR" };
  }

  await broadcastSettingsToTabs(settings);
  return { success: true };
}

/**
 * Apply a precision cadence. The one owner of the cadence side effects:
 * SET_PRECISION_CADENCE and the Safari app-bridge adoption (app-bridge.ts step
 * 7a) both call it, and nothing else in the background writes
 * `precisionCadence` — a bare updateSettings would leave hour/day without a
 * rollover alarm.
 *
 * Repairs the cadence (anything invalid becomes "never"), persists it, then
 * re-registers the Firefox bootstrap, broadcasts, and schedules or clears the
 * rollover alarm. A non-Never cadence also persists a valid `precisionSeed`
 * when none is stored. `locationPrecision` is never touched.
 *
 * Resolves `{ error: "STORAGE_ERROR" }` when the save fails, with nothing
 * changed. Rejects when the broadcast rejects; the save and the alarm stand.
 * Switching to hour or day starts from the clock's bucket; re-selecting the
 * current cadence keeps the held one.
 */
export async function applyPrecisionCadence(
  cadence: unknown
): Promise<{ success: true } | { error: string }> {
  // Repair, never reject.
  const precisionCadence = validatePrecisionCadence(cadence);

  let previous: PrecisionCadence;
  let settings: Settings;
  try {
    const current = await loadSettings();
    previous = current.precisionCadence;
    const updates: Partial<Settings> = { precisionCadence };
    if (precisionCadence !== "never") {
      updates.precisionSeed = ensureValidPrecisionSeed(current.precisionSeed);
    }
    settings = await updateSettings(updates);
  } catch {
    // The held period is untouched, so open tabs and new requests still agree.
    return { error: "STORAGE_ERROR" };
  }

  // Only after a successful save. adoptClockBucket sets the held bucket
  // synchronously, so nothing awaits between the save and the pushes below.
  const adopted =
    isTimeCadence(precisionCadence) && precisionCadence !== previous
      ? adoptClockBucket(precisionCadence, settings.precisionSeed)
      : undefined;

  try {
    // saveSettings' fire-and-forget registration may have resolved the old
    // period; this one queues after it, so the bootstrap ends on the new one.
    await Promise.all([
      adopted,
      updateBootstrapRegistration(settings),
      broadcastSettingsToTabs(settings),
    ]);
  } finally {
    // The save succeeded, so the alarm must follow the persisted cadence even
    // if the broadcast rejected. Never rejects, so it can't mask that error.
    await reschedulePrecisionRollover(loadSettings);
  }
  return { success: true };
}

/** SET_PRECISION_CADENCE handler. See {@link applyPrecisionCadence}. */
export async function handleSetPrecisionCadence(
  payload: SetPrecisionCadencePayload
): Promise<{ success: true } | { error: string }> {
  return applyPrecisionCadence(payload?.cadence);
}

/**
 * SET_LOCALE_SPOOFING handler (locale-spoofing Req 12.2, 12.3). Validate the
 * incoming setting through the shared repair path, persist it, then broadcast so
 * live tabs pick up the new Reported Language without a reload.
 *
 * A malformed or engine-unsupported value is repaired to `off` by the validator
 * rather than rejected, so the caller can never end up believing a locale is
 * applied when it isn't. No `syncDebuggerSpoofing`: locale is never driven
 * through the CDP path, so the injected delivery covers every engine.
 */
export async function handleSetLocaleSpoofing(
  payload: SetLocaleSpoofingPayload
): Promise<{ success: true } | { error: string }> {
  const localeSpoofing = validateLocaleSpoofing(payload?.localeSpoofing);

  let settings;
  try {
    settings = await updateSettings({ localeSpoofing });
  } catch {
    return { error: "STORAGE_ERROR" };
  }

  await broadcastSettingsToTabs(settings);
  return { success: true };
}
