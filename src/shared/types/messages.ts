import type {
  AccuracySetting,
  Location,
  LocationName,
  LocaleSpoofing,
  LocationPrecision,
  PrecisionCadence,
  Timezone,
  Settings,
  ScopeMode,
} from "./settings";
import type { SpoofedLocalePayload } from "@/shared/locale/resolver";

/**
 * All supported message types for inter-component communication.
 */
export type MessageType =
  | "SET_LOCATION"
  | "SET_PROTECTION_STATUS"
  | "SET_WEBRTC_PROTECTION"
  | "SET_PRESERVE_GEO_PROMPT"
  | "SET_DEBUGGER_MODE"
  | "ANNOUNCE_WORKER_FETCH"
  | "GEOCODE_QUERY"
  | "GET_SETTINGS"
  | "UPDATE_SETTINGS"
  | "COMPLETE_ONBOARDING"
  | "CHECK_TAB_INJECTION"
  | "PING"
  | "SYNC_VPN"
  | "DISABLE_VPN_SYNC"
  | "CLEAR_LOCATION"
  | "SET_DEBUG_LOGGING"
  | "SET_VERBOSITY_LEVEL"
  | "SET_THEME"
  | "SET_UI_LANGUAGE"
  | "SAVE_FAVORITE"
  | "REMOVE_FAVORITE"
  | "RENAME_FAVORITE"
  | "SET_SCOPE_MODE"
  | "ADD_SCOPE_SITE"
  | "REMOVE_SCOPE_SITE"
  | "SET_ACCURACY"
  | "SET_PRECISION"
  | "SET_PRECISION_CADENCE"
  | "SET_LOCALE_SPOOFING"
  | "SAVE_SITE_LOCATION"
  | "REMOVE_SITE_LOCATION"
  | "GET_SITE_GROUPS"
  | "GET_SITE_GROUP_INDEX"
  | "UPDATE_SITE_GROUPS";

/**
 * Generic message structure for runtime messaging.
 */
export interface Message<T = unknown> {
  type: MessageType;
  payload?: T;
}

// --- Payload types for each message ---

export interface SetLocationPayload {
  latitude: number;
  longitude: number;
}

export interface SetProtectionStatusPayload {
  enabled: boolean;
}

export interface SetWebRTCProtectionPayload {
  enabled: boolean;
}

/** Toggles the "preserve permission prompts" geolocation behavior. */
export interface SetPreserveGeoPromptPayload {
  enabled: boolean;
}

/**
 * Toggles Engine-level (chrome.debugger / CDP) timezone spoofing. Chromium
 * only. `debugger` is a required permission there; the popup requests the
 * optional `webNavigation` permission when it sends `enabled: true`, and
 * removes it after sending `enabled: false`.
 */
export interface SetDebuggerModePayload {
  enabled: boolean;
}

/**
 * Sent by the content-script Worker / ServiceWorker wrapper just
 * before it hands off to the real browser constructor so the
 * background script's webRequest.filterResponseData listener knows
 * the next request for `url` is a worker script (not a regular
 * `<script>` tag) and should be modified.
 *
 * The background registers the URL in a short-lived allowlist; the
 * webRequest listener matches incoming requests against that list.
 * No response is needed — this is fire-and-forget.
 */
export interface AnnounceWorkerFetchPayload {
  url: string;
}

export interface GeocodeQueryPayload {
  query: string;
}

export interface CheckTabInjectionPayload {
  tabId: number;
}

// --- Response types ---

export interface GeocodeResult {
  name: string;
  latitude: number;
  longitude: number;
  city: string;
  country: string;
}

export interface GeocodeResponse {
  results?: GeocodeResult[];
  error?: "TIMEOUT" | "NETWORK" | "NO_RESULTS";
  message?: string;
}

export interface InjectionStatus {
  injected: boolean;
  error: string | null;
}

/**
 * Payload sent from background to content scripts when settings change.
 */
export interface SetDebugLoggingPayload {
  enabled: boolean;
}

export interface SetVerbosityLevelPayload {
  level: string;
}

