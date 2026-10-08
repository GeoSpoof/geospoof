/**
 * Location coordinates with accuracy.
 */
export interface Location {
  /** Latitude in decimal degrees (-90 to 90) */
  latitude: number;
  /** Longitude in decimal degrees (-180 to 180) */
  longitude: number;
  /** Accuracy in meters */
  accuracy: number;
}

/**
 * Timezone information for a location.
 */
export interface Timezone {
  /** IANA timezone identifier (e.g., "America/Los_Angeles") */
  identifier: string;
  /** Minutes from UTC (e.g., 480 for PST) */
  offset: number;
  /** DST offset in minutes */
  dstOffset: number;
  /** True if timezone was estimated from longitude rather than API lookup */
  fallback?: boolean;
}

/**
 * Display name information for a location.
 */
export interface LocationName {
  /** City name */
  city: string;
  /** Country name */
  country: string;
  /** Full display name (e.g., "San Francisco, CA, USA") */
  displayName: string;
}

/**
 * A saved favorite location.
 */
export interface Favorite {
  /** Unique identifier — timestamp-based string, e.g. Date.now().toString() */
  id: string;
  latitude: number;
  longitude: number;
  /** City name from reverse geocode */
  city: string;
  /** Country name from reverse geocode */
  country: string;
  /** Full display name from reverse geocode, capped at 100 characters */
  displayName: string;
  /** User-defined label; overrides city when non-empty. null = use city fallback */
  label: string | null;
}

/**
 * Maximum number of saved favorites.
 *
 * Enforced in two places: the SAVE_FAVORITE handler (rejects with AT_CAPACITY)
 * and the load-time validator (defensive slice against hand-edited storage).
 * The Swift app mirrors this value as `favoritesCapacity` in SpoofModel.swift —
 * keep the two in sync.
 */
export const MAX_FAVORITES = 50;

/**
 * Site-scoping mode. "all" preserves the pre-1.1 global behavior.
 */
export type ScopeMode = "all" | "allowlist" | "denylist";

/** How the spoofed GeolocationCoordinates.accuracy value is produced. */
export type AccuracySetting =
  | { mode: "auto" }
  | { mode: "fixed"; meters: number }
  | { mode: "range"; min: number; max: number };

/** Single canonical fallback when no setting/context is available. */
export const DEFAULT_ACCURACY_M = 45; // desktop Wi-Fi band midpoint, integer

/**
 * Location quantum (decimal places) used when deriving the stable value.
 * Coarse on purpose (~11km at 1dp) so continuous movement / route playback
 * does not re-roll accuracy every few meters; only a meaningfully different
 * place lands in a new grid cell.
 */
export const ACCURACY_GRID_DP = 1;

export const DEFAULT_ACCURACY_SETTING: AccuracySetting = { mode: "auto" };

/**
 * How the reported latitude/longitude is derived from the user's chosen
 * location (the Anchor, `Settings.location`).
 *
 * DISTINCT from {@link AccuracySetting}: accuracy sets the reported
 * `GeolocationCoordinates.accuracy` *number* while the point stays exact; this
 * moves the *point itself*. The two are independent — different stored fields,
 * different seeds, different modules.
 *
 *   - `exact`       → report the Anchor coordinates verbatim (default; the
 *                     pre-feature behavior).
 *   - `approximate` → report a deterministic random point within `radiusMeters`
 *                     of the Anchor (a phone-style "approximate location").
 */
export type LocationPrecision = { mode: "exact" } | { mode: "approximate"; radiusMeters: number };

/** Default: report the exact chosen point (pre-feature behavior). */
export const DEFAULT_LOCATION_PRECISION: LocationPrecision = { mode: "exact" };

/**
 * Inclusive bounds (in meters) an `approximate` radius is clamped to.
 *
 * The surfaced presets stay at or below ~10km so the offset point remains in
 * the Anchor's timezone under normal conditions (keeping every signal
 * coherent). `MAX_PRECISION_RADIUS_M` is a wider defensive clamp guarding
 * against hand-edited storage, not a value the UI offers.
 */
export const MIN_PRECISION_RADIUS_M = 50;
export const MAX_PRECISION_RADIUS_M = 50000; // 50km defensive clamp

/**
 * How the browser's reported language/locale is derived — the "Reported
 * Language" feature.
 *
 *   - `off`    → report the real browser locale (default; pre-feature behavior).
 *   - `match`  → report the dominant locale of the spoofed location, derived
 *                offline from `timezone.identifier`.
 *   - `custom` → report an explicit BCP47 tag the user chose (e.g. `fr-FR`).
 *
 * DISTINCT from {@link Settings.uiLanguage}, which controls the language of
 * GeoSpoof's own popup UI and is never touched by this feature. This one governs
 * what *websites* see: `navigator.language`, `navigator.languages`, every `Intl`
 * default locale, the `toLocale*` family, and the `Accept-Language` header.
 *
 * Default is `off` because locale spoofing is visibly disruptive — many sites
 * switch language outright — so it must be opt-in.
 *
 * Unlike `accuracySetting` and `locationPrecision`, this needs no per-install
 * seed: resolution is fully deterministic from the setting plus the spoofed
 * timezone, with no randomization.
 */
