/**
 * Geolocation API overrides.
 *
 * Overrides `getCurrentPosition`, `watchPosition`, and `clearWatch` to
 * return the spoofed location when protection is enabled.
 */

import type { SpoofedLocation, SpoofedGeolocationPosition } from "./types";
import {
  spoofingEnabled,
  spoofedLocation,
  settingsReceived,
  preserveGeolocationPrompt,
  originalGetCurrentPosition,
  originalWatchPosition,
  originalClearWatch,
  nativeGetCurrentPosition,
  nativeWatchPosition,
  nativeClearWatch,
} from "./state";
import {
  installOverride,
  installScrubbedAccessor,
  stripExtensionFramesFromStack,
} from "./function-masking";
import { waitForSettings } from "./settings-listener";
import { createLogger } from "@/shared/utils/debug-logger";
import { now } from "@/shared/utils/safe-time";
import { resolveAccuracy } from "@/shared/accuracy/resolver";
import { detectDeviceClass } from "@/shared/accuracy/device-class";
import { DEFAULT_ACCURACY_SETTING } from "@/shared/types/settings";

const logger = createLogger("INJ");

/**
 * Per-spoofed-instance state for GeolocationCoordinates.
 *
 * The WebIDL spec defines `latitude`, `longitude`, `accuracy`,
 * `altitude`, `altitudeAccuracy`, `heading`, and `speed` as getters on
 * `GeolocationCoordinates.prototype` — they are NOT own data properties
 * on the instance. `Object.keys(coords)` returns `[]` on native, and
 * `getOwnPropertyDescriptor(coords, "latitude")` returns `undefined`.
 * An override that installs own data properties on the instance leaks
 * this layout difference.
 *
 * To match native, we store the actual coordinate values in a WeakMap
 * keyed by the spoofed instance, and install our own getters on
 * `GeolocationCoordinates.prototype`. The getters check the WeakMap
 * first; if the instance is one of ours, return the stored value;
 * otherwise fall back to the native getter so real browser-allocated
 * coords objects (which the page might obtain via some other path)
 * continue to work.
 */
interface CoordsSlots {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  altitudeAccuracy: number | null;
  heading: number | null;
  speed: number | null;
}
const coordsSlots = new WeakMap<object, CoordsSlots>();

/**
 * Per-spoofed-instance state for GeolocationPosition.
 * Same pattern as `coordsSlots`, but for the outer position object.
 */
interface PositionSlots {
  coords: GeolocationCoordinates;
  timestamp: number;
}
const positionSlots = new WeakMap<object, PositionSlots>();

/**
 * Stable per-session cache for padded coordinates.
 *
 * Real GPS/Wi-Fi readings produce 7-8 significant fractional digits (~1cm
 * precision internally, even when the reported `accuracy` is 10m). A user
 * who configures `37.7749` as their spoofed location emits exactly that
 * string with 4 decimals — a single line of page-side inspection
 * (`lat.toString().split('.')[1].length`) flags the low precision as
 * non-native. To close the detection vector without surfacing a "add
 * more decimals" UI requirement to the user, we pad the configured
 * coordinate with deterministic-per-session random digits the first
 * time we build a position for it, then reuse the padded pair for
 * every subsequent call in this content context.
 *
 * Stability matters: a page that calls `getCurrentPosition` twice must
 * see the same coordinates, or the variance itself becomes a fingerprint.
 * The cache is keyed by the raw (unpadded) lat/lon pair, so a fresh
 * settings update with different coordinates naturally triggers
 * re-padding — and each new browser session / page load starts with a
 * fresh random seed, avoiding cross-session fingerprinting.
 *
 * The added random offset is bounded at ±0.00000005 degrees (~5mm at the
 * equator), well below any accuracy value a user might configure, so the
 * reported position stays semantically "the location the user chose" to
 * every practical degree of resolution.
 */
interface PaddedCoords {
  rawLatitude: number;
  rawLongitude: number;
  paddedLatitude: number;
  paddedLongitude: number;
}
let paddedCoordCache: PaddedCoords | null = null;

/**
 * Count decimal places on a number's default string representation.
 * Scientific-notation values (very large / very small) return 0, which
 * correctly triggers the pad path for any configured coordinate.
 */
function decimalPlaces(n: number): number {
  const s = n.toString();
  const dot = s.indexOf(".");
  if (dot === -1) return 0;
  // Rule out scientific notation — `1e-7` would report as 4 decimals below
  // if we naively counted past the dot, but the value string contains `e`.
  if (s.indexOf("e") !== -1 || s.indexOf("E") !== -1) return 0;
  return s.length - dot - 1;
}

/**
 * Pad a coordinate to at least 7 decimal places by appending random
 * digits. Values already at ≥7 decimals are returned unchanged.
 *
 * The padding is a small additive offset in the low-order digits rather
 * than an append-to-string concatenation, so the result stays a normal
 * IEEE-754 double and round-trips cleanly through JSON / toString.
 */
function padCoordinate(raw: number): number {
  if (decimalPlaces(raw) >= 7) return raw;
  // ±0.00000005 degrees ≈ ±5mm at the equator. Well below any GPS/Wi-Fi
  // accuracy value a user might set, so the reported position is
  // indistinguishable from the configured one to any practical consumer.
  //
  // Math.random() is deliberate and NOT a security weakness here: this jitter is
  // cosmetic padding on a coordinate the user is intentionally faking, purely so
  // the stringified value has a realistic decimal length. No security property
  // depends on it being unpredictable — predicting the 8th decimal of a spoofed
  // location grants an attacker nothing. crypto.getRandomValues would be pointless
  // ceremony. CodeQL js/insecure-randomness is a false positive in this context.
  // codeql[js/insecure-randomness]
  const jitter = (Math.random() - 0.5) * 1e-7;
  // Round to 8 decimals so the stringified form has a stable,
  // realistic-looking length (7-8 digits is the native range).
  return Math.round((raw + jitter) * 1e8) / 1e8;
}

