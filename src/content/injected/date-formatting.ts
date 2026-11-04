/**
 * Date formatting overrides.
 *
 * Overrides `toString`, `toDateString`, `toTimeString`, `toLocaleString`,
 * `toLocaleDateString`, and `toLocaleTimeString` on `Date.prototype` to
 * format dates using the spoofed timezone when protection is enabled.
 *
 * Exposes two entry points:
 *   - `installDateFormattingOverrides()` — installs on the top-level
 *     `Date.prototype` using the originals captured in `state.ts`.
 *   - `installDateFormattingOverridesOn(proto, originals)` — installs on
 *     an arbitrary `Date.prototype` using a caller-supplied originals
 *     bag. The iframe patcher invokes this against each same-origin
 *     iframe's Date.prototype.
 *
 * `componentsViaShortOffset` (from `state.ts`) picks how local time is
 * derived: an epoch shift by the Intl shortOffset value on V8 and
 * JavaScriptCore, `formatToParts` on SpiderMonkey. Both give the same
 * whole-second wall clock.
 */

import {
  spoofingEnabled,
  timezoneData,
  componentsViaShortOffset,
  originalToString,
  originalToTimeString,
  originalToDateString,
  originalToLocaleString,
  originalToLocaleDateString,
  originalToLocaleTimeString,
} from "./state";
import { installOverride } from "./function-masking";
import { resolveEffectiveLocales } from "./locale-overrides";
import { createLogger } from "@/shared/utils/debug-logger";
import {
  resolvePartsForDate,
  formatGMTOffset,
  getLongTimezoneName,
  deriveOffsetFromParts,
  getLocalDateViaOffset,
  getIntlBasedOffset,
} from "./timezone-helpers";

const logger = createLogger("INJ");

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

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Zero-pad a number to 2 digits. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Bag of original `Date.prototype` formatter references for a single
 * realm. Same rationale as the getter/setter originals bags: fall-throughs
 * stay inside whichever realm triggered them.
 */
export interface DateFormattingOriginals {
  toString: (this: Date) => string;
  toDateString: (this: Date) => string;
  toTimeString: (this: Date) => string;
  toLocaleString: (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions
  ) => string;
  toLocaleDateString: (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions
  ) => string;
  toLocaleTimeString: (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions
  ) => string;
}

/**
 * Install Date formatting overrides on the supplied `Date.prototype`.
 *
 * Shared by `installDateFormattingOverrides()` (top level) and the
 * iframe patcher (per iframe realm).
 */
