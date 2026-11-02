/**
 * Settings Management
 * Load, save, validate, and update extension settings in browser.storage.local.
 */

import type {
  AccuracySetting,
  Favorite,
  LocationPrecision,
  ScopeMode,
  Settings,
} from "@/shared/types/settings";
import {
  DEFAULT_ACCURACY_M,
  DEFAULT_SETTINGS,
  MIN_PRECISION_RADIUS_M,
  MAX_PRECISION_RADIUS_M,
  MAX_FAVORITES,
} from "@/shared/types/settings";
import { isSupportedLocale } from "@/shared/i18n/locales";
import { validateLocaleSpoofing } from "@/shared/locale/resolver";
import { validatePrecisionCadence } from "@/shared/precision/cadence";
import { createLogger } from "@/shared/utils/debug-logger";
import { parsePattern } from "@/shared/utils/scope";
import { validateSiteLocations } from "@/shared/utils/site-locations";
import { getLastSyncedIp } from "./vpn-sync";
import { updateBootstrapRegistration } from "./bootstrap-register";

/**
 * Re-exported so the settings module remains the one import site for settings
 * validators, alongside `validateAccuracySetting` / `validateLocationPrecision`.
 * The implementation lives in `shared/locale/resolver.ts` because the popup and
 * the Safari app bridge validate through it too, and there must be exactly one
 * repair path for a stored `localeSpoofing`.
 */
export { validateLocaleSpoofing };

/**
 * Re-exported for the same reason: the implementation lives in
 * `shared/utils/site-locations.ts` next to the grammar it re-parses, and the
 * Safari app bridge adopts lists through it too.
 */
export { validateSiteLocations };

const logger = createLogger("BG");

/** Permitted Scope_Mode values (Req 2.1, 2.2, 3.8). */
const VALID_SCOPE_MODES = new Set<ScopeMode>(["all", "allowlist", "denylist"]);

/**
 * Sanitize a stored allowlist/denylist value into a clean Pattern string[]
 * (Advanced Filtering Req 13.4, 14.1; superseding the site-scoping domain
 * sanitizer). Drops non-array inputs, non-string entries, and entries the
 * Pattern_Parser reports as invalid; replaces each retained entry with its
 * canonical Pattern form; removes duplicates by canonical form keeping the
 * first occurrence, producing a deterministically ordered list. Because every
 * previously stored (schema 1.1) hostname is a valid bare-host Pattern with
 * identical matching meaning, this carries a 1.1 list forward losslessly
 * (Req 13.3).
 */
function sanitizeDomainList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const canonical = parsePattern(entry);
    if (canonical === null) {
      continue;
    }
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

/** Inclusive bounds the emitted accuracy is constrained to (Req 6.2, 7.3, 7.4). */
const ACCURACY_MIN_M = 1;
const ACCURACY_MAX_M = 10000;

/** Round to an integer and clamp into [ACCURACY_MIN_M, ACCURACY_MAX_M]. */
function clampAccuracyMeters(value: number): number {
  return Math.min(ACCURACY_MAX_M, Math.max(ACCURACY_MIN_M, Math.round(value)));
}

/** Clamp a precision radius into [MIN_PRECISION_RADIUS_M, MAX_PRECISION_RADIUS_M]. */
function clampPrecisionRadius(value: number): number {
  return Math.min(MAX_PRECISION_RADIUS_M, Math.max(MIN_PRECISION_RADIUS_M, value));
}

/**
 * Repair an arbitrary stored `accuracySetting` value into one of the three
 * valid AccuracySetting shapes with in-range numbers (Req 7.1–7.4):
 *   - absent / non-object / unknown mode → { mode: "auto" }
 *   - fixed with non-finite meters       → { mode: "auto" }
 *   - fixed otherwise                     → meters clamped+rounded into range
 *   - range with non-finite bound(s)      → { mode: "auto" }
 *   - range otherwise                     → swap inverted bounds, clamp both
 */
export function validateAccuracySetting(value: unknown): AccuracySetting {
  if (!value || typeof value !== "object") {
    return { mode: "auto" };
  }

  const setting = value as { mode?: unknown; meters?: unknown; min?: unknown; max?: unknown };

  switch (setting.mode) {
    case "auto":
      return { mode: "auto" };

    case "fixed": {
      if (typeof setting.meters !== "number" || !Number.isFinite(setting.meters)) {
        return { mode: "auto" };
      }
      return { mode: "fixed", meters: clampAccuracyMeters(setting.meters) };
    }

    case "range": {
      if (
        typeof setting.min !== "number" ||
        typeof setting.max !== "number" ||
        !Number.isFinite(setting.min) ||
        !Number.isFinite(setting.max)
      ) {
        return { mode: "auto" };
      }
      let lo = setting.min;
      let hi = setting.max;
      if (lo > hi) {
        [lo, hi] = [hi, lo];
      }
      return { mode: "range", min: clampAccuracyMeters(lo), max: clampAccuracyMeters(hi) };
    }

    default:
      return { mode: "auto" };
  }
}