/**
 * Retrieve the padded coordinates for the given raw spoofed location,
 * generating them once per unique (latitude, longitude) pair.
 *
 * Exported so iframe-patching.ts can reuse the same cache, guaranteeing
 * that a page reading `iframe.contentWindow.navigator.geolocation` and
 * the top-level `navigator.geolocation` sees identical coordinates.
 */
export function getPaddedCoords(location: SpoofedLocation): {
  latitude: number;
  longitude: number;
} {
  if (
    paddedCoordCache &&
    paddedCoordCache.rawLatitude === location.latitude &&
    paddedCoordCache.rawLongitude === location.longitude
  ) {
    return {
      latitude: paddedCoordCache.paddedLatitude,
      longitude: paddedCoordCache.paddedLongitude,
    };
  }
  const paddedLatitude = padCoordinate(location.latitude);
  const paddedLongitude = padCoordinate(location.longitude);
  paddedCoordCache = {
    rawLatitude: location.latitude,
    rawLongitude: location.longitude,
    paddedLatitude,
    paddedLongitude,
  };
  return { latitude: paddedLatitude, longitude: paddedLongitude };
}

/**
 * Per-call result cache used to satisfy `maximumAge` semantics. Native
 * geolocation caches the last fix and returns it synchronously when
 * `maximumAge` covers the elapsed time since the last call. A spoofing
 * implementation that always runs its artificial delay — even when the
 * caller explicitly opted into a cached read — is detectable: the call
 * with `maximumAge: 60_000` should complete in sub-millisecond time
 * after a fresh prime, but an unconditioned override runs its full
 * 10-50ms delay every time.
 *
 * We store the last successfully-emitted position here (keyed by
 * nothing — there is exactly one implicit cache slot per content
 * context) and consult it on entry to `getCurrentPositionOverride`.
 */
interface PositionCacheEntry {
  position: SpoofedGeolocationPosition;
  capturedAt: number;
}

/**
 * The realm-specific constructors used to build and brand spoofed position
 * objects. The top-level realm uses its own `GeolocationCoordinates` /
 * `GeolocationPosition` globals; the iframe patcher passes the iframe realm's
 * constructors so `pos instanceof iframeWindow.GeolocationPosition` holds and
 * the WeakMap-backed accessors/toJSON (installed on that realm's prototypes)
 * resolve correctly. Either may be `undefined` on very old engines that don't
 * expose these globals — the builder then falls back to a plain object.
 */
export interface GeolocationRealm {
  GeolocationCoordinates?: { prototype: object };
  GeolocationPosition?: { prototype: object };
}

/** The top-level realm's constructors, captured at module load. */
const TOP_REALM: GeolocationRealm = {
  GeolocationCoordinates:
    typeof GeolocationCoordinates !== "undefined" ? GeolocationCoordinates : undefined,
  GeolocationPosition: typeof GeolocationPosition !== "undefined" ? GeolocationPosition : undefined,
};

/**
 * Create a W3C-compliant GeolocationPosition from spoofed location.
 *
 * The object's `[[Prototype]]` chain points at `GeolocationPosition.
 * prototype`, and all coordinate/timestamp data is stored in the
 * `positionSlots` / `coordsSlots` WeakMaps — NOT as own data properties.
 * That matches native layout exactly:
 *
 *   - `instanceof GeolocationPosition` → true
 *   - `Object.keys(pos)` → `[]`
 *   - `Object.keys(pos.coords)` → `[]`
 *   - `Object.getOwnPropertyDescriptor(pos.coords, "latitude")` → `undefined`
 *   - `pos.coords.latitude` → our spoofed value (via the prototype getter
 *     we installed in `installCoordinateAccessors`, which consults the
 *     WeakMap)
 *
 * `toJSON` is installed on the prototype (see `installPositionToJSON` /
 * `installCoordsToJSON`), not as an own property on each instance, so
 * `Object.getOwnPropertyNames(pos)` returns `[]` just like native. The
 * prototype override checks the slots WeakMap and falls through to the
 * native `toJSON` for pristine browser-allocated instances.
 *
 * When the `GeolocationPosition` / `GeolocationCoordinates` globals
 * aren't exposed (very old engines or unusual contexts) we fall back
 * to a plain object literal so the call path still succeeds.
 */
