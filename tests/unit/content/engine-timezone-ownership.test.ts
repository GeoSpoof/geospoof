/**
 * Engine-level Spoofing (Chromium): the payload carries the page's zone flagged
 * `engineTimezone`, and each realm decides for itself whether the engine already
 * reports that zone. Where it does, Date/Intl stay native (`timezoneData` is
 * null); where it doesn't (a cross-site iframe in its own process, a refused
 * or cancelled session, an override that hasn't landed), the injected
 * overrides take the zone. Without the flag, nothing changes.
 *
 * jsdom's engine reports the host's zone, which stands in for "the engine
 * already reports this zone".
 */
import { describe, test, expect, vi } from "vitest";

type State = typeof import("@/content/injected/state");
type Helpers = typeof import("@/content/injected/timezone-helpers");

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

async function load(): Promise<{ state: State; helpers: Helpers }> {
  vi.resetModules();
  polyfillGeolocation();
  const state = await import("@/content/injected/state");
  const helpers = await import("@/content/injected/timezone-helpers");
  const { installSettingsListener } = await import("@/content/injected/settings-listener");
  installSettingsListener();
  return { state, helpers };
}

const HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** A zone whose current offset differs from the host's. */
const OTHER_ZONE = new Date().getTimezoneOffset() === -540 ? "America/Los_Angeles" : "Asia/Tokyo";

function dispatch(
  state: State,
  identifier: string,
  engineTimezone?: boolean,
  engineTimezoneSettled?: boolean
): void {
  const detail: Record<string, unknown> = {
    enabled: true,
    location: null,
    timezone: { identifier, offset: 0, dstOffset: 0 },
    debugLogging: false,
    verbosityLevel: "INFO",
    webrtcProtection: false,
    preserveGeolocationPrompt: false,
    locale: null,
  };
  if (engineTimezone !== undefined) detail.engineTimezone = engineTimezone;
  if (engineTimezoneSettled !== undefined) detail.engineTimezoneSettled = engineTimezoneSettled;
  window.dispatchEvent(new CustomEvent(state.EVENT_NAME, { detail }));
}

describe("Engine-level Spoofing: per-realm ownership of the zone", () => {
  test("the engine already reports the zone: Date/Intl stay native", async () => {
    const { state } = await load();
    dispatch(state, HOST_ZONE, true);
    expect(state.timezoneData).toBeNull();
    expect(state.engineTimezoneMode).toBe(true);
    // document.lastModified sits below the engine, so it still gets the zone.
    expect(state.engineTimezoneData?.identifier).toBe(HOST_ZONE);
  });

  test("the engine reports another zone: the injected overrides take the page's zone", async () => {
    const { state } = await load();
    dispatch(state, OTHER_ZONE, true);
    expect(state.timezoneData?.identifier).toBe(OTHER_ZONE);
    expect(state.engineTimezoneMode).toBe(true);
    expect(state.engineTimezoneData).toBeNull();
  });

  test("an older zone command can still land: the injected overrides take the zone, even the engine's own, in engine mode", async () => {
    const { state } = await load();
    dispatch(state, HOST_ZONE, true, false);
    expect(state.timezoneData?.identifier).toBe(HOST_ZONE);
    // Still engine mode, so the workers this realm starts re-check the real zone.
    expect(state.engineTimezoneMode).toBe(true);
    expect(state.engineTimezoneData).toBeNull();
    // The next settled delivery checks the engine again.
    dispatch(state, HOST_ZONE, true, true);
    expect(state.timezoneData).toBeNull();
    expect(state.engineTimezoneData?.identifier).toBe(HOST_ZONE);
  });

  test("without the flag, the zone is installed as before, even the engine's own", async () => {
    const { state } = await load();
    dispatch(state, HOST_ZONE);
    expect(state.timezoneData?.identifier).toBe(HOST_ZONE);
    expect(state.engineTimezoneMode).toBe(false);
  });

  test("re-checked on every settings event", async () => {
    const { state } = await load();
    dispatch(state, OTHER_ZONE, true);
    expect(state.timezoneData?.identifier).toBe(OTHER_ZONE);
    dispatch(state, HOST_ZONE, true);
    expect(state.timezoneData).toBeNull();
    dispatch(state, HOST_ZONE, false);
    expect(state.timezoneData?.identifier).toBe(HOST_ZONE);
    expect(state.engineTimezoneMode).toBe(false);
  });

  test("an invalid zone disables timezone spoofing, lastModified included", async () => {
    const { state } = await load();
    dispatch(state, "", true);
    expect(state.timezoneData).toBeNull();
    expect(state.engineTimezoneData).toBeNull();
  });

  test("engineReportsZone: the host zone yes, another zone or a bad id no", async () => {
    const { helpers } = await load();
    expect(helpers.engineReportsZone(HOST_ZONE)).toBe(true);
    expect(helpers.engineReportsZone(OTHER_ZONE)).toBe(false);
    expect(helpers.engineReportsZone("Not/AZone")).toBe(false);
  });
});
