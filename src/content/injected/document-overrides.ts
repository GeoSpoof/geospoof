/**
 * Document-level overrides for timezone-derived surfaces.
 *
 * `Document.prototype.lastModified` is a getter that returns a string
 * formatted as `"MM/DD/YYYY HH:MM:SS"` in the real system timezone —
 * it bypasses every `Date` / `Intl` / `Temporal` override because it
 * reads directly from the document metadata layer (HTTP Last-Modified
 * header, or the current time for blank / DOMParser-constructed
 * documents). TZP and similar detectors use this as a ground-truth
 * timezone source to detect spoofing: they compare the offset derived
 * from `lastModified` against `Date.prototype.toString()` etc., and
 * any disagreement flags the extension.
 *
 * We close the leak by overriding the getter to reformat the string
 * in the spoofed timezone. The value's underlying UTC epoch is
 * recovered by parsing the native string back through the REAL system
 * timezone (since that's how the browser produced it), then reformatted
 * using the SPOOFED timezone via `Intl.DateTimeFormat` — reusing the
 * same resolution path every other Date override uses for consistency.
 *
 * In Engine-level Spoofing (Chromium) the engine's zone is emulated but this
 * string isn't: Chrome still formats it in the OS zone. There the realm parses
 * it with the OS offset it recovers from a blank document (see
 * `lastModifiedEpoch`), and the getter follows the page's zone even where the
 * engine owns Date/Intl (`engineTimezoneData`).
 *
 * Three call sites benefit from this automatically once the prototype
 * getter is patched:
 * - `document.lastModified` (the top-level document)
 * - `new DOMParser().parseFromString('', 'text/html').lastModified`
 * - `Document.parseHTMLUnsafe('').lastModified`
 * - `iframe.contentDocument.lastModified` (via the iframe realm's own
 *   `Document.prototype`, patched by `patchIframeWindow`)
 */

import {
  OriginalDate,
  OriginalDateTimeFormat,
  originalGetTimezoneOffset,
  spoofingEnabled,
  timezoneData,
  engineTimezoneData,
  engineTimezoneMode,
} from "./state";
import { installScrubbedAccessor } from "./function-masking";
import { seedFromBootstrap } from "./bootstrap";
import { createLogger } from "@/shared/utils/debug-logger";

const logger = createLogger("INJ");

// Captured at module load (document_start, before any page script), for the
// blank document below.
const NativeDOMParser: typeof DOMParser | undefined =
  typeof DOMParser !== "undefined" ? DOMParser : undefined;
// eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound via .call below
const nativeParseFromString = NativeDOMParser?.prototype.parseFromString;
const originalDateNow = Date.now;

/**
 * One blank document for the realm, created on first use. Chrome stamps a
 * document without a `Last-Modified` header with the current time on every
 * read, in the OS zone, so its native `lastModified` tells the realm the OS
 * offset without the page ever seeing the OS zone. Null if it can't be made.
 */
let blankDocument: Document | null | undefined;
function getBlankDocument(): Document | null {
  if (blankDocument !== undefined) return blankDocument;
  try {
    blankDocument =
      NativeDOMParser && nativeParseFromString
        ? nativeParseFromString.call(new NativeDOMParser(), "", "text/html")
        : null;
  } catch {
    blankDocument = null;
  }
  return blankDocument;
}

const LAST_MODIFIED_FORMAT = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * The wall clock of a native `lastModified` string (`"MM/DD/YYYY HH:MM:SS"`),
 * read as if it were UTC, in ms. Null when the format doesn't match.
 */