export function createGeolocationPosition(
  location: SpoofedLocation,
  realm: GeolocationRealm = TOP_REALM
): SpoofedGeolocationPosition {
  const padded = getPaddedCoords(location);
  const coordsFields: CoordsSlots = {
    latitude: padded.latitude,
    longitude: padded.longitude,
    // Resolve a realistic, stable integer accuracy via the shared Resolver.
    // Determinism (seed + coarsely-quantized location) keeps the value stable
    // across back-to-back calls and page loads — matching how a stationary
    // native device reports a steady integer — without the old per-context
    // cache. Device class is detected page-side so the band is plausible for
    // the running device.
    accuracy: resolveAccuracy({
      setting: location.accuracySetting ?? DEFAULT_ACCURACY_SETTING,
      deviceClass: detectDeviceClass(navigator),
      seed: location.accuracySeed ?? 0,
      latitude: location.latitude,
      longitude: location.longitude,
    }),
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  };

  // Build the coords instance — prototype-linked, WeakMap-backed, no own props.
  const CoordsCtor = realm.GeolocationCoordinates;
  let coords: GeolocationCoordinates;
  try {
    if (CoordsCtor?.prototype) {
      const coordsInstance = Object.create(CoordsCtor.prototype) as object;
      coordsSlots.set(coordsInstance, coordsFields);
      coords = coordsInstance as unknown as GeolocationCoordinates;
    } else {
      coords = coordsFields as unknown as GeolocationCoordinates;
    }
  } catch {
    coords = coordsFields as unknown as GeolocationCoordinates;
  }

  const timestamp = Date.now();

  // Build the position instance — prototype-linked, WeakMap-backed, zero
  // own properties. `toJSON` lives on the prototype (see
  // `installPositionToJSON`), matching native layout so
  // `Object.getOwnPropertyNames(pos)` returns [].
  const PosCtor = realm.GeolocationPosition;
  try {
    if (PosCtor?.prototype) {
      const positionInstance = Object.create(PosCtor.prototype) as object;
      positionSlots.set(positionInstance, { coords, timestamp });
      return positionInstance as unknown as SpoofedGeolocationPosition;
    }
  } catch {
    // fall through to plain object
  }
  return { coords: coordsFields as unknown as SpoofedGeolocationPosition["coords"], timestamp };
}

/** A native geolocation method invoked with loose args during delegation. */
export type NativeGeoMethod = (...args: Array<unknown>) => unknown;

/** No-op used when substituting a *valid* callback during native delegation. */
const GEO_NOOP = (): void => {};

/**
 * Deliver a spoofed result to a page-supplied geolocation callback WITHOUT any
 * frame of ours on the stack.
 *
 * We schedule the callback itself as the task/microtask entry — bound to its
 * argument and to `undefined` `this` — rather than calling it from inside a
 * wrapper closure we own. If the page's callback throws, the uncaught error's
 * `.stack` AND its `ErrorEvent.filename` then name only the page's own code,
 * matching a native browser (which dispatches geolocation callbacks from C++
 * with no JS caller frame).
 *
 * Why not catch-then-scrub-then-rethrow: rethrowing re-surfaces the error from
 * OUR line, which moves `ErrorEvent.filename` onto `chrome-extension://…/
 * injected.js` — trading a stack-channel leak for a filename-channel one.
 * Detaching the call is the only way to keep BOTH channels native-clean.
 *
 * `delayMs === undefined` → microtask (matches native's sub-millisecond cache
 * hit); otherwise a `setTimeout` of the given delay (fresh-fix latency).
 */
function deliverToCallback<A>(cb: (arg: A) => void, arg: A, delayMs?: number): void {
  const bound = cb.bind(undefined, arg);
  if (delayMs === undefined) {
    queueMicrotask(bound);
  } else {
    setTimeout(bound, delayMs);
  }
}

/**
 * Whether a geolocation call's `this` and arguments are valid per WebIDL, so
 * the override can proceed. Mirrors the checks the native methods perform:
 *   - `this` must implement the Geolocation interface,
 *   - `successCallback` (arg 0) must be callable,
 *   - `errorCallback` (arg 1), when present, must be callable,
 *   - `options` (arg 2), when present, must be an object (dictionaries reject
 *     non-null primitives; functions are objects and are accepted).
 */
export function geoArgsValid(
  GeolocationCtor: new () => object,
  self: unknown,
  successCallback: unknown,
  errorCallback: unknown,
  options: unknown
): boolean {
  if (!(self instanceof GeolocationCtor)) return false;
  if (typeof successCallback !== "function") return false;
  if (errorCallback != null && typeof errorCallback !== "function") return false;
  if (options != null && Object(options) !== options) return false;
  return true;
}

/**
 * Reproduce the browser's own error for an invalid geolocation call.
 *
 * Called only once `geoArgsValid` has determined the call is invalid. Invoking
 * the unbound native method with the same receiver and arguments makes the
 * browser throw its genuine `TypeError` — correct type, exact per-engine
 * message, and a native stack — instead of a hand-rolled error whose message
 * and stack (bearing the extension's own URL) betray the override. We then
 * strip our injected-script frames from that stack so the extension id can't be
 * read off it.
 *
 * Defense in depth: any *valid* success/error callback is swapped for a no-op
 * before delegating, so in the (spec-impossible) event the native call fails to
 * throw, the page's real callbacks never receive a real position. The original
 * argument count is preserved so the native error message (which distinguishes
 * "1 argument required, but only 0 present" from a type error) matches exactly.
 */
export function reproduceNativeGeoError(
  self: unknown,
  nativeMethod: (...args: Array<unknown>) => unknown,
  args: IArguments
): void {
  const argv = Array.prototype.slice.call(args) as Array<unknown>;
  if (typeof argv[0] === "function") argv[0] = GEO_NOOP;
  if (typeof argv[1] === "function") argv[1] = GEO_NOOP;
  try {
    Reflect.apply(nativeMethod, self, argv);
  } catch (err) {
    stripExtensionFramesFromStack(err);
    throw err;
  }
}

