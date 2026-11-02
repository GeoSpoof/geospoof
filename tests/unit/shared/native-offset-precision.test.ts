/**
 * The decision of whether native `getTimezoneOffset` keeps the seconds of a
 * local-mean-time offset (SpiderMonkey, V8 from Chrome 156) or truncates them
 * (V8 before 156, JavaScriptCore). See `src/shared/native-offset-precision.ts`.
 */
import { describe, test, expect, vi } from "vitest";
import {
  OFFSET_PROBE_EPOCH_MS,
  chromiumMajorFromUserAgent,
  decideNativeFractionalOffset,
  engineFamilyFromBuild,
  fallbackFractionalOffset,
  nativeDateSurfaceOf,
  probeNativeOffsetPrecision,
} from "@/shared/native-offset-precision";
import { eastSecondsAt, fakeSurface, type FakeOffsetMode } from "../../helpers/lmt-offsets";

const UA_155 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const UA_156 = UA_155.replace("Chrome/155", "Chrome/156");
const UA_HEADLESS_156 = UA_156.replace("Chrome/156", "HeadlessChrome/156");
const UA_EDGE_156 = `${UA_156} Edg/156.0.0.0`;
const UA_OPERA_155 = `${UA_155} OPR/141.0.0.0`;
const UA_FIREFOX =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:159.0) Gecko/20100101 Firefox/159.0";

/** Seconds east of UTC at the probe instant, by zone. */
const AT_PROBE = {
  "Asia/Tokyo": 33539,
  "America/New_York": -17762,
  "America/Los_Angeles": -28378,
  "Europe/Amsterdam": 1050,
  "Europe/Warsaw": 5040,
  UTC: 0,
} as const;

const SUB_MINUTE_ZONES = [
  "Asia/Tokyo",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/Amsterdam",
] as const;
const WHOLE_MINUTE_ZONES = ["Europe/Warsaw", "UTC"] as const;
const ALL_MODES: FakeOffsetMode[] = ["fractional", "truncated", "rounded", "throws", "nan"];

describe("probe instant", () => {
  test("is 1800-01-01 12:00 UTC", () => {
    expect(OFFSET_PROBE_EPOCH_MS).toBe(Date.UTC(1800, 0, 1, 12));
  });

  test.each(Object.entries(AT_PROBE))("%s is %i s east there", (zone, seconds) => {
    expect(eastSecondsAt(zone, OFFSET_PROBE_EPOCH_MS)).toBe(seconds);
  });
});

describe("probeNativeOffsetPrecision", () => {
  test.each(SUB_MINUTE_ZONES)("%s as the real zone: reads the engine's behavior", (zone) => {
    expect(probeNativeOffsetPrecision(fakeSurface(AT_PROBE[zone], "fractional"))).toBe(
      "fractional"
    );
    expect(probeNativeOffsetPrecision(fakeSurface(AT_PROBE[zone], "truncated"))).toBe("truncated");
  });

  test.each(["Asia/Tokyo", "America/Los_Angeles"] as const)(
    "%s: an engine that rounds matches neither and is inconclusive",
    (zone) => {
      expect(probeNativeOffsetPrecision(fakeSurface(AT_PROBE[zone], "rounded"))).toBe(
        "inconclusive"
      );
    }
  );

  test.each(WHOLE_MINUTE_ZONES)("%s as the real zone: inconclusive under every mode", (zone) => {
    for (const mode of ALL_MODES) {
      expect(probeNativeOffsetPrecision(fakeSurface(AT_PROBE[zone], mode)), mode).toBe(
        "inconclusive"
      );
    }
  });

  test("a throwing or NaN getTimezoneOffset is inconclusive", () => {
    expect(probeNativeOffsetPrecision(fakeSurface(AT_PROBE["Asia/Tokyo"], "throws"))).toBe(
      "inconclusive"
    );
    expect(probeNativeOffsetPrecision(fakeSurface(AT_PROBE["Asia/Tokyo"], "nan"))).toBe(
      "inconclusive"
    );
  });

  test("this engine: matches its own getTimezoneOffset in the machine's zone", () => {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const verdict = probeNativeOffsetPrecision(nativeDateSurfaceOf(Date));
    if (eastSecondsAt(zone, OFFSET_PROBE_EPOCH_MS) % 60 === 0) {
      expect(verdict).toBe("inconclusive");
    } else {
      const gto = new Date(OFFSET_PROBE_EPOCH_MS).getTimezoneOffset();
      expect(verdict).toBe(Number.isInteger(gto) ? "truncated" : "fractional");
    }
  });

  test("one instant is enough: no zone has seconds at another sample but not at the probe", () => {
    // Guards the single-instant choice against future tzdata. Samples January
    // and July every five years, 1800 to 2000.
    const samples: number[] = [];
    for (let year = 1800; year <= 2000; year += 5) {
      samples.push(Date.UTC(year, 0, 15, 12), Date.UTC(year, 6, 15, 12));
    }
    const missed: string[] = [];
    for (const zone of Intl.supportedValuesOf("timeZone")) {
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });
      const hasSeconds = (t: number): boolean =>
        /:\d{2}:\d{2}$/.test(
          fmt.formatToParts(new Date(t)).find((p) => p.type === "timeZoneName")?.value ?? ""
        );
      if (!hasSeconds(OFFSET_PROBE_EPOCH_MS) && samples.some(hasSeconds)) missed.push(zone);
    }
    expect(missed).toEqual([]);
  });
});

