/**
 * Page-bound payloads, built in one place.
 *
 * Every payload that reaches a page goes through this module: the per-tab
 * `UPDATE_SETTINGS` payload (broadcast, content-script `GET_SETTINGS`, the
 * injection-check alarm, and new tabs) and the Firefox document_start
 * bootstrap. Duplicated builders once leaked the raw precision anchor on two
 * paths that nobody had updated, so a new per-tab field belongs here, not at a
 * call site.
 */

import type { Settings } from "@/shared/types/settings";
import type { UpdateSettingsPayload } from "@/shared/types/messages";
import { computeEffectivePreserveGeoPrompt } from "@/shared/utils/scope";
import { resolveSiteSettings } from "@/shared/utils/site-locations";
import { computeEffectiveAccuracySetting } from "@/shared/accuracy/resolver";
import { resolvePageLocale } from "@/shared/locale/resolver";
import { resolveCurrentPageLocation } from "./precision-cadence";
import { isRestrictedUrl } from "./restricted-url";

/** The inlined Firefox bootstrap payload: the synchronous-surface subset of the page payload. */
export type BootstrapPayload = { enabled: true } & Pick<
  UpdateSettingsPayload,
  "timezone" | "location" | "webrtcProtection" | "locale"
>;

/**
 * Build the per-tab `UPDATE_SETTINGS` payload for a tab whose top-level URL is
 * `topLevelUrl`.
 *
 * The background is the sole gatekeeper for the per-tab spoofing decision: the
 * `enabled` field is that tab's `Effective_Enabled` value, computed from its
 * top-level URL via the shared `computeEffectiveEnabled` source of truth (Req
 * 8.1, 8.2). The non-scope fields are equal to the persisted Settings (Req
 * 8.3), except that a matching site location supplies `location`, `timezone`,
 * and (in Match mode) `locale` via `resolveSiteSettings`. The allowlist/denylist
 * arrays and the site-location list are never included — `UpdateSettingsPayload`
 * has no list keys, so the lists cannot leak (privacy invariant).
 */
export async function buildPagePayload(
  settings: Settings,
  topLevelUrl: string | undefined
): Promise<UpdateSettingsPayload> {
  // Resolve Effective_Enabled for this tab against its top-level URL (Req 8.1,
  // 8.2), then the site location, if one matches. Restricted or undeterminable
  // URLs resolve to false (Req 8.6, 8.7). Out of scope, `r.settings` is the
  // input itself, so an entry's coordinates can't reach a page Filters keep
  // GeoSpoof off. Only location, timezone, and locale follow the site; every
  // other field stays global.
  const r = resolveSiteSettings(settings, topLevelUrl, isRestrictedUrl);

  // When browser-level (chrome.debugger) spoofing is active on Chromium, CDP
  // owns the TIMEZONE (it covers every frame/worker before first script).
  // Withhold the timezone from the injected path so its Date/Intl overrides
  // no-op (they gate on having timezone data) — but keep `enabled` and
  // `location` so the injected GEOLOCATION override still runs (CDP can't make
  // geolocation reliably prompt-free). WebRTC is independent. Compiled out on
  // Firefox/Safari.
  const debuggerActive = __CHROMIUM__ && settings.debuggerModeEnabled;

  return {
    enabled: r.enabled,
    // Approximate-location precision, when enabled, offsets the reported point
    // within its radius; `exact` (the default) returns the anchor unchanged.
    // The anchor in storage is never mutated. On iOS Safari a non-Pro user is
    // gated back to exact (fail-open elsewhere). `resolveCurrentPageLocation`
    // is the shared resolver, so every page-bound payload agrees on the point
    // for the current cadence period (location-precision Req 5.2). A site
    // location's point is the anchor here, with the global seed and cadence.
    location: await resolveCurrentPageLocation(r.settings),
    timezone: debuggerActive ? null : r.settings.timezone,
    debugLogging: settings.debugLogging,
    verbosityLevel: settings.verbosityLevel,
    webrtcProtection: settings.webrtcProtection,
    preserveGeolocationPrompt: computeEffectivePreserveGeoPrompt(
      settings.preserveGeolocationPrompt,
      settings.proFeaturesBlocked
    ),
    // Custom accuracy is Pro-gated on iOS Safari: force Realistic ("auto") for a
    // free user so the page can't receive a pinned accuracy. Fail-open +
    // Safari-only (no effect on macOS / Chrome / Firefox).
    accuracySetting: computeEffectiveAccuracySetting(
      settings.accuracySetting,
      settings.proFeaturesBlocked
    ),
    accuracySeed: settings.accuracySeed,
    // Reported Language, resolved here so the page world receives only the
    // outcome — never the mode or the zone/country mapping data. Pro-gated back
    // to "off" for a non-entitled Safari user. `null` means "leave the real
    // locale alone", which is also the default (Req 12.4). In Match mode the
    // locale follows the site location's zone.
    locale: resolvePageLocale(
      settings.localeSpoofing,
      r.settings.timezone?.identifier ?? null,
      settings.proFeaturesBlocked
    ),
  };
}

/**
 * Build the payload inlined into the Firefox document_start bootstrap script.
 * The caller only registers it when spoofing is on and a timezone is set.
 */
export async function buildBootstrapPayload(settings: Settings): Promise<BootstrapPayload> {
  return {
    enabled: true,
    timezone: settings.timezone,
    // Offset the location for approximate-precision mode so the exact anchor
    // is never inlined into the MAIN-world global (and any early geolocation
    // read at cold start sees the same point the async path delivers). The
    // shared resolver gives the point for the current cadence period, the
    // same one every other page-bound builder delivers.
    location: await resolveCurrentPageLocation(settings),
    webrtcProtection: settings.webrtcProtection,
    // Inline the resolved locale so a page's very first synchronous
    // `navigator.language` / `Intl` read is already spoofed instead of racing
    // the async settings path. Resolution is deterministic, so this value is
    // identical to the one the async path delivers moments later — no
    // cold-start flip.
    locale: resolvePageLocale(
      settings.localeSpoofing,
      settings.timezone?.identifier ?? null,
      settings.proFeaturesBlocked
    ),
  };
}