/**
 * The realm-specific dependencies a set of geolocation overrides needs. The
 * top-level realm and each same-origin iframe realm supply their own, so the
 * full behavior — brand check, `maximumAge` cache, preserve-prompt native
 * prompt, defer-until-settings, and `watchPosition` re-fire cadence — is
 * defined once and shared, instead of the iframe carrying a simplified copy
 * that drifts (previously: no cache, no prompt, fires-once).
 *
 * Per-realm (not shared): the `Geolocation` constructor (brand check), the
 * realm's bound native methods (pass-through / preserve-prompt) and unbound
 * natives (faithful `reproduceNativeGeoError` throw), a `buildPosition` closure
 * that mints a spoofed position in the correct realm, and `isAlive` — a
 * liveness check the watch cadence consults before each re-fire so a removed
 * iframe's timers stop (the top-level realm passes `() => true`).
 *
 * Shared via module state (same for every realm): `spoofingEnabled`,
 * `spoofedLocation`, `settingsReceived`, `preserveGeolocationPrompt`,
 * `waitForSettings`, and `sampleNativeToJsonOrder`. The `maximumAge` cache and
 * watch bookkeeping are per-override-set (closed over below) — native-correct,
 * since the top frame and an iframe are separate browsing contexts with
 * independent caches.
 */
export interface GeolocationOverrideRealm {
  Geolocation: new () => object;
  origGetCurrentPosition: (
    success: PositionCallback,
    error?: PositionErrorCallback | null,
    options?: PositionOptions
  ) => void;
  origWatchPosition: (
    success: PositionCallback,
    error?: PositionErrorCallback | null,
    options?: PositionOptions
  ) => number;
  origClearWatch: (watchId: number) => void;
  nativeGetCurrentPosition: NativeGeoMethod;
  nativeWatchPosition: NativeGeoMethod;
  nativeClearWatch: NativeGeoMethod;
  buildPosition: () => SpoofedGeolocationPosition;
  isAlive: () => boolean;
}

/** The three geolocation method overrides produced for a realm. */
export interface GeolocationOverrides {
  getCurrentPosition: (
    this: unknown,
    successCallback: PositionCallback,
    errorCallback?: PositionErrorCallback | null,
    options?: PositionOptions
  ) => void;
  watchPosition: (
    this: unknown,
    successCallback: PositionCallback,
    errorCallback?: PositionErrorCallback | null,
    options?: PositionOptions
  ) => number;
  clearWatch: (this: unknown, watchId: number) => void;
}

/**
 * Build the `getCurrentPosition` / `watchPosition` / `clearWatch` overrides for
 * one realm. See {@link GeolocationOverrideRealm} for the split between
 * per-realm dependencies and shared module state.
 */
