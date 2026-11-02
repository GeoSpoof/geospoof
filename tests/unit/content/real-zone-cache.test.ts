/**
 * The Date constructor override shifts an ambiguous local-time construction by
 * (real offset − spoofed offset), with the real zone cached for the realm. In
 * Engine-level Spoofing the engine's zone can change under the realm after it
 * was cached (a CDP override that lands after the injected overrides were
 * installed), so there the cache is re-checked against native
 * getTimezoneOffset. Elsewhere it isn't, exactly as before.
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

async function load(engineMode: boolean) {
  vi.resetModules();
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
});

describe("computeEpochAdjustment: the cached real zone", () => {
  // Spoofing the zone the engine now uses needs no adjustment at all.
  const date = new Date(2026, 0, 15, 12);
  const hostEast = -date.getTimezoneOffset();

  test("Engine-level: a stale cached zone is replaced, so no adjustment", async () => {
    const helpers = await load(true);
    armed = true;
    expect(helpers.computeEpochAdjustment(date, HOST_ZONE, hostEast)).toBe(0);
  });

  test("otherwise the cache is kept, as before", async () => {
    const helpers = await load(false);
    armed = true;
    expect(helpers.computeEpochAdjustment(date, HOST_ZONE, hostEast)).not.toBe(0);
  });

  test("Engine-level with a current cache: unchanged", async () => {
    const helpers = await load(true);
    expect(helpers.computeEpochAdjustment(date, HOST_ZONE, hostEast)).toBe(0);
  });
});
