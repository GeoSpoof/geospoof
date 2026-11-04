/**
 * Date getter overrides.
 *
 * Overrides `getHours`, `getMinutes`, `getSeconds`, `getMilliseconds`,
 * `getDate`, `getDay`, `getMonth`, and `getFullYear` to return values
 * in the spoofed timezone when protection is enabled.
 *
 * Exposes two entry points:
 *   - `installDateGetterOverrides()` — installs on the top-level
 *     `Date.prototype` using the originals captured in `state.ts`. Called
 *     from `index.ts` at module init.
 *   - `installDateGetterOverridesOn(proto, originals)` — installs on an
 *     arbitrary `Date.prototype` using a caller-supplied originals bag.
 *     Called from `iframe-patching.ts` against each same-origin iframe
 *     realm, so the iframe's Date.prototype receives the same overrides
 *     as the top-level one. A single implementation, two call sites.
 *
 * When `componentsViaShortOffset` is true (V8, JavaScriptCore), we shift the
 * epoch via getIntlBasedOffset and read UTC methods on the shifted date,
 * matching how those engines compute local time.
 *
 * On SpiderMonkey, native getters match formatToParts, so we use
 * resolvePartsForDate.
 *
 * Both paths keep the full seconds of a pre-standard-time offset, as every
 * engine's native getters do. The precision of `getTimezoneOffset` is a
 * separate decision (`nativeFractionalOffset`) and doesn't affect these.
 */

import {
  spoofingEnabled,
  timezoneData,
  componentsViaShortOffset,
  originalGetHours,
  originalGetMinutes,
  originalGetSeconds,
  originalGetMilliseconds,
  originalGetDate,
  originalGetDay,
  originalGetMonth,
  originalGetFullYear,
} from "./state";
import { installOverride } from "./function-masking";
import { resolvePartsForDate, getLocalDateViaOffset, WEEKDAY_TO_NUMBER } from "./timezone-helpers";
import { createLogger } from "@/shared/utils/debug-logger";

const logger = createLogger("INJ");

/**
 * Bag of original `Date.prototype` getter references for a single realm.
 *
 * Each `install*OverridesOn` variant accepts one of these so that when an
 * override falls back (because spoofing is disabled, the offset resolution
 * failed, or the handler threw), it calls into THAT realm's native method
 * rather than the top-level realm's. Keeps each realm self-contained:
 * pristine iframe Dates that somehow reach a top-level fallback path don't
 * accidentally cross realms on the fallback call.
 */
export interface DateGetterOriginals {
  getHours: (this: Date) => number;
  getMinutes: (this: Date) => number;
  getSeconds: (this: Date) => number;
  getMilliseconds: (this: Date) => number;
  getDate: (this: Date) => number;
  getDay: (this: Date) => number;
  getMonth: (this: Date) => number;
  getFullYear: (this: Date) => number;
}

/**
 * Install Date getter overrides on the supplied `Date.prototype`.
 *
 * Shared by `installDateGetterOverrides()` (top level) and the iframe
 * patcher (per iframe realm).
 */