export function buildGeolocationOverrides(realm: GeolocationOverrideRealm): GeolocationOverrides {
  // Per-realm watch bookkeeping and maximumAge cache slot.
  const watchCallbacks = new Map<number, PositionCallback>();
  let watchIdCounter = 1;
  let cachedPosition: PositionCacheEntry | null = null;

  /**
   * Check whether the cached position can satisfy the caller's `maximumAge`
   * request. Returns the cached position or `null`.
   */
  const consumeCachedPosition = (options?: PositionOptions): SpoofedGeolocationPosition | null => {
    if (!cachedPosition) return null;
    const maxAge = options?.maximumAge ?? 0;
    if (maxAge <= 0) return null;
    const age = Date.now() - cachedPosition.capturedAt;
    if (age > maxAge) return null;
    return cachedPosition.position;
  };

  /** Record a newly-emitted position so subsequent `maximumAge` reads can hit it. */
  const rememberPosition = (position: SpoofedGeolocationPosition): void => {
    cachedPosition = { position, capturedAt: Date.now() };
  };

  /**
   * Emit a freshly-built spoofed position to the success callback with a
   * realistic 10-50ms delay (mirrors a native fresh-fix latency). This is the
   * seamless, prompt-free path used when "preserve permission prompts" is off.
   */
  const emitSpoofedPosition = (successCallback: PositionCallback): void => {
    const position = realm.buildPosition();
    rememberPosition(position);
    const delay = 10 + Math.random() * 40;
    logger.debug("getCurrentPosition: returning spoofed coords", {
      coords: { lat: position.coords.latitude, lon: position.coords.longitude },
      delay: `${delay.toFixed(1)}ms`,
    });
    // Deliver detached (callback is the timer entry) so a throwing page callback
    // reports only its own frames in both stack and ErrorEvent.filename.
    deliverToCallback(successCallback, position as GeolocationPosition, delay);
  };

  /**
   * "Preserve permission prompts" path: invoke the real geolocation API so the
   * browser surfaces its native permission prompt. On grant, discard the real
   * coordinates and hand back spoofed ones (the page still never learns the
   * real location); on denial / unavailable / timeout, forward the native error
   * unchanged. The real position is requested only to drive the genuine
   * permission flow — the user keeps per-site control over which sites get any
   * location at all, and a denied site is indistinguishable from a normal
   * browser.
   */
  const respondViaNativePrompt = (
    successCallback: PositionCallback,
    errorCallback: PositionErrorCallback | null | undefined,
    options: PositionOptions | undefined
  ): void => {
    logger.debug("getCurrentPosition: preserve-prompt mode, calling real API for native prompt");
    realm.origGetCurrentPosition(
      (realPosition) => {
        // We momentarily hold a genuine native position — learn the engine's
        // true toJSON key order from it before discarding, then hand back
        // spoofed coords.
        sampleNativeToJsonOrder(realPosition);
        const position = realm.buildPosition();
        rememberPosition(position);
        logger.debug("getCurrentPosition: prompt granted, substituting spoofed coords");
        // Detached delivery (microtask) — no wrapper frame of ours on the stack.
        deliverToCallback(successCallback, position as GeolocationPosition);
      },
      errorCallback,
      options
    );
  };

  /** Override for `navigator.geolocation.getCurrentPosition`. */
  function getCurrentPosition(
    this: unknown,
    successCallback: PositionCallback,
    errorCallback?: PositionErrorCallback | null,
    options?: PositionOptions
  ): void {
    if (!geoArgsValid(realm.Geolocation, this, successCallback, errorCallback, options)) {
      // eslint-disable-next-line prefer-rest-params
      reproduceNativeGeoError(this, realm.nativeGetCurrentPosition, arguments);
      return;
    }
    logger.debug(
      "getCurrentPosition called — settingsReceived:",
      settingsReceived,
      "spoofingEnabled:",
      spoofingEnabled,
      "hasLocation:",
      !!spoofedLocation
    );

    // Satisfy `maximumAge`: if the caller accepts a cached position and
    // one is still fresh, return it synchronously (via queueMicrotask so
    // the callback still fires asynchronously, as native does). This
    // mirrors the observable timing of a cache hit — sub-millisecond —
    // which a real implementation produces but a naive spoof does not.
    if (settingsReceived && spoofingEnabled && spoofedLocation) {
      const cached = consumeCachedPosition(options);
      if (cached) {
        logger.debug("getCurrentPosition: cache hit, returning immediately");
        // Detached microtask delivery — matches native cache-hit timing and
        // keeps a throwing callback's stack/filename free of our frames.
        deliverToCallback(successCallback, cached as GeolocationPosition);
        return;
      }
    }

    if (settingsReceived) {
      // Settings already loaded — respond immediately
      if (spoofingEnabled && spoofedLocation) {
        if (preserveGeolocationPrompt) {
          respondViaNativePrompt(successCallback, errorCallback, options);
        } else {
          emitSpoofedPosition(successCallback);
        }
      } else {
        logger.debug("getCurrentPosition: spoofing disabled, using original");
        realm.origGetCurrentPosition(successCallback, errorCallback, options);
      }
    } else {
      // Settings not yet received — wait for them before responding
      logger.debug("getCurrentPosition: deferring until settings arrive");
      const deferStart = now();
      void waitForSettings().then(({ timedOut }) => {
        const waited = now() - deferStart;
        if (timedOut) {
          // Settings never arrived within the timeout window. We don't know
          // whether spoofing should be on or off, so we cannot safely fall
          // through to the real API (that would leak the user's real location
          // if spoofing was meant to be active). Fire the error callback instead.
          logger.warn(
            `getCurrentPosition: settings timed out after ${waited.toFixed(1)}ms, returning TIMEOUT error`
          );
          if (errorCallback) {
            deliverToCallback(errorCallback, {
              code: GeolocationPositionError.TIMEOUT,
              message: "Settings not received in time",
              PERMISSION_DENIED: GeolocationPositionError.PERMISSION_DENIED,
              POSITION_UNAVAILABLE: GeolocationPositionError.POSITION_UNAVAILABLE,
              TIMEOUT: GeolocationPositionError.TIMEOUT,
            });
          }
          return;
        }
        logger.debug(`getCurrentPosition: waitForSettings resolved after ${waited.toFixed(1)}ms`);
        if (spoofingEnabled && spoofedLocation) {
          if (preserveGeolocationPrompt) {
            respondViaNativePrompt(successCallback, errorCallback, options);
          } else {
            emitSpoofedPosition(successCallback);
          }
        } else {
          logger.debug("getCurrentPosition (deferred): spoofing disabled, using original");
          realm.origGetCurrentPosition(successCallback, errorCallback, options);
        }
      });
    }
  }

  /**
   * Override for `navigator.geolocation.watchPosition`.
   *
   * Native watchPosition fires its callback repeatedly as the device
   * moves, and on a stationary device it still emits updates every few
   * seconds as GPS/Wi-Fi estimates refine. A spoofing implementation that
   * fires once and falls silent is trivially detectable — a fingerprinter
   * can count callbacks over a 5-second window. We emit an initial
   * callback then schedule periodic re-fires with the same spoofed
   * position until the caller clears the watch.
   */
  function watchPosition(
    this: unknown,
    successCallback: PositionCallback,
    errorCallback?: PositionErrorCallback | null,
    options?: PositionOptions
  ): number {
    if (!geoArgsValid(realm.Geolocation, this, successCallback, errorCallback, options)) {
      // eslint-disable-next-line prefer-rest-params
      reproduceNativeGeoError(this, realm.nativeWatchPosition, arguments);
      // `reproduceNativeGeoError` always throws (the native call rejects the
      // invalid input); this return only satisfies the number return type.
      return 0;
    }
    if (spoofingEnabled && spoofedLocation) {
      if (preserveGeolocationPrompt) {
        // Preserve-prompt mode: let the real API drive both the native permission
        // prompt and the native re-fire cadence, but substitute spoofed coords on
        // every update so the real location never reaches the page. Denials/errors
        // flow through untouched. The returned id is the real watch id, so
        // clearWatch routes it back to the native clearWatch (see below).
        logger.debug("watchPosition: preserve-prompt mode, delegating to real API");
        return realm.origWatchPosition(
          (realPosition) => {
            if (!spoofingEnabled || !spoofedLocation) return;
            sampleNativeToJsonOrder(realPosition);
            // Detached delivery — no wrapper frame of ours on the stack.
            deliverToCallback(successCallback, realm.buildPosition() as GeolocationPosition);
          },
          errorCallback,
          options
        );
      }

      const watchId = watchIdCounter++;
      watchCallbacks.set(watchId, successCallback);

      const initialDelay = 10 + Math.random() * 40;
      logger.debug("watchPosition: returning spoofed coords", {
        watchId,
        delay: `${initialDelay.toFixed(1)}ms`,
      });

      const emit = (): void => {
        if (!watchCallbacks.has(watchId)) return;
        if (!spoofingEnabled || !spoofedLocation) return;
        // Stop (and forget) the watch if the realm is gone — e.g. an iframe
        // removed from the DOM. Our timers run in the parent context, but the
        // callback belongs to the (now dead) iframe realm; re-firing would leak
        // timers and throw every tick.
        if (!realm.isAlive()) {
          watchCallbacks.delete(watchId);
          return;
        }
        try {
          successCallback(realm.buildPosition() as GeolocationPosition);
        } catch (err) {
          // The callback's realm may have gone away between the liveness check
          // and this call. Stop re-firing rather than throwing every tick.
          logger.debug(
            "watchPosition: emit failed, clearing watch",
            err instanceof Error ? err.message : String(err)
          );
          watchCallbacks.delete(watchId);
        }
      };

      // Initial callback — mirrors the timing of a first fresh fix.
      setTimeout(emit, initialDelay);

      // Periodic re-fires matching native behavior. We cap the interval
      // at 2s so worst-case RNG still produces at least two callbacks
      // inside a 3-second observation window (first callback up to 50ms
      // + one re-fire at up to 2000ms = 2050ms, well under 3000ms). A
      // wider upper bound made the cadence test flaky.
      const schedule = (): void => {
        if (!watchCallbacks.has(watchId)) return;
        if (!realm.isAlive()) {
          watchCallbacks.delete(watchId);
          return;
        }
        const interval = 1_000 + Math.random() * 1_000;
        setTimeout(() => {
          emit();
          schedule();
        }, interval);
      };
      schedule();

      return watchId;
    } else {
      return realm.origWatchPosition(successCallback, errorCallback, options);
    }
  }

  /** Override for `navigator.geolocation.clearWatch`. */
  function clearWatch(this: unknown, watchId: number): void {
    // clearWatch takes only a `this` brand check natively (the numeric watchId
    // coerces without throwing), so validate the receiver and delegate a foreign
    // `this` to the native method for a faithful, non-leaking TypeError.
    if (!(this instanceof realm.Geolocation)) {
      // eslint-disable-next-line prefer-rest-params
      reproduceNativeGeoError(this, realm.nativeClearWatch, arguments);
      return;
    }
    // A synthetic (spoofed) watch lives in `watchCallbacks`; clear it locally.
    // Anything else is a real native watch — either spoofing is off, or we're in
    // preserve-prompt mode where watchPosition delegates to the real API — so
    // route it to the native clearWatch.
    if (watchCallbacks.has(watchId)) {
      watchCallbacks.delete(watchId);
    } else {
      realm.origClearWatch(watchId);
    }
  }

  return { getCurrentPosition, watchPosition, clearWatch };
}