export function parseLastModifiedWallClock(str: string): number | null {
  const m = LAST_MODIFIED_FORMAT.exec(str);
  if (!m) return null;
  const ms = OriginalDate.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The OS zone's offset now, in minutes east of UTC, from a blank document's
 * `lastModified` (`osNow`, "now" in the OS zone) and the epoch read right after
 * it. The string drops the milliseconds, so the result is rounded to a minute.
 */
export function osOffsetMinutesEast(osNow: string, nowMs: number): number | null {
  const wall = parseLastModifiedWallClock(osNow);
  if (wall === null) return null;
  return Math.round((wall - nowMs) / 60000);
}

/** What {@link lastModifiedEpoch} needs from the realm; a seam for tests. */
export interface LastModifiedContext {
  /** Engine-level Spoofing is on (the payload's `engineTimezone`). */
  engineMode: boolean;
  /** Now, read right after `osNow`. */
  nowMs: number;
  /** A blank document's native `lastModified`, or null. */
  osNow: () => string | null;
  /** The engine's own (possibly emulated) offset at an instant, minutes east. */
  engineOffsetEastAt: (ms: number) => number;
  /** Parse the string as the engine's local time (the injected path's way). */
  parseLocal: (str: string) => number | null;
}

/**
 * The instant a native `lastModified` string stands for.
 *
 * Chrome formats it in the OS zone, which the engine's emulated zone doesn't
 * change. So outside Engine-level Spoofing, and wherever the engine isn't
 * emulating a different offset, it's parsed as engine-local time, with exact
 * DST handling. Where the engine is emulated, it's parsed with the OS offset
 * the realm recovers from a blank document. That offset is today's, so a
 * `Last-Modified` header from the other side of an OS DST change comes back off
 * by the DST delta (documented in `docs/API.md`).
 */
export function lastModifiedEpoch(native: string, ctx: LastModifiedContext): number | null {
  if (!ctx.engineMode) return ctx.parseLocal(native);
  const osNow = ctx.osNow();
  const osOffset = osNow === null ? null : osOffsetMinutesEast(osNow, ctx.nowMs);
  if (osOffset === null || osOffset === ctx.engineOffsetEastAt(ctx.nowMs)) {
    return ctx.parseLocal(native);
  }
  const wall = parseLastModifiedWallClock(native);
  return wall === null ? null : wall - osOffset * 60000;
}

/**
 * Parse the native `lastModified` string (`"MM/DD/YYYY HH:MM:SS"`)
 * into a UTC epoch in milliseconds.
 *
 * The native string is in the real system local timezone, so we
 * build a Date in local time and read `.getTime()` to get the UTC
 * epoch. Returns `null` when the format doesn't match.
 */
function parseNativeLastModified(str: string): number | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(str);
  if (!match) return null;
  const month = Number.parseInt(match[1], 10) - 1;
  const day = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  const hours = Number.parseInt(match[4], 10);
  const minutes = Number.parseInt(match[5], 10);
  const seconds = Number.parseInt(match[6], 10);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds)
  ) {
    return null;
  }
  // `new Date(year, month, day, h, m, s)` interprets the arguments
  // in the REAL system local timezone, which is exactly what the
  // native `lastModified` emitted. `.getTime()` then returns UTC.
  const d = new OriginalDate(year, month, day, hours, minutes, seconds);
  const epoch = d.getTime();
  if (!Number.isFinite(epoch)) return null;
  return epoch;
}

/**
 * Reformat a UTC epoch into the `"MM/DD/YYYY HH:MM:SS"` string format
 * that `Document.prototype.lastModified` emits, but rendered in the
 * SPOOFED timezone. Uses `Intl.DateTimeFormat` via `formatToParts` so
 * we can assemble the exact format the native getter produces without
 * going through any of our overridden `Date.prototype` methods.
 */
