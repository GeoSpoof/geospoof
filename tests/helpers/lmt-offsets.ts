/**
 * Shared cases and oracles for the sub-minute historical offset tests (local
 * mean time, before each zone adopted standard time). Not a `*.test.ts` file,
 * so Vitest doesn't collect it.
 *
 * Every expected value is computed from Intl's `longOffset` (the zone's offset
 * in whole seconds), never from the code under test, so the main-realm tests
 * and the worker tests check against one oracle and therefore agree with each
 * other.
 */
import type { NativeDateSurface } from "@/shared/native-offset-precision";

export interface LmtCase {
  identifier: string;
  /** Modern standard offset in minutes east, for `TimezoneData`. */
  offset: number;
  /** Modern DST offset in minutes east, for `TimezoneData`. */
  dstOffset: number;
}

/**
 * Tokyo, New York, Los Angeles and Amsterdam have seconds in their local mean
 * time. Warsaw's is a whole number of minutes (+1:24) and UTC has none, so they
 * are the zones the probe can't decide from.
 */
export const LMT_CASES: readonly LmtCase[] = [
  { identifier: "Asia/Tokyo", offset: 540, dstOffset: 540 },
  { identifier: "America/New_York", offset: -300, dstOffset: -240 },
  { identifier: "America/Los_Angeles", offset: -480, dstOffset: -420 },
  { identifier: "Europe/Amsterdam", offset: 60, dstOffset: 120 },
  { identifier: "Europe/Warsaw", offset: 60, dstOffset: 120 },
  { identifier: "UTC", offset: 0, dstOffset: 0 },
];

/** January and July of the oldest and newest years arkenfox TZP's offsets row reads. */
export const TZP_INSTANTS: readonly number[] = [
  Date.UTC(1879, 0, 15, 13),
  Date.UTC(1879, 6, 15, 13),
  Date.UTC(2025, 0, 15, 13),
  Date.UTC(2025, 6, 15, 13),
];

/** The zone's offset east of UTC at `epochMs`, in whole seconds, from Intl `longOffset`. */
export function eastSecondsAt(zone: string, epochMs: number): number {
  const value =
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(new Date(epochMs))
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  if (value === "GMT") return 0;
  const m = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) throw new Error(`unexpected longOffset ${JSON.stringify(value)} for ${zone}`);
  const sign = m[1] === "+" ? 1 : -1;
  return sign * (parseInt(m[2], 10) * 3600 + parseInt(m[3], 10) * 60 + parseInt(m[4] ?? "0", 10));
}

/**
 * What a native engine's `getTimezoneOffset` returns for a zone `eastSec`
 * seconds east of UTC: the exact milliseconds over 60000 (SpiderMonkey, V8 from
 * Chrome 156), or that truncated toward zero (V8 before 156, JavaScriptCore).
 * A zero offset is +0, as native engines return it.
 */
export function expectedGto(eastSec: number, fractional: boolean): number {
  const west = -(eastSec * 1000) / 60000;
  const value = fractional ? west : Math.trunc(west);
  return value === 0 ? 0 : value;
}

/** The offset (minutes west) implied by a date's local getters: TZP's "components" method. */
export function gettersWestMinutes(d: Date): number {
  const localAsUtc = Date.UTC(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds()
  );
  return (d.getTime() - localAsUtc) / 60000;
}

/** Minutes east from the `GMT±HHMM` token of a `toString` / `toTimeString`, or null. */
export function gmtTokenEastMinutes(str: string): number | null {
  const m = /GMT([+-])(\d{2})(\d{2})/.exec(str);
  if (!m) return null;
  const minutes = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
  return m[1] === "-" ? -minutes : minutes;
}

export type FakeOffsetMode = "fractional" | "truncated" | "rounded" | "throws" | "nan";

/**
 * A native-Date surface for a real zone `eastSec` seconds east of UTC at every
 * instant. Local getters apply the full offset (as every engine does);
 * `getTimezoneOffset` behaves per `mode`.
 */
export function fakeSurface(eastSec: number, mode: FakeOffsetMode): NativeDateSurface {
  const local = (d: Date): Date => new Date(d.getTime() + eastSec * 1000);
  const westMinutes = -(eastSec * 1000) / 60000;
  return {
    Date,
    getTimezoneOffset(this: Date): number {
      switch (mode) {
        case "fractional":
          return westMinutes;
        case "truncated":
          return Math.trunc(westMinutes);
        case "rounded":
          return Math.round(westMinutes);
        case "throws":
          throw new TypeError("getTimezoneOffset unavailable");
        case "nan":
          return NaN;
      }
    },
    getFullYear(this: Date): number {
      return local(this).getUTCFullYear();
    },
    getMonth(this: Date): number {
      return local(this).getUTCMonth();
    },
    getDate(this: Date): number {
      return local(this).getUTCDate();
    },
    getHours(this: Date): number {
      return local(this).getUTCHours();
    },
    getMinutes(this: Date): number {
      return local(this).getUTCMinutes();
    },
    getSeconds(this: Date): number {
      return local(this).getUTCSeconds();
    },
    getMilliseconds(this: Date): number {
      return local(this).getUTCMilliseconds();
    },
  };
}