describe("chromiumMajorFromUserAgent", () => {
  test("reads the Chrome/N token, including HeadlessChrome, Edge and Opera", () => {
    expect(chromiumMajorFromUserAgent(UA_155)).toBe(155);
    expect(chromiumMajorFromUserAgent(UA_HEADLESS_156)).toBe(156);
    expect(chromiumMajorFromUserAgent(UA_EDGE_156)).toBe(156);
    expect(chromiumMajorFromUserAgent(UA_OPERA_155)).toBe(155);
  });

  test("is null without a token or a string", () => {
    expect(chromiumMajorFromUserAgent(UA_FIREFOX)).toBeNull();
    expect(chromiumMajorFromUserAgent("")).toBeNull();
    expect(chromiumMajorFromUserAgent(undefined)).toBeNull();
    expect(chromiumMajorFromUserAgent(156)).toBeNull();
  });
});

describe("fallbackFractionalOffset", () => {
  test("SpiderMonkey keeps the fraction and JavaScriptCore truncates, without reading the UA", () => {
    const reader = vi.fn(() => UA_155);
    expect(fallbackFractionalOffset("spidermonkey", reader)).toBe(true);
    expect(fallbackFractionalOffset("javascriptcore", reader)).toBe(false);
    expect(reader).not.toHaveBeenCalled();
  });

  test.each([
    ["Chrome 155", UA_155, false],
    ["Chrome 156", UA_156, true],
    ["HeadlessChrome 156", UA_HEADLESS_156, true],
    ["Edge on Chromium 156", UA_EDGE_156, true],
    ["Opera on Chromium 155", UA_OPERA_155, false],
    ["no Chrome token", UA_FIREFOX, true],
    ["no user agent", undefined, true],
  ])("V8, %s → fractional %s", (_label, ua, expected) => {
    expect(fallbackFractionalOffset("v8", () => ua)).toBe(expected);
  });

  test("V8 with a reader that throws → fractional", () => {
    expect(
      fallbackFractionalOffset("v8", () => {
        throw new Error("no navigator");
      })
    ).toBe(true);
  });
});

describe("decideNativeFractionalOffset", () => {
  test("an inconclusive real zone falls back to the user agent on V8", () => {
    expect(decideNativeFractionalOffset(fakeSurface(0, "fractional"), "v8", () => UA_156)).toBe(
      true
    );
    expect(decideNativeFractionalOffset(fakeSurface(0, "truncated"), "v8", () => UA_155)).toBe(
      false
    );
    expect(decideNativeFractionalOffset(fakeSurface(5040, "fractional"), "v8", () => UA_155)).toBe(
      false
    );
  });

  test("a conclusive probe beats the user agent", () => {
    const tokyo = AT_PROBE["Asia/Tokyo"];
    expect(decideNativeFractionalOffset(fakeSurface(tokyo, "truncated"), "v8", () => UA_156)).toBe(
      false
    );
    expect(decideNativeFractionalOffset(fakeSurface(tokyo, "fractional"), "v8", () => UA_155)).toBe(
      true
    );
  });

  test("a conclusive probe beats the engine family", () => {
    const tokyo = AT_PROBE["Asia/Tokyo"];
    const reader = vi.fn(() => UA_155);
    expect(
      decideNativeFractionalOffset(fakeSurface(tokyo, "fractional"), "javascriptcore", reader)
    ).toBe(true);
    expect(
      decideNativeFractionalOffset(fakeSurface(tokyo, "truncated"), "spidermonkey", reader)
    ).toBe(false);
    expect(reader).not.toHaveBeenCalled();
  });
});

describe("engineFamilyFromBuild", () => {
  test("follows the build target (the test build defines the Firefox target)", () => {
    expect(engineFamilyFromBuild()).toBe("spidermonkey");
  });
});