export interface SetThemePayload {
  theme: "system" | "light" | "dark";
}

/**
 * Sets the popup UI language override. `language` is a supported `_locales`
 * code, or `""` to follow the browser UI language. Popup-only preference — no
 * tab broadcast is needed since it affects nothing outside the popup.
 */
export interface SetUiLanguagePayload {
  language: string;
}

export interface UpdateSettingsPayload {
  enabled: boolean;
  location: Location | null;
  timezone: Timezone | null;
  /**
   * Engine-level Spoofing (Chromium's `chrome.debugger` mode) sets the zone in
   * the engine for this page. `timezone` is still this page's zone: each frame
   * keeps its native Date/Intl only where the engine already reports that zone,
   * and installs the injected overrides for it where it doesn't (a cross-site
   * iframe in its own process, a refused or cancelled session, an override that
   * hasn't landed yet). False on Firefox and Safari, and for a document Chrome
   * is prerendering. The page world gets only this boolean, never the real zone.
   */
  engineTimezone: boolean;
  /**
   * With `engineTimezone`: false when an older zone command to this tab was
   * still in flight after the background stopped waiting for it, so the
   * engine can still move to another zone. No frame keeps native Date/Intl
   * on such a delivery, whatever its engine reports when it arrives: the
   * injected overrides take `timezone`, and the frame stays in Engine-level
   * mode, so the workers it starts keep re-checking the engine's zone. True
   * otherwise.
   */
  engineTimezoneSettled: boolean;
  debugLogging: boolean;
  verbosityLevel: string;
  /**
   * When true the injected script wraps RTCPeerConnection (both the
   * constructor and getStats) so no ICE candidates are ever gathered
   * or surfaced, regardless of what `browser.privacy.network.
   * webRTCIPHandlingPolicy` does at the browser layer.
   *
   * This closes two gaps left by the browser-level policy:
   *   - Firefox only honours `disable_non_proxied_udp` when a proxy
   *     is configured; without one, srflx still leaks.
   *   - Safari doesn't expose `browser.privacy` at all.
   */
  webrtcProtection: boolean;
  /**
   * When true, the injected geolocation override triggers the browser's native
   * permission prompt (via the real API) and substitutes spoofed coords only on
   * grant, and `permissions.query` reports the real state instead of a forced
   * "granted". Off by default. Engine-independent (content-script behavior).
   */
  preserveGeolocationPrompt: boolean;
  /**
   * How the spoofed `GeolocationCoordinates.accuracy` value should be
   * produced. Threaded end-to-end so the injected page-world script
   * resolves accuracy using the user's chosen setting rather than
   * falling back to auto mode. The content script attaches this onto
   * the dispatched `location` object, where the injected Resolver
   * reads it (see SpoofedLocation.accuracySetting).
   */
  accuracySetting: AccuracySetting;
  /**
   * Per-install stable seed the Resolver uses to deterministically
   * derive the accuracy value. Delivered alongside `accuracySetting`
   * so the page-emitted value matches the popup's Details panel for
   * the same device class (both consume the real seed).
   */
  accuracySeed: number;
  /**
   * The ALREADY-RESOLVED Reported Language, or `null` to leave the real locale
   * untouched.
   *
   * The background resolves this (Pro gate → mode → mapping tables → engine
   * capability check) and ships only the outcome, so the page world never
   * receives the user's mode, the zone/country mapping data, or the
   * `Accept-Language` string. `null` covers every "don't spoof" case: the
   * feature being off, no spoofed timezone in `match` mode, an unmapped zone, or
   * a tag this engine has no data for.
   *
   * Delivered regardless of `enabled` — like `timezone` — because the injected
   * overrides gate on `enabled` themselves.
   */
  locale: SpoofedLocalePayload | null;
}

/** The UPDATE_SETTINGS message a tab receives. `revision` rides on the envelope, never in the payload. */
export interface UpdateSettingsMessage {
  type: "UPDATE_SETTINGS";
  payload: UpdateSettingsPayload;
  revision?: number;
}

