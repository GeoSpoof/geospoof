/**
 * App → Extension bridge (Safari only)
 *
 * The native containing app writes a full "pending" desired-state snapshot into
 * the shared App Group container. The extension's JavaScript can't read that
 * container directly, so it asks the native handler (SafariWebExtensionHandler)
 * for it via browser.runtime.sendNativeMessage, and adopts it if the app acted
 * more recently than the extension's own last settings change.
 *
 * This is the inbound counterpart to the REGION_UPDATE push in settings.ts.
 */

import { createLogger } from "@/shared/utils/debug-logger";
import type { Favorite, ScopeMode, Settings, Timezone } from "@/shared/types/settings";
import { MAX_FAVORITES } from "@/shared/types/settings";
import { parsePattern } from "@/shared/utils/scope";
import { isValidIANATimezone } from "@/shared/utils/type-guards";
import { validatePrecisionCadence } from "@/shared/precision/cadence";
import {
  loadSettings,
  pushRegionNow,
  updateSettings,
  validateAccuracySetting,
  validateLocationPrecision,
  validateLocaleSpoofing,
  validateSiteLocations,
} from "./settings";
import { computeOffsets } from "./timezone";
import {
  applyPrecisionCadence,
  handleSetLocation,
  handleSetProtectionStatus,
  handleSetWebRTCProtection,
  handleSetPreserveGeoPrompt,
} from "./messages";
import { syncVpnLocation, clearIpGeoCache } from "./vpn-sync";
import { broadcastSettingsToTabs } from "./tabs";
import { updateBadge } from "./badge";
import { collectAccessReport } from "./website-access";

const logger = createLogger("BG");

export interface PendingSettings {
  updatedAt: number; // Unix seconds (Swift timeIntervalSince1970)
  enabled?: boolean;
  webrtc?: boolean;
  /**
   * App→extension "preserve location prompts" preference. A plain bool bridged
   * like `webrtc`. Adopted into settings.preserveGeolocationPrompt. Pro-gated on
   * iOS, but the background tab-payload gate independently forces the free
   * behavior for non-Pro users, so adopting the raw preference here is safe.
   */
  preservePrompt?: boolean;
  vpnSync?: boolean;
  cleared?: boolean;
  resync?: boolean;
  /**
   * App→extension gate: true when the iOS app says this user isn't entitled to
   * automatic background sync (non-Pro or toggle off). Adopted into
   * settings.autoSyncBlocked. Absent/false = allowed (fail-open).
   */
  autoSyncBlocked?: boolean;
  /**
   * App→extension gate: true when the iOS app says Pro-only config features
   * (per-site filtering, custom accuracy) aren't allowed (non-Pro). Adopted
   * into settings.proFeaturesBlocked. Absent/false = allowed (fail-open).
   */
  proFeaturesBlocked?: boolean;
  latitude?: number;
  longitude?: number;
  displayName?: string;
  /**
   * IANA timezone id the app already resolved for these coordinates (e.g.
   * "Asia/Tashkent"). Forwarded as the timezoneHint so the extension doesn't
   * have to re-resolve from coordinates — that offline lookup can fail (CDN
   * range hiccup) and fall back to null, which would leave the page leaking the
   * real zone even though the app knew the right one.
   */
  timezone?: string;
  favorites?: string; // JSON-encoded Favorite[] from the app
  scopeMode?: string; // "all" | "allowlist" | "denylist"
  allowlist?: string; // JSON-encoded string[] from the app
  denylist?: string; // JSON-encoded string[] from the app
  accuracySetting?: string; // JSON-encoded AccuracySetting from the app (accuracySeed stays extension-owned)
  locationPrecision?: string; // JSON-encoded LocationPrecision from the app (precisionSeed stays extension-owned)
  /**
   * JSON-encoded LocaleSpoofing (Reported Language) from the app. Only the raw
   * PREFERENCE crosses the bridge — the resolved locale is derived per payload in
   * the background and is never bridged, so the app can't put the page world and
   * the Accept-Language header out of step with each other.
   */
  localeSpoofing?: string;
  /**
   * Precision cadence ("Pick a new point") as a plain string, not JSON. Pro-gated
   * in the app's UI; the raw preference is adopted here, and the extension's
   * proFeaturesBlocked gate (computeEffectiveLocationPrecision) still forces the
   * Anchor for a non-Pro user, so adopting it is safe. Absent when the app
   * predates the bridge or hasn't learned a cadence yet. Validated through
   * validatePrecisionCadence on adoption; period state never crosses.
   */
  precisionCadence?: string;
  /**
   * JSON-encoded SiteLocation[] from the app. Unset until learned: the app must
   * not write pending_siteLocations until it has read region_siteLocations or
   * the user edited the list there, because `[]` is a real "clear the list".
   * Re-validated through validateSiteLocations on adoption (step 9).
   */
  siteLocations?: string;
}