export function installDateGetterOverridesOn(proto: object, originals: DateGetterOriginals): void {
  // Override getHours
  try {
    installOverride(proto, "getHours", function (this: Date): number {
      try {
        if (spoofingEnabled && timezoneData) {
          if (componentsViaShortOffset) {
            const local = getLocalDateViaOffset(this, timezoneData.identifier, timezoneData.offset);
            const val = local.getUTCHours();
            logger.trace("getHours: spoofed", this.getTime(), true, val);
            return val;
          }
          const parts = resolvePartsForDate(this, timezoneData.identifier);
          if (parts) {
            logger.trace("getHours: spoofed", this.getTime(), false, parts.hour);
            return parts.hour;
          }
        }
        logger.debug("getHours: fallback", "spoofing disabled");
        return originals.getHours.call(this);
      } catch {
        logger.debug("getHours: fallback", "error");
        return originals.getHours.call(this);
      }
    });
  } catch {
    // Failed to override — original remains in place
  }

  // Override getMinutes
  try {
    installOverride(proto, "getMinutes", function (this: Date): number {
      try {
        if (spoofingEnabled && timezoneData) {
          if (componentsViaShortOffset) {
            const local = getLocalDateViaOffset(this, timezoneData.identifier, timezoneData.offset);
            const val = local.getUTCMinutes();
            logger.trace("getMinutes: spoofed", this.getTime(), true, val);
            return val;
          }
          const parts = resolvePartsForDate(this, timezoneData.identifier);
          if (parts) {
            logger.trace("getMinutes: spoofed", this.getTime(), false, parts.minute);
            return parts.minute;
          }
        }
        logger.debug("getMinutes: fallback", "spoofing disabled");
        return originals.getMinutes.call(this);
      } catch {
        logger.debug("getMinutes: fallback", "error");
        return originals.getMinutes.call(this);
      }
    });
  } catch {
    // Failed to override — original remains in place
  }

  // Override getSeconds
  try {
    installOverride(proto, "getSeconds", function (this: Date): number {
      try {
        if (spoofingEnabled && timezoneData) {
          if (componentsViaShortOffset) {
            const local = getLocalDateViaOffset(this, timezoneData.identifier, timezoneData.offset);
            const val = local.getUTCSeconds();
            logger.trace("getSeconds: spoofed", this.getTime(), true, val);
            return val;
          }
          const parts = resolvePartsForDate(this, timezoneData.identifier);
          if (parts) {
            logger.trace("getSeconds: spoofed", this.getTime(), false, parts.second);
            return parts.second;
          }
        }
        logger.debug("getSeconds: fallback", "spoofing disabled");
        return originals.getSeconds.call(this);
      } catch {
        logger.debug("getSeconds: fallback", "error");
        return originals.getSeconds.call(this);
      }
    });
  } catch {
    // Failed to override — original remains in place
  }

  // Override getMilliseconds — timezone-independent, always passthrough
  // but routed through installOverride so it's toString-masked in the
  // override registry.
  try {
    installOverride(proto, "getMilliseconds", function (this: Date): number {
      try {
        return originals.getMilliseconds.call(this);
      } catch {
        return originals.getMilliseconds.call(this);
      }
    });
  } catch {
    // Failed to override — original remains in place
  }

  // Override getDate (day of month)
  try {
    installOverride(proto, "getDate", function (this: Date): number {
      try {
        if (spoofingEnabled && timezoneData) {
          if (componentsViaShortOffset) {
            const local = getLocalDateViaOffset(this, timezoneData.identifier, timezoneData.offset);
            const val = local.getUTCDate();
            logger.trace("getDate: spoofed", this.getTime(), true, val);
            return val;
          }
          const parts = resolvePartsForDate(this, timezoneData.identifier);
          if (parts) {
            logger.trace("getDate: spoofed", this.getTime(), false, parts.day);
            return parts.day;
          }
        }
        logger.debug("getDate: fallback", "spoofing disabled");
        return originals.getDate.call(this);
      } catch {
        logger.debug("getDate: fallback", "error");
        return originals.getDate.call(this);
      }
    });
  } catch {
    // Failed to override — original remains in place
  }

  // Override getDay (day of week, 0=Sun..6=Sat)
  try {
    installOverride(proto, "getDay", function (this: Date): number {
      try {
        if (spoofingEnabled && timezoneData) {
          if (componentsViaShortOffset) {
            const local = getLocalDateViaOffset(this, timezoneData.identifier, timezoneData.offset);
            const val = local.getUTCDay();
            logger.trace("getDay: spoofed", this.getTime(), true, val);
            return val;
          }
          const parts = resolvePartsForDate(this, timezoneData.identifier);
          if (parts) {
            const val = WEEKDAY_TO_NUMBER[parts.weekday];
            logger.trace("getDay: spoofed", this.getTime(), false, val);
            return val;
          }
        }
        logger.debug("getDay: fallback", "spoofing disabled");
        return originals.getDay.call(this);
      } catch {
        logger.debug("getDay: fallback", "error");
        return originals.getDay.call(this);
      }
    });
  } catch {
    // Failed to override — original remains in place
  }

  // Override getMonth (0-indexed: 0=Jan..11=Dec)
  try {
    installOverride(proto, "getMonth", function (this: Date): number {
      try {
        if (spoofingEnabled && timezoneData) {
          if (componentsViaShortOffset) {
            const local = getLocalDateViaOffset(this, timezoneData.identifier, timezoneData.offset);
            const val = local.getUTCMonth();
            logger.trace("getMonth: spoofed", this.getTime(), true, val);
            return val;
          }
          const parts = resolvePartsForDate(this, timezoneData.identifier);
          if (parts) {
            const val = parts.month - 1;
            logger.trace("getMonth: spoofed", this.getTime(), false, val);
            return val;
          }
        }
        logger.debug("getMonth: fallback", "spoofing disabled");
        return originals.getMonth.call(this);
      } catch {
        logger.debug("getMonth: fallback", "error");
        return originals.getMonth.call(this);
      }
    });
  } catch {
    // Failed to override — original remains in place
  }

  // Override getFullYear
  try {
    installOverride(proto, "getFullYear", function (this: Date): number {
      try {
        if (spoofingEnabled && timezoneData) {
          if (componentsViaShortOffset) {
            const local = getLocalDateViaOffset(this, timezoneData.identifier, timezoneData.offset);
            const val = local.getUTCFullYear();
            logger.trace("getFullYear: spoofed", this.getTime(), true, val);
            return val;
          }
          const parts = resolvePartsForDate(this, timezoneData.identifier);
          if (parts) {
            logger.trace("getFullYear: spoofed", this.getTime(), false, parts.year);
            return parts.year;
          }
        }
        logger.debug("getFullYear: fallback", "spoofing disabled");
        return originals.getFullYear.call(this);
      } catch {
        logger.debug("getFullYear: fallback", "error");
        return originals.getFullYear.call(this);
      }
    });
  } catch {
    // Failed to override — original remains in place
  }
}

/**
 * Install Date getter overrides on the top-level `Date.prototype`.
 *
 * Convenience wrapper for the top-level realm — uses the originals
 * captured at module load in `state.ts`.
 */
export function installDateGetterOverrides(): void {
  installDateGetterOverridesOn(Date.prototype, {
    getHours: originalGetHours,
    getMinutes: originalGetMinutes,
    getSeconds: originalGetSeconds,
    getMilliseconds: originalGetMilliseconds,
    getDate: originalGetDate,
    getDay: originalGetDay,
    getMonth: originalGetMonth,
    getFullYear: originalGetFullYear,
  });
}