/**
 * Repair an arbitrary stored `locationPrecision` value into one of the two
 * valid LocationPrecision shapes (Req 7.1–7.5):
 *   - absent / non-object / unknown mode        → { mode: "exact" }
 *   - approximate with non-finite radiusMeters   → { mode: "exact" }
 *   - approximate otherwise                       → radiusMeters clamped into
 *                                                   [MIN_PRECISION_RADIUS_M,
 *                                                    MAX_PRECISION_RADIUS_M]
 *
 * Independent of the accuracy validation above: precision has its own field,
 * its own seed, and its own repair path.
 */
export function validateLocationPrecision(value: unknown): LocationPrecision {
  if (!value || typeof value !== "object") {
    return { mode: "exact" };
  }

  const setting = value as { mode?: unknown; radiusMeters?: unknown };

  switch (setting.mode) {
    case "exact":
      return { mode: "exact" };

    case "approximate": {
      if (typeof setting.radiusMeters !== "number" || !Number.isFinite(setting.radiusMeters)) {
        return { mode: "exact" };
      }
      return { mode: "approximate", radiusMeters: clampPrecisionRadius(setting.radiusMeters) };
    }

    default:
      return { mode: "exact" };
  }
}

/** A stored seed is usable only when it is a finite, non-zero number (Req 5.5). */
function isValidAccuracySeed(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value !== 0;
}

/** Generate a fresh per-install accuracy seed in [0, 2^31). */
function generateAccuracySeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * A stored precision seed is usable only when it is a finite, non-zero number.
 * Separate from the accuracy seed check so the two features stay independent.
 */
function isValidPrecisionSeed(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value !== 0;
}

/** Generate a fresh per-install precision seed in [0, 2^31). */
function generatePrecisionSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * Return `v` when it is a usable precision seed, otherwise a fresh one. Used by
 * `SET_PRECISION_CADENCE` so a non-Never cadence always persists a real seed:
 * `loadSettings()` returns the unvalidated defaults (seed `0`) when nothing is
 * stored, and an unpersisted seed would be re-minted on every load, moving the
 * hour/day phase and the point each time. A valid seed is returned unchanged.
 */
export function ensureValidPrecisionSeed(v: unknown): number {
  return isValidPrecisionSeed(v) ? v : generatePrecisionSeed();
}

/**
 * Load settings from storage with validation and corruption handling
 */
