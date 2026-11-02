/**
 * Main-realm `getTimezoneOffset` before standard time (local mean time, whose
 * offsets have seconds), under both native behaviors:
 *
 *   - fractional: SpiderMonkey, V8 from Chrome 156 (1879 Tokyo -558.9833…)
 *   - truncated:  V8 before Chrome 156, JavaScriptCore (1879 Tokyo -558)
 *
 * Whichever the engine does, the override must do the same, and the local
 * getters must keep the seconds either way, because that is what every engine's
 * native getters do. Otherwise arkenfox TZP's `[offsets] timezone` row, which
 * hashes the offset from ten methods, reads "mixed".
 *
 * Runs the production installers against a synthetic `Date.prototype` (an
 * object inheriting from the real one), so the global `Date` is never modified.
 * Expected values come from `tests/helpers/lmt-offsets.ts`, the same oracle the
 * worker-payload tests use.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import {
  LMT_CASES,
  TZP_INSTANTS,
  eastSecondsAt,
  expectedGto,
  fakeSurface,
  gettersWestMinutes,
} from "../../helpers/lmt-offsets";
import {
  OFFSET_PROBE_EPOCH_MS,
  decideNativeFractionalOffset,
} from "@/shared/native-offset-precision";

type StateModule = typeof import("@/content/injected/state");
type MakeDate = (epochMs: number) => Date;
type BuildRealm = (fractional: boolean) => MakeDate;

const UA_HEADLESS_156 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36";
const UA_155 = UA_HEADLESS_156.replace("HeadlessChrome/156", "Chrome/155");

/** `state.ts` captures navigator.geolocation at import time and jsdom has none. */
function polyfillGeolocation(): void {
  if (!("geolocation" in navigator)) {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: () => undefined,
        watchPosition: () => 0,
        clearWatch: () => undefined,
      },
      configurable: true,
    });
  }
}

/** Import the injected modules (fresh after `vi.resetModules()`) and return a realm factory. */
async function loadInjected(): Promise<{ state: StateModule; realm: BuildRealm }> {
  polyfillGeolocation();
  const state = await import("@/content/injected/state");
  const { installGetTimezoneOffsetOverrideOn } =
    await import("@/content/injected/timezone-overrides");
  const { installDateGetterOverridesOn } = await import("@/content/injected/date-getters");
  const { installDateFormattingOverridesOn } = await import("@/content/injected/date-formatting");
  state.setSettingsReceived(true);
  state.setSpoofingEnabled(true);

  const realm: BuildRealm = (fractional) => {
    const proto = Object.create(Date.prototype) as object;
    installGetTimezoneOffsetOverrideOn(proto, state.originalGetTimezoneOffset, fractional);
    installDateGetterOverridesOn(proto, {
      getHours: state.originalGetHours,
      getMinutes: state.originalGetMinutes,
      getSeconds: state.originalGetSeconds,
      getMilliseconds: state.originalGetMilliseconds,
      getDate: state.originalGetDate,
      getDay: state.originalGetDay,
      getMonth: state.originalGetMonth,
      getFullYear: state.originalGetFullYear,
    });
    installDateFormattingOverridesOn(proto, {
      toString: state.originalToString,
      toDateString: state.originalToDateString,
      toTimeString: state.originalToTimeString,
      toLocaleString: state.originalToLocaleString,
      toLocaleDateString: state.originalToLocaleDateString,
      toLocaleTimeString: state.originalToLocaleTimeString,
    });
    return (t) => Object.setPrototypeOf(new Date(t), proto) as Date;
  };
  return { state, realm };
}

