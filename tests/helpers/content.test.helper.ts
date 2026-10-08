/**
 * Test Helper for Content Script
 * Provides utilities to test content script in isolated environment
 */
import { vi } from "vitest";
import type { Location, Timezone } from "../../src/shared/types/settings";
import type {
  SpoofedGeolocationPosition,
  PositionCallback,
  PositionErrorCallback,
} from "../../src/shared/types/location";

/** Input settings for setupContentScript */
interface ContentScriptSettings {
  enabled?: boolean;
  location?: Location | null;
  timezone?: Timezone | null;
}

/** Partial settings update for updateSettings */
interface SettingsUpdate {
  enabled?: boolean;
  location?: Location | null;
  timezone?: Timezone | null;
}

/** Return type of setupContentScript */
export interface ContentScriptTestInterface {
  navigator: {
    geolocation: {
      getCurrentPosition: (
        successCallback: PositionCallback,
        errorCallback?: PositionErrorCallback,
        options?: PositionOptions
      ) => void;
      watchPosition: (
        successCallback: PositionCallback,
        errorCallback?: PositionErrorCallback,
        options?: PositionOptions
      ) => number;
      clearWatch: (watchId: number) => void;
    };
    permissions: {
      query: (descriptor: { name: string }) => Promise<PermissionStatus>;
    };
  };
  DateConstructor: (...args: unknown[]) => Date;
  DateParse: (str: string) => number;
  isAmbiguousDateString: (str: string) => boolean;
  computeEpochAdjustment: (parsedDate: Date, timezoneId: string, fallbackOffset: number) => number;
  Date: {
    prototype: {
      getTimezoneOffset: () => number;
      toString: () => string;
      toTimeString: () => string;
      toDateString: () => string;
      toLocaleString: (locales?: string | string[], options?: Intl.DateTimeFormatOptions) => string;
      toLocaleDateString: (
        locales?: string | string[],
        options?: Intl.DateTimeFormatOptions
      ) => string;
      toLocaleTimeString: (
        locales?: string | string[],
        options?: Intl.DateTimeFormatOptions
      ) => string;
      getHours: () => number;
      getMinutes: () => number;
      getSeconds: () => number;
      getMilliseconds: () => number;
      getDate: () => number;
      getDay: () => number;
      getMonth: () => number;
      getFullYear: () => number;
    };
  };
  Intl: {
    DateTimeFormat: (
      ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
    ) => Intl.DateTimeFormat;
    resolvedOptions: (instance: Intl.DateTimeFormat) => Intl.ResolvedDateTimeFormatOptions;
  };
  Temporal: {
    Now: {
      timeZoneId: () => string;
      plainDateTimeISO: (tzLike?: string) => TemporalPlainDateTime;
      plainDateISO: (tzLike?: string) => TemporalPlainDate;
      plainTimeISO: (tzLike?: string) => TemporalPlainTime;
      zonedDateTimeISO: (tzLike?: string) => TemporalZonedDateTime;
    };
  };
  updateSettings: (newSettings: SettingsUpdate) => void;
  getWatchCallbacks: () => Map<number, PositionCallback>;
  originals: {
    getCurrentPosition: ReturnType<typeof vi.fn>;
    watchPosition: ReturnType<typeof vi.fn>;
    clearWatch: ReturnType<typeof vi.fn>;
    permissionsQuery: ReturnType<typeof vi.fn>;
    getTimezoneOffset: typeof Date.prototype.getTimezoneOffset;
    DateTimeFormat: typeof Intl.DateTimeFormat;
    resolvedOptions: typeof Intl.DateTimeFormat.prototype.resolvedOptions;
    toString: typeof Date.prototype.toString;
    toTimeString: typeof Date.prototype.toTimeString;
    toDateString: typeof Date.prototype.toDateString;
    toLocaleString: typeof Date.prototype.toLocaleString;
    toLocaleDateString: typeof Date.prototype.toLocaleDateString;
    toLocaleTimeString: typeof Date.prototype.toLocaleTimeString;
    getHours: typeof Date.prototype.getHours;
    getMinutes: typeof Date.prototype.getMinutes;
    getSeconds: typeof Date.prototype.getSeconds;
    getMilliseconds: typeof Date.prototype.getMilliseconds;
    getDate: typeof Date.prototype.getDate;
    getDay: typeof Date.prototype.getDay;
    getMonth: typeof Date.prototype.getMonth;
    getFullYear: typeof Date.prototype.getFullYear;
    temporalTimeZoneId: () => string;
    temporalPlainDateTimeISO: (tzLike?: string) => TemporalPlainDateTime;
    temporalPlainDateISO: (tzLike?: string) => TemporalPlainDate;
    temporalPlainTimeISO: (tzLike?: string) => TemporalPlainTime;
    temporalZonedDateTimeISO: (tzLike?: string) => TemporalZonedDateTime;
    DateConstructor: DateConstructor;
    DateParse: typeof Date.parse;
  };
}

/**
 * Setup content script with given settings.
 * Returns an object with overridden APIs for testing.
 */
