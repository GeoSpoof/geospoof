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
  SaveSiteLocationPayload,
  RemoveSiteLocationPayload,
  SiteLocationResponse,
  GetSettingsPayload,
  ContentSettingsReply,
} from "@/shared/types/messages";
import type {
  LocationName,
  PrecisionCadence,
  Settings,
  SiteLocation,
  Timezone,
} from "@/shared/types/settings";
import {
  MAX_FAVORITES,
  MAX_PATTERNS_PER_SITE_LOCATION,
  MAX_SITE_LOCATIONS,
} from "@/shared/types/settings";
import {
  normalizeSiteLocationLabel,
  normalizeSiteLocationName,
  siteLocationEntryKey,
} from "@/shared/utils/site-locations";
import { isValidIANATimezone } from "@/shared/utils/type-guards";
import { resolveAccuracy } from "@/shared/accuracy/resolver";
import { detectDeviceClass } from "@/shared/accuracy/device-class";
import { isTimeCadence, validatePrecisionCadence } from "@/shared/precision/cadence";
import { setDebugEnabled, setVerbosityLevel, createLogger } from "@/shared/utils/debug-logger";
import {
  classifyFilterEntry,
  parseFilterEntry,
  parseSiteLocationEntry,
} from "@/shared/utils/filter-entries";
import { siteGroupsAvailable } from "@/shared/site-groups/availability";
import { isSiteGroupToken } from "@/shared/site-groups/tokens";
import {
  ensureValidPrecisionSeed,
  loadSettings,
  updateSettings,
  updateSettingsWith,
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
  revisionField,
} from "./tabs";
import { buildPagePayload } from "./page-payload";
import {
  isPrerendering,
  isUndeterminedPrerenderedFrame,
  topLevelUrlForSender,
} from "./sender-page-url";
import { syncVpnLocation, clearIpGeoCache, clearEndpointCooldowns } from "./vpn-sync";
import { adoptPendingSettingsFromApp } from "./app-bridge";
import { allowlistWorkerUrl, isSameOriginWorker, tabPageUrlCache } from "./worker-request-filter";
import { beforePageDelivery, syncDebuggerSpoofing } from "./debugger-spoof";
import { updateBootstrapRegistration } from "./bootstrap-register";
import { adoptClockBucket, reschedulePrecisionRollover } from "./precision-cadence";
import {
  isSiteLocationEntrySuperseded,
  noteLocalSiteLocationEdit,
  runSiteLocationJob,
  stampSiteLocationRequest,
} from "./site-location-queue";
import {
  handleGetSiteGroupIndex,
  handleGetSiteGroups,
  handleUpdateSiteGroups,
  pruneSiteGroupDataSoon,
  withSiteGroupData,
} from "./site-groups";

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

        // The page is judged by its top-level URL: the document's own URL for
        // a top-level document (a page Chrome is prerendering isn't the one
        // `tab.url` shows yet), the tab's for a subframe. See sender-page-url.
        const claimsTopFrame =
          (message.payload as GetSettingsPayload | undefined)?.topFrame === true;
        const pageUrl = topLevelUrlForSender(_sender, claimsTopFrame);

        // Chromium Engine-level, as for a push (sendSettingsToTab). Not for a
        // prerendering document: the tab's session doesn't reach it.
        const engineTimezoneSettled =
          !__CHROMIUM__ ||
          senderTabId == null ||
          isPrerendering(_sender) ||
          (await beforePageDelivery(senderTabId, settings, pageUrl));

        // Effective_Enabled resolves to false when the URL is missing,
        // unparseable, restricted, or out of scope (Req 8.7). The shared
        // builder also sets `engineTimezone` in Chromium debugger mode, as the
        // broadcast path does, except for a prerendering document, which the
        // tab's debugger session doesn't reach. A prerendered subframe is
        // judged by the page being left, so it gets that page's Filters
        // decision and the main location, never its per-site location.
        const payload = await buildPagePayload(settings, pageUrl, {
          prerendering: isPrerendering(_sender),
          withoutSiteLocation: isUndeterminedPrerenderedFrame(_sender, claimsTopFrame),
          engineTimezoneSettled,
        });

        // Badge recovery: a content-script GET_SETTINGS confirms the script is
        // alive. Reflect the per-tab decision via the shared three-state badge
        // mapping using the payload's Effective_Enabled (Req 12.1–12.3). The
        // badge reflects whether protection is active for the tab, so it stays
        // on in debugger mode even though the injected path is suppressed.
        // `applyTabIndicator` resolves through the same `resolveSiteSettings`
        // as the payload, so its badge agrees with `payload.enabled`, and it
        // also sets the title that names an applied site location.
        //
        // It deliberately reads `tab.url`, not `pageUrl`: the badge describes
        // the page the user sees, and a prerendered document must not repaint
        // it for a page that isn't showing. The content script asks again when
        // a prerendered page is shown, and that request repaints the badge.
        if (senderTabId != null) {
          applyTabIndicator(senderTabId, settings, _sender.tab.url);
        }

        // Stamped with the revision of the snapshot the payload was built
        // from, so the content script can drop a reply built from settings
        // older than a push it has already applied.
        const reply: ContentSettingsReply = { ...payload, ...revisionField(settings) };
        return reply;
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
        // Pass city/country from freeipapi directly — no need for separate Nominatim call.
        // enableVpnSync stores vpnSyncEnabled: true in the same write as the
        // location, so a manual location can't land between the two.
        await handleSetLocation(
          { latitude: result.latitude, longitude: result.longitude },
          {
            fromVpnSync: true,
            enableVpnSync: true,
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

      case "SAVE_SITE_LOCATION":
        return await handleSaveSiteLocation(message.payload as SaveSiteLocationPayload);

      case "REMOVE_SITE_LOCATION":
        return await handleRemoveSiteLocation(message.payload as RemoveSiteLocationPayload);

      case "GET_SITE_GROUPS":
        return await handleGetSiteGroups();

      case "GET_SITE_GROUP_INDEX":
        return await handleGetSiteGroupIndex();

      case "UPDATE_SITE_GROUPS":
        return await handleUpdateSiteGroups();

      default:
        logger.warn("Unknown message type:", message.type);
        return { error: "Unknown message type" };
    }
  } catch (error) {
    logger.error("Error handling message:", error);
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Set the main location: resolve the time zone and the place name, then store
 * the location, its accuracy, and any VPN-sync change in one settings write.
 * Resolves true when it wrote, and false only when `onlyWhileVpnSync` found VPN
 * sync off by the time the write ran.
 */
export async function handleSetLocation(
  payload: SetLocationPayload,
  options?: {
    fromVpnSync?: boolean;
    locationName?: LocationName;
    timezoneHint?: string;
    /**
     * Automatic syncs only (startup, auto-resync): write nothing unless VPN
     * sync is still on when the write runs.
     */
    onlyWhileVpnSync?: boolean;
    /**
     * Explicit syncs only (SYNC_VPN, the app's VPN snapshot): store
     * `vpnSyncEnabled: true` in the same write.
     */
    enableVpnSync?: boolean;
  }
): Promise<boolean> {
  const { latitude, longitude } = payload;

  logger.debug("Resolving timezone for coordinates:", { latitude, longitude });
  const timezone = await getTimezoneForCoordinates(latitude, longitude, options?.timezoneHint);
  logger.debug("Timezone resolved:", timezone);

  // Don't persist a fallback timezone to storage — it's a longitude estimate
  // with no DST awareness (Etc/GMT±N), produced when the geo-tz data fetch
  // fails transiently. Saving null means the next browser session will retry
  // the real lookup rather than loading a wrong timezone from storage.
  const timezoneToSave = timezone.fallback ? null : timezone;

  // A provided locationName (e.g., from VPN sync) is used directly. Otherwise
  // reverse geocode, blocking so the popup shows the name immediately.
  const locationName = options?.locationName ?? (await reverseGeocodeOrNull(latitude, longitude));

  // Everything derived from stored settings is decided inside the write, from
  // the settings as stored when it runs: the accuracy, whether a manual
  // location turns VPN sync off (Req 9.3; a call from VPN sync itself
  // doesn't), and whether an automatic sync still applies.
  let disabledVpnSync = false;
  const updated = await updateSettingsWith((current) => {
    if (options?.onlyWhileVpnSync && !current.vpnSyncEnabled) return null;
    disabledVpnSync = current.vpnSyncEnabled && !options?.fromVpnSync;
    const accuracy = resolveAccuracy({
      setting: current.accuracySetting,
      deviceClass: detectDeviceClass(),
      seed: current.accuracySeed,
      latitude,
      longitude,
    });
    return {
      location: { latitude, longitude, accuracy },
      timezone: timezoneToSave,
      locationName,
      ...(disabledVpnSync ? { vpnSyncEnabled: false } : {}),
      ...(options?.enableVpnSync ? { vpnSyncEnabled: true } : {}),
    };
  });

  if (updated === null) {
    logger.debug("[RESYNC] VPN sync was turned off during the check; not writing its location");
    return false;
  }

  // After the write, so it follows the stored decision. Never rejects.
  if (disabledVpnSync) await clearIpGeoCache();

  logger.debug("Settings updated after SET_LOCATION:", updated);
  await broadcastSettingsToTabs(updated);
  await syncDebuggerSpoofing(updated);
  return true;
}

/** The reverse-geocoded place name, or null when the lookup fails. */
async function reverseGeocodeOrNull(
  latitude: number,
  longitude: number
): Promise<LocationName | null> {
  try {
    const locationName = await reverseGeocode(latitude, longitude);
    logger.debug("Reverse geocode result:", locationName);
    return locationName;
  } catch (error) {
    logger.warn("Reverse geocoding failed:", error);
    return null;
  }
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
 * Toggle Engine-level (chrome.debugger / CDP) timezone spoofing. Persists the
 * flag, reconciles the live debugger state (attach + apply when turning on,
 * detach when turning off), then re-broadcasts so every frame gets the new
 * `engineTimezone` flag and re-checks whether its engine reports its zone
 * (geolocation and WebRTC injection are unaffected). Chromium-only in effect;
 * a no-op spoof sync on other engines.
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

/**
 * SAVE_FAVORITE handler. The capacity check, the duplicate check, and the
 * append run inside one settings write, against the list as stored when it
 * runs, so overlapping favorites changes can't erase each other.
 */
export async function handleSaveFavorite(payload: SaveFavoritePayload): Promise<FavoriteResponse> {
  // Checked before the write, so a bad payload can't surface as STORAGE_ERROR.
  // handleMessage returns the TypeError as { error }.
  if (typeof payload?.displayName !== "string") {
    throw new TypeError("SAVE_FAVORITE needs a string displayName");
  }

  let outcome: FavoriteResponse = { success: true };
  try {
    await updateSettingsWith((current) => {
      // Capacity check (Req 2.6, 8.5)
      if (current.favorites.length >= MAX_FAVORITES) {
        outcome = { error: "AT_CAPACITY" };
        return null;
      }

      // Deduplication by coordinates rounded to 4dp (Req 10.1)
      const roundCoord = (v: number) => Math.round(v * 10000) / 10000;
      const roundedLat = roundCoord(payload.latitude);
      const roundedLon = roundCoord(payload.longitude);
      const isDuplicate = current.favorites.some(
        (f) => roundCoord(f.latitude) === roundedLat && roundCoord(f.longitude) === roundedLon
      );
      if (isDuplicate) {
        return null;
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
      return { favorites: [...current.favorites, newFavorite] };
    });
  } catch {
    return { error: "STORAGE_ERROR" };
  }

  return outcome;
}

/** REMOVE_FAVORITE handler. Filters the list as stored when its write runs. */
export async function handleRemoveFavorite(
  payload: RemoveFavoritePayload
): Promise<FavoriteResponse> {
  try {
    // Filter out matching id — no-op if not found (Req 2.3, 2.4, 8.6, 8.7)
    await updateSettingsWith((current) => ({
      favorites: current.favorites.filter((f) => f.id !== payload.id),
    }));
  } catch {
    return { error: "STORAGE_ERROR" };
  }

  return { success: true };
}

/** RENAME_FAVORITE handler. Relabels the entry as stored when its write runs. */
export async function handleRenameFavorite(
  payload: RenameFavoritePayload
): Promise<FavoriteResponse> {
  try {
    await updateSettingsWith((current) => {
      // No-op if id not found (Req 8.8)
      if (!current.favorites.some((f) => f.id === payload.id)) {
        return null;
      }
      return {
        favorites: current.favorites.map((f) =>
          f.id === payload.id ? { ...f, label: payload.label } : f
        ),
      };
    });
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
 * True when `canonical` is an entry form this engine may create: typed
 * patterns always; exact, site group and list-link entries only where site
 * groups are available (not Safari, until geospoof-ios supports them).
 */
function isCreatableEntry(canonical: string): boolean {
  return siteGroupsAvailable() || classifyFilterEntry(canonical)?.type === "pattern";
}

/**
 * ADD_SCOPE_SITE handler (Req 14.1–14.5). Parse the entered entry to its
 * canonical form (`parseFilterEntry`: a typed pattern, an exact address, a
 * site group or a list from a link), append it to the target list (idempotent
 * against existing canonical entries), persist, then re-broadcast and
 * re-badge. A site group or link entry has its data built and stored first
 * (`withSiteGroupData`); when that fails, nothing is stored and the error
 * names the reason. Returns INVALID_PATTERN for input the entry grammar
 * rejects (and, where site groups aren't available, for the three new forms)
 * and STORAGE_ERROR on persistence failure.
 */
export async function handleAddScopeSite(payload: ScopeSitePayload): Promise<ScopeResponse> {
  // Checked before the write: an unknown list would otherwise throw inside it
  // and surface as a misleading STORAGE_ERROR.
  if (payload?.list !== "allowlist" && payload?.list !== "denylist") {
    return { error: "INVALID_PATTERN" };
  }
  const list = payload.list;

  const canonical = typeof payload.pattern === "string" ? parseFilterEntry(payload.pattern) : null;
  if (canonical === null || !isCreatableEntry(canonical)) {
    return { error: "INVALID_PATTERN" };
  }

  // The duplicate check and the append run inside one settings write, against
  // the list as stored when it runs.
  const append = () =>
    updateSettingsWith((current) =>
      current[list].includes(canonical) ? null : { [list]: [...current[list], canonical] }
    );

  let updated;
  let siteGroup: { count: number; skipped: number } | undefined;
  try {
    if (isSiteGroupToken(canonical)) {
      const result = await withSiteGroupData([canonical], append);
      if (!result.ok) {
        return {
          error: result.error,
          token: canonical,
          ...(result.skipped !== undefined ? { skipped: result.skipped } : {}),
        };
      }
      updated = result.value;
      siteGroup = result.added[canonical];
    } else {
      updated = await append();
    }
  } catch {
    return { error: "STORAGE_ERROR" };
  }
  const success = siteGroup ? { success: true as const, siteGroup } : { success: true as const };

  // Idempotent: a duplicate add reports success without re-persisting (Req
  // 14.2).
  if (updated === null) {
    return success;
  }

  await broadcastSettingsToTabs(updated);
  await updateBadge();
  await syncDebuggerSpoofing(updated);
  return success;
}

/**
 * REMOVE_SCOPE_SITE handler (Req 9.2). Remove the matching canonical pattern
 * from the target list, persist, then re-broadcast and re-badge. Falls back to
 * the raw pattern when parsing fails so legacy/odd entries can still be removed.
 * Returns STORAGE_ERROR on persistence failure.
 */
export async function handleRemoveScopeSite(payload: ScopeSitePayload): Promise<ScopeResponse> {
  // Same list guard as ADD_SCOPE_SITE.
  if (payload?.list !== "allowlist" && payload?.list !== "denylist") {
    return { error: "INVALID_PATTERN" };
  }
  const list = payload.list;

  const canonical =
    (typeof payload.pattern === "string" ? parseFilterEntry(payload.pattern) : null) ??
    payload.pattern;

  // Filters the list as stored when the write runs.
  let updated;
  try {
    updated = await updateSettingsWith((current) => ({
      [list]: current[list].filter((entry) => entry !== canonical),
    }));
  } catch {
    return { error: "STORAGE_ERROR" };
  }
  // derive never returns null; the check only narrows the type.
  if (updated === null) {
    return { error: "STORAGE_ERROR" };
  }

  // A removed group or link may have left data nothing references.
  if (typeof canonical === "string" && isSiteGroupToken(canonical)) {
    void pruneSiteGroupDataSoon();
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

  // The previous cadence and the seed come from the settings as stored when the
  // write runs, so two overlapping switches persist one seed and only the first
  // adopts the clock bucket.
  // Initialized so it's definitely assigned (TS2454); derive overwrites it with the stored cadence.
  let previous: PrecisionCadence = precisionCadence;
  let settings: Settings;
  try {
    const updated = await updateSettingsWith((current) => {
      previous = current.precisionCadence;
      const updates: Partial<Settings> = { precisionCadence };
      if (precisionCadence !== "never") {
        updates.precisionSeed = ensureValidPrecisionSeed(current.precisionSeed);
      }
      return updates;
    });
    // derive never returns null; the check only narrows the type.
    if (updated === null) return { error: "STORAGE_ERROR" };
    settings = updated;
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

/**
 * The first pattern in `patterns` that an entry other than `selfId` already
 * owns, as a PATTERN_IN_USE response naming that entry, or null. Patterns are
 * compared by `siteLocationEntryKey`, so `münchen.de` conflicts with a
 * stored `xn--mnchen-3ya.de`, and a site group or link token conflicts with
 * the same token.
 */
function findPatternConflict(
  list: readonly SiteLocation[],
  patterns: readonly string[],
  selfId: string | undefined
): SiteLocationResponse | null {
  for (const pattern of patterns) {
    const key = siteLocationEntryKey(pattern);
    const owner = list.find(
      (e) => e.id !== selfId && e.patterns.some((p) => siteLocationEntryKey(p) === key)
    );
    if (owner) {
      return { error: "PATTERN_IN_USE", pattern, ownerId: owner.id };
    }
  }
  return null;
}

/** A `Date.now()`-style id, like favorites', bumped until it's unused in `list`. */
function newSiteLocationId(list: readonly SiteLocation[]): string {
  let n = Date.now();
  while (list.some((e) => e.id === String(n))) n++;
  return String(n);
}

/**
 * SAVE_SITE_LOCATION handler: create or edit a site location.
 *
 * Validates the coordinates and patterns, rejects a pattern another entry
 * owns or a new entry past the cap, resolves the timezone (reused when the
 * coordinates are unchanged; a longitude fallback is refused, never stored),
 * names the place, then RE-LOADS settings and re-checks conflicts and capacity
 * before writing, because a concurrent save, VPN resync, or app adoption may
 * have landed during the awaits. Broadcasts, re-badges, and re-syncs CDP after
 * a successful save (`saveSettings` already pushes REGION_UPDATE and the
 * bootstrap). The re-load through delivery runs in the site-location queue
 * (`site-location-queue.ts`), so overlapping list changes can't erase each
 * other. An edit whose entry was written meanwhile by a remove or save that
 * arrived after it, or changed or removed by an app action newer than it,
 * writes nothing and returns SUPERSEDED, so the later user action wins.
 */
export async function handleSaveSiteLocation(
  payload: SaveSiteLocationPayload
): Promise<SiteLocationResponse> {
  // 1. Coordinates.
  const latitude = payload?.latitude;
  const longitude = payload?.longitude;
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return { error: "INVALID_LOCATION" };
  }

  // 2. Patterns: canonical, deduped, 1..MAX_PATTERNS_PER_SITE_LOCATION.
  if (!Array.isArray(payload.patterns)) {
    return { error: "INVALID_PATTERN" };
  }
  // A host with no A-label form has no key and could never match, so it's
  // invalid too. Two spellings of one host (Unicode and A-label) keep the first.
  // Exact, site group and link entries are accepted only where site groups
  // are available.
  const patterns: string[] = [];
  const keys = new Set<string>();
  for (const raw of payload.patterns as unknown[]) {
    const canonical = typeof raw === "string" ? parseSiteLocationEntry(raw) : null;
    const key = canonical === null ? null : siteLocationEntryKey(canonical);
    if (canonical === null || key === null || !isCreatableEntry(canonical)) {
      return { error: "INVALID_PATTERN", pattern: String(raw) };
    }
    if (!keys.has(key)) {
      keys.add(key);
      patterns.push(canonical);
    }
  }
  if (patterns.length === 0) {
    return { error: "INVALID_PATTERN" };
  }
  if (patterns.length > MAX_PATTERNS_PER_SITE_LOCATION) {
    return { error: "TOO_MANY_PATTERNS" };
  }

  // Before the first await: a remove or save of this entry that arrives while
  // the lookups below run is later than this save, even though it reaches the
  // queue first.
  const stamp = stampSiteLocationRequest();

  // 3. The entry being edited, if any. An unknown id is saved as a new entry.
  const settings = await loadSettings();
  const existing =
    typeof payload.id === "string"
      ? settings.siteLocations.find((e) => e.id === payload.id)
      : undefined;

  // 4–5. Conflicts and capacity, against the list as loaded.
  const conflict = findPatternConflict(settings.siteLocations, patterns, existing?.id);
  if (conflict) return conflict;
  if (!existing && settings.siteLocations.length >= MAX_SITE_LOCATIONS) {
    return { error: "AT_CAPACITY" };
  }

  // 6. Timezone. A pattern-only edit keeps the stored one and needs no lookup.
  const coordinatesUnchanged =
    existing !== undefined &&
    existing.location.latitude === latitude &&
    existing.location.longitude === longitude;
  let timezone: Timezone;
  if (coordinatesUnchanged) {
    timezone = existing.timezone;
  } else {
    let resolved: Timezone;
    try {
      resolved = await getTimezoneForCoordinates(latitude, longitude);
    } catch (error) {
      logger.warn("Site location timezone lookup failed:", error);
      return { error: "TIMEZONE_UNAVAILABLE" };
    }
    // A longitude estimate has no DST awareness and would be wrong for the
    // site's whole lifetime, so it's refused rather than stored.
    if (resolved.fallback === true || !isValidIANATimezone(resolved.identifier)) {
      return { error: "TIMEZONE_UNAVAILABLE" };
    }
    timezone = {
      identifier: resolved.identifier,
      offset: resolved.offset,
      dstOffset: resolved.dstOffset,
    };
  }

  // 7. Place name: the supplied one, else the stored one, else a lookup.
  let locationName = normalizeSiteLocationName(payload.locationName);
  if (locationName === null) {
    if (coordinatesUnchanged) {
      locationName = existing.locationName;
    } else {
      try {
        locationName = normalizeSiteLocationName(await reverseGeocode(latitude, longitude));
      } catch (error) {
        logger.warn("Site location reverse geocoding failed:", error);
        locationName = null;
      }
    }
  }

  // 8, 10–11 run in the site-location queue, so no other save, remove, or app
  // adoption can write between this re-load and this write.
  const writeSiteLocation = (): Promise<SiteLocationResponse> =>
    runSiteLocationJob(async (): Promise<SiteLocationResponse> => {
      // A remove or save of this entry that arrived after this save has already
      // written it. Writing this older edit now would undo that. Checked by the
      // requested id, not `existing`, because a remove that landed before the
      // first load above leaves `existing` undefined. An id nothing later wrote
      // still creates a new entry.
      if (typeof payload.id === "string" && isSiteLocationEntrySuperseded(payload.id, stamp)) {
        return { error: "SUPERSEDED" };
      }

      // 10. Re-load after the awaits and re-check against the latest list.
      const latest = await loadSettings();
      const list = latest.siteLocations;
      const inPlace = existing !== undefined && list.some((e) => e.id === existing.id);
      const lateConflict = findPatternConflict(list, patterns, existing?.id);
      if (lateConflict) return lateConflict;
      if (!inPlace && list.length >= MAX_SITE_LOCATIONS) {
        return { error: "AT_CAPACITY" };
      }

      // 8. Accuracy, as for the main location, from the settings as re-loaded.
      const accuracy = resolveAccuracy({
        setting: latest.accuracySetting,
        deviceClass: detectDeviceClass(),
        seed: latest.accuracySeed,
        latitude,
        longitude,
      });

      // 9. The entry. An edited entry whose original vanished meanwhile (removed
      // by a request that arrived before this save, or by an app action older
      // than this save) keeps its id (it's unused now) and is appended.
      const id = existing?.id ?? newSiteLocationId(list);
      const entry: SiteLocation = {
        id,
        kind: "location",
        patterns,
        location: { latitude, longitude, accuracy },
        timezone,
        locationName,
        label:
          payload.label !== undefined
            ? normalizeSiteLocationLabel(payload.label)
            : (existing?.label ?? null),
        updatedAt: Date.now(),
      };
      const next = inPlace ? list.map((e) => (e.id === id ? entry : e)) : [...list, entry];

      let updated: Settings;
      try {
        updated = await updateSettings({ siteLocations: next });
      } catch {
        return { error: "STORAGE_ERROR" };
      }
      noteLocalSiteLocationEdit(id, stamp);

      // 11. Deliver, inside the queue so broadcasts go out in write order.
      await deliverSiteLocationChange(updated);
      return { success: true, id };
    });

  // Site group and link patterns have their data built and stored first,
  // after the lookups above and before that job (the site-group job finishes
  // before the site-location job starts, so the lock order holds). A failure
  // stores nothing.
  const tokens = patterns.filter(isSiteGroupToken);
  if (tokens.length === 0) return writeSiteLocation();
  const result = await withSiteGroupData(tokens, writeSiteLocation);
  if (!result.ok) {
    return {
      error: result.error,
      ...(result.token !== undefined ? { pattern: result.token } : {}),
      ...(result.skipped !== undefined ? { skipped: result.skipped } : {}),
    };
  }
  return result.value;
}

/**
 * Broadcast, re-badge, and re-sync CDP after a site-location write. The change
 * is already stored (and pushed to the app), so a failed step is logged, the
 * rest still run, and the handler still reports success. Reporting "not saved"
 * for a stored change would have the user retry a create (and meet
 * PATTERN_IN_USE from it) or see a removed entry come back until the next load.
 */
async function deliverSiteLocationChange(updated: Settings): Promise<void> {
  const steps: Array<[string, () => Promise<void>]> = [
    ["broadcast", () => broadcastSettingsToTabs(updated)],
    ["badge", () => updateBadge()],
    ["engine-level sync", () => syncDebuggerSpoofing(updated)],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      logger.error(`Site location saved, but its ${name} failed:`, error);
    }
  }
}

/**
 * REMOVE_SITE_LOCATION handler. With a `pattern`, removes just that pattern
 * (this backs "Use main location" for one site of a multi-site entry) and the
 * entry with it when it was the last. Without one, removes the entry. An
 * unknown id or pattern is a no-op success. Broadcasts, re-badges, and
 * re-syncs CDP after a successful save. Runs entirely in the site-location
 * queue, like the final step of a save, and is stamped on arrival, so an
 * earlier save of the same entry still waiting on its lookups won't write it
 * back.
 */
export function handleRemoveSiteLocation(
  payload: RemoveSiteLocationPayload
): Promise<SiteLocationResponse> {
  const stamp = stampSiteLocationRequest();
  return runSiteLocationJob(async (): Promise<SiteLocationResponse> => {
    const id = payload?.id;
    const settings = await loadSettings();
    const list = settings.siteLocations;
    const entry = list.find((e) => e.id === id);
    if (!entry) {
      return { success: true, id };
    }

    let next: SiteLocation[];
    let removed: readonly string[];
    if (typeof payload.pattern === "string") {
      const canonical = parseSiteLocationEntry(payload.pattern) ?? payload.pattern;
      if (!entry.patterns.includes(canonical)) {
        return { success: true, id };
      }
      const remaining = entry.patterns.filter((p) => p !== canonical);
      removed = [canonical];
      next =
        remaining.length === 0
          ? list.filter((e) => e.id !== id)
          : list.map((e) => (e.id === id ? { ...e, patterns: remaining } : e));
    } else {
      removed = entry.patterns;
      next = list.filter((e) => e.id !== id);
    }

    let updated: Settings;
    try {
      updated = await updateSettings({ siteLocations: next });
    } catch {
      return { error: "STORAGE_ERROR" };
    }
    noteLocalSiteLocationEdit(entry.id, stamp);
    // A removed group or link may have left data nothing references.
    if (removed.some(isSiteGroupToken)) void pruneSiteGroupDataSoon();

    await deliverSiteLocationChange(updated);
    return { success: true, id };
  });
}