function label(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The agreement checks for every case. Registered twice: once on the V8 /
 * JavaScriptCore component path, once on the SpiderMonkey one.
 */
function describeAgreement(get: () => { state: StateModule; realm: BuildRealm }): void {
  for (const fractional of [true, false]) {
    describe(fractional ? "native keeps the fraction" : "native truncates", () => {
      for (const zone of LMT_CASES) {
        for (const t of TZP_INSTANTS) {
          test(`${zone.identifier} ${label(t)}`, () => {
            const { state, realm } = get();
            state.setTimezoneData(zone);
            const d = realm(fractional)(t);
            const eastSec = eastSecondsAt(zone.identifier, t);
            const gto = d.getTimezoneOffset();
            const gettersWest = gettersWestMinutes(d);

            expect(gto).toBe(expectedGto(eastSec, fractional));
            // The getters keep the seconds under both decisions.
            expect(gettersWest).toBe(expectedGto(eastSec, true));
            expect(gto).toBe(fractional ? gettersWest : Math.trunc(gettersWest));
          });
        }
      }
    });
  }
}

const shared: { state?: StateModule; realm?: BuildRealm } = {};

beforeAll(async () => {
  Object.assign(shared, await loadInjected());
});

describe("getTimezoneOffset agrees with the getters (V8 / JavaScriptCore component path)", () => {
  test("this suite runs the shortOffset component path", () => {
    expect(shared.state!.componentsViaShortOffset).toBe(true);
  });
  describeAgreement(() => ({ state: shared.state!, realm: shared.realm! }));
});

describe("pinned values, 1879-01-15 13:00 UTC", () => {
  const T = Date.UTC(1879, 0, 15, 13);
  test.each([
    ["Asia/Tokyo", -558.9833333333333, -558],
    ["America/New_York", 296.03333333333336, 296],
    ["America/Los_Angeles", 472.96666666666664, 472],
    ["Europe/Amsterdam", -17.5, -17],
    ["Europe/Warsaw", -84, -84],
    ["UTC", 0, 0],
  ])("%s: fractional %d, truncated %d", (identifier, fractionalValue, truncatedValue) => {
    const zone = LMT_CASES.find((z) => z.identifier === identifier)!;
    shared.state!.setTimezoneData(zone);
    expect(shared.realm!(true)(T).getTimezoneOffset()).toBe(fractionalValue);
    expect(shared.realm!(false)(T).getTimezoneOffset()).toBe(truncatedValue);
  });

  test("2025 values are whole minutes and identical under both decisions", () => {
    for (const zone of LMT_CASES) {
      shared.state!.setTimezoneData(zone);
      for (const t of TZP_INSTANTS.filter((x) => new Date(x).getUTCFullYear() === 2025)) {
        const a = shared.realm!(true)(t).getTimezoneOffset();
        const b = shared.realm!(false)(t).getTimezoneOffset();
        expect(Number.isInteger(a), `${zone.identifier} ${label(t)}`).toBe(true);
        expect(a).toBe(b);
      }
    }
  });
});

describe("contract: the shortOffset parse is exactly milliseconds / 60000", () => {
  test("for every zone at the probe instant", async () => {
    // getTimezoneOffset's fractional value comes from parsing shortOffset
    // ("GMT+9:18:59"); native engines and TZP's date-arithmetic methods divide
    // milliseconds by 60000. TZP hashes the values, so they must be identical
    // doubles, not merely close.
    const { parseGMTOffset } = await import("@/content/injected/timezone-helpers");
    const mismatches: string[] = [];
    for (const zone of Intl.supportedValuesOf("timeZone")) {
      const short =
        new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
          .formatToParts(new Date(OFFSET_PROBE_EPOCH_MS))
          .find((p) => p.type === "timeZoneName")?.value ?? "";
      const eastSec = eastSecondsAt(zone, OFFSET_PROBE_EPOCH_MS);
      if (parseGMTOffset(short) !== (eastSec * 1000) / 60000) mismatches.push(`${zone} ${short}`);
    }
    expect(mismatches).toEqual([]);
  });
});

describe("real zone with no seconds: the decision falls back to the user agent", () => {
  const TOKYO_1879 = Date.UTC(1879, 0, 15, 13);
  const tokyo = LMT_CASES.find((z) => z.identifier === "Asia/Tokyo")!;

  test.each([
    ["UTC", 0],
    ["Europe/Warsaw", 5040],
  ])("%s as the real zone", (_name, realEastSec) => {
    shared.state!.setTimezoneData(tokyo);
    for (const mode of ["fractional", "truncated"] as const) {
      const surface = fakeSurface(realEastSec, mode);
      const on156 = decideNativeFractionalOffset(surface, "v8", () => UA_HEADLESS_156);
      const on155 = decideNativeFractionalOffset(surface, "v8", () => UA_155);
      expect(on156).toBe(true);
      expect(on155).toBe(false);
      expect(shared.realm!(on156)(TOKYO_1879).getTimezoneOffset()).toBe(-558.9833333333333);
      expect(shared.realm!(on155)(TOKYO_1879).getTimezoneOffset()).toBe(-558);
    }
  });
});

describe("getTimezoneOffset agrees with the getters (SpiderMonkey component path)", () => {
  const sm: { state?: StateModule; realm?: BuildRealm } = {};
  const g = globalThis as { InternalError?: unknown };

  beforeAll(async () => {
    vi.resetModules();
    g.InternalError = function InternalError(): void {};
    Object.assign(sm, await loadInjected());
  });

  afterAll(() => {
    delete g.InternalError;
    vi.resetModules();
  });

  test("this suite runs the formatToParts component path", () => {
    expect(sm.state!.componentsViaShortOffset).toBe(false);
  });
  describeAgreement(() => ({ state: sm.state!, realm: sm.realm! }));
});