export async function loadSettings(): Promise<Settings> {
  try {
    const result = await browser.storage.local.get("settings");
    const settings: unknown = result.settings;

    if (!settings || typeof settings !== "object") {
      logger.warn("Settings not found or invalid, using defaults");
      return { ...DEFAULT_SETTINGS };
    }

    const validated = validateSettings(settings);

    // NOTE: a freshly assigned per-install accuracy seed (Req 5.5) is returned
    // in-memory here but intentionally NOT written from this read path —
    // loadSettings does not persist (see initialize() in index.ts, which owns
    // the one-time startup persistence for migrated settings). The assigned
    // seed is durably written on the next save (startup migration persistence
    // for upgraded installs, or any subsequent settings update).
    return validated;
  } catch (error) {
    logger.error("Failed to load settings:", error);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Validate settings object and fix corruption
 */
export function validateSettings(settings: Partial<Settings>): Settings {
  const validated: Settings = { ...DEFAULT_SETTINGS };

  if (typeof settings.enabled === "boolean") {
    validated.enabled = settings.enabled;
  }

  if (settings.location && typeof settings.location === "object") {
    const { latitude, longitude, accuracy } = settings.location;

    if (
      typeof latitude === "number" &&
      typeof longitude === "number" &&
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180
    ) {
      validated.location = {
        latitude,
        longitude,
        accuracy: typeof accuracy === "number" && accuracy > 0 ? accuracy : DEFAULT_ACCURACY_M,
      };
    } else {
      logger.warn("Invalid coordinates in settings, resetting location");
    }
  }

  if (settings.timezone && typeof settings.timezone === "object") {
    const { identifier, offset, dstOffset } = settings.timezone;

    if (
      typeof identifier === "string" &&
      typeof offset === "number" &&
      typeof dstOffset === "number"
    ) {
      validated.timezone = { identifier, offset, dstOffset };
    }
  }

  if (settings.locationName && typeof settings.locationName === "object") {
    const { city, country, displayName } = settings.locationName;

    if (typeof displayName === "string") {
      validated.locationName = {
        city: typeof city === "string" ? city : "",
        country: typeof country === "string" ? country : "",
        displayName,
      };
    }
  }

  if (typeof settings.webrtcProtection === "boolean") {
    validated.webrtcProtection = settings.webrtcProtection;
  }

  if (typeof settings.preserveGeolocationPrompt === "boolean") {
    validated.preserveGeolocationPrompt = settings.preserveGeolocationPrompt;
  }

  if (typeof settings.onboardingCompleted === "boolean") {
    validated.onboardingCompleted = settings.onboardingCompleted;
  }

  if (typeof settings.version === "string") {
    validated.version = settings.version;
  }

  // Schema migration (Advanced Filtering Req 13.1, 13.2): stamp "1.2" when the
  // stored version is "1.0", "1.1", or absent, leaving newer version strings
  // untouched. All copied-through fields (enabled, location, etc.) are
  // preserved (Req 13.7), and the allowlist/denylist migrate losslessly because
  // sanitizeDomainList re-parses each entry through the Pattern_Parser, which
  // accepts every previously valid hostname as a bare-host Pattern (Req 13.3).
  if (
    validated.version === "1.0" ||
    validated.version === "1.1" ||
    typeof settings.version !== "string"
  ) {
    validated.version = "1.2";
  }

  // scopeMode (Req 2.1, 2.2, 1.6, 3.8): preserve a permitted value, otherwise
  // fall back to "all".
  validated.scopeMode =
    typeof settings.scopeMode === "string" && VALID_SCOPE_MODES.has(settings.scopeMode)
      ? settings.scopeMode
      : "all";

  // allowlist + denylist (Req 1.4, 13.4, 13.5): sanitize each list into
  // canonical Patterns, dropping invalid/duplicate entries.
  validated.allowlist = sanitizeDomainList(settings.allowlist);
  validated.denylist = sanitizeDomainList(settings.denylist);

  if (typeof settings.lastUpdated === "number") {
    validated.lastUpdated = settings.lastUpdated;
  }

  if (typeof settings.vpnSyncEnabled === "boolean") {
    validated.vpnSyncEnabled = settings.vpnSyncEnabled;
  }

  if (typeof settings.debuggerModeEnabled === "boolean") {
    validated.debuggerModeEnabled = settings.debuggerModeEnabled;
  }

  if (typeof settings.autoSyncBlocked === "boolean") {
    validated.autoSyncBlocked = settings.autoSyncBlocked;
  }

  if (typeof settings.proFeaturesBlocked === "boolean") {
    validated.proFeaturesBlocked = settings.proFeaturesBlocked;
  }

  if (typeof settings.debugLogging === "boolean") {
    validated.debugLogging = settings.debugLogging;
  }

  const VALID_VERBOSITY_LEVELS = new Set(["ERROR", "WARN", "INFO", "DEBUG", "TRACE"]);
  if (
    typeof settings.verbosityLevel === "string" &&
    VALID_VERBOSITY_LEVELS.has(settings.verbosityLevel)
  ) {
    validated.verbosityLevel = settings.verbosityLevel;
  }

  const VALID_THEMES = new Set(["system", "light", "dark"]);
  if (typeof settings.theme === "string" && VALID_THEMES.has(settings.theme)) {
    validated.theme = settings.theme;
  }

  // uiLanguage: "" (follow browser) or a supported `_locales` code. Anything
  // else (stale/unknown code, manual storage edit) falls back to the default.
  if (
    typeof settings.uiLanguage === "string" &&
    (settings.uiLanguage === "" || isSupportedLocale(settings.uiLanguage))
  ) {
    validated.uiLanguage = settings.uiLanguage;
  }

  if (Array.isArray(settings.favorites)) {
    const validatedFavorites: Favorite[] = [];
    for (const entry of settings.favorites) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.id === "string" &&
        typeof entry.latitude === "number" &&
        typeof entry.longitude === "number" &&
        entry.latitude >= -90 &&
        entry.latitude <= 90 &&
        entry.longitude >= -180 &&
        entry.longitude <= 180 &&
        typeof entry.city === "string" &&
        typeof entry.country === "string" &&
        typeof entry.displayName === "string" &&
        (entry.label == null || typeof entry.label === "string")
      ) {
        validatedFavorites.push({
          id: entry.id,
          latitude: entry.latitude,
          longitude: entry.longitude,
          city: entry.city,
          country: entry.country,
          displayName: entry.displayName.slice(0, 100),
          // Normalize a missing/undefined label to null so the stored shape
          // always matches the `string | null` contract (some producers omit
          // the key for null).
          label: entry.label ?? null,
        });
      }
    }
    // Enforce capacity cap on load (defensive against manual storage edits)
    validated.favorites = validatedFavorites.slice(0, MAX_FAVORITES);
  } else {
    // Missing field (first run / migration) — treat as empty
    validated.favorites = [];
  }

  // accuracySetting (Req 7.1–7.4): repair an absent/unknown/malformed value
  // into one of the three valid shapes with in-range numbers.
  validated.accuracySetting = validateAccuracySetting(settings.accuracySetting);

  // accuracySeed (Req 5.5): keep a valid stored seed; otherwise assign a fresh
  // per-install seed. loadSettings persists it once when it was freshly
  // assigned during a load.
  validated.accuracySeed = isValidAccuracySeed(settings.accuracySeed)
    ? settings.accuracySeed
    : generateAccuracySeed();

  // locationPrecision (Req 7.1–7.5): repair an absent/unknown/malformed value
  // into a valid shape; approximate radii are clamped into bounds.
  validated.locationPrecision = validateLocationPrecision(settings.locationPrecision);

  // precisionSeed (Req 1.4): keep a valid stored seed; otherwise assign a fresh
  // per-install seed, independently of accuracySeed. Persisted on the next save.
  validated.precisionSeed = isValidPrecisionSeed(settings.precisionSeed)
    ? settings.precisionSeed
    : generatePrecisionSeed();

  // precisionCadence: repair an absent/unknown value (including the deferred
  // "page") to "never", which is the pre-cadence behavior.
  validated.precisionCadence = validatePrecisionCadence(settings.precisionCadence);

  // localeSpoofing (locale-spoofing Req 11.1–11.3): repair an absent/unknown/
  // malformed value to `off`. A `custom` tag is canonicalized and checked
  // against this engine's locale data; anything unusable collapses to `off` so
  // the user's real locale is reported rather than a half-applied one.
  validated.localeSpoofing = validateLocaleSpoofing(settings.localeSpoofing);

  // siteLocations: repair an absent/malformed value to [] and drop invalid
  // entries (bad coordinates, fallback zones, unknown kinds, patterns another
  // entry already claims). Absent repairs to [] with no version bump.
  validated.siteLocations = validateSiteLocations(settings.siteLocations);

  return validated;
}

