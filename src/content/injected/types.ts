/**
 * Shared type definitions for the injected script modules.
 * This module contains only type definitions and interfaces — no runtime code.
 */

import type { AccuracySetting } from "@/shared/types/settings";

export interface SpoofedLocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
  /**
   * How the spoofed `accuracy` value should be produced. When absent the
   * Resolver falls back to {@link DEFAULT_ACCURACY_SETTING} (auto mode).
   */
  accuracySetting?: AccuracySetting;
  /**
   * Per-install stable seed used by the Resolver to deterministically derive
   * the accuracy value. When absent it defaults to `0`.
   */
  accuracySeed?: number;
}

/**
 * The Reported Language, already fully resolved by the background.
 *
 * The page world never sees the user's mode, the zone/country mapping tables, or
 * the `Accept-Language` string — only the tag to report and the list to hand back
 * from `navigator.languages`. Presence of this object is itself the signal that
 * locale spoofing is active; the background sends `null` for every "don't spoof"
 * case (feature off, no timezone in match mode, unmapped zone, or a tag this
 * engine has no data for).
 */
export interface LocaleData {
  /** Canonical BCP47 tag — the value `navigator.language` reports. */
  tag: string;
  /** The value `navigator.languages` reports; `languages[0] === tag`. */
  languages: string[];
}

export interface TimezoneData {
  /** IANA timezone identifier */
  identifier: string;
  /** Minutes from UTC */
  offset: number;
  /** DST offset in minutes */
  dstOffset: number;
  /** True if estimated from longitude */
  fallback?: boolean;
}

export interface SettingsEventDetail {
  enabled: boolean;
  location: SpoofedLocation | null;
  timezone: TimezoneData | null;
  /**
   * Engine-level Spoofing (Chromium) sets `timezone` in the engine for this
   * page. A realm whose engine already reports it keeps native Date/Intl; one
   * whose engine doesn't installs the overrides for it. Absent means false.
   */
  engineTimezone?: boolean;
  /**
   * With `engineTimezone`: false when an older zone command to the tab can
   * still land, so the engine may yet move to another zone. No realm keeps
   * native Date/Intl on this event; the overrides take `timezone`. Absent
   * means true.
   */
  engineTimezoneSettled?: boolean;
  debugLogging: boolean;
  verbosityLevel: string;
  /**
   * Content-script-level WebRTC IP-leak protection. When true, the
   * injected script wraps `RTCPeerConnection` so ICE gathering never
   * produces any candidates — closes the srflx leak that Firefox's
   * `disable_non_proxied_udp` pref misses without a proxy, and covers
   * Safari (which doesn't expose browser.privacy at all).
   */
  webrtcProtection: boolean;
  /**
   * When true, the geolocation override surfaces the browser's native
   * permission prompt (calling the real API) and only substitutes spoofed
   * coordinates after the user grants — forwarding denials/errors — instead of
   * silently answering with spoofed coords. Also stops `permissions.query` from
   * forcing `"granted"`. Off by default (seamless prompt-free spoofing).
   */
  preserveGeolocationPrompt: boolean;
  /**
   * The resolved Reported Language, or `null`/absent to leave the real locale
   * alone. Consumed by `locale-overrides.ts` and by the locale injection in the
   * `Intl.DateTimeFormat` and `Date.prototype.toLocale*` overrides.
   */
  locale?: LocaleData | null;
}

export interface SpoofedGeolocationPosition {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number;
    altitude: null;
    altitudeAccuracy: null;
    heading: null;
    speed: null;
  };
  timestamp: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFunction = (...args: any[]) => any;
