/**
 * The Date constructor override shifts an ambiguous local-time construction by
 * (real offset − spoofed offset), with the real zone cached for the realm. On
 * Chromium the engine's zone can change under the realm after it was cached (a
 * CDP override that lands after the injected overrides were installed, or one
 * Chrome keeps after Engine-level Spoofing is off), so there the cache is
 * re-checked against native getTimezoneOffset whatever the payload says. On
 * Firefox and Safari it isn't, exactly as before.
 *
 * The stand-in: the first default-zone `resolvedOptions` call after arming (the
 * cache fill) reports a stale zone whose offset differs from the host's.
 */
import { describe, test, expect, vi, afterEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/unbound-method
const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
const HOST_ZONE = realResolvedOptions.call(new Intl.DateTimeFormat()).timeZone;
const STALE_ZONE = new Date().getTimezoneOffset() === -330 ? "Pacific/Chatham" : "Asia/Kolkata";
let armed = false;

function installStaleZone(): void {
  Intl.DateTimeFormat.prototype.resolvedOptions = function (this: Intl.DateTimeFormat) {
    const r = realResolvedOptions.call(this);
    if (armed && r.timeZone === HOST_ZONE) {
      armed = false;
      return { ...r, timeZone: STALE_ZONE };
    }
    return r;
  };
}

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

async function load(chromium: boolean, engineMode: boolean) {
  vi.resetModules();
  vi.stubGlobal("__CHROMIUM__", chromium);
  polyfillGeolocation();
  installStaleZone();
  const state = await import("@/content/injected/state");
  const helpers = await import("@/content/injected/timezone-helpers");
  state.setEngineTimezoneMode(engineMode);
  return helpers;
}

afterEach(() => {
  armed = false;
  Intl.DateTimeFormat.prototype.resolvedOptions = realResolvedOptions;
  vi.unstubAllGlobals();
});

describe("computeEpochAdjustment: the cached real zone", () => {
  // Spoofing the zone the engine now uses needs no adjustment at all.
  const date = new Date(2026, 0, 15, 12);
  const hostEast = -date.getTimezoneOffset();

  test("Chromium, Engine-level on: a stale cached zone is replaced, so no adjustment", async () => {
    const helpers = await load(true, true);
    armed = true;
    expect(helpers.computeEpochAdjustment(date, HOST_ZONE, hostEast)).toBe(0);
  });

  test("Chromium, Engine-level off (an override Chrome kept): replaced too", async () => {
    const helpers = await load(true, false);
    armed = true;
    expect(helpers.computeEpochAdjustment(date, HOST_ZONE, hostEast)).toBe(0);
  });

  test("Firefox and Safari: the cache is kept, as before", async () => {
    const helpers = await load(false, false);
    armed = true;
    expect(helpers.computeEpochAdjustment(date, HOST_ZONE, hostEast)).not.toBe(0);
  });

  test("Chromium with a current cache: unchanged", async () => {
    const helpers = await load(true, true);
    expect(helpers.computeEpochAdjustment(date, HOST_ZONE, hostEast)).toBe(0);
  });
});