/**
 * Field of the GET_PENDING_SETTINGS response (not an App Group key) that the
 * native handler sets to `true` while the app has no current per-site list.
 * It asks the extension to push its region once. Only the handler writes it,
 * and only adoptPendingResponse reads it. The geospoof-ios parity test reads
 * this literal, so keep it on one line.
 */
export const REGION_WANTED_FIELD = "regionWanted";

export interface PendingResponse {
  pending: PendingSettings | null;
  /**
   * The app's one-time request for a region push. It rides next to
   * `pending: null` too. Absent from an older handler, and anything but `true`
   * asks for nothing.
   */
  [REGION_WANTED_FIELD]?: boolean;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** `{ identifier, ...computeOffsets(identifier) }`, or null when the lookup throws. */
function bridgedTimezone(identifier: string): Timezone | null {
  try {
    return { identifier, ...computeOffsets(identifier) };
  } catch {
    return null;
  }
}

/**
 * Give bridged site locations full timezones before validation. The app may
 * store just the IANA id, or an object whose offsets didn't survive the trip;
 * both are recomputed here. Anything else passes through unchanged, and an
 * unrepairable zone is left as-is so validateSiteLocations drops the entry.
 */
function repairBridgedSiteLocationTimezones(entries: unknown[]): unknown[] {
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const tz = (entry as Record<string, unknown>).timezone;
    let identifier: string | null = null;
    if (typeof tz === "string") {
      identifier = tz;
    } else if (tz && typeof tz === "object") {
      const { identifier: id, offset, dstOffset } = tz as Record<string, unknown>;
      if (typeof id === "string" && !(Number.isFinite(offset) && Number.isFinite(dstOffset))) {
        identifier = id;
      }
    }
    if (identifier === null || !isValidIANATimezone(identifier)) return entry;
    const repaired = bridgedTimezone(identifier);
    return repaired ? { ...entry, timezone: repaired } : entry;
  });
}

/**
 * Ask the native host for the app-written desired-state snapshot and adopt it
 * if the app acted more recently than the extension's own last settings change
 * (symmetric last-writer-wins). Applies WebRTC, VPN sync, location/clear, and
 * the protection toggle. Never throws.
 */
export async function adoptPendingSettingsFromApp(): Promise<void> {
  if (!__SAFARI__) return;

  // Rides the request this function was already sending, rather than a message of its
  // own. The native handler stamps its heartbeat from every invocation regardless of
  // type, and this call already fires on background boot, tab switch, every navigation,
  // popup open and every content-script boot — so attaching the reading here costs no
  // extra native round trip and no extra App Group write, and it refreshes at exactly the
  // moments the answer can have changed.
  //
  // Sent as an envelope field, not as settings: it is an observation about the
  // environment, and the handler treats it that way. Omitted entirely when unknown, so
  // the app can tell "not granted" from "no answer".
  const access = await collectAccessReport();

  let response: PendingResponse | undefined;
  try {
    response = (await browser.runtime.sendNativeMessage("com.moonloaf.geospoof", {
      type: "GET_PENDING_SETTINGS",
      // Spread rather than assigned, so a field the engine couldn't answer is absent from
      // the message entirely. The handler treats absent as "no answer" and leaves the
      // stored value alone, which is what keeps "unknown" distinct from "denied".
      ...(access.allSites === undefined ? {} : { websiteAccess: access.allSites }),
      ...(access.origins === undefined ? {} : { websiteAccessOrigins: access.origins }),
      ...(access.privateBrowsing === undefined
        ? {}
        : { privateBrowsingAccess: access.privateBrowsing }),
    })) as PendingResponse;
  } catch (error) {
    logger.debug("adoptPendingSettingsFromApp: native message failed:", error);
    return;
  }

  await adoptPendingResponse(response);
}

