/**
 * Iframe geolocation + toString + timezone patching.
 *
 * Fingerprinting scripts bypass top-level overrides by reading from
 * inside a same-origin iframe's realm — the iframe gets its own fresh
 * globals that never passed through our injected script:
 *
 * 1. toString bypass — `iframeWindow.Function.prototype.toString` gives
 *    a clean reference for cross-checking our overrides.
 *
 * 2. Geolocation bypass — `iframe.contentWindow.navigator.geolocation`
 *    is a fresh instance with unpatched methods.
 *
 * 3. Timezone bypass — `iframe.contentWindow.Intl.DateTimeFormat` and
 *    `iframe.contentWindow.Date` see the real system timezone, because
 *    each iframe realm has its own Intl/Date globals.
 *
 * 4. Temporal bypass — `iframe.contentWindow.Temporal.Now.timeZoneId()`
 *    returns the real zone for the same reason.
 *
 * We fix all four by patching the iframe window synchronously on every
 * access path:
 * - contentWindow getter override (catches direct property access)
 * - DOM insertion wrappers (catches appendChild/innerHTML patterns)
 * - window[n] / frames[n] numeric indexing (caught via the same DOM
 *   insertion hooks — the iframe is in the DOM before the index is
 *   valid)
 *
 * Per-method `Date.prototype` overrides (getTimezoneOffset, the six
 * formatters, the seven getters, the six setters) install into each
 * iframe realm via the parameterized helpers exported from
 * `date-getters.ts`, `date-setters.ts`, `date-formatting.ts`, and
 * `timezone-overrides.ts`. Each realm captures its own native method
 * references for fallback paths, so cross-realm errors or disabled
 * spoofing still land inside the correct realm's native
 * implementation. This closes the "iframe-realm Date.prototype
 * methods" bypass that an earlier version of this module documented
 * as a gap.
 */

import type { AnyFunction } from "./types";
import { overrideRegistry, spoofedLocation } from "./state";
import {
  installOverride,
  stripConstruct,
  registerOverride,
  disguiseAsNative,
  stripExtensionFramesFromStack,
} from "./function-masking";
import { installErrorReportSanitizerOn } from "./error-report-sanitizer";
import { buildPermissionsQueryOverride } from "./permissions";
import {
  createGeolocationPosition,
  installGeolocationObjectModel,
  buildGeolocationOverrides,
  type NativeGeoMethod,
  type GeolocationRealm,
} from "./geolocation";
import { installLastModifiedOverride } from "./document-overrides";
import { installXsltOverridesOn } from "./xslt-overrides";
import { installLocaleOverridesOn } from "./locale-overrides";
import { seedFromBootstrap } from "./bootstrap";
import { buildRTCPeerConnectionWrapper, installRTCGetStatsOverride } from "./webrtc";
import { installDateGetterOverridesOn, type DateGetterOriginals } from "./date-getters";
import { installDateSetterOverridesOn, type DateSetterOriginals } from "./date-setters";
import { installDateFormattingOverridesOn, type DateFormattingOriginals } from "./date-formatting";
import {
  installGetTimezoneOffsetOverrideOn,
  installDateTimeFormatOverridesOn,
} from "./timezone-overrides";
import { installDateConstructorOn } from "./date-constructor";
import { installTemporalOverridesOn } from "./temporal";
import { createLogger } from "@/shared/utils/debug-logger";

const logger = createLogger("INJ");

// Track which iframe windows have already been patched to avoid re-patching
const patchedIframeWindows = new WeakSet<Window>();

/**
 * Patch an iframe window's geolocation API and Function.prototype.toString
 * to use the shared spoofing state and override registry.
 *
 * Safe to call multiple times — subsequent calls for the same window are no-ops.
 */