export type LocaleSpoofing =
  { mode: "off" } | { mode: "match" } | { mode: "custom"; locale: string };

/** Default: report the real browser locale (pre-feature behavior). */
export const DEFAULT_LOCALE_SPOOFING: LocaleSpoofing = { mode: "off" };

/**
 * Complete extension settings persisted in browser.storage.local.
 */
export interface Settings {
  /** Whether location spoofing is active */
  enabled: boolean;
  /** Spoofed location coordinates, or null if not set */
  location: Location | null;
  /** Timezone information for the spoofed location */
  timezone: Timezone | null;
  /** Cached display name for the spoofed location */
  locationName: LocationName | null;
  /** Whether WebRTC IP leak protection is enabled */
  webrtcProtection: boolean;
  /**
   * When true, GeoSpoof surfaces the browser's native geolocation permission
   * prompt instead of silently auto-granting spoofed coordinates: the injected
   * override calls the real API to trigger the prompt and only swaps in spoofed
   * coords after the user grants (denials pass through), and `permissions.query`
   * reports the real state rather than a forced "granted". Off by default to
   * preserve the seamless VPN-companion experience; turning it on gives per-site
   * control and reduces the always-granted fingerprinting signal. Applies on
   * every engine (it's a content-script behavior, independent of debugger mode).
   */
  preserveGeolocationPrompt: boolean;
  /** Whether the user has completed onboarding */
  onboardingCompleted: boolean;
  /** Settings schema version (for migrations) */
  version: string;
  /** Timestamp of last settings update (milliseconds since epoch) */
  lastUpdated: number;
  /** Whether VPN sync mode is the active location method */
  vpnSyncEnabled: boolean;
  /**
   * Chromium only: when true, GeoSpoof spoofs the TIMEZONE at the browser level
   * via the chrome.debugger API (Chrome DevTools Protocol's Emulation domain,
   * `setTimezoneOverride`) instead of the page-world content-script override.
   * The CDP override applies to every frame AND worker — including module /
   * service workers — even on the very first synchronous script, closing the
   * worker-timezone leaks the Chromium content-script path can't cover (no
   * `webRequest.filterResponseData` on Chromium MV3). The trade-off is the
   * persistent "GeoSpoof started debugging this browser" notification bar, so
   * it's strictly opt-in and gated behind the optional `debugger` permission
   * (requested at runtime from the popup). While it's on, only the injected
   * TIMEZONE override is suppressed (redundant); WebRTC protection still runs
   * through the content script. Always false on Firefox/Safari (no
   * chrome.debugger equivalent).
   *
   * GEOLOCATION is deliberately NOT driven through CDP, even in this mode — it
   * stays on the injected content-script path. Reasons:
   *   1. Minimal upside. `navigator.geolocation` is a Window-only API (not
   *      exposed to workers), so the worker-coverage benefit that justifies CDP
   *      for timezone doesn't exist for geolocation. The only edge CDP would buy
   *      is cold start: it could answer the very first `getCurrentPosition` at
   *      native latency instead of after the injected path defers for the
   *      settings round-trip (see `waitForSettings`). But that's a timing-
   *      fidelity nicety, not correctness — the injected deferral already
   *      guarantees no real-location leak at cold start — and it's negated by
   *      reason 2 (early readiness doesn't make geo prompt-free).
   *   2. Real downside. CDP's `setGeolocationOverride` only takes effect once
   *      the origin already holds the geolocation permission, so making it
   *      prompt-free requires `Browser.grantPermissions`, which grants the
   *      origin geolocation while DENYING all its other permissions — clobbering
   *      unrelated site state — and mixes a Browser-domain (global) command into
   *      a per-tab attach, complicating teardown.
   *   3. The injected path is already strictly better here: it replaces
   *      `getCurrentPosition` outright, so it's reliably prompt-free, race-free,
   *      and per-tab scope-aware, with no debugging bar. (See
   *      `Settings.preserveGeolocationPrompt` for opting back into the native
   *      prompt — that's a separate, engine-independent content-script toggle.)
   * The injected geolocation override therefore keeps running in debugger mode;
   * see the timezone-only suppression in background `broadcastSettingsToTabs` /
   * the GET_SETTINGS scoped payload, and `src/background/debugger-spoof.ts`.
   */
  debuggerModeEnabled: boolean;
  /**
   * App→extension gate (Safari only): when true, the iOS app has signaled that
   * this user is NOT entitled to automatic background VPN sync (non-Pro, or the
   * "Automatic Background Sync" toggle is off). Fail-open: defaults false so
   * macOS Safari / Chrome / Firefox / Android Firefox are unaffected and a
   * Pro subscriber is never wrongly blocked. Only the iOS app ever sets it true.
   */
  autoSyncBlocked: boolean;
  /**
   * App→extension gate (Safari only): when true, the iOS app has signaled this
   * user isn't entitled to Pro-only *configuration* features — currently
   * per-site filtering (allowlist/denylist). The extension forces scope "all"
   * so a free user always spoofs everywhere and can't narrow it. Fail-open:
   * defaults false, so macOS Safari / Chrome / Firefox are unaffected and only
   * the iOS app ever sets it true. (Shared across Pro config gates, e.g. custom
   * accuracy, so we don't grow a flag per feature.)
   */
  proFeaturesBlocked: boolean;
  /** Whether debug logging is enabled */
  debugLogging: boolean;
  /** Active verbosity level threshold for the debug logger */
  verbosityLevel: string;
  /** UI theme preference */
  theme: "system" | "light" | "dark";
  /**
   * Popup UI language override. Empty string (the default) means "follow the
   * browser UI language" — the popup then localizes via the native
   * `browser.i18n` path. A non-empty value is a `_locales` code (e.g. "ru",
   * "pt_BR") the user picked in Advanced settings to force a specific language
   * regardless of the browser's; see `SUPPORTED_UI_LOCALES` and the override
   * loader in src/popup/i18n.ts.
   */
  uiLanguage: string;
  /** Saved favorite locations */
  favorites: Favorite[];
  /** Which sites are spoofed when `enabled` is true */
  scopeMode: ScopeMode;
  /**
   * Canonical glob-style URL Patterns spoofed in allowlist mode (schema 1.2+).
   * Each entry is a `[scheme://]host[:port][/path]` pattern produced by
   * `parsePattern`; a bare host is a superset of the pre-1.2 normalized
   * hostname (apex + subdomains), so 1.1 lists migrate losslessly.
   */
  allowlist: string[];
  /** Canonical glob-style URL Patterns excluded in denylist mode (schema 1.2+); see `allowlist`. */
  denylist: string[];
  /** How the spoofed GeolocationCoordinates.accuracy value is produced */
  accuracySetting: AccuracySetting;
  /** Per-install, persisted; stable derivation source for auto accuracy */
  accuracySeed: number;
  /**
   * How the reported coordinates are derived from `location` (the Anchor):
   * report it exactly, or a deterministic random point within a radius. The
   * Anchor stored in `location` is never mutated — the offset is applied only
   * to the coordinates delivered to pages. Independent of the accuracy setting.
   */
  locationPrecision: LocationPrecision;
  /**
   * Per-install, persisted; stable derivation source for the approximate-
   * location offset. Dedicated to precision and fully independent of
   * `accuracySeed` (separate field, separate validation/generation). `0` means
   * unseeded — the first save assigns a real value.
   */
  precisionSeed: number;
  /**
   * How the language/locale reported to websites is derived: off, matched to the
   * spoofed location, or an explicit BCP47 tag. Defaults to `off`.
   *
   * Independent of `uiLanguage` (the popup's own display language) — that one is
   * about GeoSpoof's UI, this one is about what sites see.
   */
  localeSpoofing: LocaleSpoofing;
}

/**
 * Default settings used when no saved settings exist.
 */
export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  location: null,
  timezone: null,
  locationName: null,
  webrtcProtection: false,
  preserveGeolocationPrompt: false,
  onboardingCompleted: false,
  version: "1.2",
  // Epoch 0 (not Date.now()): a never-saved settings object hasn't been
  // "updated" yet. On Safari first run the app→extension adoption gate in
  // app-bridge.ts compares the app's pending-write timestamp against this; a
  // Date.now() default would make the freshly-booted extension look newer than
  // the user's earlier in-app setup and silently discard it. saveSettings()
  // always stamps Date.now() before persisting, so stored settings are real.
  lastUpdated: 0,
  vpnSyncEnabled: false,
  debuggerModeEnabled: false,
  autoSyncBlocked: false,
  proFeaturesBlocked: false,
  debugLogging: false,
  verbosityLevel: "INFO",
  theme: "system",
  uiLanguage: "",
  favorites: [],
  scopeMode: "all",
  allowlist: [],
  denylist: [],
  accuracySetting: { mode: "auto" },
  accuracySeed: 0,
  locationPrecision: { mode: "exact" },
  precisionSeed: 0,
  localeSpoofing: { mode: "off" },
};
