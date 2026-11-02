/**
 * Shared mutable state, original API references, and constants.
 * All cross-module state is centralized here with controlled access via setters.
 */

import type { SpoofedLocation, TimezoneData, LocaleData, AnyFunction } from "./types";
import {
  decideNativeFractionalOffset,
  engineFamilyFromBuild,
} from "@/shared/native-offset-precision";

// ── Build-time declarations ──────────────────────────────────────────

/* eslint-disable no-var */
// `process.env.EVENT_NAME` is replaced at build time by Vite's `define` config.
declare var process: { env: Record<string, string | undefined> };
/* eslint-enable no-var */

// ── Constants ────────────────────────────────────────────────────────

/** Event name for settings updates (must match content script). */
export const EVENT_NAME: string = process.env.EVENT_NAME || "__x_evt";

/**
 * Event name for announcing an imminent worker-script fetch so the
 * background-script webRequest listener can allowlist the URL. One-way
 * (page-context → content script → background). Must match the
 * constant in `src/content/index.ts`.
 */
export const ANNOUNCE_EVENT_NAME: string = (process.env.EVENT_NAME || "__x_evt") + "_announce";

/**
 * Milliseconds to wait for settings before giving up.
 * This must be long enough to cover the background script round-trip on a
 * cold page load (GET_SETTINGS → background → content script → CustomEvent).
 * Falling through to the real API on timeout would leak the user's real
 * location to pages that call getCurrentPosition early (e.g. in <head>).
 */
export const SETTINGS_WAIT_TIMEOUT = 3000;

/**
 * True when the local getters and `toString` / `toTimeString` / `toDateString`
 * overrides should derive local time by shifting the epoch by the Intl
 * `shortOffset` value (V8, JavaScriptCore), false when they should read
 * `formatToParts` (SpiderMonkey). Both give the same whole-second wall clock;
 * the split mirrors how each engine computes local time.
 *
 * This selects the component path only. It does NOT decide the precision of
 * `getTimezoneOffset`; that is {@link nativeFractionalOffset}, which Chrome 156
 * changed without changing this.
 *
 * `InternalError` is a SpiderMonkey-only global exposed to web content; V8 and
 * JavaScriptCore do not define it.
 */
function detectComponentsViaShortOffset(): boolean {
  try {
    return typeof (globalThis as { InternalError?: unknown }).InternalError === "undefined";
  } catch {
    return true;
  }
}

export const componentsViaShortOffset: boolean = detectComponentsViaShortOffset();

// ── Override registry ────────────────────────────────────────────────

export const overrideRegistry = new Map<AnyFunction, string>();

// ── Explicit timezone instances tracking ─────────────────────────────

export const explicitTimezoneInstances = new WeakSet<Intl.DateTimeFormat>();

// ── Original API references ──────────────────────────────────────────
// Captured at module load time, before any overrides are applied.

// eslint-disable-next-line @typescript-eslint/unbound-method
export const originalFunctionToString = Function.prototype.toString;
// eslint-disable-next-line @typescript-eslint/unbound-method
export const originalCall = Function.prototype.call;

export const OriginalDate = Date;
export const OriginalDateParse = Date.parse;

// Geolocation originals (bound to navigator.geolocation)
export const originalGetCurrentPosition = navigator.geolocation.getCurrentPosition.bind(
  navigator.geolocation
);
export const originalWatchPosition = navigator.geolocation.watchPosition.bind(
  navigator.geolocation
);
export const originalClearWatch = navigator.geolocation.clearWatch.bind(navigator.geolocation);

// Unbound native geolocation methods, captured before overrides are applied.
// Unlike the bound `original*` refs above, these are invoked via
// `Reflect.apply(fn, self, args)` so the browser performs its own WebIDL
// brand check and argument coercion against an arbitrary `this` — reproducing
// the exact native TypeError (correct type, per-engine message, native stack)
// when the override is called with a foreign `this` or invalid arguments.
// See `reproduceNativeGeoError` in geolocation.ts. Reading the property off the
// instance yields the same function object as `Geolocation.prototype.<method>`.
/* eslint-disable @typescript-eslint/unbound-method */
export const nativeGetCurrentPosition = navigator.geolocation.getCurrentPosition;
export const nativeWatchPosition = navigator.geolocation.watchPosition;
export const nativeClearWatch = navigator.geolocation.clearWatch;
/* eslint-enable @typescript-eslint/unbound-method */