export function patchIframeWindow(iframeWindow: Window): void {
  if (patchedIframeWindows.has(iframeWindow)) {
    logger.debug("[patchIframeWindow] already patched, skipping");
    return;
  }
  patchedIframeWindows.add(iframeWindow);
  // Seed spoofing state from the early bootstrap global if it hasn't been
  // consumed yet — covers a page that reaches into an iframe's Date/Intl
  // realm before touching the top-level ones.
  seedFromBootstrap();
  logger.debug("[patchIframeWindow] entering", {
    hasDocument: (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        return !!(iframeWindow as any).document;
      } catch (err) {
        return `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
    })(),
  });

  // ── 0. Error-report sanitizer ─────────────────────────────────────────
  // Install first so an uncaught throw from any override below (in this iframe
  // realm) has its filename/onerror-source scrubbed too — the .stack scrubs
  // can't reach that channel. Same reasoning as the top-realm install.
  try {
    installErrorReportSanitizerOn(iframeWindow as Window & typeof globalThis);
  } catch (err) {
    logger.debug(
      "[patchIframeWindow] section 0 (error sanitizer) threw:",
      err instanceof Error ? err.message : String(err)
    );
  }

  // ── 1. toString masking ──────────────────────────────────────────────
  try {
    logger.trace("Patching iframe window toString");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframeFnProto = (iframeWindow as any).Function.prototype as {
      toString: AnyFunction;
      call: typeof Function.prototype.call;
    };
    const iframeOrigToString = iframeFnProto.toString;
    const iframeOrigCall = iframeFnProto.call;

    // Derive the engine-specific "[native code]" surround format from
    // the iframe's own Number constructor. Same rationale as the main
    // window override: Firefox's native toString output is multi-line,
    // Chrome's is single-line, and CreepJS reconstructs expected
    // strings using this split.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframeNumber = (iframeWindow as any).Number as unknown;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const numSrc: string = (iframeOrigCall as any).call(iframeOrigToString, iframeNumber);
    const iframeNativeParts = numSrc.split("Number");
    const iframeNativeP1 = iframeNativeParts[0] ?? "function ";
    const iframeNativeP2 = iframeNativeParts[1] ?? "() { [native code] }";

    // Use method shorthand so the patched toString has no prototype/[[Construct]]
    // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional: method shorthand destructuring for anti-fingerprint
    iframeFnProto.toString = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toString(this: any): string {
        const nativeName = overrideRegistry.get(this as AnyFunction);
        if (nativeName !== undefined) {
          return iframeNativeP1 + nativeName + iframeNativeP2;
        }
        // Delegate the reject case to the iframe realm's native toString so it
        // produces the genuine builtin frame + per-engine message, then scrub
        // our injected-script frame from the thrown error — same fix and same
        // reasoning as the main-realm toString override (a hand-thrown error
        // would be missing the native frame that a clean browser shows).
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
          return (iframeOrigCall as any).call(iframeOrigToString, this) as string;
        } catch (err) {
          stripExtensionFramesFromStack(err);
          throw err;
        }
      },
    }.toString;
    logger.debug("[patchIframeWindow] section 1 (toString) complete");
  } catch (err) {
    logger.debug(
      "[patchIframeWindow] section 1 (toString) threw:",
      err instanceof Error ? err.message : String(err)
    );
    // Cross-origin iframes throw SecurityError — silently ignore
  }

  // ── 2. Geolocation override ──────────────────────────────────────────
  // Install overrides on the iframe's own `Geolocation.prototype`, not
  // on the per-iframe `navigator.geolocation` instance. That matches
  // native layout (where `getCurrentPosition` is inherited from the
  // prototype, not an own property of the instance), so descriptor
  // checks like `Object.getOwnPropertyDescriptor(iframe.contentWindow.
  // navigator.geolocation, "getCurrentPosition")` correctly return
  // `undefined`.
  //
  // Each iframe has its own realm with its own `Geolocation.prototype`
  // object; we patch each one exactly once (guarded by
  // `patchedIframeWindows`) and use the iframe's own `navigator.
  // geolocation` instance only to capture pristine originals for
  // pass-through when spoofing is disabled.
  //
  // Wrapped in a labeled block so the early-bailout `break` statements
  // below skip only this section, not the rest of patchIframeWindow —
  // a bare `return` here would also skip sections 3..8, leaking every
  // downstream surface whenever the iframe lacks a Geolocation realm.
  geolocationSection: try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframeNav = (iframeWindow as any).navigator as Navigator;
    if (!iframeNav?.geolocation) break geolocationSection;

    const iframeGeo = iframeNav.geolocation;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframeGeolocationCtor = (iframeWindow as any).Geolocation as
      { prototype: object } | undefined;
    if (!iframeGeolocationCtor?.prototype) break geolocationSection;

    // Capture the iframe's own originals before we install the override,
    // so pass-through mode (spoofing disabled) hits the real API.
    const iframeOrigGetCurrentPosition = iframeGeo.getCurrentPosition.bind(iframeGeo);
    const iframeOrigWatchPosition = iframeGeo.watchPosition.bind(iframeGeo);
    const iframeOrigClearWatch = iframeGeo.clearWatch.bind(iframeGeo);

    // Unbound native methods (captured before override) + the realm's
    // Geolocation constructor, so the shared guard (`geoArgsValid` +
    // `reproduceNativeGeoError`) can reject a foreign `this` exactly like the
    // top-level override — brand check + native-delegate + stack scrub — instead
    // of the old iframe arrows that ignored `this`.
    const iframeGeoProto = iframeGeolocationCtor.prototype as {
      getCurrentPosition: NativeGeoMethod;
      watchPosition: NativeGeoMethod;
      clearWatch: NativeGeoMethod;
    };

    const iframeNativeGetCurrentPosition = iframeGeoProto.getCurrentPosition;
    const iframeNativeWatchPosition = iframeGeoProto.watchPosition;
    const iframeNativeClearWatch = iframeGeoProto.clearWatch;

    const IframeGeolocation = iframeGeolocationCtor as unknown as new () => object;

    // Install the WeakMap-backed accessors + toJSON on THIS realm's
    // GeolocationCoordinates / GeolocationPosition prototypes, then build
    // spoofed positions with the shared builder. This makes iframe-realm
    // spoofed objects byte-identical to top-level ones: zero own properties
    // (`Object.keys(coords)` → []) and native per-engine `toJSON` key order —
    // closing the detection vector where the old `defineOwnFields` approach
    // left own data properties and a throwing native `toJSON`.
    const iframeGeoRealm: GeolocationRealm = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      GeolocationCoordinates: (iframeWindow as any).GeolocationCoordinates as
        { prototype: object } | undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      GeolocationPosition: (iframeWindow as any).GeolocationPosition as
        { prototype: object } | undefined,
    };
    installGeolocationObjectModel(iframeGeoRealm);

    // Liveness check for the shared watch cadence: our re-fire timers run in
    // the parent context, but the success callback belongs to THIS iframe's
    // realm. Once the iframe is removed from the DOM, keep firing would leak
    // timers and throw on a dead realm — so the cadence stops when the frame
    // is no longer connected. (The top-level realm passes `() => true`.)
    const iframeIsAlive = (): boolean => {
      try {
        const el = iframeWindow.frameElement;
        return el ? el.isConnected : false;
      } catch {
        // Cross-realm access can throw once the browsing context is torn down.
        return false;
      }
    };

    // Build the geolocation overrides with the SAME shared factory the
    // top-level realm uses (see buildGeolocationOverrides in geolocation.ts).
    // The maximumAge cache, preserve-prompt native prompt, defer-until-settings,
    // and watchPosition re-fire cadence now live in one place — the iframe no
    // longer carries a fires-once, cacheless copy that drifts.
    const iframeOverrides = buildGeolocationOverrides({
      Geolocation: IframeGeolocation,
      origGetCurrentPosition: iframeOrigGetCurrentPosition,
      origWatchPosition: iframeOrigWatchPosition,
      origClearWatch: iframeOrigClearWatch,
      nativeGetCurrentPosition: iframeNativeGetCurrentPosition,
      nativeWatchPosition: iframeNativeWatchPosition,
      nativeClearWatch: iframeNativeClearWatch,
      buildPosition: () => createGeolocationPosition(spoofedLocation!, iframeGeoRealm),
      isAlive: iframeIsAlive,
    });

    // Install on the iframe's own `Geolocation.prototype`. `installOverride`
    // reads the target's descriptor and preserves its flags, so the
    // spec-matching `{writable:true, configurable:true, enumerable:true}`
    // shape is kept without hardcoding here.
    installOverride(
      iframeGeolocationCtor.prototype,
      "getCurrentPosition",
      iframeOverrides.getCurrentPosition,
      1
    );
    installOverride(
      iframeGeolocationCtor.prototype,
      "watchPosition",
      iframeOverrides.watchPosition,
      1
    );
    installOverride(iframeGeolocationCtor.prototype, "clearWatch", iframeOverrides.clearWatch, 1);

    logger.debug("[patchIframeWindow] section 2 (geolocation) complete");
  } catch (err) {
    logger.debug(
      "[patchIframeWindow] section 2 (geolocation) threw:",
      err instanceof Error ? err.message : String(err)
    );
    // Cross-origin or sandboxed iframes may throw — silently ignore
  }

  // ── 3. Permissions override ──────────────────────────────────────────
  // Also patch the iframe's `Permissions.prototype.query` so that
  // permission checks from within the iframe (or from the parent via
  // `iframe.contentWindow.navigator.permissions.query(...)`) return
  // "granted" for geolocation.
  //
  // Wrapped in a labeled block for the same reason as section 2 — a
  // bare `return` on missing Permissions realm would skip sections
  // 4..8 and leak Intl/Date/Temporal/DOM-insertion/lastModified.
  permissionsSection: try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframePerms = (iframeWindow as any).navigator?.permissions as Permissions | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframePermsCtor = (iframeWindow as any).Permissions as { prototype: object } | undefined;
    if (!iframePerms?.query || !iframePermsCtor?.prototype) break permissionsSection;

    const iframeOrigQuery = iframePerms.query.bind(iframePerms);

    // Unbound native `query`, captured BEFORE we override the prototype.

    const iframeNativeQueryUnbound = (
      iframePermsCtor.prototype as {
        query?: (this: unknown, descriptor?: PermissionDescriptor) => Promise<PermissionStatus>;
      }
    ).query;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframePermissionStatusCtor = (iframeWindow as any).PermissionStatus as
      { prototype: object } | undefined;

    // Use the SAME builder as the top-level realm (see permissions.ts), so the
    // brand check, native-delegation-with-scrub, preserve-prompt gating, and
    // settings-wait behaviour can't drift between realms.
    const iframePermissionsQuery = buildPermissionsQueryOverride({
      Permissions: iframePermsCtor as unknown as new () => object,
      nativeQueryUnbound: iframeNativeQueryUnbound,
      boundQuery: iframeOrigQuery,
      PermissionStatusCtor: iframePermissionStatusCtor,
    });

    installOverride(iframePermsCtor.prototype, "query", iframePermissionsQuery, 1);
    logger.debug("[patchIframeWindow] section 3 (permissions) complete");
  } catch (err) {
    logger.debug(
      "[patchIframeWindow] section 3 (permissions) threw:",
      err instanceof Error ? err.message : String(err)
    );
    // Silently ignore
  }

  // ── 4. Intl.DateTimeFormat override ──────────────────────────────────
  // The iframe has its own Intl realm. Without patching, a page that
  // reads `iframe.contentWindow.Intl.DateTimeFormat().resolvedOptions()
  // .timeZone` gets the real system zone, trivially bypassing timezone
  // spoofing. Same rationale as the top-level override in
  // timezone-overrides.ts — we inject the spoofed identifier when the
  // caller doesn't supply an explicit timeZone, and leave explicit
  // zones untouched.
  //
  // Labeled block so a missing Intl realm skips only this section,
  // not the downstream Date / Temporal / cascade / lastModified
  // installs.
  intlSection: try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframeIntl = (iframeWindow as any).Intl as typeof Intl | undefined;
    if (!iframeIntl?.DateTimeFormat) break intlSection;

    // Same shared installer the top-level realm uses — the DTF spoof
    // logic, explicit-timezone tracking, and error-path stack scrub live
    // in one place and cannot drift between realms. No `seed` hook here:
    // the iframe is patched after bootstrap has already run.
    installDateTimeFormatOverridesOn(iframeIntl);

    logger.debug("[patchIframeWindow] section 4 (Intl) complete");
  } catch (err) {
    logger.debug(
      "[patchIframeWindow] section 4 (Intl) threw:",
      err instanceof Error ? err.message : String(err)
    );
    // Cross-origin or missing Intl — silently ignore
  }

  // ── 4b. Locale overrides ─────────────────────────────────────────────
  // Each iframe realm has its own `navigator`, `Intl` constructors, and
  // primitive prototypes. Without patching, reading
  // `iframe.contentWindow.navigator.language` — or constructing
  // `new iframe.contentWindow.Intl.NumberFormat()` — reports the REAL
  // locale, trivially bypassing the top-level override. Same shared
  // installer the top-level realm uses, so the logic cannot drift; it
  // captures this realm's own natives for its fallback paths.
  //
  // Labeled block so a cross-origin/missing realm skips only this
  // section, not the downstream Date / Temporal / cascade installs.
  localeSection: try {
    const localeWin = iframeWindow as unknown as (Window & typeof globalThis) | undefined;
    if (!localeWin) break localeSection;

    installLocaleOverridesOn(localeWin);

    logger.debug("[patchIframeWindow] section 4b (locale) complete");
  } catch (err) {
    logger.debug(
      "[patchIframeWindow] section 4b (locale) threw:",
      err instanceof Error ? err.message : String(err)
    );
    // Cross-origin or missing globals — silently ignore
  }

  // ── 5. Date constructor override ─────────────────────────────────────
  // Each iframe realm has its own Date global. Without patching,
  // `new iframe.contentWindow.Date("2024-01-01T12:00:00")` (ambiguous
  // local-time string) parses in the REAL system zone rather than the
  // spoofed zone, leaking both. Same adjustment logic as the top-level
  // override in date-constructor.ts. Intentionally reuses the top-level
  // `OriginalDate` (captured at module load before any overrides) as
  // the numeric epoch source — iframe and parent share the same UTC
  // clock, so this produces identical epoch values.
  //
  // Labeled block so a missing Date realm skips only this section,
  // not the downstream Temporal / cascade / lastModified installs.
  dateSection: try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const IframeOriginalDate = (iframeWindow as any).Date as DateConstructor | undefined;
    if (!IframeOriginalDate) break dateSection;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframeFunctionProto = (iframeWindow as any).Function.prototype as object;

    // Same shared installer the top-level realm uses — the ambiguous-string
    // epoch adjustment, the no-`new` `Date()` spoofed-zone consistency fix,
    // static-method copying, and toString registration all live in one place
    // and cannot drift between realms. No `seed` hook here: the iframe is
    // patched after bootstrap has already run.
    installDateConstructorOn({
      target: iframeWindow,
      originalDate: IframeOriginalDate,
      functionProto: iframeFunctionProto,
    });

    logger.debug("[patchIframeWindow] section 5 (Date) complete");
  } catch (err) {
    logger.debug(
      "[patchIframeWindow] section 5 (Date) threw:",
      err instanceof Error ? err.message : String(err)
    );
    // Cross-origin or missing Date — silently ignore
  }

  // ── 6. Date.prototype methods (getters, setters, formatters,
  //      getTimezoneOffset) ───────────────────────────────────────────
  //
  // Each iframe realm has its own `Date.prototype`, independent of the
  // top-level's. Top-level overrides installed on the top-level
  // Date.prototype don't apply to Dates produced by the iframe's
  // constructor. Without this section, a page can trivially bypass
  // the per-method overrides by going through the iframe:
  //
  //     new iframe.contentWindow.Date().getHours()
  //     // ^ falls through to the iframe's unpatched native getHours,
  //     //   which returns the hour in the real system zone
  //
  // The four `install*OverridesOn` helpers below are the parameterized
  // variants of the top-level installers — the same implementation is
  // shared across realms. They accept a target Date.prototype and a bag
  // of THAT realm's native methods, so fall-through paths stay inside
  // the correct realm (no cross-realm calls on error paths).
  //
  // Ordering within this section matches the top-level init order:
  // getTimezoneOffset → formatters → getters → setters. Setters must
  // come last because their multi-argument "preserve current component"
  // branch reads through the spoofed getters.
  //
  // Labeled block so a missing Date.prototype (cross-origin
  // SecurityError) skips only this section, not the downstream
  // Temporal / cascade / lastModified installs.
  dateProtoSection: try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframeDateProto = (iframeWindow as any).Date?.prototype as Date | undefined;
    if (!iframeDateProto) break dateProtoSection;

    // Capture the iframe realm's native Date.prototype method references
    // BEFORE we install any overrides on that prototype. These go into
    // the originals bags so each spoofed method's fall-through path
    // calls back into the iframe's native method rather than the
    // top-level's. Cross-realm fallbacks would work (the methods only
    // touch the instance's internal [[DateValue]] slot and that is
    // realm-agnostic) but keeping each realm self-contained is cleaner
    // and removes a class of potential realm-boundary bugs.
    //
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const origGetTzOffset = iframeDateProto.getTimezoneOffset;
    const getterOriginals: DateGetterOriginals = {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getHours: iframeDateProto.getHours,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getMinutes: iframeDateProto.getMinutes,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getSeconds: iframeDateProto.getSeconds,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getMilliseconds: iframeDateProto.getMilliseconds,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getDate: iframeDateProto.getDate,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getDay: iframeDateProto.getDay,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getMonth: iframeDateProto.getMonth,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getFullYear: iframeDateProto.getFullYear,
    };
    const setterOriginals: DateSetterOriginals = {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      setHours: iframeDateProto.setHours,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      setMinutes: iframeDateProto.setMinutes,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      setSeconds: iframeDateProto.setSeconds,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      setDate: iframeDateProto.setDate,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      setMonth: iframeDateProto.setMonth,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      setFullYear: iframeDateProto.setFullYear,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      setTime: iframeDateProto.setTime,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getMilliseconds: iframeDateProto.getMilliseconds,
    };
    const formattingOriginals: DateFormattingOriginals = {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      toString: iframeDateProto.toString,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      toDateString: iframeDateProto.toDateString,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      toTimeString: iframeDateProto.toTimeString,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      toLocaleString: iframeDateProto.toLocaleString,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      toLocaleDateString: iframeDateProto.toLocaleDateString,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      toLocaleTimeString: iframeDateProto.toLocaleTimeString,
    };

    // Install in the same order as top-level index.ts: getTimezoneOffset,
    // formatters, getters, setters. Each call is defensive — individual
    // installers swallow per-method failures internally so a bad override
    // on one method doesn't prevent others from installing.
    installGetTimezoneOffsetOverrideOn(iframeDateProto, origGetTzOffset);
    installDateFormattingOverridesOn(iframeDateProto, formattingOriginals);
    installDateGetterOverridesOn(iframeDateProto, getterOriginals);
    installDateSetterOverridesOn(iframeDateProto, setterOriginals);

    logger.debug("[patchIframeWindow] section 6 (Date.prototype methods) complete");
  } catch (err) {
    logger.debug(
      "[patchIframeWindow] section 6 (Date.prototype methods) threw:",
      err instanceof Error ? err.message : String(err)
    );
    // Cross-origin or missing Date.prototype — silently skip
  }

  // ── 7. Temporal.Now override ─────────────────────────────────────────
  // Temporal is feature-detected; skip when unavailable in the iframe's
  // realm. Same override pattern as the top-level temporal.ts:
  // `timeZoneId()` returns the spoofed identifier, and every
  // `plain*ISO` / `zonedDateTimeISO` method substitutes the spoofed zone
  // only when no explicit timezone argument was provided.
  //
  // Labeled block so a missing Temporal realm skips only this section,
  // not the downstream cascade / lastModified installs. This was the
  // root cause of a Safari-only `iframe.contentDocument.lastModified`
  // leak: Safari doesn't ship Temporal, so a bare `return` here
  // aborted patchIframeWindow before section 9 could run and patched
  // Document.prototype never got the spoofed getter.
  temporalSection: try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframeTemporal = (iframeWindow as any).Temporal as typeof Temporal | undefined;
    if (!iframeTemporal?.Now) break temporalSection;

    // Same shared installer the top-level realm uses — the Now spoofing
    // logic and the ZonedDateTime offset accessor scrub live in one place
    // and cannot drift between realms. No `seed` hook here: the iframe is
    // patched after bootstrap has already run.
    installTemporalOverridesOn(iframeTemporal);

    logger.debug("[patchIframeWindow] section 7 (Temporal) complete");
  } catch (err) {
    logger.debug(
      "[patchIframeWindow] section 7 (Temporal) threw:",
      err instanceof Error ? err.message : String(err)
    );
    // Temporal unavailable or cross-origin — silently ignore
  }

  // ── 8. Nested-iframe cascade ─────────────────────────────────────────
  // A same-origin iframe's document has its own HTMLIFrameElement
  // prototype, its own Node/Element prototypes, and its own document
  // tree that the top-level MutationObserver cannot see. Without
  // patching these, a nested iframe created from inside the outer
  // iframe — via `outerDoc.write("<iframe>")`, `innerHTML`, or any DOM
  // method called on the outer iframe's own Node.prototype — escapes
  // every patching vector and leaks real geolocation when
  // `nested.contentWindow.navigator.geolocation` is read.
  //
  // We mirror the top-level `installIframePatching` and
  // `installDomInsertionWrapping` onto the iframe's own realm so the
  // patching cascades recursively: a nested iframe gets the same
  // treatment, and a grand-nested iframe gets it too.
  //
  // All shape/descriptor checks must use tag-name / duck-typing rather
  // than `instanceof` — elements created in the iframe's realm are NOT
  // instances of the top-level `HTMLIFrameElement` constructor, so
  // `node instanceof HTMLIFrameElement` (and similar) is always false
  // across realm boundaries.
  try {
    /** Cross-realm-safe iframe detection: check tag name rather than instanceof. */
    const isIframe = (node: unknown): node is HTMLIFrameElement => {
      return (
        node !== null &&
        typeof node === "object" &&
        (node as { nodeType?: number }).nodeType === 1 &&
        (node as { tagName?: string }).tagName === "IFRAME"
      );
    };

    /**
     * Scan a node and its descendants for iframes and patch their
     * contentWindows. Equivalent to top-level `scanAndPatchIframes`
     * but realm-agnostic — safe to call with nodes from any realm.
     */
    const scanAndPatchIframesHere = (node: Node | null | undefined): void => {
      if (!node) return;
      try {
        if (isIframe(node) && node.contentWindow) {
          patchIframeWindow(node.contentWindow);
        }
        // Descendants: use querySelectorAll if available (Element /
        // DocumentFragment / Document all have it). Returns an empty
        // NodeList when no iframes match, so this is safe on nodes that
        // aren't themselves iframes.
        const queryable = node as unknown as {
          querySelectorAll?: (sel: string) => NodeList;
        };
        if (typeof queryable.querySelectorAll === "function") {
          const nested = queryable.querySelectorAll("iframe");
          for (let i = 0; i < nested.length; i += 1) {
            const ifr = nested[i] as unknown as HTMLIFrameElement;
            if (ifr.contentWindow) {
              try {
                patchIframeWindow(ifr.contentWindow);
              } catch {
                // cross-origin
              }
            }
          }
        }
      } catch {
        // cross-origin or detached node — silently skip
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframeHTMLIFrameElementCtor = (iframeWindow as any).HTMLIFrameElement as
      { prototype: object } | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframeNodeCtor = (iframeWindow as any).Node as { prototype: object } | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframeElementCtor = (iframeWindow as any).Element as { prototype: object } | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframeMutationObserverCtor = (iframeWindow as any).MutationObserver as
      (new (cb: MutationCallback) => MutationObserver) | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframeDocumentFragmentCtor = (iframeWindow as any).DocumentFragment as
      (new () => DocumentFragment) | undefined;

    // ── 7a. HTMLIFrameElement.prototype accessors ──────────────────────
    // So `nested.contentWindow` (read from inside the outer iframe)
    // triggers patchIframeWindow on the nested window before the caller
    // sees it.
    if (iframeHTMLIFrameElementCtor?.prototype) {
      const proto = iframeHTMLIFrameElementCtor.prototype;

      const cwDesc = Object.getOwnPropertyDescriptor(proto, "contentWindow");
      if (cwDesc?.get) {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional: re-bound via .call(this) inside the wrapper
        const origCWGet = cwDesc.get;
        const cwGetter = stripConstruct(function (this: HTMLIFrameElement): WindowProxy | null {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const win = origCWGet.call(this);
          if (win) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
              patchIframeWindow(win);
            } catch {
              // cross-origin
            }
          }
          return win;
        });
        registerOverride(cwGetter, "contentWindow");
        disguiseAsNative(cwGetter, "contentWindow", 0);
        Object.defineProperty(proto, "contentWindow", {
          get: cwGetter,
          configurable: cwDesc.configurable,
          enumerable: cwDesc.enumerable,
        });
      }

      const cdDesc = Object.getOwnPropertyDescriptor(proto, "contentDocument");
      if (cdDesc?.get) {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional: re-bound via .call(this) inside the wrapper
        const origCDGet = cdDesc.get;
        const cdGetter = stripConstruct(function (this: HTMLIFrameElement): Document | null {
          // Access contentWindow via our patched getter to cascade
          // patching, then return the original contentDocument.
          const win = this.contentWindow;
          void win;

          return origCDGet.call(this) as Document | null;
        });
        registerOverride(cdGetter, "contentDocument");
        disguiseAsNative(cdGetter, "contentDocument", 0);
        Object.defineProperty(proto, "contentDocument", {
          get: cdGetter,
          configurable: cdDesc.configurable,
          enumerable: cdDesc.enumerable,
        });
      }
    }

    // ── 7b. Node.prototype / Element.prototype insertion wrappers ──────
    // Same wrappers `installDomInsertionWrapping` installs at the top
    // level, but on the iframe's own realm. Synchronously scans
    // inserted subtrees for iframes and patches them before the next
    // line of JS runs (arkenfox's `window[n]` race).
    if (iframeNodeCtor?.prototype) {
      const nodeProto = iframeNodeCtor.prototype as unknown as {
        appendChild: (n: Node) => Node;
        insertBefore: (n: Node, r: Node | null) => Node;
        replaceChild: (n: Node, o: Node) => Node;
      };

      const origAppendChild = nodeProto.appendChild;

      const origInsertBefore = nodeProto.insertBefore;

      const origReplaceChild = nodeProto.replaceChild;

      installOverride(nodeProto, "appendChild", function <T extends Node>(this: Node, node: T): T {
        const isFrag =
          iframeDocumentFragmentCtor !== undefined && node instanceof iframeDocumentFragmentCtor;
        const children: Array<Node> = isFrag
          ? Array.from((node as unknown as { childNodes: NodeList }).childNodes)
          : [];
        const result = origAppendChild.call(this, node) as T;
        if (isFrag) {
          for (const c of children) scanAndPatchIframesHere(c);
        } else {
          scanAndPatchIframesHere(node);
        }
        return result;
      });

      installOverride(nodeProto, "insertBefore", function <
        T extends Node,
      >(this: Node, node: T, ref: Node | null): T {
        const isFrag =
          iframeDocumentFragmentCtor !== undefined && node instanceof iframeDocumentFragmentCtor;
        const children: Array<Node> = isFrag
          ? Array.from((node as unknown as { childNodes: NodeList }).childNodes)
          : [];
        const result = origInsertBefore.call(this, node, ref) as T;
        if (isFrag) {
          for (const c of children) scanAndPatchIframesHere(c);
        } else {
          scanAndPatchIframesHere(node);
        }
        return result;
      });

      installOverride(nodeProto, "replaceChild", function <
        T extends Node,
      >(this: Node, node: Node, old: T): T {
        const isFrag =
          iframeDocumentFragmentCtor !== undefined && node instanceof iframeDocumentFragmentCtor;
        const children: Array<Node> = isFrag
          ? Array.from((node as unknown as { childNodes: NodeList }).childNodes)
          : [];
        const result = origReplaceChild.call(this, node, old) as T;
        if (isFrag) {
          for (const c of children) scanAndPatchIframesHere(c);
        } else {
          scanAndPatchIframesHere(node);
        }
        return result;
      });
    }

    if (iframeElementCtor?.prototype) {
      const elProto = iframeElementCtor.prototype as unknown as {
        append: (...nodes: Array<Node | string>) => void;
        prepend: (...nodes: Array<Node | string>) => void;
        replaceWith: (...nodes: Array<Node | string>) => void;
        insertAdjacentElement: (pos: InsertPosition, el: Element) => Element | null;
        insertAdjacentHTML: (pos: InsertPosition, html: string) => void;
      };

      const origAppend = elProto.append;

      const origPrepend = elProto.prepend;

      const origReplaceWith = elProto.replaceWith;

      const origInsertAdjacentElement = elProto.insertAdjacentElement;

      const origInsertAdjacentHTML = elProto.insertAdjacentHTML;

      installOverride(
        elProto,
        "append",
        function (this: Element, ...nodes: Array<Node | string>): void {
          origAppend.apply(this, nodes);
          for (const n of nodes) {
            if (typeof n !== "string") scanAndPatchIframesHere(n);
          }
        }
      );

      installOverride(
        elProto,
        "prepend",
        function (this: Element, ...nodes: Array<Node | string>): void {
          origPrepend.apply(this, nodes);
          for (const n of nodes) {
            if (typeof n !== "string") scanAndPatchIframesHere(n);
          }
        }
      );

      installOverride(
        elProto,
        "replaceWith",
        function (this: Element, ...nodes: Array<Node | string>): void {
          origReplaceWith.apply(this, nodes);
          for (const n of nodes) {
            if (typeof n !== "string") scanAndPatchIframesHere(n);
          }
        }
      );

      installOverride(
        elProto,
        "insertAdjacentElement",
        function (this: Element, position: InsertPosition, element: Element): Element | null {
          const result = origInsertAdjacentElement.call(this, position, element);
          scanAndPatchIframesHere(element);
          return result;
        }
      );

      installOverride(
        elProto,
        "insertAdjacentHTML",
        function (this: Element, position: InsertPosition, text: string): void {
          origInsertAdjacentHTML.call(this, position, text);
          scanAndPatchIframesHere(this.parentElement ?? this);
        }
      );

      // innerHTML setter — catches the `div.innerHTML = "<iframe>"`
      // arkenfox pattern from inside the iframe's realm.
      const innerHTMLDesc = Object.getOwnPropertyDescriptor(elProto, "innerHTML");
      if (innerHTMLDesc?.set) {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional: re-bound via .call(this) inside the wrapper
        const origInnerHTMLSet = innerHTMLDesc.set;
        const innerHTMLSetter = stripConstruct(function (this: Element, value: string) {
          origInnerHTMLSet.call(this, value);
          scanAndPatchIframesHere(this);
        });
        registerOverride(innerHTMLSetter, "innerHTML");
        disguiseAsNative(innerHTMLSetter, "innerHTML", 1);
        Object.defineProperty(elProto, "innerHTML", {
          // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional: passing original getter descriptor to Object.defineProperty
          get: innerHTMLDesc.get,
          set: innerHTMLSetter,
          configurable: innerHTMLDesc.configurable,
          enumerable: innerHTMLDesc.enumerable,
        });
      }
    }

    // ── 7c. MutationObserver fallback on the iframe's document ─────────
    // Same fallback as the top level — catches anything the wrappers
    // miss (most notably iframes the HTML parser materializes via
    // `document.write`, which goes through neither our DOM wrappers
    // nor the contentWindow getter until something touches the node).
    if (iframeMutationObserverCtor) {
      const iframeObserver = new iframeMutationObserverCtor((mutations) => {
        for (const mutation of mutations) {
          for (const addedNode of Array.from(mutation.addedNodes)) {
            scanAndPatchIframesHere(addedNode);
          }
        }
      });
      const iframeDoc = iframeWindow.document;
      if (iframeDoc.documentElement) {
        iframeObserver.observe(iframeDoc.documentElement, {
          childList: true,
          subtree: true,
        });
      } else {
        // documentElement isn't created yet (rare for about:blank; more
        // common when patching happens before DOMContentLoaded). Defer
        // until it exists.
        iframeDoc.addEventListener(
          "DOMContentLoaded",
          () => {
            if (iframeDoc.documentElement) {
              iframeObserver.observe(iframeDoc.documentElement, {
                childList: true,
                subtree: true,
              });
            }
          },
          { once: true }
        );
      }
    }

    // Scan whatever iframes the outer iframe already contains at patch
    // time — the MutationObserver only fires for future insertions, so
    // without this we'd miss iframes that were materialized before the
    // outer iframe's contentWindow was first accessed.
    try {
      if (iframeWindow.document.documentElement) {
        scanAndPatchIframesHere(iframeWindow.document.documentElement);
      }
    } catch {
      // cross-origin or detached — silently skip
    }

    logger.debug("[patchIframeWindow] section 8 (nested-iframe cascade) complete");
  } catch (err) {
    logger.debug(
      "[patchIframeWindow] section 8 (nested-iframe cascade) threw:",
      err instanceof Error ? err.message : String(err)
    );
    // Cross-origin or missing constructors — silently ignore
  }

  // ── 9. Document.prototype.lastModified ───────────────────────────────
  // Each iframe realm has its own `Document.prototype`, which means
  // `iframe.contentDocument.lastModified` reads through the iframe's
  // un-patched accessor and leaks the real system timezone. This is
  // one of TZP's primary ground-truth sources for detecting spoofing —
  // closing it removes the single highest-signal cross-surface leak.
  //
  // Safari quirk: WebKit treats about:blank iframes as cross-origin
  // relative to their parent, so `(iframeWindow as any).Document`
  // throws SecurityError. But `iframe.contentDocument.lastModified`
  // itself still succeeds when read from the parent — leaking the
  // real-zone string. To cover that case, we reach into the iframe's
  // `Document.prototype` through the Document *instance* rather than
  // through the iframe's window global, which sidesteps Safari's
  // realm-access gating.
  try {
    let iframeDocumentProto: object | null = null;
    let pathTaken: "window.Document" | "window.document" | "none" = "none";
    let windowDocErr: string | null = null;
    let windowDocumentErr: string | null = null;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      const iframeDocumentCtor = (iframeWindow as any).Document as
        { prototype: object } | undefined;
      if (iframeDocumentCtor?.prototype) {
        iframeDocumentProto = iframeDocumentCtor.prototype;
        pathTaken = "window.Document";
      }
    } catch (err) {
      windowDocErr = err instanceof Error ? err.message : String(err);
      // Safari gates Document access on the iframe window global —
      // fall through to the instance-based path below.
    }
    if (iframeDocumentProto === null) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        const doc = (iframeWindow as any).document as Document | null | undefined;
        if (doc) {
          iframeDocumentProto = Object.getPrototypeOf(doc) as object | null;
          pathTaken = "window.document";
        }
      } catch (err) {
        windowDocumentErr = err instanceof Error ? err.message : String(err);
        // If even this access throws, the iframe is genuinely
        // inaccessible — nothing more we can do from the content script.
      }
    }

    logger.debug("[lastModified-patch] iframe realm access result", {
      pathTaken,
      windowDocErr,
      windowDocumentErr,
      hasProto: iframeDocumentProto !== null,
    });

    if (iframeDocumentProto) {
      installLastModifiedOverride(iframeDocumentProto);
      logger.debug("[lastModified-patch] installed on iframe Document.prototype", {
        pathTaken,
      });
    } else {
      logger.debug(
        "[lastModified-patch] could not reach iframe Document.prototype — iframe.contentDocument.lastModified will leak real zone"
      );
    }
  } catch (err) {
    logger.debug(
      "[lastModified-patch] outer try caught error (cross-origin or missing Document):",
      err instanceof Error ? err.message : String(err)
    );
  }

  // ── 9b. XSLT / EXSLT date-time override ───────────────────────────────
  // The iframe realm has its own XSLTProcessor, so an EXSLT date:date-time()
  // read through `iframe.contentWindow.XSLTProcessor` would bypass the
  // top-level override. Patch the iframe realm's prototype too (Gecko-only
  // in effect; a no-op where EXSLT isn't shipped).
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframeXsltCtor = (iframeWindow as any).XSLTProcessor as typeof XSLTProcessor | undefined;
    if (iframeXsltCtor) {
      installXsltOverridesOn(iframeXsltCtor);
      logger.debug("[patchIframeWindow] section 9b (XSLT) complete");
    }
  } catch (err) {
    logger.debug(
      "[patchIframeWindow] section 9b (XSLT) threw:",
      err instanceof Error ? err.message : String(err)
    );
  }

  // ── 10. RTCPeerConnection override ────────────────────────────────────
  // Each iframe realm has its own `RTCPeerConnection` global. A page
  // can bypass the top-level wrapper by calling
  // `iframe.contentWindow.RTCPeerConnection(...)` from the parent;
  // without an override here the iframe realm still leaks the public
  // IP via srflx candidates / getStats local-candidate addresses.
  //
  // We install the same wrapper pattern as the top-level webrtc.ts:
  // subclass the iframe realm's native constructor, sanitize the
  // config (`iceServers: []`, `iceTransportPolicy: "relay"`) when
  // protection is active, and scrub `local-candidate` addresses
  // from the iframe realm's `RTCPeerConnection.prototype.getStats`.
  //
  // Labeled block so a missing RTCPeerConnection in this iframe
  // realm (unlikely but possible in sandboxed / minimal contexts)
  // doesn't prevent any later sections from running. This is the
  // last section today, but the pattern matches the rest of the
  // function for future-proofing.
  webrtcSection: try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const iframeRTC = (iframeWindow as any).RTCPeerConnection as
      typeof RTCPeerConnection | undefined;
    if (!iframeRTC || typeof iframeRTC !== "function") break webrtcSection;

    // Install getStats scrubber on the iframe realm's prototype
    // first. Instances created before or after the constructor swap
    // inherit this via the prototype chain.
    try {
      installRTCGetStatsOverride(iframeRTC.prototype as RTCPeerConnection);
    } catch (err) {
      logger.debug(
        "[patchIframeWindow] section 10 (webrtc) failed to install getStats override:",
        err instanceof Error ? err.message : String(err)
      );
    }

    const Wrapped = buildRTCPeerConnectionWrapper(iframeRTC);

    try {
      Object.defineProperty(iframeWindow, "RTCPeerConnection", {
        value: Wrapped,
        configurable: true,
        enumerable: false,
        writable: true,
      });
    } catch (err) {
      logger.debug(
        "[patchIframeWindow] section 10 (webrtc) failed to swap iframe RTCPeerConnection:",
        err instanceof Error ? err.message : String(err)
      );
    }

    logger.debug("[patchIframeWindow] section 10 (webrtc) complete");
  } catch (err) {
    logger.debug(
      "[patchIframeWindow] section 10 (webrtc) threw:",
      err instanceof Error ? err.message : String(err)
    );
    // Cross-origin or missing RTCPeerConnection — silently ignore.
  }
}