export function installDateFormattingOverridesOn(
  proto: object,
  originals: DateFormattingOriginals
): void {
  // Override toDateString
  try {
    installOverride(proto, "toDateString", function (this: Date): string {
      try {
        if (spoofingEnabled && timezoneData) {
          if (componentsViaShortOffset) {
            // V8/JavaScriptCore: use shortOffset-derived local date (matches native getter path)
            const local = getLocalDateViaOffset(this, timezoneData.identifier, timezoneData.offset);
            const weekday = SHORT_DAYS[local.getUTCDay()];
            const month = SHORT_MONTHS[local.getUTCMonth()];
            const day = pad2(local.getUTCDate());
            const year = local.getUTCFullYear();
            const result = `${weekday} ${month} ${day} ${year}`;
            logger.trace("toDateString: spoofed", this.getTime(), true, result);
            return result;
          }
          const parts = resolvePartsForDate(this, timezoneData.identifier);
          if (parts) {
            const weekday = parts.weekday;
            const month = SHORT_MONTHS[parts.month - 1];
            const day = pad2(parts.day);
            const year = parts.year;
            const result = `${weekday} ${month} ${day} ${year}`;
            logger.trace("toDateString: spoofed", this.getTime(), false, result);
            return result;
          }
        }
        logger.debug("toDateString: fallback", "spoofing disabled");
        return originals.toDateString.call(this);
      } catch (error) {
        logger.error("Error in toDateString override:", error);
        logger.debug("toDateString: fallback", "error");
        return originals.toDateString.call(this);
      }
    });
  } catch (error) {
    logger.error("Failed to override Date.toDateString:", error);
  }

  // Override toString
  try {
    installOverride(proto, "toString", function (this: Date): string {
      try {
        if (spoofingEnabled && timezoneData) {
          if (componentsViaShortOffset) {
            const local = getLocalDateViaOffset(this, timezoneData.identifier, timezoneData.offset);
            const offsetMinutes = getIntlBasedOffset(
              this,
              timezoneData.identifier,
              timezoneData.offset
            );
            const weekday = SHORT_DAYS[local.getUTCDay()];
            const month = SHORT_MONTHS[local.getUTCMonth()];
            const day = pad2(local.getUTCDate());
            const year = local.getUTCFullYear();
            const hours = pad2(local.getUTCHours());
            const minutes = pad2(local.getUTCMinutes());
            const seconds = pad2(local.getUTCSeconds());
            const gmtOffset = formatGMTOffset(offsetMinutes);
            const longName = getLongTimezoneName(this, timezoneData.identifier);
            const result = `${weekday} ${month} ${day} ${year} ${hours}:${minutes}:${seconds} ${gmtOffset} (${longName})`;
            logger.trace("toString: spoofed", this.getTime(), true, offsetMinutes, result);
            return result;
          }
          const parts = resolvePartsForDate(this, timezoneData.identifier);
          if (parts) {
            const offsetMinutes = deriveOffsetFromParts(this, timezoneData.identifier);
            const weekday = parts.weekday;
            const month = SHORT_MONTHS[parts.month - 1];
            const day = pad2(parts.day);
            const year = parts.year;
            const hours = pad2(parts.hour);
            const minutes = pad2(parts.minute);
            const seconds = pad2(parts.second);
            const gmtOffset = formatGMTOffset(offsetMinutes ?? 0);
            const longName = getLongTimezoneName(this, timezoneData.identifier);
            const result = `${weekday} ${month} ${day} ${year} ${hours}:${minutes}:${seconds} ${gmtOffset} (${longName})`;
            logger.trace("toString: spoofed", this.getTime(), false, offsetMinutes ?? 0, result);
            return result;
          }
        }
        logger.debug("toString: fallback", "spoofing disabled");
        return originals.toString.call(this);
      } catch (error) {
        logger.error("Error in toString override:", error);
        logger.debug("toString: fallback", "error");
        return originals.toString.call(this);
      }
    });
  } catch (error) {
    logger.error("Failed to override Date.toString:", error);
  }

  // Override toTimeString
  try {
    installOverride(proto, "toTimeString", function (this: Date): string {
      try {
        if (spoofingEnabled && timezoneData) {
          if (componentsViaShortOffset) {
            const local = getLocalDateViaOffset(this, timezoneData.identifier, timezoneData.offset);
            const offsetMinutes = getIntlBasedOffset(
              this,
              timezoneData.identifier,
              timezoneData.offset
            );
            const hours = pad2(local.getUTCHours());
            const minutes = pad2(local.getUTCMinutes());
            const seconds = pad2(local.getUTCSeconds());
            const gmtOffset = formatGMTOffset(offsetMinutes);
            const longName = getLongTimezoneName(this, timezoneData.identifier);
            const result = `${hours}:${minutes}:${seconds} ${gmtOffset} (${longName})`;
            logger.trace("toTimeString: spoofed", this.getTime(), true, offsetMinutes, result);
            return result;
          }
          const parts = resolvePartsForDate(this, timezoneData.identifier);
          if (parts) {
            const offsetMinutes = deriveOffsetFromParts(this, timezoneData.identifier);
            const hours = pad2(parts.hour);
            const minutes = pad2(parts.minute);
            const seconds = pad2(parts.second);
            const gmtOffset = formatGMTOffset(offsetMinutes ?? 0);
            const longName = getLongTimezoneName(this, timezoneData.identifier);
            const result = `${hours}:${minutes}:${seconds} ${gmtOffset} (${longName})`;
            logger.trace(
              "toTimeString: spoofed",
              this.getTime(),
              false,
              offsetMinutes ?? 0,
              result
            );
            return result;
          }
        }
        logger.debug("toTimeString: fallback", "spoofing disabled");
        return originals.toTimeString.call(this);
      } catch (error) {
        logger.error("Error in toTimeString override:", error);
        logger.debug("toTimeString: fallback", "error");
        return originals.toTimeString.call(this);
      }
    });
  } catch (error) {
    logger.error("Failed to override Date.toTimeString:", error);
  }

  // Override toLocaleString
  try {
    installOverride(
      proto,
      "toLocaleString",
      function (
        this: Date,
        locales?: string | string[],
        options?: Intl.DateTimeFormatOptions
      ): string {
        // Locale injection lives in this SAME wrapper (not a second one in
        // locale-overrides.ts) so the locale and timezone axes are resolved
        // together and cannot disagree. Note this must apply on the
        // no-timezone path too: locale spoofing is independent of timezone
        // spoofing, so a user with a locale but no spoofed zone still needs it.
        const effectiveLocales = resolveEffectiveLocales(locales);
        try {
          if (spoofingEnabled && timezoneData) {
            const hasExplicitTimezone = options?.timeZone != null;
            if (!hasExplicitTimezone) {
              const opts: Intl.DateTimeFormatOptions = {
                ...options,
                timeZone: timezoneData.identifier,
              };
              return originals.toLocaleString.call(this, effectiveLocales as string, opts);
            }
            return originals.toLocaleString.call(this, effectiveLocales, options);
          }
          logger.debug("toLocaleString: fallback", "spoofing disabled");
          return originals.toLocaleString.call(this, effectiveLocales as string, options);
        } catch (error) {
          logger.error("Error in toLocaleString override:", error);
          logger.debug("toLocaleString: fallback", "error");
          return originals.toLocaleString.call(this, locales as string, options);
        }
      }
    );
  } catch (error) {
    logger.error("Failed to override Date.toLocaleString:", error);
  }

  // Override toLocaleDateString
  try {
    installOverride(
      proto,
      "toLocaleDateString",
      function (
        this: Date,
        locales?: string | string[],
        options?: Intl.DateTimeFormatOptions
      ): string {
        // Locale injection lives in this SAME wrapper (not a second one in
        // locale-overrides.ts) so the locale and timezone axes are resolved
        // together and cannot disagree. Note this must apply on the
        // no-timezone path too: locale spoofing is independent of timezone
        // spoofing, so a user with a locale but no spoofed zone still needs it.
        const effectiveLocales = resolveEffectiveLocales(locales);
        try {
          if (spoofingEnabled && timezoneData) {
            const hasExplicitTimezone = options?.timeZone != null;
            if (!hasExplicitTimezone) {
              const opts: Intl.DateTimeFormatOptions = {
                ...options,
                timeZone: timezoneData.identifier,
              };
              return originals.toLocaleDateString.call(this, effectiveLocales as string, opts);
            }
            return originals.toLocaleDateString.call(this, effectiveLocales, options);
          }
          logger.debug("toLocaleDateString: fallback", "spoofing disabled");
          return originals.toLocaleDateString.call(this, effectiveLocales as string, options);
        } catch (error) {
          logger.error("Error in toLocaleDateString override:", error);
          logger.debug("toLocaleDateString: fallback", "error");
          return originals.toLocaleDateString.call(this, locales as string, options);
        }
      }
    );
  } catch (error) {
    logger.error("Failed to override Date.toLocaleDateString:", error);
  }

  // Override toLocaleTimeString
  try {
    installOverride(
      proto,
      "toLocaleTimeString",
      function (
        this: Date,
        locales?: string | string[],
        options?: Intl.DateTimeFormatOptions
      ): string {
        // Locale injection lives in this SAME wrapper (not a second one in
        // locale-overrides.ts) so the locale and timezone axes are resolved
        // together and cannot disagree. Note this must apply on the
        // no-timezone path too: locale spoofing is independent of timezone
        // spoofing, so a user with a locale but no spoofed zone still needs it.
        const effectiveLocales = resolveEffectiveLocales(locales);
        try {
          if (spoofingEnabled && timezoneData) {
            const hasExplicitTimezone = options?.timeZone != null;
            if (!hasExplicitTimezone) {
              const opts: Intl.DateTimeFormatOptions = {
                ...options,
                timeZone: timezoneData.identifier,
              };
              return originals.toLocaleTimeString.call(this, effectiveLocales as string, opts);
            }
            return originals.toLocaleTimeString.call(this, effectiveLocales, options);
          }
          logger.debug("toLocaleTimeString: fallback", "spoofing disabled");
          return originals.toLocaleTimeString.call(this, effectiveLocales as string, options);
        } catch (error) {
          logger.error("Error in toLocaleTimeString override:", error);
          logger.debug("toLocaleTimeString: fallback", "error");
          return originals.toLocaleTimeString.call(this, locales as string, options);
        }
      }
    );
  } catch (error) {
    logger.error("Failed to override Date.toLocaleTimeString:", error);
  }
}

/**
 * Install Date formatting overrides on the top-level `Date.prototype`.
 *
 * Convenience wrapper for the top-level realm — uses the originals
 * captured at module load in `state.ts`.
 */
export function installDateFormattingOverrides(): void {
  installDateFormattingOverridesOn(Date.prototype, {
    toString: originalToString,
    toDateString: originalToDateString,
    toTimeString: originalToTimeString,
    toLocaleString: originalToLocaleString,
    toLocaleDateString: originalToLocaleDateString,
    toLocaleTimeString: originalToLocaleTimeString,
  });
}
