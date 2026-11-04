/**
 * Does this browser's native `Date.prototype.getTimezoneOffset()` keep the
 * seconds of a pre-standard-time (local mean time) offset, or drop them?
 *
 * Before a zone adopted standard time its offset was local mean time, which has
 * seconds (Asia/Tokyo +9:18:59, America/Los_Angeles -7:52:58). Engines disagree
 * on what `getTimezoneOffset` returns for such dates:
 *
 *   - SpiderMonkey (Firefox) returns the exact fraction: 1879 Tokyo -558.9833…
 *   - V8 before Chrome 156 truncated it toward zero: -558. Chrome 156 changed
 *     this (v8/v8@646e0b7 "[date] Do not truncate getTimezoneOffset() to whole
 *     minutes", crbug.com/40814804, first in 156.0.8078.0) and now returns the
 *     fraction like SpiderMonkey.
 *   - JavaScriptCore (Safari) truncates toward zero (`utcOffsetInMinute` is an
 *     int32 in DatePrototype.cpp).
 *
 * In all three, the local getters (`getHours` … `getSeconds`) and the
 * `toString` offset are unaffected: the getters always apply the full offset,
 * and `toString` always prints whole minutes truncated toward zero.
 *
 * The override has to answer the way the host engine does, or the page sees
 * `getTimezoneOffset` disagree with every other method (arkenfox TZP's
 * `[offsets] timezone` row reads "mixed"). Engine identity can't tell Chrome 155
 * from Chrome 156, so this module decides from behavior.
 *
 * **The probe.** At {@link OFFSET_PROBE_EPOCH_MS} (1800-01-01 12:00 UTC) every
 * zone is still on local mean time. The probe compares the engine's own native
 * `getTimezoneOffset` with the offset implied by its own native local getters,
 * in the real system zone. Both read the same internal LocalTime(t), so no Intl
 * formatting is involved. If the getters show seconds, `getTimezoneOffset` either
 * keeps them (fractional) or drops them (truncated).
 *
 * **Inconclusive real zones.** The probe can only see the real zone. With ICU 77,
 * 43 of 428 zone ids have no seconds at the probe instant, nor at any January or
 * July instant from 1800 to 2000: UTC and Etc/*, zones whose history starts at
 * offset 0, and whole-minute local-mean-time zones such as Europe/Warsaw (+1:24)
 * and Asia/Taipei (+8:06). No other in-realm surface reveals the precision there, so
 * the fallback reproduces what each engine is known to do: SpiderMonkey
 * fractional, JavaScriptCore truncated, V8 by the `Chrome/N` major in the user
 * agent (156 and later fractional, 155 and earlier truncated, no token
 * fractional because that is current Chromium). A user agent claiming another
 * Chrome major, or a Chromium build running on a non-V8 engine, gets the user
 * agent's answer.
 *
 * Pure: every native is passed in, nothing is cached, logged or written to any
 * global. The injected script runs it once in `state.ts` against the natives
 * it captured before installing any override; the Firefox background runs it on
 * its own realm for the workers it patches at the network layer.
 */

/** `Date.UTC(1800, 0, 1, 12)`: before every zone's first transition away from local mean time. */
export const OFFSET_PROBE_EPOCH_MS = -5364619200000;

/**
 * First Chromium major whose V8 keeps the fraction in `getTimezoneOffset`
 * (v8/v8@646e0b7, crbug.com/40814804; earliest build 156.0.8078.0).
 */
export const FIRST_FRACTIONAL_CHROMIUM = 156;

export type OffsetProbeVerdict = "fractional" | "truncated" | "inconclusive";

export type EngineFamily = "v8" | "spidermonkey" | "javascriptcore";

/** The native Date surface the probe reads. Methods are unbound and called with `.call`. */
export interface NativeDateSurface {
  Date: DateConstructor;
  getTimezoneOffset: (this: Date) => number;
  getFullYear: (this: Date) => number;
  getMonth: (this: Date) => number;
  getDate: (this: Date) => number;
  getHours: (this: Date) => number;
  getMinutes: (this: Date) => number;
  getSeconds: (this: Date) => number;
  getMilliseconds: (this: Date) => number;
}