// Date prototype originals
// These are intentionally detached and always re-bound at call sites via `.call(this)`.
/* eslint-disable @typescript-eslint/unbound-method */
export const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
export const OriginalDateTimeFormat = Intl.DateTimeFormat;
export const originalResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
export const originalToString = Date.prototype.toString;
export const originalToTimeString = Date.prototype.toTimeString;
export const originalToLocaleString = Date.prototype.toLocaleString;
export const originalToLocaleDateString = Date.prototype.toLocaleDateString;
export const originalToDateString = Date.prototype.toDateString;
export const originalToLocaleTimeString = Date.prototype.toLocaleTimeString;
export const originalGetHours = Date.prototype.getHours;
export const originalGetMinutes = Date.prototype.getMinutes;
export const originalGetSeconds = Date.prototype.getSeconds;
export const originalGetMilliseconds = Date.prototype.getMilliseconds;
export const originalGetDate = Date.prototype.getDate;
export const originalGetDay = Date.prototype.getDay;
export const originalGetMonth = Date.prototype.getMonth;
export const originalGetFullYear = Date.prototype.getFullYear;
export const originalSetHours = Date.prototype.setHours;
export const originalSetMinutes = Date.prototype.setMinutes;
export const originalSetSeconds = Date.prototype.setSeconds;
export const originalSetMilliseconds = Date.prototype.setMilliseconds;
export const originalSetDate = Date.prototype.setDate;
export const originalSetMonth = Date.prototype.setMonth;
export const originalSetFullYear = Date.prototype.setFullYear;
export const originalSetTime = Date.prototype.setTime;
/* eslint-enable @typescript-eslint/unbound-method */

/**
 * True when this engine's native `getTimezoneOffset` keeps the seconds of a
 * pre-standard-time offset (SpiderMonkey, V8 from Chrome 156), false when it
 * truncates them toward zero (V8 before Chrome 156, JavaScriptCore). The
 * `getTimezoneOffset` override follows it in every realm, and the worker
 * payload receives it as a literal, so no surface disagrees with the engine.
 *
 * Decided by a behavior probe of the natives captured above: native
 * `getTimezoneOffset` against the native local getters at 1800-01-01 12:00 UTC
 * in the real zone. When the real zone has no seconds there (UTC, Warsaw,
 * Taipei, ...), it falls back to the build's engine and, on Chromium, the
 * `Chrome/N` major in the user agent. See `@/shared/native-offset-precision`.
 *
 * Must stay below the Date originals (it reads them, and `const` is in the TDZ
 * until then). This module is evaluated before `index.ts` installs any
 * override, and the MAIN-world script runs at `document_start` before any page
 * script, so the probe sees native functions and no page can observe it. It
 * allocates one Date and leaves nothing behind.
 */
export const nativeFractionalOffset: boolean = decideNativeFractionalOffset(
  {
    Date: OriginalDate,
    getTimezoneOffset: originalGetTimezoneOffset,
    getFullYear: originalGetFullYear,
    getMonth: originalGetMonth,
    getDate: originalGetDate,
    getHours: originalGetHours,
    getMinutes: originalGetMinutes,
    getSeconds: originalGetSeconds,
    getMilliseconds: originalGetMilliseconds,
  },
  engineFamilyFromBuild(),
  () => navigator.userAgent
);

// Permissions original (may be undefined if API unavailable)
export const originalPermissionsQuery = navigator.permissions?.query?.bind(navigator.permissions);

// Unbound native `Permissions.prototype.query`, captured before the override.
// Used to reproduce the browser's own brand-check error when `query` is called
// with a `this` that isn't a real `Permissions` object (native throws
// synchronously; our override must too). May be undefined if the Permissions
// API isn't exposed. See `permissions.ts`.
/* eslint-disable @typescript-eslint/unbound-method */
export const nativePermissionsQuery =
  typeof Permissions !== "undefined" && Permissions.prototype
    ? Permissions.prototype.query
    : undefined;
/* eslint-enable @typescript-eslint/unbound-method */

/**
 * Original WebRTC constructor reference, captured at module load
 * time before any overrides. May be `undefined` on engines that
 * don't expose WebRTC at all (very rare — essentially legacy
 * mobile browsers). Consumed by `webrtc.ts` to build the pristine
 * passthrough when protection is disabled and to subclass the
 * brand-checked prototype when protection is enabled.
 */
export const OriginalRTCPeerConnection: typeof RTCPeerConnection | undefined =
  typeof RTCPeerConnection !== "undefined" ? RTCPeerConnection : undefined;