/**
 * Install geolocation API overrides on `Geolocation.prototype`.
 *
 * Overrides `getCurrentPosition`, `watchPosition`, and `clearWatch` on
 * the interface prototype — this is where native methods live, so a
 * fingerprinting check like `Object.getOwnPropertyDescriptor(
 *   navigator.geolocation, "getCurrentPosition")` correctly returns
 * `undefined` (the method is inherited, not own), and the descriptor on
 * the prototype (`writable: true, configurable: true, enumerable: true`)
 * matches the WebIDL-specified native shape.
 *
 * We also install accessor overrides on `GeolocationCoordinates.prototype`
 * and `GeolocationPosition.prototype` so our spoofed coords/position
 * objects have zero own properties — matching the native layout where
 * `Object.keys(coords)` returns `[]`. See `coordsSlots` /
 * `positionSlots` WeakMaps above for details.
 *
 * We deliberately do NOT install a second copy on `navigator.geolocation`
 * itself. A page that wants to shadow on the instance is fighting
 * itself — they don't gain a pristine reference that way.
 *
 * `installOverride` reads the target's existing descriptor and preserves
 * its flags, so we automatically match the native shape without
 * hardcoding it here.
 */
export function installGeolocationOverrides(): void {
  const overrides = buildGeolocationOverrides({
    Geolocation,
    origGetCurrentPosition: originalGetCurrentPosition,
    origWatchPosition: originalWatchPosition,
    origClearWatch: originalClearWatch,
    nativeGetCurrentPosition: nativeGetCurrentPosition as NativeGeoMethod,
    nativeWatchPosition: nativeWatchPosition as NativeGeoMethod,
    nativeClearWatch: nativeClearWatch as NativeGeoMethod,
    // Top-level realm: build in the default (top) realm; always alive.
    buildPosition: () => createGeolocationPosition(spoofedLocation!),
    isAlive: () => true,
  });
  installOverride(Geolocation.prototype, "getCurrentPosition", overrides.getCurrentPosition, 1);
  installOverride(Geolocation.prototype, "watchPosition", overrides.watchPosition, 1);
  installOverride(Geolocation.prototype, "clearWatch", overrides.clearWatch, 1);
  installGeolocationObjectModel(TOP_REALM);
}

/**
 * Install the WeakMap-backed attribute accessors + `toJSON` overrides on a
 * realm's `GeolocationCoordinates.prototype` and `GeolocationPosition.prototype`.
 *
 * This is what makes spoofed position objects indistinguishable from native:
 * values live in the shared `coordsSlots` / `positionSlots` WeakMaps (keyed by
 * instance, so they work across realms) rather than as own data properties, so
 * `Object.keys(coords)` returns `[]` and `coords.toJSON()` emits the native
 * per-engine key order. Called once per realm — by `installGeolocationOverrides`
 * for the top level and by the iframe patcher for each same-origin iframe realm,
 * so both share one implementation and cannot drift.
 */