/**
 * Compare the native `getTimezoneOffset` with the native local getters at
 * `epochMs`, in the real system zone.
 *
 * Returns "inconclusive" when the real zone has no seconds at that instant,
 * when anything throws or is not finite, and when `getTimezoneOffset` matches
 * neither the exact nor the truncated value (an engine that rounds, say).
 */
export function probeNativeOffsetPrecision(
  n: NativeDateSurface,
  epochMs: number = OFFSET_PROBE_EPOCH_MS
): OffsetProbeVerdict {
  try {
    const d = new n.Date(epochMs);
    const gto = n.getTimezoneOffset.call(d);
    const localAsUtc = n.Date.UTC(
      n.getFullYear.call(d),
      n.getMonth.call(d),
      n.getDate.call(d),
      n.getHours.call(d),
      n.getMinutes.call(d),
      n.getSeconds.call(d),
      n.getMilliseconds.call(d)
    );
    if (!Number.isFinite(gto) || !Number.isFinite(localAsUtc)) return "inconclusive";
    // Positive = west of UTC, the getTimezoneOffset sign convention.
    const westMs = epochMs - localAsUtc;
    if (westMs % 60000 === 0) return "inconclusive";
    // gto * 60000 is not always an exact integer for a fractional gto, but it
    // always rounds back to the millisecond offset it was divided from.
    if (Math.round(gto * 60000) === westMs) return "fractional";
    if (gto === Math.trunc(westMs / 60000)) return "truncated";
    return "inconclusive";
  } catch {
    return "inconclusive";
  }
}

/** The Chromium major from a `Chrome/N.` token (also matches `HeadlessChrome/N.`), or null. */
export function chromiumMajorFromUserAgent(ua: unknown): number | null {
  if (typeof ua !== "string") return null;
  const m = /Chrome\/(\d+)\./.exec(ua);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * What the engine is known to do when the probe can't tell. `readUserAgent` is
 * only called for V8; a reader that throws counts as "no token".
 */
export function fallbackFractionalOffset(
  engine: EngineFamily,
  readUserAgent: () => string | undefined
): boolean {
  if (engine === "spidermonkey") return true;
  if (engine === "javascriptcore") return false;
  let ua: string | undefined;
  try {
    ua = readUserAgent();
  } catch {
    ua = undefined;
  }
  const major = chromiumMajorFromUserAgent(ua);
  return major === null ? true : major >= FIRST_FRACTIONAL_CHROMIUM;
}

/**
 * True when `getTimezoneOffset` should keep the fraction for this engine: the
 * probe's answer when it has one, otherwise the per-engine fallback.
 */
export function decideNativeFractionalOffset(
  n: NativeDateSurface,
  engine: EngineFamily,
  readUserAgent: () => string | undefined
): boolean {
  const verdict = probeNativeOffsetPrecision(n);
  if (verdict === "fractional") return true;
  if (verdict === "truncated") return false;
  return fallbackFractionalOffset(engine, readUserAgent);
}

/** The engine family this bundle was built for (Vite `define`). */
export function engineFamilyFromBuild(): EngineFamily {
  if (__FIREFOX__) return "spidermonkey";
  if (__SAFARI__) return "javascriptcore";
  return "v8";
}

/** Read the probe's surface off a realm's `Date`. Call before any override is installed on it. */
export function nativeDateSurfaceOf(D: DateConstructor): NativeDateSurface {
  /* eslint-disable @typescript-eslint/unbound-method -- re-bound with .call by the probe */
  return {
    Date: D,
    getTimezoneOffset: D.prototype.getTimezoneOffset,
    getFullYear: D.prototype.getFullYear,
    getMonth: D.prototype.getMonth,
    getDate: D.prototype.getDate,
    getHours: D.prototype.getHours,
    getMinutes: D.prototype.getMinutes,
    getSeconds: D.prototype.getSeconds,
    getMilliseconds: D.prototype.getMilliseconds,
  };
  /* eslint-enable @typescript-eslint/unbound-method */
}