// DOM method originals for iframe patching / DOM insertion wrapping
/* eslint-disable @typescript-eslint/unbound-method */
export const originalAppendChild = Node.prototype.appendChild;
export const originalInsertBefore = Node.prototype.insertBefore;
export const originalReplaceChild = Node.prototype.replaceChild;
export const originalAppend = Element.prototype.append;
export const originalPrepend = Element.prototype.prepend;
export const originalReplaceWith = Element.prototype.replaceWith;
export const originalInsertAdjacentElement = Element.prototype.insertAdjacentElement;
export const originalInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
/* eslint-enable @typescript-eslint/unbound-method */

// ── Mutable spoofing state ───────────────────────────────────────────

export let debugEnabled = false;
export let spoofingEnabled = false;
export let spoofedLocation: SpoofedLocation | null = null;
export let timezoneData: TimezoneData | null = null;
export let settingsReceived = false;
/**
 * Content-script-level WebRTC IP-leak protection flag.
 *
 * Set from the settings CustomEvent and consumed by the
 * `installWebRTCOverride` module. When `true` the wrapped
 * `RTCPeerConnection` constructor refuses to gather any ICE
 * candidates (blocks srflx, host, relay — everything), and
 * `.getStats()` strips address/ip fields from local-candidate
 * reports. When `false` the native API passes through untouched.
 *
 * Orthogonal to `spoofingEnabled` — a user could have location
 * spoofing off but WebRTC protection on (closes the leak in
 * real-location mode too, useful for VPN users).
 */
export let webrtcProtectionEnabled = false;

/**
 * Content-script-level "preserve permission prompts" flag.
 *
 * When false (default), the geolocation override answers `getCurrentPosition`
 * / `watchPosition` directly with spoofed coordinates and forces
 * `permissions.query` to report `"granted"` — so a site silently receives a
 * location and never sees the native browser prompt.
 *
 * When true, the override instead calls the real geolocation API to surface
 * the browser's own permission prompt; it substitutes spoofed coordinates only
 * after the user grants, and forwards denials/errors unchanged. The
 * `permissions.query` override also stops forcing `"granted"` and reports the
 * real permission state. This trades the seamless VPN-companion experience for
 * lower fingerprinting entropy (denied sites behave like a normal browser) and
 * genuine per-site user control. Set from the settings CustomEvent.
 */
export let preserveGeolocationPrompt = false;

/**
 * The Reported Language to report to the page, or `null` to report the real one.
 *
 * Set from the settings CustomEvent (and from the Firefox document_start
 * bootstrap) and read by `locale-overrides.ts` plus the locale injection inside
 * the `Intl.DateTimeFormat` and `Date.prototype.toLocale*` overrides.
 *
 * Orthogonal to `timezoneData`: a user can spoof a timezone without a locale or
 * vice versa, and the two overrides must not interfere. Every consumer gates on
 * `spoofingEnabled && localeData`, so an out-of-scope tab (which receives
 * `enabled: false`) reports its real locale even though the value was delivered.
 *
 * Note there is no separate "enabled" flag for this: the background sends `null`
 * for every don't-spoof case, so a non-null value always means "spoof this".
 */
export let localeData: LocaleData | null = null;

/**
 * The payload's `engineTimezone`: Engine-level Spoofing (Chromium) sets the
 * page's zone in the engine. Whether this realm's engine actually reports it is
 * decided per realm in `settings-listener.ts` (`timezoneData` is null where it
 * does). While true, the engine's own zone can change under the realm (an
 * override that lands or changes later), so the cached real zone is re-checked
 * (`computeEpochAdjustment`) and `lastModified` recovers the OS offset itself.
 * Always false on Firefox and Safari.
 */
export let engineTimezoneMode = false;

// Setter functions for state mutation from other modules
export function setSpoofingEnabled(v: boolean): void {
  spoofingEnabled = v;
}

export function setSpoofedLocation(v: SpoofedLocation | null): void {
  spoofedLocation = v;
}

export function setTimezoneData(v: TimezoneData | null): void {
  timezoneData = v;
}

export function setSettingsReceived(v: boolean): void {
  settingsReceived = v;
}

export function setDebugEnabled(v: boolean): void {
  debugEnabled = v;
}

export function setWebRTCProtectionEnabled(v: boolean): void {
  webrtcProtectionEnabled = v;
}

export function setPreserveGeolocationPrompt(v: boolean): void {
  preserveGeolocationPrompt = v;
}

export function setLocaleData(v: LocaleData | null): void {
  localeData = v;
}

export function setEngineTimezoneMode(v: boolean): void {
  engineTimezoneMode = v;
}