/**
 * Save settings to storage with quota exceeded handling.
 *
 * Safari (with unsigned/development extensions) has a bug where it rejects
 * browser.storage.local.set() with a spurious "Exceeded storage quota" error
 * when the new serialized value is smaller than the currently stored value.
 * The workaround is to remove the key first, then write the new value.
 * This is safe because loadSettings() falls back to DEFAULT_SETTINGS on any
 * read failure, so a crash between remove and set is recoverable.
 */
export async function saveSettings(settings: Settings): Promise<void> {
  settings.lastUpdated = Date.now();

  try {
    await browser.storage.local.set({ settings });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isQuotaError =
      msg.includes("QuotaExceededError") ||
      msg.includes("Exceeded storage quota") ||
      msg.includes("quota");

    if (isQuotaError) {
      // Safari bug: rejects writes that shrink the stored value.
      // Delete first, then write fresh.
      logger.warn("Storage write failed (Safari quota bug), retrying via remove+set");
      try {
        await browser.storage.local.remove("settings");
        await browser.storage.local.set({ settings });
      } catch (retryError) {
        logger.error("Failed to save settings even after remove+set:", retryError);
        throw retryError;
      }
    } else {
      logger.error("Failed to save settings:", error);
      throw error;
    }
  }

  // Push the current region to the native host (Safari only) so the
  // containing app can display the active spoofed location without needing
  // to read browser.storage.local directly. Fire-and-forget — a failure
  // here must never block saving the actual settings.
  if (__SAFARI__) {
    void pushRegionToNativeHost(settings);
  }

  // Refresh the Firefox document_start bootstrap user script so the next page
  // load can apply the timezone synchronously (closing the cold-start race for
  // Date/Intl). Firefox-only and fully guarded; fire-and-forget so it never
  // blocks or fails the save. Compiled out on Chromium / Safari.
  if (__FIREFOX__) {
    void updateBootstrapRegistration(settings);
  }
}