/**
 * Act on the native host's GET_PENDING_SETTINGS response: adopt its snapshot,
 * then answer the app's region request. Split from adoptPendingSettingsFromApp
 * so tests can drive it: Vitest compiles `__SAFARI__` to false, which removes
 * the native fetch above. Production calls it only from there. Never throws.
 */
export async function adoptPendingResponse(response: PendingResponse | undefined): Promise<void> {
  // 1. Read the flag before the no-snapshot return below: the handler sends it
  // next to `pending: null` too, which is the usual case while the app is unset.
  const regionWanted = response?.[REGION_WANTED_FIELD] === true;
  const before = regionWanted ? (await loadSettings()).lastUpdated : 0;

  const pending = response?.pending;
  if (pending && typeof pending.updatedAt === "number") {
    // 2. Adoption first, awaited.
    await adoptPendingSnapshot(pending);
  }
  if (!regionWanted) return;

  // 3. Push only if adoption saved nothing: every save already pushed, through
  // saveSettings. So a push that isn't a save never carries a list older than
  // an app edit Safari hasn't adopted yet.
  const settings = await loadSettings();
  if (settings.lastUpdated !== before) return;
  pushRegionOnce(settings);
}

// 4. Single-flight. Adoption runs on background boot, tab activation, navigation
// start, popup open and content-script boot, so several calls can see the flag
// before the first push lands. The guard clears when the push settles, so a
// later adoption that still sees the flag (after a failed push, say) pushes again.
let regionPushInFlight = false;

function pushRegionOnce(settings: Settings): void {
  if (regionPushInFlight) return;
  regionPushInFlight = true;
  void pushRegionNow(settings).finally(() => {
    regionPushInFlight = false;
  });
}

/**
 * Adopt one app-written snapshot when it's newer than the extension's last
 * change (symmetric last-writer-wins on `updatedAt`), in numbered steps.
 * Exported so tests can drive it directly. Production calls it only from
 * adoptPendingResponse. Never throws.
 */