/** A content script's GET_SETTINGS reply: its page payload plus the revision it was built from. Isolated world only. */
export type ContentSettingsReply = UpdateSettingsPayload & { revision?: number };

/**
 * Optional GET_SETTINGS payload. Extension pages send none.
 */
export interface GetSettingsPayload {
  /** Content scripts: this document is its tab's top frame (`window.top === window`). */
  topFrame?: boolean;
}

/**
 * Response shape for GET_SETTINGS messages.
 */
export type GetSettingsResponse = Settings;

// --- VPN Sync types ---

export type VpnSyncErrorCode =
  "IP_DETECTION_FAILED" | "GEOLOCATION_FAILED" | "IP_BLOCKED" | "NETWORK";

export interface SyncVpnPayload {
  forceRefresh?: boolean;
}

export interface SyncVpnSuccessResponse {
  latitude: number;
  longitude: number;
  city: string;
  country: string;
  ip: string;
}

export interface SyncVpnErrorResponse {
  error: VpnSyncErrorCode;
  message: string;
}

export type SyncVpnResponse = SyncVpnSuccessResponse | SyncVpnErrorResponse;

// --- Favorites payload types ---

export interface SaveFavoritePayload {
  id: string;
  latitude: number;
  longitude: number;
  city: string;
  country: string;
  displayName: string;
  label: string | null;
}

export interface RemoveFavoritePayload {
  id: string;
}

export interface RenameFavoritePayload {
  id: string;
  label: string;
}

// --- Favorites response types ---

export interface FavoriteSuccessResponse {
  success: true;
}

export interface FavoriteErrorResponse {
  error: "AT_CAPACITY" | "STORAGE_ERROR";
}

export type FavoriteResponse = FavoriteSuccessResponse | FavoriteErrorResponse;

// --- Site-scoping payload types ---

export interface SetScopeModePayload {
  scopeMode: ScopeMode;
}

export interface ScopeSitePayload {
  list: "allowlist" | "denylist";
  /**
   * A Filters entry: a glob-style URL pattern (see `parsePattern`), an exact
   * address (`=host`), a site group (`geosite:name[@attr]`), or a list from a
   * link (`list:https://...`); see `parseFilterEntry`. Background re-validates.
   */
  pattern: string;
}

// --- Accuracy payload types ---

export interface SetAccuracyPayload {
  accuracySetting: AccuracySetting;
}

// --- Location precision payload types ---

export interface SetPrecisionPayload {
  precision: LocationPrecision;
}

/** How often approximate mode draws a new point. Invalid values are stored as "never". */
export interface SetPrecisionCadencePayload {
  cadence: PrecisionCadence;
}

// --- Reported-Language payload types ---

export interface SetLocaleSpoofingPayload {
  localeSpoofing: LocaleSpoofing;
}

// --- Site-scoping response types ---

export interface ScopeSuccessResponse {
  success: true;
  /** A site group or link entry: its usable entry count and skipped rules. */
  siteGroup?: { count: number; skipped: number };
}

/**
 * Why a site group or link entry couldn't be added. Nothing is stored.
 *   - `UNKNOWN_GROUP`: no catalog list has that name.
 *   - `EMPTY_GROUP`: the list has no entries with every requested `@attr`.
 *   - `LINK_FAILED`: the download failed (network, status, timeout, non-https).
 *   - `LINK_EMPTY`: the download has no usable entries (`skipped` counts the rest).
 *   - `LINK_TOO_LARGE`: over 10 MB or 250,000 entries.
 *   - `STORAGE_FULL`: the stored group data would pass its 5,000,000-char cap.
 */
export type SiteGroupErrorCode =
  | "UNKNOWN_GROUP"
  | "EMPTY_GROUP"
  | "LINK_FAILED"
  | "LINK_EMPTY"
  | "LINK_TOO_LARGE"
  | "STORAGE_FULL";

export interface ScopeErrorResponse {
  error: "INVALID_PATTERN" | "STORAGE_ERROR" | SiteGroupErrorCode;
  /** The site group or link token the error is about. */
  token?: string;
  /** LINK_EMPTY: rules that were read but not used. */
  skipped?: number;
}