/**
 * Push the current spoofed region to the containing native app via
 * browser.runtime.sendNativeMessage → SafariWebExtensionHandler →
 * UserDefaults(suiteName: "group.com.moonloaf.geospoof").
 *
 * Called after every successful settings save. Non-throwing.
 */
async function pushRegionToNativeHost(settings: Settings): Promise<void> {
  try {
    let ip: string | null = null;
    if (settings.vpnSyncEnabled) {
      ip = (await getLastSyncedIp()) ?? null;
    }
    await browser.runtime.sendNativeMessage("com.moonloaf.geospoof", {
      type: "REGION_UPDATE",
      enabled: settings.enabled,
      locationName: settings.locationName ?? null,
      location: settings.location ?? null,
      timezone: settings.timezone ?? null,
      webrtcProtection: settings.webrtcProtection,
      // "Preserve location prompts" — a plain bool like webrtcProtection. The
      // app decodes + adopts it; it's Pro-gated on iOS, but the raw preference
      // is bridged (the app is the Pro authority and the tab-payload gate in
      // the background still forces the free behavior for non-Pro users).
      preserveGeolocationPrompt: settings.preserveGeolocationPrompt,
      vpnSyncEnabled: settings.vpnSyncEnabled,
      ip,
      // Favorites are synced through the bridge as a JSON string so the native
      // handler stays a dumb passthrough (no nested-array bridging). The app
      // decodes it; last-writer-wins by region/pending timestamp as usual.
      favorites: JSON.stringify(settings.favorites ?? []),
      // Site-scoping: the mode is a scalar; the allow/deny lists ride as JSON
      // strings exactly like favorites (passthrough both ways).
      scopeMode: settings.scopeMode,
      allowlist: JSON.stringify(settings.allowlist ?? []),
      denylist: JSON.stringify(settings.denylist ?? []),
      // Spoofed-accuracy setting rides as a JSON string (mirroring favorites /
      // allow/deny). The app decodes + adopts it; accuracySeed stays
      // extension-owned and is intentionally NOT bridged.
      accuracySetting: JSON.stringify(settings.accuracySetting),
      // Location-precision setting rides as a JSON string like accuracySetting;
      // the app decodes + adopts it. precisionSeed stays extension-owned and is
      // intentionally NOT bridged. The bridged region/location stays the anchor.
      locationPrecision: JSON.stringify(settings.locationPrecision),
      // Precision cadence ("Pick a new point") rides as a plain top-level string,
      // not JSON and never inside locationPrecision, so that JSON stays
      // byte-identical. The native handler stores it verbatim. Only the
      // preference crosses: the session id, held bucket, and precisionSeed stay
      // extension-owned, and a rollover saves nothing, so it never pushes.
      precisionCadence: settings.precisionCadence,
      // Reported-Language setting rides as a JSON string like the two above, so
      // the app can persist and relay it (last-writer-wins) even though the
      // control itself lives only in the browser popup for now. Only the raw
      // preference crosses the bridge — the *resolved* locale is derived in the
      // background per payload, never bridged.
      localeSpoofing: JSON.stringify(settings.localeSpoofing),
      // Site locations ride as a JSON string like favorites. The native handler
      // stores it as region_siteLocations verbatim; an older handler drops the
      // unknown key, so this stays inert until the app learns it.
      siteLocations: JSON.stringify(settings.siteLocations),
    });
  } catch (error) {
    // Swallow — native messaging may not be available in all contexts
    // (e.g., Firefox, Chromium, or Safari without the host app running).
    logger.debug("pushRegionToNativeHost: native message failed (expected on non-Safari):", error);
  }
}

/**
 * The same push without a save, for the app bridge's one-time region request
 * (`regionWanted`, see adoptPendingResponse in app-bridge.ts). Non-throwing.
 */
export const pushRegionNow = pushRegionToNativeHost;

/**
 * Get current settings (alias for loadSettings for consistency)
 */
export async function getSettings(): Promise<Settings> {
  return await loadSettings();
}

/**
 * Update settings with partial updates
 */
export async function updateSettings(updates: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const updated: Settings = { ...current, ...updates };
  await saveSettings(updated);
  return updated;
}