export async function adoptPendingSnapshot(pending: PendingSettings): Promise<void> {
  const settings = await loadSettings();

  // The app writes updatedAt as Unix seconds; settings.lastUpdated is Unix ms.
  const pendingAtMs = pending.updatedAt * 1000;

  // Only adopt if the app's action is newer than the last extension change.
  if (pendingAtMs <= settings.lastUpdated) {
    return;
  }

  logger.info("Adopting pending settings from app:", pending);

  try {
    // 1. WebRTC protection — apply only when it actually differs.
    if (typeof pending.webrtc === "boolean" && pending.webrtc !== settings.webrtcProtection) {
      await handleSetWebRTCProtection({ enabled: pending.webrtc });
    }

    // 1a. "Preserve location prompts" — plain bool, adopt only when it differs.
    // handleSetPreserveGeoPrompt persists + re-broadcasts (the broadcast's
    // Pro-gate forces the free behavior for a non-Pro user regardless).
    if (
      typeof pending.preservePrompt === "boolean" &&
      pending.preservePrompt !== settings.preserveGeolocationPrompt
    ) {
      await handleSetPreserveGeoPrompt({ enabled: pending.preservePrompt });
    }

    // 1b. Automatic-background-sync gate. The app is the authority on iOS Pro
    // entitlement (the extension can't tell iOS from macOS), so adopt its
    // autoSyncBlocked signal whenever it differs. Cheap settings write; takes
    // effect on the next resync trigger / startup.
    if (typeof pending.autoSyncBlocked === "boolean") {
      const latest = await loadSettings();
      if (latest.autoSyncBlocked !== pending.autoSyncBlocked) {
        await updateSettings({ autoSyncBlocked: pending.autoSyncBlocked });
      }
    }

    // 1c. Pro-only config gate (per-site filtering, custom accuracy). Same
    // app-as-authority rationale as 1b.
    if (typeof pending.proFeaturesBlocked === "boolean") {
      const latest = await loadSettings();
      if (latest.proFeaturesBlocked !== pending.proFeaturesBlocked) {
        await updateSettings({ proFeaturesBlocked: pending.proFeaturesBlocked });
      }
    }

    // 2. Location source: VPN sync, explicit clear, or a manual location.
    if (pending.vpnSync) {
      if (typeof pending.latitude === "number" && typeof pending.longitude === "number") {
        // The app already resolved the exit IP (shared device egress) — adopt
        // its coordinates as a VPN-synced location.
        const changed =
          !settings.location ||
          round4(settings.location.latitude) !== round4(pending.latitude) ||
          round4(settings.location.longitude) !== round4(pending.longitude);
        if (changed || !settings.vpnSyncEnabled) {
          await handleSetLocation(
            { latitude: pending.latitude, longitude: pending.longitude },
            {
              fromVpnSync: true,
              timezoneHint: pending.timezone,
              locationName: {
                city: "",
                country: "",
                displayName:
                  pending.displayName ||
                  `${pending.latitude.toFixed(5)}, ${pending.longitude.toFixed(5)}`,
              },
            }
          );
        }
        await updateSettings({ vpnSyncEnabled: true });
      } else {
        // No coords from the app — the extension owns IP detection + geolocation.
        const needSync = pending.resync === true || !settings.vpnSyncEnabled;
        if (needSync) {
          const result = await syncVpnLocation(true);
          if (!("error" in result)) {
            await handleSetLocation(
              { latitude: result.latitude, longitude: result.longitude },
              {
                fromVpnSync: true,
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
          } else {
            logger.warn("adoptPendingSettingsFromApp: VPN sync failed:", result);
          }
        }
        await updateSettings({ vpnSyncEnabled: true });
      }
    } else if (pending.cleared) {
      if (settings.location || settings.vpnSyncEnabled) {
        if (settings.vpnSyncEnabled) await clearIpGeoCache();
        const cleared = await updateSettings({
          location: null,
          timezone: null,
          locationName: null,
          vpnSyncEnabled: false,
        });
        await broadcastSettingsToTabs(cleared);
      }
    } else if (typeof pending.latitude === "number" && typeof pending.longitude === "number") {
      // Apply only when the location actually changed (avoids a redundant
      // reverse-geocode when the app just toggled something else).
      const changed =
        !settings.location ||
        round4(settings.location.latitude) !== round4(pending.latitude) ||
        round4(settings.location.longitude) !== round4(pending.longitude);
      if (changed) {
        await handleSetLocation(
          { latitude: pending.latitude, longitude: pending.longitude },
          {
            timezoneHint: pending.timezone,
            ...(pending.displayName
              ? { locationName: { city: "", country: "", displayName: pending.displayName } }
              : {}),
          }
        );
      }
    }

    // 3. Protection toggle — apply last, after location is settled.
    const current = await loadSettings();
    if (typeof pending.enabled === "boolean" && current.enabled !== pending.enabled) {
      await handleSetProtectionStatus({ enabled: pending.enabled });
    }

    // 4. Favorites — adopt the app's list when it differs. The app and
    // extension reconcile last-writer-wins by the pending/region timestamp,
    // same as every other field. (Concurrent edits on both sides resolve to
    // whichever wrote most recently — the whole list, not a per-item merge.)
    if (typeof pending.favorites === "string") {
      try {
        const parsed = JSON.parse(pending.favorites) as Favorite[];
        if (Array.isArray(parsed)) {
          const latest = await loadSettings();
          const next = parsed.slice(0, MAX_FAVORITES);
          if (JSON.stringify(latest.favorites) !== JSON.stringify(next)) {
            await updateSettings({ favorites: next });
          }
        }
      } catch (error) {
        logger.debug("adoptPendingSettingsFromApp: favorites parse failed:", error);
      }
    }

    // 5. Site-scoping — adopt the mode and the allow/deny lists when present
    // and changed. Entries are parsed as glob-style URL patterns + de-duplicated
    // here so the extension stays the source of truth for list hygiene
    // regardless of what the app stored, and so advanced patterns (wildcards,
    // ports, paths) survive the app→extension round-trip. A scope change
    // re-broadcasts per-tab and re-badges so open tabs and the toolbar reflect
    // the new decision without a manual reload.
    const scopeUpdates: Partial<Settings> = {};
    const VALID_SCOPE_MODES = new Set<ScopeMode>(["all", "allowlist", "denylist"]);
    const latestForScope = await loadSettings();

    if (
      typeof pending.scopeMode === "string" &&
      VALID_SCOPE_MODES.has(pending.scopeMode as ScopeMode) &&
      pending.scopeMode !== latestForScope.scopeMode
    ) {
      scopeUpdates.scopeMode = pending.scopeMode as ScopeMode;
    }

    const parsePatternList = (json: string | undefined): string[] | undefined => {
      if (typeof json !== "string") return undefined;
      let arr: unknown;
      try {
        arr = JSON.parse(json);
      } catch {
        return undefined;
      }
      if (!Array.isArray(arr)) return undefined;
      const seen = new Set<string>();
      const out: string[] = [];
      for (const entry of arr) {
        if (typeof entry !== "string") continue;
        const canonical = parsePattern(entry);
        if (canonical !== null && !seen.has(canonical)) {
          seen.add(canonical);
          out.push(canonical);
        }
      }
      return out;
    };

    const adoptedAllow = parsePatternList(pending.allowlist);
    if (adoptedAllow && JSON.stringify(adoptedAllow) !== JSON.stringify(latestForScope.allowlist)) {
      scopeUpdates.allowlist = adoptedAllow;
    }
    const adoptedDeny = parsePatternList(pending.denylist);
    if (adoptedDeny && JSON.stringify(adoptedDeny) !== JSON.stringify(latestForScope.denylist)) {
      scopeUpdates.denylist = adoptedDeny;
    }

    if (Object.keys(scopeUpdates).length > 0) {
      const updated = await updateSettings(scopeUpdates);
      await broadcastSettingsToTabs(updated);
      await updateBadge();
    }

    // 6. Accuracy setting — adopt the app's value when present and changed.
    // Rides as a JSON string like favorites/allow-deny; validated through the
    // same repair function the SET_ACCURACY handler uses so the extension stays
    // the source of truth for shape/range hygiene. accuracySeed is NOT bridged
    // (per-install, extension-owned).
    if (typeof pending.accuracySetting === "string") {
      try {
        const parsedAccuracy: unknown = JSON.parse(pending.accuracySetting);
        const validatedAccuracy = validateAccuracySetting(parsedAccuracy);
        const latestForAccuracy = await loadSettings();
        if (
          JSON.stringify(validatedAccuracy) !== JSON.stringify(latestForAccuracy.accuracySetting)
        ) {
          const updated = await updateSettings({ accuracySetting: validatedAccuracy });
          await broadcastSettingsToTabs(updated);
        }
      } catch (error) {
        logger.debug("adoptPendingSettingsFromApp: accuracySetting parse failed:", error);
      }
    }

    // 7. Location precision — adopt the app's value when present and changed.
    // Rides as a JSON string like accuracySetting; validated through the same
    // repair function the SET_PRECISION handler uses so the extension stays the
    // source of truth for shape/range hygiene. precisionSeed is NOT bridged
    // (per-install, extension-owned). The control itself lives only in the
    // browser popup, but the value round-trips so it survives the app's
    // last-writer-wins snapshots.
    if (typeof pending.locationPrecision === "string") {
      try {
        const parsedPrecision: unknown = JSON.parse(pending.locationPrecision);
        const validatedPrecision = validateLocationPrecision(parsedPrecision);
        const latestForPrecision = await loadSettings();
        if (
          JSON.stringify(validatedPrecision) !==
          JSON.stringify(latestForPrecision.locationPrecision)
        ) {
          const updated = await updateSettings({ locationPrecision: validatedPrecision });
          await broadcastSettingsToTabs(updated);
        }
      } catch (error) {
        logger.debug("adoptPendingSettingsFromApp: locationPrecision parse failed:", error);
      }
    }

    // 7a. Precision cadence ("Pick a new point") — a plain string, not JSON.
    // Adopted only when present and, once repaired by validatePrecisionCadence,
    // different from the stored value (an unknown "page" repairs to "never").
    // Goes through applyPrecisionCadence, the function SET_PRECISION_CADENCE
    // uses, so hour/day get their seed, held bucket, and rollover alarm. An
    // absent key (an app that predates the bridge or hasn't learned a cadence)
    // changes nothing. Its own try/catch so a failure never skips step 8.
    if (typeof pending.precisionCadence === "string") {
      try {
        const nextCadence = validatePrecisionCadence(pending.precisionCadence);
        const latestForCadence = await loadSettings();
        if (nextCadence !== latestForCadence.precisionCadence) {
          const result = await applyPrecisionCadence(nextCadence);
          if ("error" in result) {
            logger.warn("[cadence] app cadence not adopted:", result.error);
          }
        }
      } catch (error) {
        logger.warn("[cadence] app cadence adoption failed:", error);
      }
    }

    // 8. Reported Language — adopt the app's value when present and changed.
    // Rides as a JSON string like accuracySetting / locationPrecision, and is
    // validated through the same repair path the SET_LOCALE_SPOOFING handler
    // uses, so the extension stays the source of truth for shape hygiene AND for
    // whether this engine can actually honor a custom tag (the validator repairs
    // an unsupported tag to `off` rather than letting the app enable a locale
    // that would silently fall back). Like precision, the control lives only in
    // the browser popup, but the value round-trips so it survives the app's
    // last-writer-wins snapshots.
    if (typeof pending.localeSpoofing === "string") {
      try {
        const parsedLocale: unknown = JSON.parse(pending.localeSpoofing);
        const validatedLocale = validateLocaleSpoofing(parsedLocale);
        const latestForLocale = await loadSettings();
        if (JSON.stringify(validatedLocale) !== JSON.stringify(latestForLocale.localeSpoofing)) {
          const updated = await updateSettings({ localeSpoofing: validatedLocale });
          // Re-broadcast so live tabs pick up the new locale, and so the
          // Accept-Language rule is refreshed in the same step (both ride
          // broadcastSettingsToTabs).
          await broadcastSettingsToTabs(updated);
        }
      } catch (error) {
        logger.debug("adoptPendingSettingsFromApp: localeSpoofing parse failed:", error);
      }
    }

    // 9. Site locations — adopt the app's list when present and changed. Rides
    // as a JSON string like favorites. A non-array or invalid JSON is a no-op,
    // never a wipe; `[]` is a real "the app cleared the list". Bare IANA zone
    // ids are repaired with offsets, then every entry is re-validated, so the
    // extension stays the source of truth for list hygiene. Its own try/catch
    // so a failure here never undoes the steps above.
    if (typeof pending.siteLocations === "string") {
      try {
        const parsed: unknown = JSON.parse(pending.siteLocations);
        if (!Array.isArray(parsed)) throw new Error("siteLocations is not an array");
        const next = validateSiteLocations(repairBridgedSiteLocationTimezones(parsed));
        const latestForSites = await loadSettings();
        if (JSON.stringify(next) !== JSON.stringify(latestForSites.siteLocations)) {
          const updated = await updateSettings({ siteLocations: next });
          await broadcastSettingsToTabs(updated);
          await updateBadge();
        }
      } catch (error) {
        logger.debug("adoptPendingSettingsFromApp: siteLocations adoption failed:", error);
      }
    }

    logger.info("Pending settings adopted and applied.");
  } catch (error) {
    logger.error("Failed to adopt pending settings:", error);
  }
}