export function installGeolocationObjectModel(realm: GeolocationRealm): void {
  const coordsProto = realm.GeolocationCoordinates?.prototype;
  if (coordsProto) {
    installCoordinateAccessors(coordsProto);
    installCoordsToJSON(coordsProto);
  }
  const positionProto = realm.GeolocationPosition?.prototype;
  if (positionProto) {
    installPositionAccessors(positionProto);
    installPositionToJSON(positionProto);
  }
}

/**
 * Install the seven WebIDL-spec'd attribute accessors on
 * `GeolocationCoordinates.prototype`. Each getter first checks the
 * `coordsSlots` WeakMap (for our spoofed instances); if the instance
 * isn't one of ours, it falls through to the original native getter
 * so pristine browser-allocated coords keep working.
 */
function installCoordinateAccessors(proto: object): void {
  const keys: ReadonlyArray<keyof CoordsSlots> = [
    "latitude",
    "longitude",
    "accuracy",
    "altitude",
    "altitudeAccuracy",
    "heading",
    "speed",
  ];
  for (const key of keys) {
    const originalDesc = Object.getOwnPropertyDescriptor(proto, key);
    if (!originalDesc?.get) continue;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional: re-bound via .call(this) inside the spoofed getter
    const originalGet = originalDesc.get;

    // Spoofed instances read from the WeakMap slot; any other receiver (e.g. a
    // page's `GeolocationCoordinates.prototype.latitude.call({})` brand-probe)
    // falls through to the native getter, which throws. `installScrubbedAccessor`
    // wraps this so that thrown error's stack has no extension frames.
    function spoofedGet(this: object): unknown {
      const slots = coordsSlots.get(this);
      if (slots) return slots[key];
      return originalGet.call(this);
    }

    installScrubbedAccessor(proto, key, { get: spoofedGet });
  }
}

/**
 * Install the two WebIDL-spec'd attribute accessors on
 * `GeolocationPosition.prototype`: `coords` and `timestamp`. Same
 * pattern as `installCoordinateAccessors`.
 */
function installPositionAccessors(proto: object): void {
  const keys: ReadonlyArray<keyof PositionSlots> = ["coords", "timestamp"];
  for (const key of keys) {
    const originalDesc = Object.getOwnPropertyDescriptor(proto, key);
    if (!originalDesc?.get) continue;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional: re-bound via .call(this) inside the spoofed getter
    const originalGet = originalDesc.get;

    function spoofedGet(this: object): unknown {
      const slots = positionSlots.get(this);
      if (slots) return slots[key];
      return originalGet.call(this);
    }

    installScrubbedAccessor(proto, key, { get: spoofedGet });
  }
}

/**
 * The native key order that the `[Default] toJSON()` serializer emits, per
 * engine. The serializer walks the interface's Web IDL attribute-declaration
 * order — which is NOT the prototype's own-property order (Blink installs the
 * getters in one order but serializes in another) and CANNOT be sampled from a
 * spoofed instance (native `toJSON` brand-checks and throws on our
 * `Object.create`-d objects). So we encode the two known native orders and
 * select by build target:
 *
 *   - Blink / Chromium: `accuracy` leads coords, `timestamp` leads position
 *     (confirmed empirically on Chrome 149 and documented on MDN).
 *   - Gecko (Firefox) and WebKit (Safari): the W3C-origin IDL order — coords
 *     lead with `latitude` (with `altitude` before `accuracy`), position leads
 *     with `coords` (verified against the Gecko and WebKit IDL sources, which
 *     are byte-identical in attribute order).
 *
 * Each build ships to exactly one engine family, so a compile-time constant is
 * correct and has zero runtime cost or detection surface. It is also the
 * fallback for the runtime-sampled order (see `sampleNativeToJsonOrder`).
 *
 * Sources (the `[Default] object toJSON()` serializer walks IDL attribute
 * order):
 *   - Spec + serializer definition: https://www.w3.org/TR/geolocation/#coordinates_interface
 *     and the commit that added it: https://github.com/w3c/geolocation/commit/09b48e6
 *   - MDN (documents the observed Blink output order):
 *     https://developer.mozilla.org/en-US/docs/Web/API/GeolocationCoordinates/toJSON
 *     https://developer.mozilla.org/en-US/docs/Web/API/GeolocationPosition/toJSON
 *   - Gecko IDL: https://github.com/mozilla/gecko-dev/blob/master/dom/webidl/GeolocationCoordinates.webidl
 *     https://github.com/mozilla/gecko-dev/blob/master/dom/webidl/GeolocationPosition.webidl
 *   - WebKit IDL: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/geolocation/GeolocationCoordinates.idl
 *     https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/geolocation/GeolocationPosition.idl
 *   - Blink intent-to-ship discussion: https://groups.google.com/a/chromium.org/g/blink-dev/c/JQkvFd0oXUI
 */
const COORDS_JSON_ORDER: ReadonlyArray<keyof CoordsSlots> = __CHROMIUM__
  ? ["accuracy", "latitude", "longitude", "altitude", "altitudeAccuracy", "heading", "speed"]
  : ["latitude", "longitude", "altitude", "accuracy", "altitudeAccuracy", "heading", "speed"];

const POSITION_JSON_ORDER: ReadonlyArray<keyof PositionSlots> = __CHROMIUM__
  ? ["timestamp", "coords"]
  : ["coords", "timestamp"];

/**
 * Runtime-learned native key orders. Populated by `sampleNativeToJsonOrder`
 * the first time we hold a genuine browser-allocated position (preserve-prompt
 * mode calls the real API). When set, they take precedence over the hardcoded
 * build-flag defaults — so if an engine ever changes its serializer order, a
 * preserve-prompt user's spoofed output tracks it automatically. `null` until
 * sampled, which is the common case (default prompt-free mode never sees a real
 * position), and then the verified defaults apply.
 */
