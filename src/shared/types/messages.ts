import type {
  AccuracySetting,
  Location,
  LocaleSpoofing,
  LocationPrecision,
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
  | "SET_LOCALE_SPOOFING";

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
 * Toggles browser-level (chrome.debugger / CDP) geo+timezone spoofing.
 * Chromium only — the popup requests the optional `debugger` permission before
 * sending `enabled: true`, and revokes it after sending `enabled: false`.
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
  /** Canonical glob-style URL pattern (see `parsePattern`); background re-validates. */
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

// --- Reported-Language payload types ---

export interface SetLocaleSpoofingPayload {
  localeSpoofing: LocaleSpoofing;
}

// --- Site-scoping response types ---

export interface ScopeSuccessResponse {
  success: true;
}

export interface ScopeErrorResponse {
  error: "INVALID_PATTERN" | "STORAGE_ERROR";
}

export type ScopeResponse = ScopeSuccessResponse | ScopeErrorResponse;
