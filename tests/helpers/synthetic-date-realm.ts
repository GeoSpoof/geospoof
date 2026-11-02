/**
 * Runs the production Date installers (getTimezoneOffset, local getters,
 * formatters) against a synthetic `Date.prototype`: an object inheriting from
 * the real one, so the global `Date` is never modified. Not a `*.test.ts` file,
 * so Vitest doesn't collect it.
 *
 * The injected modules are imported dynamically, so calling this after
 * `vi.resetModules()` evaluates `state.ts` afresh (e.g. with a stubbed
 * `InternalError` to select the SpiderMonkey component path).
 */
export type InjectedState = typeof import("@/content/injected/state");

/** Builds a realm for a `getTimezoneOffset` precision decision; returns a Date factory. */
export type BuildDateRealm = (fractional: boolean) => (epochMs: number) => Date;

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

/** Import the injected modules, turn spoofing on, and return a realm factory. */
export async function loadInjectedDateRealm(): Promise<{
  state: InjectedState;
  realm: BuildDateRealm;
}> {
  polyfillGeolocation();
  const state = await import("@/content/injected/state");
  const { installGetTimezoneOffsetOverrideOn } =
    await import("@/content/injected/timezone-overrides");
  const { installDateGetterOverridesOn } = await import("@/content/injected/date-getters");
  const { installDateFormattingOverridesOn } = await import("@/content/injected/date-formatting");
  state.setSettingsReceived(true);
  state.setSpoofingEnabled(true);

  const realm: BuildDateRealm = (fractional) => {
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