function formatInSpoofedZone(epoch: number, timezoneId: string): string {
  const d = new OriginalDate(epoch);
  const fmt = new OriginalDateTimeFormat("en-US", {
    timeZone: timezoneId,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  // `en-US` with `hour12: false` can emit "24" for midnight on some
  // engines — normalize to "00" so the output format is stable.
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return `${get("month")}/${get("day")}/${get("year")} ${hour}:${get("minute")}:${get("second")}`;
}

/**
 * Install the `Document.prototype.lastModified` override on the given
 * realm's `Document.prototype`. Exported so `iframe-patching.ts` can
 * call it for each patched iframe realm; the top-level `installDocumentOverrides`
 * calls it with the main window's Document prototype.
 */
export function installLastModifiedOverride(documentProto: object): void {
  const desc = Object.getOwnPropertyDescriptor(documentProto, "lastModified");
  if (!desc?.get) {
    logger.debug("[lastModified-install] getter not found on Document.prototype, skipping", {
      isTopLevel: documentProto === (typeof Document !== "undefined" ? Document.prototype : null),
    });
    return;
  }
  if (desc.configurable === false) {
    // Defensive: WebIDL spec says this is configurable, and all known
    // engines comply, but if a future engine locks it down we'd throw
    // at `Object.defineProperty` and crash the whole injection. Skip
    // the override and let the native value leak rather than breaking
    // every other override.
    logger.warn(
      "[lastModified-install] Document.prototype.lastModified is non-configurable, skipping override"
    );
    return;
  }
  // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional: re-bound via .call(this) inside the wrapper
  const originalGet = desc.get;

  // The getter body. A foreign `this` makes `originalGet.call(this)` throw a
  // native brand-check TypeError; `installScrubbedAccessor` wraps this (no
  // prototype / [[Construct]], and strips our injected frames from any thrown
  // error), so we don't repeat that plumbing here.
  function spoofedLastModified(this: Document): string {
    // Close the document_start race for `document.lastModified` (and the
    // DOMParser / parseHTMLUnsafe / iframe variants that share this getter):
    // seed from the early bootstrap global if it hasn't been consumed yet.
    seedFromBootstrap();
    const native = originalGet.call(this) as string;
    // Where the engine owns Date/Intl (Engine-level Spoofing), `timezoneData`
    // is null but this getter still has to follow the page's zone.
    const zone = timezoneData ?? engineTimezoneData;
    if (!spoofingEnabled || !zone) {
      logger.debug("[lastModified-get] spoofing disabled, returning native", {
        native,
        spoofingEnabled,
        hasTimezoneData: zone !== null,
      });
      return native;
    }
    try {
      let osNow: string | null = null;
      let nowMs = 0;
      if (engineTimezoneMode) {
        // The blank document first, then the epoch, so the rounding in
        // osOffsetMinutesEast absorbs the gap.
        const blank = getBlankDocument();
        osNow = blank ? (originalGet.call(blank) as string) : null;
        nowMs = originalDateNow();
      }
      const epoch = lastModifiedEpoch(native, {
        engineMode: engineTimezoneMode,
        nowMs,
        osNow: () => osNow,
        engineOffsetEastAt: (ms) => -originalGetTimezoneOffset.call(new OriginalDate(ms)),
        parseLocal: parseNativeLastModified,
      });
      if (epoch === null) {
        logger.debug("[lastModified-get] parse failed, returning native", { native });
        return native;
      }
      const spoofed = formatInSpoofedZone(epoch, zone.identifier);
      logger.debug("[lastModified-get] spoofed", {
        native,
        spoofed,
        zone: zone.identifier,
      });
      return spoofed;
    } catch (err) {
      logger.warn("[lastModified-get] override failed, returning native value:", err);
      return native;
    }
  }

  installScrubbedAccessor(documentProto, "lastModified", { get: spoofedLastModified });

  logger.debug("[lastModified-install] override installed on Document.prototype", {
    isTopLevel: documentProto === (typeof Document !== "undefined" ? Document.prototype : null),
  });
}

/**
 * Install all Document-level overrides on the top-level realm. Called
 * by `src/content/injected/index.ts` during initialization.
 */
export function installDocumentOverrides(): void {
  if (typeof Document === "undefined" || !Document.prototype) {
    logger.warn("Document not available, skipping Document overrides");
    return;
  }
  installLastModifiedOverride(Document.prototype);
}