let sampledCoordsOrder: ReadonlyArray<keyof CoordsSlots> | null = null;
let sampledPositionOrder: ReadonlyArray<keyof PositionSlots> | null = null;

/** The coords key order to emit: runtime-sampled if known, else the default. */
function effectiveCoordsOrder(): ReadonlyArray<keyof CoordsSlots> {
  return sampledCoordsOrder ?? COORDS_JSON_ORDER;
}

/** The position key order to emit: runtime-sampled if known, else the default. */
function effectivePositionOrder(): ReadonlyArray<keyof PositionSlots> {
  return sampledPositionOrder ?? POSITION_JSON_ORDER;
}

/**
 * Learn the engine's true `toJSON()` key order from a genuine, browser-
 * allocated `GeolocationPosition` (available only in preserve-prompt mode,
 * where we call the real geolocation API). Calling `.toJSON()` on a real
 * instance routes through our prototype override, which delegates non-spoofed
 * instances to the native serializer — so the returned key order is the true
 * native order for this exact engine build. We cache it once; failures are
 * swallowed and simply leave the verified hardcoded defaults in place.
 */
function sampleNativeToJsonOrder(realPosition: GeolocationPosition): void {
  try {
    const coordKeys = new Set<string>([
      "accuracy",
      "altitude",
      "altitudeAccuracy",
      "heading",
      "latitude",
      "longitude",
      "speed",
    ]);
    const withToJson = realPosition as unknown as { toJSON?: () => unknown };
    if (sampledPositionOrder === null && typeof withToJson.toJSON === "function") {
      const posJson = withToJson.toJSON();
      if (posJson && typeof posJson === "object") {
        const keys = Object.keys(posJson as Record<string, unknown>).filter(
          (k) => k === "coords" || k === "timestamp"
        );
        if (keys.length === 2) sampledPositionOrder = keys;
      }
    }
    const coords = realPosition.coords as unknown as { toJSON?: () => unknown };
    if (sampledCoordsOrder === null && coords && typeof coords.toJSON === "function") {
      const cJson = coords.toJSON();
      if (cJson && typeof cJson === "object") {
        const keys = Object.keys(cJson as Record<string, unknown>).filter((k) => coordKeys.has(k));
        if (keys.length === coordKeys.size) sampledCoordsOrder = keys as Array<keyof CoordsSlots>;
      }
    }
  } catch {
    // Sampling is best-effort; the hardcoded defaults remain in effect.
  }
}

/** Build the coords JSON object with keys inserted in native order. */
function buildCoordsJSON(
  cSlots: CoordsSlots,
  order: ReadonlyArray<keyof CoordsSlots>
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const key of order) {
    out[key] = cSlots[key];
  }
  return out;
}

/**
 * Install a `toJSON` override on `GeolocationPosition.prototype`.
 *
 * Native `GeolocationPosition.prototype.toJSON` is a brand-checked
 * method — invoking it on a non-browser-allocated object (like our
 * `Object.create(GeolocationPosition.prototype)` instance) throws. So
 * we install our own `toJSON` on the prototype: for our spoofed
 * instances (identified via the `positionSlots` WeakMap) we build the
 * JSON shape ourselves; for any pristine browser-allocated position
 * that happens to reach this prototype, we fall through to the native
 * method.
 *
 * Installing on the prototype rather than as an own property on each
 * instance means `Object.getOwnPropertyNames(pos)` returns `[]` —
 * matching native layout and closing the detection vector where a
 * page can inspect non-enumerable own keys.
 */
function installPositionToJSON(protoObj: object): void {
  const proto = protoObj as unknown as {
    toJSON?: () => unknown;
  };

  const originalToJSON = proto.toJSON;

  function spoofedToJSON(this: object): unknown {
    const slots = positionSlots.get(this);
    if (slots) {
      const cSlots = coordsSlots.get(slots.coords);
      const coordsJSON: unknown = cSlots
        ? buildCoordsJSON(cSlots, effectiveCoordsOrder())
        : slots.coords;
      // Assemble the position object with keys in native order (engine-specific
      // — Blink emits `timestamp` before `coords`; Gecko/WebKit the reverse).
      const out: Record<string, unknown> = {};
      for (const key of effectivePositionOrder()) {
        out[key] = key === "coords" ? coordsJSON : slots.timestamp;
      }
      return out;
    }
    // Pristine browser-allocated instance — fall through to native.
    if (typeof originalToJSON === "function") {
      return originalToJSON.call(this);
    }
    // No native toJSON to fall through to (very old engines) — return
    // an empty object rather than throwing so JSON.stringify doesn't
    // propagate an error up the call stack.
    return {};
  }

  installOverride(proto, "toJSON", spoofedToJSON, 0);
}

/**
 * Install a `toJSON` override on `GeolocationCoordinates.prototype`.
 *
 * Same rationale as `installPositionToJSON`, but for the coords
 * sub-object. Spoofed instances return their stored fields; pristine
 * browser-allocated instances fall through to the native method.
 */
function installCoordsToJSON(protoObj: object): void {
  const proto = protoObj as unknown as {
    toJSON?: () => unknown;
  };

  const originalToJSON = proto.toJSON;

  function spoofedToJSON(this: object): unknown {
    const slots = coordsSlots.get(this);
    if (slots) {
      return buildCoordsJSON(slots, effectiveCoordsOrder());
    }
    if (typeof originalToJSON === "function") {
      return originalToJSON.call(this);
    }
    return {};
  }

  installOverride(proto, "toJSON", spoofedToJSON, 0);
}