export type ScopeResponse = ScopeSuccessResponse | ScopeErrorResponse;

// --- Site-location payload and response types ---

/**
 * Create or edit a site location. The background re-parses every pattern,
 * resolves the timezone (never storing a fallback), and computes accuracy, so
 * the popup sends only what the user chose.
 */
export interface SaveSiteLocationPayload {
  /** Present when editing; an unknown id is saved as a new entry. */
  id?: string;
  /** Raw site patterns (host-only grammar); re-parsed and deduped by the background. */
  patterns: string[];
  latitude: number;
  longitude: number;
  /** The chosen place's name; omitted or null means "look it up" (or keep it, when unchanged). */
  locationName?: LocationName | null;
  /** Omitted keeps the existing label on edit; null or "" clears it. */
  label?: string | null;
}

/**
 * Remove a site location, or just one of its patterns (the entry goes when its
 * last pattern does). An unknown id or pattern is a no-op success.
 */
export interface RemoveSiteLocationPayload {
  id: string;
  pattern?: string;
}

export type SiteLocationErrorCode =
  | "INVALID_PATTERN"
  | "PATTERN_IN_USE"
  | "AT_CAPACITY"
  | "TOO_MANY_PATTERNS"
  | "INVALID_LOCATION"
  | "TIMEZONE_UNAVAILABLE"
  | "STORAGE_ERROR"
  /** A remove or save of the same entry that arrived later was written first. */
  | "SUPERSEDED"
  | SiteGroupErrorCode;

export type SiteLocationResponse =
  | { success: true; id: string }
  | {
      error: SiteLocationErrorCode;
      /** The offending pattern (INVALID_PATTERN, PATTERN_IN_USE, and the site group codes). */
      pattern?: string;
      /** The entry that already owns `pattern` (PATTERN_IN_USE). */
      ownerId?: string;
      /** LINK_EMPTY: rules that were read but not used. */
      skipped?: number;
    };

// --- Site group types ---

/** One stored site group or link token, as the popup shows it. */
export interface SiteGroupSummary {
  token: string;
  kind: "group" | "link";
  /** The list name (`google`), or a link's derived name (`direct-list`). */
  name: string;
  /** Usable entries (domains plus fulls). */
  count: number;
  /** Rules that were read but not used. */
  skipped: number;
  /** When the data was last built or downloaded (ms). */
  updatedAt: number;
  /** A newer catalog lacks this list or leaves it empty; the last good copy stays in use. */
  missingUpstream?: boolean;
  /** A link's last refresh failed; the last good copy stays in use. */
  lastError?: "LINK_FAILED" | "LINK_EMPTY" | "LINK_TOO_LARGE" | null;
}

/** The catalog and refresh state the popup shows. */
export interface SiteGroupsStatus {
  /** The release of the catalog in use (bundled or downloaded), or null. */
  release: string | null;
  releasedAt: string | null;
  /** When the last refresh checked the CDN (ms), or null. */
  checkedAt: number | null;
  /** The last refresh's failure, or null. */
  lastError: "NETWORK" | "INVALID" | null;
  /** A refresh is running now. */
  updating: boolean;
}

/** GET_SITE_GROUPS response. `available` is false where site groups are hidden (Safari). */
export interface SiteGroupsResponse {
  available: boolean;
  status: SiteGroupsStatus;
  /** Every stored token's summary plus its framed `d`/`f` strings. */
  groups: Record<string, SiteGroupSummary & { d: string; f: string }>;
}

/** GET_SITE_GROUP_INDEX response: every catalog list's name and entry count, by name. */
export interface SiteGroupIndexResponse {
  release: string | null;
  lists: { name: string; count: number }[];
}

/** UPDATE_SITE_GROUPS ("Update now") response. */
export type SiteGroupsUpdateResponse =
  | { success: true; status: SiteGroupsStatus }
  | { error: "NETWORK" | "INVALID" | "NOT_AVAILABLE"; status: SiteGroupsStatus };
