/**
 * `document.lastModified` in Engine-level Spoofing (Chromium).
 *
 * Chrome formats the string in the OS zone, below the engine's emulated zone,
 * so parsing it as engine-local time (the injected path's way) gives the wrong
 * instant there. The realm recovers the OS offset itself from a blank
 * document's `lastModified` ("now" in the OS zone) and parses with that. A
 * `Last-Modified` header from the other side of an OS DST change comes back
 * off by the DST delta: the documented residual.
 *
 * Native strings are built with Intl in the stated OS zone, so these don't
 * depend on the machine's zone.
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import type { LastModifiedContext } from "@/content/injected/document-overrides";

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

async function loadModules() {
  vi.resetModules();
  polyfillGeolocation();
  const state = await import("@/content/injected/state");
  const doc = await import("@/content/injected/document-overrides");
  return { state, doc };
}

/** The "MM/DD/YYYY HH:MM:SS" string Chrome would print for `ms` in `zone`. */
function nativeIn(zone: string, ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("month")}/${get("day")}/${get("year")} ${hour}:${get("minute")}:${get("second")}`;
}

/** Minutes east of UTC for `zone` at `ms`. */
function eastIn(zone: string, ms: number): number {
  const s = nativeIn(zone, Math.floor(ms / 1000) * 1000);
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(s)!;
  const wall = Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
}

const ENGINE_ZONE = "Asia/Tokyo";

function engineCtx(os: string, nowMs: number, osNowMs = nowMs): LastModifiedContext {
  return {
    engineCanBeEmulated: true,
    nowMs,
    osNow: () => nativeIn(os, osNowMs),
    engineOffsetEastAt: (ms) => eastIn(ENGINE_ZONE, ms),
    parseLocal: () => {
      throw new Error("parseLocal must not be used while the engine is emulated");
    },
  };
}

describe("lastModifiedEpoch in Engine-level Spoofing", () => {
  // 2026-01-15 12:00:00 UTC, and a Last-Modified header three days earlier:
  // the same DST period in every zone below.
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
  const HEADER = NOW - 3 * 86400e3 + 1234 * 1000;

  test.each(["America/New_York", "Asia/Kolkata", "Australia/Eucla", "Pacific/Chatham"])(
    "OS zone %s: the header's instant comes back exactly",
    async (os) => {
      const { doc } = await loadModules();
      expect(doc.lastModifiedEpoch(nativeIn(os, HEADER), engineCtx(os, NOW))).toBe(HEADER);
    }
  );

  test("now read 999 ms past the string's second: the OS offset is still exact", async () => {
    const { doc } = await loadModules();
    const ctx = engineCtx("Asia/Kolkata", NOW + 999, NOW);
    expect(doc.lastModifiedEpoch(nativeIn("Asia/Kolkata", HEADER), ctx)).toBe(HEADER);
    expect(doc.osOffsetMinutesEast(nativeIn("Asia/Kolkata", NOW), NOW + 999)).toBe(330);
  });

  test("documented residual: a July header read in November is off by the OS DST delta", async () => {
    const { doc } = await loadModules();
    const now = Date.UTC(2026, 10, 15, 12);
    const july = Date.UTC(2026, 6, 15, 12);
    const epoch = doc.lastModifiedEpoch(
      nativeIn("America/New_York", july),
      engineCtx("America/New_York", now)
    );
    // Parsed with November's -5:00 instead of July's -4:00.
    expect(epoch).toBe(july + 60 * 60000);
  });

  test("engine offset equal to the OS offset: parsed as local time, exact DST handling", async () => {
    const { doc } = await loadModules();
    const parseLocal = vi.fn().mockReturnValue(42);
    const ctx: LastModifiedContext = {
      ...engineCtx("Asia/Tokyo", NOW),
      parseLocal,
    };
    expect(doc.lastModifiedEpoch("01/12/2026 21:20:34", ctx)).toBe(42);
    expect(parseLocal).toHaveBeenCalledExactlyOnceWith("01/12/2026 21:20:34");
  });

  test("the OS offset can't be read: parsed as local time", async () => {
    const { doc } = await loadModules();
    const parseLocal = vi.fn().mockReturnValue(7);
    const ctx: LastModifiedContext = {
      ...engineCtx("America/New_York", NOW),
      osNow: () => null,
      parseLocal,
    };
    expect(doc.lastModifiedEpoch("01/12/2026 21:20:34", ctx)).toBe(7);
  });

  test("Firefox and Safari: parsed as local time, exactly as before", async () => {
    const { doc } = await loadModules();
    const parseLocal = vi.fn().mockReturnValue(99);
    const osNow = vi.fn().mockReturnValue("01/15/2026 07:00:00");
    const ctx: LastModifiedContext = {
      engineCanBeEmulated: false,
      nowMs: NOW,
      osNow,
      engineOffsetEastAt: () => 540,
      parseLocal,
    };
    expect(doc.lastModifiedEpoch("01/12/2026 21:20:34", ctx)).toBe(99);
    expect(doc.emulatedOsOffset(ctx)).toBeNull();
    expect(osNow).not.toHaveBeenCalled();
  });

  test("emulatedOsOffset: the OS offset only where the engine reports another", async () => {
    const { doc } = await loadModules();
    expect(doc.emulatedOsOffset(engineCtx("America/New_York", NOW))).toBe(-300);
    expect(doc.emulatedOsOffset(engineCtx("Asia/Tokyo", NOW))).toBeNull();
  });

  test("parseLastModifiedWallClock: the wall clock as UTC, or null", async () => {
    const { doc } = await loadModules();
    expect(doc.parseLastModifiedWallClock("01/15/2026 07:00:01")).toBe(
      Date.UTC(2026, 0, 15, 7, 0, 1)
    );
    expect(doc.parseLastModifiedWallClock("2026-01-15 07:00:01")).toBeNull();
  });
});

/** Minutes east implied by a lastModified string read now. */
function eastOf(str: string): number {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(str)!;
  const wall = Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
  return Math.round((wall - Date.now()) / 60000);
}

describe("the lastModified getter", () => {
  const TOKYO = { identifier: "Asia/Tokyo", offset: 540, dstOffset: 0 };
  /** A prototype with its own copy of the native getter, so jsdom's stays untouched. */
  function syntheticDocumentProto(): Document {
    const proto = Object.create(Document.prototype) as Document;
    Object.defineProperty(
      proto,
      "lastModified",
      Object.getOwnPropertyDescriptor(Document.prototype, "lastModified")!
    );
    return proto;
  }

  test("Engine-level, engine-owned realm: the page's zone, within 2 s", async () => {
    const { state, doc } = await loadModules();
    const proto = syntheticDocumentProto();
    doc.installLastModifiedOverride(proto);
    state.setSpoofingEnabled(true);
    state.setTimezoneData(null);
    state.setEngineTimezoneData(TOKYO);
    state.setEngineTimezoneMode(true);
    const value = String(Reflect.get(proto, "lastModified", document));
    expect(Math.abs(eastOf(value) - eastIn("Asia/Tokyo", Date.now()))).toBeLessThanOrEqual(1);
  });

  test("Firefox-style seeding (timezoneData, no flag): unchanged", async () => {
    const { state, doc } = await loadModules();
    const proto = syntheticDocumentProto();
    doc.installLastModifiedOverride(proto);
    state.setSpoofingEnabled(true);
    state.setTimezoneData(TOKYO);
    state.setEngineTimezoneData(null);
    state.setEngineTimezoneMode(false);
    const value = String(Reflect.get(proto, "lastModified", document));
    expect(Math.abs(eastOf(value) - eastIn("Asia/Tokyo", Date.now()))).toBeLessThanOrEqual(1);
  });

  test("no zone at all: native", async () => {
    const { state, doc } = await loadModules();
    const proto = syntheticDocumentProto();
    doc.installLastModifiedOverride(proto);
    state.setSpoofingEnabled(true);
    state.setTimezoneData(null);
    state.setEngineTimezoneData(null);
    const value = String(Reflect.get(proto, "lastModified", document));
    expect(Math.abs(eastOf(value) + new Date().getTimezoneOffset())).toBeLessThanOrEqual(1);
  });
});

/**
 * Chrome can keep a CDP override after the session ends (another extension's
 * frame in the page), and then refuses to revert it. Turning the mode off,
 * protection off, or a Filters exclusion then reaches the page while its engine
 * still reports the override's zone. Every `lastModified` surface must agree
 * with Date there too.
 *
 * Stand-in: jsdom's engine (the host zone) plays the kept override, and the
 * document's native getter prints "now" in OS_ZONE, a zone with another offset,
 * as Chrome prints the OS zone under an override.
 */
describe("lastModified after Chrome kept the override", () => {
  const HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const OS_ZONE = new Date().getTimezoneOffset() === -330 ? "Pacific/Chatham" : "Asia/Kolkata";
  const PAGE_ZONE = { identifier: HOST_ZONE, offset: 0, dstOffset: 0 };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A prototype whose native getter prints now in OS_ZONE, for any real document. */
  function osZoneDocumentProto(): Document {
    const proto = Object.create(Document.prototype) as Document;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with each document below
    const jsdomGetter = Object.getOwnPropertyDescriptor(Document.prototype, "lastModified")!.get!;
    Object.defineProperty(proto, "lastModified", {
      configurable: true,
      enumerable: true,
      get(this: Document) {
        jsdomGetter.call(this); // the brand check
        return nativeIn(OS_ZONE, Date.now());
      },
    });
    return proto;
  }

  function dispatch(eventName: string, enabled: boolean, engineTimezone: boolean): void {
    const detail = {
      enabled,
      location: null,
      timezone: PAGE_ZONE,
      engineTimezone,
      debugLogging: false,
      verbosityLevel: "INFO",
      webrtcProtection: false,
      preserveGeolocationPrompt: false,
      locale: null,
    };
    window.dispatchEvent(new CustomEvent(eventName, { detail }));
  }

  /** Each surface's offset from lastModified, and what Date reports (the host, here). */
  function surfaces(proto: Document) {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    try {
      const read = (d: Document): number => eastOf(String(Reflect.get(proto, "lastModified", d)));
      return {
        document: read(document),
        domParser: read(new DOMParser().parseFromString("", "text/html")),
        iframe: read(frame.contentDocument!),
        date: -new Date().getTimezoneOffset(),
      };
    } finally {
      frame.remove();
    }
  }

  async function retainedOverride(chromium: boolean) {
    vi.stubGlobal("__CHROMIUM__", chromium);
    const { state, doc } = await loadModules();
    const { installSettingsListener } = await import("@/content/injected/settings-listener");
    installSettingsListener();
    const proto = osZoneDocumentProto();
    doc.installLastModifiedOverride(proto);
    // Engine-level on, and the engine reports the page's zone: engine-owned.
    dispatch(state.EVENT_NAME, true, true);
    expect(state.timezoneData).toBeNull();
    return { state, proto };
  }

  const near = (r: ReturnType<typeof surfaces>, east: number): void => {
    for (const v of [r.document, r.domParser, r.iframe]) {
      expect(Math.abs(v - east)).toBeLessThanOrEqual(1);
    }
  };

  // Protection off and a Filters exclusion send the same payload: enabled false.
  test.each([
    ["Engine-level off (the injected path takes the zone)", true, false],
    ["protection off or a Filters exclusion (native Date)", false, true],
    ["Engine-level off, then protection off or an exclusion", false, false],
  ])("Chromium, %s: every surface agrees with Date", async (_name, enabled, engineTimezone) => {
    const { state, proto } = await retainedOverride(true);
    near(surfaces(proto), -new Date().getTimezoneOffset());
    dispatch(state.EVENT_NAME, enabled, engineTimezone);
    expect(state.engineTimezoneMode).toBe(engineTimezone);
    const r = surfaces(proto);
    near(r, r.date);
  });

  test("Firefox and Safari (the engine is never emulated there): unchanged", async () => {
    const { state, proto } = await retainedOverride(false);
    const osEast = eastIn(OS_ZONE, Date.now());
    dispatch(state.EVENT_NAME, true, false);
    near(surfaces(proto), osEast); // parsed as engine-local time, as before
    dispatch(state.EVENT_NAME, false, false);
    near(surfaces(proto), osEast); // native
  });
});