/** Scan a node (and descendants) for iframes and patch their windows. */
export function scanAndPatchIframes(node: Node): void {
  if (node instanceof HTMLIFrameElement) {
    if (node.contentWindow) {
      try {
        logger.trace("Iframe patching: scanning iframe", { src: node.src || "(no src)" });
        patchIframeWindow(node.contentWindow);
      } catch {
        /* cross-origin */
      }
    }
  }
  if (node instanceof Element) {
    for (const iframe of Array.from(node.querySelectorAll("iframe"))) {
      if (iframe.contentWindow) {
        try {
          logger.trace("Iframe patching: scanning iframe", { src: iframe.src || "(no src)" });
          patchIframeWindow(iframe.contentWindow);
        } catch {
          /* cross-origin */
        }
      }
    }
  }
}

/**
 * Install contentWindow/contentDocument getter overrides on HTMLIFrameElement.prototype.
 * Called by index.ts during initialization.
 */
export function installIframePatching(): void {
  // Override HTMLIFrameElement.prototype.contentWindow getter to patch
  // the iframe's toString synchronously on first access.
  const iframeContentWindowDesc = Object.getOwnPropertyDescriptor(
    HTMLIFrameElement.prototype,
    "contentWindow"
  );
  if (iframeContentWindowDesc?.get) {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional: re-bound via .call(this) inside the wrapper
    const originalContentWindowGet = iframeContentWindowDesc.get;
    // Wrap via stripConstruct so the getter has no prototype/[[Construct]]

    const contentWindowGetter = stripConstruct(function (
      this: HTMLIFrameElement
    ): WindowProxy | null {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const win = originalContentWindowGet.call(this);
      if (win) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          patchIframeWindow(win);
        } catch {
          // Ignore cross-origin errors
        }
      }
      return win;
    });
    registerOverride(contentWindowGetter, "contentWindow");
    disguiseAsNative(contentWindowGetter, "contentWindow", 0);
    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
      get: contentWindowGetter,
      configurable: iframeContentWindowDesc.configurable,
      enumerable: iframeContentWindowDesc.enumerable,
    });
  }

  // Also intercept contentDocument for completeness — some tests access
  // the iframe's document to get Function.prototype.toString from there.
  const iframeContentDocDesc = Object.getOwnPropertyDescriptor(
    HTMLIFrameElement.prototype,
    "contentDocument"
  );
  if (iframeContentDocDesc?.get) {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional: re-bound via .call(this) inside the wrapper
    const originalContentDocGet = iframeContentDocDesc.get;

    const contentDocGetter = stripConstruct(function (this: HTMLIFrameElement): Document | null {
      // Trigger contentWindow patching first
      const win = this.contentWindow; // uses our patched getter above
      void win; // ensure side-effect
      return originalContentDocGet.call(this);
    });
    registerOverride(contentDocGetter, "contentDocument");
    disguiseAsNative(contentDocGetter, "contentDocument", 0);
    Object.defineProperty(HTMLIFrameElement.prototype, "contentDocument", {
      get: contentDocGetter,
      configurable: iframeContentDocDesc.configurable,
      enumerable: iframeContentDocDesc.enumerable,
    });
  }
}
