/**
 * Permissions API override.
 *
 * Overrides `navigator.permissions.query` to return "granted" for
 * geolocation permission when spoofing is enabled.
 */

import {
  spoofingEnabled,
  settingsReceived,
  preserveGeolocationPrompt,
  originalPermissionsQuery,
  nativePermissionsQuery,
} from "./state";
import { installOverride, stripExtensionFramesFromStack } from "./function-masking";
import { waitForSettings } from "./settings-listener";
import { createLogger } from "@/shared/utils/debug-logger";

const logger = createLogger("INJ");

/**
 * Create a W3C-compliant PermissionStatus object with state "granted".
 *
 * We return an object whose prototype chain points at `PermissionStatus.
 * prototype`, so page-side checks like `status instanceof PermissionStatus`
 * and `Object.prototype.toString.call(status)` (which reads
 * `Symbol.toStringTag` off the prototype, yielding
 * `"[object PermissionStatus]"`) match native. A plain EventTarget — which
 * is what the previous implementation returned — brands as
 * `"[object EventTarget]"`, which is a direct detection vector.
 *
 * `state`, `name`, and `onchange` are installed as own data properties
 * so that the prototype's brand-checked accessors are bypassed (the
 * same trick we use for GeolocationCoordinates.latitude in geolocation.ts).
 */
function createSpoofedPermissionStatus(
  PermissionStatusCtor: { prototype: object } | undefined,
  name: PermissionName = "geolocation"
): PermissionStatus {
  const target = PermissionStatusCtor?.prototype
    ? (Object.create(PermissionStatusCtor.prototype) as PermissionStatus)
    : (new EventTarget() as unknown as PermissionStatus);

  let onchangeHandler: ((this: PermissionStatus, ev: Event) => unknown) | null = null;

  Object.defineProperty(target, "state", {
    value: "granted",
    writable: false,
    enumerable: true,
    configurable: false,
  });

  Object.defineProperty(target, "name", {
    value: name,
    writable: false,
    enumerable: true,
    configurable: false,
  });

  Object.defineProperty(target, "onchange", {
    get: () => onchangeHandler,
    set: (value: ((this: PermissionStatus, ev: Event) => unknown) | null) => {
      onchangeHandler = value;
    },
    enumerable: true,
    configurable: true,
  });

  return target;
}

/**
 * Realm-specific bindings the `query` override needs. Passing these in lets the
 * SAME builder serve the top-level realm and every iframe realm (see
 * `iframe-patching.ts`), so the brand check, native-delegation-with-scrub,
 * preserve-prompt gating, and settings-wait logic live in exactly ONE place —
 * no more drift between the two implementations. Shared spoofing state
 * (`spoofingEnabled` / `settingsReceived` / `preserveGeolocationPrompt`) comes
 * from the single shared `state` module, so it's identical across realms.
 */
export interface PermissionsRealm {
  /** The realm's `Permissions` constructor, for the WebIDL `this` brand check. */
  Permissions: (new () => object) | undefined;
  /** The realm's unbound native `query`, captured BEFORE the override is installed. */
  nativeQueryUnbound:
    ((this: unknown, descriptor?: PermissionDescriptor) => Promise<PermissionStatus>) | undefined;
  /** The realm's original `query`, bound to its `navigator.permissions`. */
  boundQuery: (descriptor: PermissionDescriptor) => Promise<PermissionStatus>;
  /** The realm's `PermissionStatus` constructor, for a prototype-correct spoofed status. */
  PermissionStatusCtor: { prototype: object } | undefined;
}

/**
 * Build the `Permissions.prototype.query` override for a given realm — the
 * single source of truth used by both the top-level installer and
 * `patchIframeWindow`.
 *
 *  - WebIDL brand check: a foreign `this` is delegated to the realm's unbound
 *    native `query` so it rejects genuinely, with our injected frames scrubbed
 *    from the (possibly cross-realm) rejection stack.
 *  - `geolocation` → spoofed "granted" when spoofing is on and preserve-prompt
 *    is off; otherwise the genuine state (preserve-prompt) via the original.
 *  - Defers until settings arrive; all other permissions pass through.
 */
export function buildPermissionsQueryOverride(
  realm: PermissionsRealm
): (this: unknown, descriptor: PermissionDescriptor) => Promise<PermissionStatus> {
  const spoofedOrGenuine = (
    descriptor: PermissionDescriptor
  ): Promise<PermissionStatus> | PermissionStatus =>
    spoofingEnabled && !preserveGeolocationPrompt
      ? createSpoofedPermissionStatus(realm.PermissionStatusCtor)
      : realm.boundQuery(descriptor);

  return function permissionsQueryOverride(
    this: unknown,
    descriptor: PermissionDescriptor
  ): Promise<PermissionStatus> {
    // Brand check: `query` is a Promise-returning WebIDL op, so a foreign `this`
    // REJECTS (not throws). Delegate to the realm's unbound native query for a
    // genuine rejection, then scrub our injected frames from its stack (the
    // rejection may be a cross-realm Error, so the scrub is duck-typed).
    if (realm.nativeQueryUnbound && realm.Permissions && !(this instanceof realm.Permissions)) {
      let result: Promise<PermissionStatus>;
      try {
        result = realm.nativeQueryUnbound.call(this, descriptor);
      } catch (err) {
        stripExtensionFramesFromStack(err);
        throw err;
      }
      return result.catch((err: unknown) => {
        stripExtensionFramesFromStack(err);
        throw err;
      });
    }
    try {
      if (descriptor?.name === "geolocation") {
        logger.debug("permissions.query: intercepted geolocation check", {
          spoofingEnabled,
          settingsReceived,
          preserveGeolocationPrompt,
        });
        if (settingsReceived) {
          return Promise.resolve(spoofedOrGenuine(descriptor));
        }
        // Settings not yet received — defer so we don't answer before we know
        // whether spoofing (and preserve-prompt) is on.
        return waitForSettings().then(() => spoofedOrGenuine(descriptor));
      }
      return realm.boundQuery(descriptor);
    } catch (error) {
      logger.error("Error in permissions.query override:", error);
      return realm.boundQuery(descriptor);
    }
  };
}

/**
 * Install the `Permissions.prototype.query` override.
 *
 * When spoofing is enabled and the queried permission is "geolocation",
 * returns a spoofed PermissionStatus with state "granted". Falls back
 * to the original API for all other permission types or when spoofing
 * is disabled. No-ops gracefully if `navigator.permissions.query` is
 * unavailable.
 *
 * Installed on `Permissions.prototype` — not on `navigator.permissions`
 * — so `Object.getOwnPropertyDescriptor(navigator.permissions, "query")`
 * correctly returns `undefined` (the method is inherited), and the
 * prototype descriptor matches the WebIDL-specified native shape.
 *
 * `installOverride` reads the target's existing descriptor and preserves
 * its flags, so we automatically match the native shape without
 * hardcoding it here.
 */
export function installPermissionsOverride(): void {
  if (!originalPermissionsQuery) {
    logger.warn("navigator.permissions.query not available, skipping override");
    return;
  }
  if (typeof Permissions === "undefined" || !Permissions.prototype) {
    logger.warn("Permissions interface not exposed, skipping override");
    return;
  }

  const override = buildPermissionsQueryOverride({
    Permissions,
    nativeQueryUnbound: nativePermissionsQuery as PermissionsRealm["nativeQueryUnbound"],
    boundQuery: originalPermissionsQuery,
    PermissionStatusCtor: typeof PermissionStatus !== "undefined" ? PermissionStatus : undefined,
  });

  installOverride(Permissions.prototype, "query", override, 1);
}