function setupContentScript(settings: ContentScriptSettings): ContentScriptTestInterface {
  // Store original methods
  const originalGetCurrentPosition = vi.fn(
    (success: PositionCallback, _error?: PositionErrorCallback, _options?: PositionOptions) => {
      setTimeout(() => {
        success({
          coords: {
            latitude: 0,
            longitude: 0,
            accuracy: 10,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null,
          },
          timestamp: Date.now(),
        });
      }, 10);
    }
  );

  const originalWatchPosition = vi.fn(
    (
      success: PositionCallback,
      _error?: PositionErrorCallback,
      _options?: PositionOptions
    ): number => {
      setTimeout(() => {
        success({
          coords: {
            latitude: 0,
            longitude: 0,
            accuracy: 10,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null,
          },
          timestamp: Date.now(),
        });
      }, 10);
      return 1;
    }
  );

  const originalClearWatch = vi.fn();

  // Original permissions.query mock — returns "prompt" for geolocation by default
  const originalPermissionsQuery = vi.fn(
    (descriptor: { name: string }): Promise<PermissionStatus> => {
      const target = new EventTarget();
      const state = descriptor?.name === "geolocation" ? "prompt" : "granted";
      Object.defineProperty(target, "state", {
        get: () => state as PermissionState,
        enumerable: true,
        configurable: false,
      });
      Object.defineProperty(target, "onchange", {
        value: null,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return Promise.resolve(target as unknown as PermissionStatus);
    }
  );

  // Capture the original Date prototype methods so the overrides below can delegate
  // to them. These references are only ever invoked via .call(dateInstance), and the
  // `this: Date` casts make that contract explicit, so the unbound-method rule does
  // not apply here. (typescript-eslint 8.71 tightened the rule to also flag the
  // methods shared with Object.prototype such as toString/toLocaleString, hence the
  // block disable rather than relying on the index-access form alone.)
  /* eslint-disable @typescript-eslint/unbound-method -- deliberate: originals are always called via .call() with an explicit `this: Date` receiver */
  const dateProto = Date.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originalGetTimezoneOffset = dateProto["getTimezoneOffset"] as (this: Date) => number;
  const originalToString = dateProto["toString"] as (this: Date) => string;
  const originalToTimeString = dateProto["toTimeString"] as (this: Date) => string;
  const originalToDateString = dateProto["toDateString"] as (this: Date) => string;
  const originalToLocaleString = dateProto["toLocaleString"] as (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions
  ) => string;
  const originalToLocaleDateString = dateProto["toLocaleDateString"] as (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions
  ) => string;
  const originalToLocaleTimeString = dateProto["toLocaleTimeString"] as (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions
  ) => string;
  const originalGetHours = dateProto["getHours"] as (this: Date) => number;
  const originalGetMinutes = dateProto["getMinutes"] as (this: Date) => number;
  const originalGetSeconds = dateProto["getSeconds"] as (this: Date) => number;
  const originalGetMilliseconds = dateProto["getMilliseconds"] as (this: Date) => number;
  const originalGetDate = dateProto["getDate"] as (this: Date) => number;
  const originalGetDay = dateProto["getDay"] as (this: Date) => number;
  const originalGetMonth = dateProto["getMonth"] as (this: Date) => number;
  const originalGetFullYear = dateProto["getFullYear"] as (this: Date) => number;
  /* eslint-enable @typescript-eslint/unbound-method */
  const OriginalDateTimeFormat = Intl.DateTimeFormat;

  // Settings
  let spoofingEnabled = settings.enabled || false;
  let spoofedLocation: Location | null = settings.location || null;
  let timezoneOverride: Timezone | null = settings.timezone || null;

  // Validate timezone data
  function validateTimezoneData(tz: Timezone | null): boolean {
    if (!tz) {
      return false;
    }

    if (typeof tz.identifier !== "string" || tz.identifier.length === 0) {
      return false;
    }

    if (typeof tz.offset !== "number" || !Number.isFinite(tz.offset)) {
      return false;
    }

    if (typeof tz.dstOffset !== "number" || !Number.isFinite(tz.dstOffset)) {
      return false;
    }

    return true;
  }

  // Validate initial timezone
  if (timezoneOverride && !validateTimezoneData(timezoneOverride)) {
    timezoneOverride = null;
  }

  // ── Timezone formatting helpers ──────────────────────────────────────

  /** Parse a GMT offset string like "GMT+5:30" or "GMT-8" into fractional minutes from UTC. */
  function parseGMTOffset(gmtString: string): number {
    if (gmtString === "GMT" || gmtString === "UTC") return 0;
    // Handle GMT±H:MM:SS (historical sub-minute offsets like GMT+0:53:28)
    const match = gmtString.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/);
    if (!match) return 0;
    const sign = match[1] === "+" ? 1 : -1;
    const hours = parseInt(match[2], 10);
    const minutes = parseInt(match[3] || "0", 10);
    const seconds = parseInt(match[4] || "0", 10);
    return sign * (hours * 60 + minutes + seconds / 60);
  }

  /** Resolve the actual UTC offset for a given date and IANA timezone.
   *  Cached per (epoch, timezoneId) to guarantee deterministic results on Chrome
   *  where shortOffset can be non-deterministic for sub-minute LMT offsets. */
  let _offsetCacheEpoch = NaN;
  let _offsetCacheTz = "";
  let _offsetCacheValue = 0;

  function getIntlBasedOffset(date: Date, timezoneId: string, fallbackOffset: number): number {
    const epoch = date.getTime();
    if (epoch === _offsetCacheEpoch && timezoneId === _offsetCacheTz) {
      return _offsetCacheValue;
    }
    try {
      const formatter = new OriginalDateTimeFormat("en-US", {
        timeZone: timezoneId,
        timeZoneName: "shortOffset",
      });
      const parts = formatter.formatToParts(date);
      const tzPart = parts.find((p) => p.type === "timeZoneName");
      const result = parseGMTOffset(tzPart?.value ?? "GMT");
      _offsetCacheEpoch = epoch;
      _offsetCacheTz = timezoneId;
      _offsetCacheValue = result;
      return result;
    } catch {
      return fallbackOffset;
    }
  }

  /** Convert an offset in minutes from UTC to a `GMT±HHMM` string. */
  function formatGMTOffset(offsetMinutes: number): string {
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const abs = Math.round(Math.abs(offsetMinutes));
    const hours = Math.floor(abs / 60);
    const minutes = abs % 60;
    return `GMT${sign}${String(hours).padStart(2, "0")}${String(minutes).padStart(2, "0")}`;
  }

  /** Extract the long timezone name for a date and IANA tz. */
  function getLongTimezoneName(date: Date, timezoneId: string): string {
    try {
      const formatter = new OriginalDateTimeFormat("en-US", {
        timeZone: timezoneId,
        timeZoneName: "long",
      });
      const parts = formatter.formatToParts(date);
      const tzPart = parts.find((p) => p.type === "timeZoneName");
      return tzPart?.value ?? timezoneId;
    } catch {
      return timezoneId;
    }
  }

  // ── Date constructor helpers ─────────────────────────────────────────

  /** Store original Date references before any overrides */
  const OriginalDate = Date;
  const OriginalDateParse = Date.parse;

  /**
   * Determine if a date string lacks an explicit timezone indicator.
   * Returns true if the string is "ambiguous" (no tz info).
   */
  function isAmbiguousDateString(str: string): boolean {
    // ISO 8601 date-only: YYYY-MM-DD with no time component → UTC per ECMAScript spec
    if (/^\d{4}-\d{2}-\d{2}$/.test(str.trim())) {
      return false;
    }
    const hasExplicitTz =
      /Z$/i.test(str.trim()) ||
      /\b(?:UTC|GMT)\b/i.test(str) ||
      /[+-]\d{2}(?::?\d{2})?$/.test(str.trim());
    return !hasExplicitTz;
  }

  /**
   * Compute the epoch adjustment in milliseconds to shift a timestamp
   * from real-local-time interpretation to spoofed-local-time interpretation.
   *
   * The algorithm resolves the spoofed offset at the correct UTC instant
   * and then verifies the offset at the *final* adjusted epoch, iterating
   * until stable. This guarantees getUTC* component differences match
   * getTimezoneOffset for historical sub-minute LMT dates.
   */
  function computeEpochAdjustment(
    parsedDate: Date,
    timezoneId: string,
    fallbackOffset: number
  ): number {
    // (a) Real system offset in minutes (positive = west of UTC, getTimezoneOffset convention)
    const realOffset = originalGetTimezoneOffset.call(parsedDate);

    // (b) Compute the wall-clock time as a UTC epoch.
    const utcEpoch = parsedDate.getTime() + realOffset * 60000;

    try {
      // (c) Create a probe date at the estimated UTC instant for the spoofed timezone.
      const probeDate = new OriginalDate(utcEpoch - fallbackOffset * 60000);

      // (d) Resolve the actual spoofed offset at the probe instant (positive = east).
      let spoofedOffset = getIntlBasedOffset(probeDate, timezoneId, fallbackOffset);

      // (e) Refine for DST boundary crossings.
      if (spoofedOffset !== fallbackOffset) {
        const refinedProbe = new OriginalDate(utcEpoch - spoofedOffset * 60000);
        spoofedOffset = getIntlBasedOffset(refinedProbe, timezoneId, fallbackOffset);
      }

      // (f) Compute the initial adjustment.
      let adjustment = Math.round((-spoofedOffset - realOffset) * 60000);

      // (g) Verify at the final adjusted epoch and iterate until stable.
      for (let i = 0; i < 2; i++) {
        const finalDate = new OriginalDate(parsedDate.getTime() + adjustment);
        const finalOffset = getIntlBasedOffset(finalDate, timezoneId, fallbackOffset);
        if (finalOffset === spoofedOffset) break;
        spoofedOffset = finalOffset;
        adjustment = Math.round((-spoofedOffset - realOffset) * 60000);
      }

      return adjustment;
    } catch {
      // Fall back to a simple adjustment using the fallback offset on any error.
      return Math.round((-fallbackOffset - realOffset) * 60000);
    }
  }

  // ── Date constructor and Date.parse overrides ──────────────────────────

  function DateOverride(...args: unknown[]): Date {
    // When spoofing is disabled, delegate entirely to OriginalDate
    if (!spoofingEnabled || !timezoneOverride) {
      if (args.length === 0) return new OriginalDate();
      if (args.length === 1) return new OriginalDate(args[0] as number | string);
      return new OriginalDate(
        args[0] as number,
        args[1] as number,
        (args[2] ?? 1) as number,
        (args[3] ?? 0) as number,
        (args[4] ?? 0) as number,
        (args[5] ?? 0) as number,
        (args[6] ?? 0) as number
      );
    }

    if (args.length === 0) return new OriginalDate();

    if (args.length === 1) {
      const arg = args[0];
      if (typeof arg === "number") return new OriginalDate(arg);
      if (typeof arg === "string") {
        try {
          const parsed = new OriginalDate(arg);
          if (isNaN(parsed.getTime())) return parsed;
          if (isAmbiguousDateString(arg)) {
            const adjustment = computeEpochAdjustment(
              parsed,
              timezoneOverride.identifier,
              timezoneOverride.offset
            );
            return new OriginalDate(parsed.getTime() + adjustment);
          }
          return parsed;
        } catch {
          return new OriginalDate(arg);
        }
      }
      return new OriginalDate(arg as number | string);
    }

    // Multi-argument
    try {
      const parsed = new OriginalDate(
        args[0] as number,
        args[1] as number,
        (args[2] ?? 1) as number,
        (args[3] ?? 0) as number,
        (args[4] ?? 0) as number,
        (args[5] ?? 0) as number,
        (args[6] ?? 0) as number
      );
      const adjustment = computeEpochAdjustment(
        parsed,
        timezoneOverride.identifier,
        timezoneOverride.offset
      );
      return new OriginalDate(parsed.getTime() + adjustment);
    } catch {
      return new OriginalDate(
        args[0] as number,
        args[1] as number,
        (args[2] ?? 1) as number,
        (args[3] ?? 0) as number,
        (args[4] ?? 0) as number,
        (args[5] ?? 0) as number,
        (args[6] ?? 0) as number
      );
    }
  }

  function dateParseOverride(str: string): number {
    if (!spoofingEnabled || !timezoneOverride) {
      return OriginalDateParse(str);
    }
    try {
      const epoch = OriginalDateParse(str);
      if (isNaN(epoch)) return NaN;
      if (isAmbiguousDateString(str)) {
        const parsed = new OriginalDate(epoch);
        const adjustment = computeEpochAdjustment(
          parsed,
          timezoneOverride.identifier,
          timezoneOverride.offset
        );
        return epoch + adjustment;
      }
      return epoch;
    } catch {
      return OriginalDateParse(str);
    }
  }

  // Watch callbacks storage
  const watchCallbacks = new Map<number, PositionCallback>();
  let watchIdCounter = 1;

  // Create GeolocationPosition object
  function createGeolocationPosition(location: Location): SpoofedGeolocationPosition {
    return {
      coords: {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy || 10,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    };
  }

  // Override getCurrentPosition
  const getCurrentPosition = function (
    this: Geolocation,
    successCallback: PositionCallback,
    errorCallback?: PositionErrorCallback,
    options?: PositionOptions
  ): void {
    if (spoofingEnabled && spoofedLocation) {
      const position = createGeolocationPosition(spoofedLocation);
      const delay = 10 + Math.random() * 40;
      setTimeout(() => {
        if (successCallback) {
          successCallback(position);
        }
      }, delay);
    } else {
      originalGetCurrentPosition.call(this, successCallback, errorCallback, options);
    }
  };

  // Override watchPosition
  const watchPosition = function (
    this: Geolocation,
    successCallback: PositionCallback,
    errorCallback?: PositionErrorCallback,
    options?: PositionOptions
  ): number {
    if (spoofingEnabled && spoofedLocation) {
      const watchId = watchIdCounter++;
      watchCallbacks.set(watchId, successCallback);

      const position = createGeolocationPosition(spoofedLocation);
      const delay = 10 + Math.random() * 40;

      setTimeout(() => {
        if (successCallback) {
          successCallback(position);
        }
      }, delay);

      return watchId;
    } else {
      return originalWatchPosition.call(this, successCallback, errorCallback, options);
    }
  };

  // Override clearWatch
  const clearWatch = function (this: Geolocation, watchId: number): void {
    if (spoofingEnabled) {
      watchCallbacks.delete(watchId);
    } else {
      originalClearWatch.call(this, watchId);
    }
  };

  // Derive offset from formatToParts — same path as component getters.
  // Mirrors production deriveOffsetFromParts in timezone-helpers.ts.
  function deriveOffsetFromParts(date: Date, timezoneId: string): number | undefined {
    const epoch = date.getTime();
    if (isNaN(epoch)) return undefined;
    const parts = resolvePartsForDate(date, timezoneId);
    if (!parts) return undefined;
    const localAsUTC = OriginalDate.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    // Strip sub-second precision — formatToParts only resolves to whole seconds.
    const epochSeconds = Math.floor(epoch / 1000) * 1000;
    return (localAsUTC - epochSeconds) / 60000;
  }

  // Override getTimezoneOffset — derives offset from formatToParts (same path as getters)
  const getTimezoneOffset = function (this: Date): number {
    if (spoofingEnabled && timezoneOverride) {
      const offsetMinutes = deriveOffsetFromParts(this, timezoneOverride.identifier);
      if (offsetMinutes !== undefined) {
        return -offsetMinutes;
      }
    }
    return originalGetTimezoneOffset.call(this);
  };

  // Track Intl.DateTimeFormat instances created with an explicit timeZone option.
  const explicitTimezoneInstances = new WeakSet<Intl.DateTimeFormat>();

  // Override DateTimeFormat — scoped: only inject spoofed tz when caller did NOT
  // provide an explicit timeZone option, or when the explicit tz matches the spoofed tz.
  const DateTimeFormat = function (
    ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
  ): Intl.DateTimeFormat {
    const [locales, options] = args;
    const hasExplicitTimezone = options?.timeZone != null;
    const matchesSpoofedTz =
      hasExplicitTimezone &&
      spoofingEnabled &&
      timezoneOverride &&
      options.timeZone!.toLowerCase() === timezoneOverride.identifier.toLowerCase();

    if (spoofingEnabled && timezoneOverride && (!hasExplicitTimezone || matchesSpoofedTz)) {
      const opts: Intl.DateTimeFormatOptions = {
        ...options,
        timeZone: timezoneOverride.identifier,
      };
      return new OriginalDateTimeFormat(locales, opts);
    }

    const instance = new OriginalDateTimeFormat(locales, options);
    if (hasExplicitTimezone) {
      explicitTimezoneInstances.add(instance);
    }
    return instance;
  };

  // Override resolvedOptions — scoped: only inject spoofed tz for default-timezone instances
  const dtfProto = OriginalDateTimeFormat.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const originalResolvedOptions = dtfProto["resolvedOptions"] as (
    this: Intl.DateTimeFormat
  ) => Intl.ResolvedDateTimeFormatOptions;
  const resolvedOptions = function (this: Intl.DateTimeFormat): Intl.ResolvedDateTimeFormatOptions {
    const opts = originalResolvedOptions.call(this);
    // The constructor already injected the spoofed timezone for non-explicit
    // instances, so the native resolvedOptions returns the engine-normalized
    // identifier. No need to overwrite.
    return opts;
  };

  // ── Date formatting helpers ──────────────────────────────────────────

  const SHORT_MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  function pad2(n: number): string {
    return String(n).padStart(2, "0");
  }

  // Override Date formatting methods

  const toDateString = function (this: Date): string {
    if (spoofingEnabled && timezoneOverride) {
      try {
        const parts = resolvePartsForDate(this, timezoneOverride.identifier);
        if (parts) {
          const weekday = parts.weekday;
          const month = SHORT_MONTHS[parts.month - 1];
          const day = pad2(parts.day);
          const year = parts.year;
          return `${weekday} ${month} ${day} ${year}`;
        }
        return originalToDateString.call(this);
      } catch (error) {
        console.error("[GeoSpoof Injected] Error in toDateString override:", error);
        return originalToDateString.call(this);
      }
    }
    return originalToDateString.call(this);
  };

  const toString = function (this: Date): string {
    if (spoofingEnabled && timezoneOverride) {
      try {
        const parts = resolvePartsForDate(this, timezoneOverride.identifier);
        if (parts) {
          const offsetMinutes = deriveOffsetFromParts(this, timezoneOverride.identifier);
          const weekday = parts.weekday;
          const month = SHORT_MONTHS[parts.month - 1];
          const day = pad2(parts.day);
          const year = parts.year;
          const hours = pad2(parts.hour);
          const minutes = pad2(parts.minute);
          const seconds = pad2(parts.second);
          const gmtOffset = formatGMTOffset(offsetMinutes ?? 0);
          const longName = getLongTimezoneName(this, timezoneOverride.identifier);
          return `${weekday} ${month} ${day} ${year} ${hours}:${minutes}:${seconds} ${gmtOffset} (${longName})`;
        }
        return originalToString.call(this);
      } catch (error) {
        console.error("[GeoSpoof Injected] Error in toString override:", error);
        return originalToString.call(this);
      }
    }
    return originalToString.call(this);
  };

  const toTimeString = function (this: Date): string {
    if (spoofingEnabled && timezoneOverride) {
      try {
        const parts = resolvePartsForDate(this, timezoneOverride.identifier);
        if (parts) {
          const offsetMinutes = deriveOffsetFromParts(this, timezoneOverride.identifier);
          const hours = pad2(parts.hour);
          const minutes = pad2(parts.minute);
          const seconds = pad2(parts.second);
          const gmtOffset = formatGMTOffset(offsetMinutes ?? 0);
          const longName = getLongTimezoneName(this, timezoneOverride.identifier);
          return `${hours}:${minutes}:${seconds} ${gmtOffset} (${longName})`;
        }
        return originalToTimeString.call(this);
      } catch (error) {
        console.error("[GeoSpoof Injected] Error in toTimeString override:", error);
        return originalToTimeString.call(this);
      }
    }
    return originalToTimeString.call(this);
  };

  const toLocaleString = function (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions
  ): string {
    if (spoofingEnabled && timezoneOverride) {
      try {
        const hasExplicitTimezone = options?.timeZone != null;
        if (!hasExplicitTimezone) {
          const opts = { ...options, timeZone: timezoneOverride.identifier };
          return originalToLocaleString.call(this, locales, opts);
        }
        return originalToLocaleString.call(this, locales, options);
      } catch {
        return originalToLocaleString.call(this, locales, options);
      }
    }
    return originalToLocaleString.call(this, locales, options);
  };

  const toLocaleDateString = function (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions
  ): string {
    if (spoofingEnabled && timezoneOverride) {
      try {
        const hasExplicitTimezone = options?.timeZone != null;
        if (!hasExplicitTimezone) {
          const opts = { ...options, timeZone: timezoneOverride.identifier };
          return originalToLocaleDateString.call(this, locales, opts);
        }
        return originalToLocaleDateString.call(this, locales, options);
      } catch {
        return originalToLocaleDateString.call(this, locales, options);
      }
    }
    return originalToLocaleDateString.call(this, locales, options);
  };

  const toLocaleTimeString = function (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions
  ): string {
    if (spoofingEnabled && timezoneOverride) {
      try {
        const hasExplicitTimezone = options?.timeZone != null;
        if (!hasExplicitTimezone) {
          const opts = { ...options, timeZone: timezoneOverride.identifier };
          return originalToLocaleTimeString.call(this, locales, opts);
        }
        return originalToLocaleTimeString.call(this, locales, options);
      } catch {
        return originalToLocaleTimeString.call(this, locales, options);
      }
    }
    return originalToLocaleTimeString.call(this, locales, options);
  };

  // ── resolvePartsForDate (mirrors production timezone-helpers.ts) ────

  /** Resolved date/time components from native formatToParts. */
  interface ResolvedDateParts {
    year: number;
    month: number; // 1-indexed
    day: number;
    weekday: string;
    hour: number;
    minute: number;
    second: number;
  }

  const WEEKDAY_TO_NUMBER: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  let _partsCacheEpoch = NaN;
  let _partsCacheTz = "";
  let _partsCacheValue: ResolvedDateParts | undefined;

  function resolvePartsForDate(date: Date, timezoneId: string): ResolvedDateParts | undefined {
    const epoch = date.getTime();
    if (isNaN(epoch)) return undefined;

    if (epoch === _partsCacheEpoch && timezoneId === _partsCacheTz) {
      return _partsCacheValue;
    }

    const fmt = new OriginalDateTimeFormat("en-US", {
      timeZone: timezoneId,
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
    });

    const parts = fmt.formatToParts(date);

    let year = 0,
      month = 0,
      day = 0,
      hour = 0,
      minute = 0,
      second = 0;
    let weekday = "";

    for (const p of parts) {
      switch (p.type) {
        case "year":
          year = parseInt(p.value, 10);
          break;
        case "month":
          month = parseInt(p.value, 10);
          break;
        case "day":
          day = parseInt(p.value, 10);
          break;
        case "weekday":
          weekday = p.value;
          break;
        case "hour":
          hour = parseInt(p.value, 10);
          break;
        case "minute":
          minute = parseInt(p.value, 10);
          break;
        case "second":
          second = parseInt(p.value, 10);
          break;
      }
    }

    // hour12:false with en-US can produce "24" for midnight — normalize to 0
    if (hour === 24) hour = 0;

    const result: ResolvedDateParts = { year, month, day, weekday, hour, minute, second };

    _partsCacheEpoch = epoch;
    _partsCacheTz = timezoneId;
    _partsCacheValue = result;

    return result;
  }

  // ── Date getter helpers & overrides ──────────────────────────────────

  /**
   * Compute the local time in the spoofed timezone by shifting the UTC epoch
   * by the Intl-based offset. Returns a Date whose UTC methods give the
   * wall-clock time in the spoofed timezone.
   * Retained for use by computeEpochAdjustment if needed.
   */
  function getLocalDateViaOffset(date: Date, timezoneId: string, fallbackOffset: number): Date {
    const offsetMinutes = getIntlBasedOffset(date, timezoneId, fallbackOffset);
    return new OriginalDate(date.getTime() + offsetMinutes * 60000);
  }

  // Suppress unused-variable lint — getLocalDateViaOffset is retained for
  // computeEpochAdjustment compatibility but no longer used by getters/formatting.
  void getLocalDateViaOffset;

  const getHours = function (this: Date): number {
    try {
      if (spoofingEnabled && timezoneOverride) {
        const parts = resolvePartsForDate(this, timezoneOverride.identifier);
        if (parts) return parts.hour;
      }
      return originalGetHours.call(this);
    } catch {
      return originalGetHours.call(this);
    }
  };

  const getMinutes = function (this: Date): number {
    try {
      if (spoofingEnabled && timezoneOverride) {
        const parts = resolvePartsForDate(this, timezoneOverride.identifier);
        if (parts) return parts.minute;
      }
      return originalGetMinutes.call(this);
    } catch {
      return originalGetMinutes.call(this);
    }
  };

  const getSeconds = function (this: Date): number {
    try {
      if (spoofingEnabled && timezoneOverride) {
        const parts = resolvePartsForDate(this, timezoneOverride.identifier);
        if (parts) return parts.second;
      }
      return originalGetSeconds.call(this);
    } catch {
      return originalGetSeconds.call(this);
    }
  };

  const getMilliseconds = function (this: Date): number {
    try {
      if (spoofingEnabled && timezoneOverride) {
        // Milliseconds are timezone-independent
        return originalGetMilliseconds.call(this);
      }
      return originalGetMilliseconds.call(this);
    } catch {
      return originalGetMilliseconds.call(this);
    }
  };

  const getDate = function (this: Date): number {
    try {
      if (spoofingEnabled && timezoneOverride) {
        const parts = resolvePartsForDate(this, timezoneOverride.identifier);
        if (parts) return parts.day;
      }
      return originalGetDate.call(this);
    } catch {
      return originalGetDate.call(this);
    }
  };

  const getDay = function (this: Date): number {
    try {
      if (spoofingEnabled && timezoneOverride) {
        const parts = resolvePartsForDate(this, timezoneOverride.identifier);
        if (parts) return WEEKDAY_TO_NUMBER[parts.weekday];
      }
      return originalGetDay.call(this);
    } catch {
      return originalGetDay.call(this);
    }
  };

  const getMonth = function (this: Date): number {
    try {
      if (spoofingEnabled && timezoneOverride) {
        const parts = resolvePartsForDate(this, timezoneOverride.identifier);
        if (parts) return parts.month - 1;
      }
      return originalGetMonth.call(this);
    } catch {
      return originalGetMonth.call(this);
    }
  };

  const getFullYear = function (this: Date): number {
    try {
      if (spoofingEnabled && timezoneOverride) {
        const parts = resolvePartsForDate(this, timezoneOverride.identifier);
        if (parts) return parts.year;
      }
      return originalGetFullYear.call(this);
    } catch {
      return originalGetFullYear.call(this);
    }
  };

  // ── Temporal API mock & overrides ──────────────────────────────────

  // Mock Temporal.Now for testing (jsdom/Node.js doesn't have Temporal natively).
  // The "originals" simulate what a real browser's Temporal.Now would return.
  const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const originalTemporalTimeZoneId = (): string => systemTimezone;
  const originalTemporalPlainDateTimeISO = (tzLike?: string): TemporalPlainDateTime => {
    const tz = tzLike ?? systemTimezone;
    const now = new Date();
    const fmt = new OriginalDateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const get = (type: string): number =>
      parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
    return {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour: get("hour"),
      minute: get("minute"),
      second: get("second"),
      millisecond: 0,
      microsecond: 0,
      nanosecond: 0,
      toString: () =>
        `${get("year")}-${String(get("month")).padStart(2, "0")}-${String(get("day")).padStart(2, "0")}T${String(get("hour")).padStart(2, "0")}:${String(get("minute")).padStart(2, "0")}:${String(get("second")).padStart(2, "0")}`,
    };
  };
  const originalTemporalPlainDateISO = (tzLike?: string): TemporalPlainDate => {
    const dt = originalTemporalPlainDateTimeISO(tzLike);
    return {
      year: dt.year,
      month: dt.month,
      day: dt.day,
      toString: () =>
        `${dt.year}-${String(dt.month).padStart(2, "0")}-${String(dt.day).padStart(2, "0")}`,
    };
  };
  const originalTemporalPlainTimeISO = (tzLike?: string): TemporalPlainTime => {
    const dt = originalTemporalPlainDateTimeISO(tzLike);
    return {
      hour: dt.hour,
      minute: dt.minute,
      second: dt.second,
      millisecond: 0,
      microsecond: 0,
      nanosecond: 0,
      toString: () =>
        `${String(dt.hour).padStart(2, "0")}:${String(dt.minute).padStart(2, "0")}:${String(dt.second).padStart(2, "0")}`,
    };
  };
  const originalTemporalZonedDateTimeISO = (tzLike?: string): TemporalZonedDateTime => {
    const tz = tzLike ?? systemTimezone;
    const dt = originalTemporalPlainDateTimeISO(tz);
    return {
      year: dt.year,
      month: dt.month,
      day: dt.day,
      hour: dt.hour,
      minute: dt.minute,
      second: dt.second,
      timeZoneId: tz,
      offsetNanoseconds: 0,
      offset: "+00:00",
      toString: () => `${dt.toString()}[${tz}]`,
    };
  };

  // Temporal.Now overrides (mirrors injected.ts logic)
  const temporalTimeZoneId = (): string => {
    if (spoofingEnabled && timezoneOverride) {
      return timezoneOverride.identifier;
    }
    return originalTemporalTimeZoneId();
  };

  const temporalPlainDateTimeISO = (tzLike?: string): TemporalPlainDateTime => {
    if (spoofingEnabled && timezoneOverride && tzLike === undefined) {
      return originalTemporalPlainDateTimeISO(timezoneOverride.identifier);
    }
    return originalTemporalPlainDateTimeISO(tzLike);
  };

  const temporalPlainDateISO = (tzLike?: string): TemporalPlainDate => {
    if (spoofingEnabled && timezoneOverride && tzLike === undefined) {
      return originalTemporalPlainDateISO(timezoneOverride.identifier);
    }
    return originalTemporalPlainDateISO(tzLike);
  };

  const temporalPlainTimeISO = (tzLike?: string): TemporalPlainTime => {
    if (spoofingEnabled && timezoneOverride && tzLike === undefined) {
      return originalTemporalPlainTimeISO(timezoneOverride.identifier);
    }
    return originalTemporalPlainTimeISO(tzLike);
  };

  const temporalZonedDateTimeISO = (tzLike?: string): TemporalZonedDateTime => {
    if (spoofingEnabled && timezoneOverride && tzLike === undefined) {
      return originalTemporalZonedDateTimeISO(timezoneOverride.identifier);
    }
    return originalTemporalZonedDateTimeISO(tzLike);
  };

  // Create spoofed PermissionStatus
  function createSpoofedPermissionStatus(): PermissionStatus {
    const target = new EventTarget();
    let onchangeHandler: ((this: PermissionStatus, ev: Event) => unknown) | null = null;

    Object.defineProperty(target, "state", {
      get: () => "granted" as PermissionState,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(target, "onchange", {
      get: () => onchangeHandler,
      set: (value: ((this: PermissionStatus, ev: Event) => unknown) | null) => {
        onchangeHandler = value;
      },
      enumerable: true,
      configurable: true,
    });

    return target as unknown as PermissionStatus;
  }

  // Override permissions.query
  const permissionsQuery = function (descriptor: { name: string }): Promise<PermissionStatus> {
    try {
      if (spoofingEnabled && descriptor?.name === "geolocation") {
        return Promise.resolve(createSpoofedPermissionStatus());
      }
      return originalPermissionsQuery(descriptor);
    } catch (error) {
      console.error("[GeoSpoof Test] Error in permissions.query override:", error);
      return originalPermissionsQuery(descriptor);
    }
  };

  // Return test interface
  return {
    navigator: {
      geolocation: {
        getCurrentPosition,
        watchPosition,
        clearWatch,
      },
      permissions: {
        query: permissionsQuery,
      },
    },
    DateConstructor: DateOverride,
    DateParse: dateParseOverride,
    isAmbiguousDateString,
    computeEpochAdjustment,
    Date: {
      prototype: {
        getTimezoneOffset,
        toString,
        toTimeString,
        toDateString,
        toLocaleString,
        toLocaleDateString,
        toLocaleTimeString,
        getHours,
        getMinutes,
        getSeconds,
        getMilliseconds,
        getDate,
        getDay,
        getMonth,
        getFullYear,
      },
    },
    Intl: {
      DateTimeFormat,
      resolvedOptions: (instance: Intl.DateTimeFormat) => resolvedOptions.call(instance),
    },
    Temporal: {
      Now: {
        timeZoneId: temporalTimeZoneId,
        plainDateTimeISO: temporalPlainDateTimeISO,
        plainDateISO: temporalPlainDateISO,
        plainTimeISO: temporalPlainTimeISO,
        zonedDateTimeISO: temporalZonedDateTimeISO,
      },
    },
    updateSettings: (newSettings: SettingsUpdate): void => {
      spoofingEnabled = newSettings.enabled !== undefined ? newSettings.enabled : spoofingEnabled;
      spoofedLocation = newSettings.location !== undefined ? newSettings.location : spoofedLocation;

      if (newSettings.timezone !== undefined) {
        if (newSettings.timezone && validateTimezoneData(newSettings.timezone)) {
          timezoneOverride = newSettings.timezone;
        } else {
          timezoneOverride = null;
        }
      }
    },
    getWatchCallbacks: () => watchCallbacks,

    originals: {
      getCurrentPosition: originalGetCurrentPosition,
      watchPosition: originalWatchPosition,
      clearWatch: originalClearWatch,
      permissionsQuery: originalPermissionsQuery,
      getTimezoneOffset: originalGetTimezoneOffset,
      DateTimeFormat: OriginalDateTimeFormat,
      resolvedOptions: originalResolvedOptions,
      toString: originalToString,
      toTimeString: originalToTimeString,
      toDateString: originalToDateString,
      toLocaleString: originalToLocaleString,
      toLocaleDateString: originalToLocaleDateString,
      toLocaleTimeString: originalToLocaleTimeString,
      getHours: originalGetHours,
      getMinutes: originalGetMinutes,
      getSeconds: originalGetSeconds,
      getMilliseconds: originalGetMilliseconds,
      getDate: originalGetDate,
      getDay: originalGetDay,
      getMonth: originalGetMonth,
      getFullYear: originalGetFullYear,
      temporalTimeZoneId: originalTemporalTimeZoneId,
      temporalPlainDateTimeISO: originalTemporalPlainDateTimeISO,
      temporalPlainDateISO: originalTemporalPlainDateISO,
      temporalPlainTimeISO: originalTemporalPlainTimeISO,
      temporalZonedDateTimeISO: originalTemporalZonedDateTimeISO,
      DateConstructor: OriginalDate,
      DateParse: OriginalDateParse,
    },
  };
}

export { setupContentScript };
