/**
 * Timezone overrides.
 *
 * Overrides `Date.prototype.getTimezoneOffset` and `Intl.DateTimeFormat`
 * constructor + `resolvedOptions` to return the spoofed timezone when
 * protection is enabled.
 *
 * Exposes the getTimezoneOffset installer in two flavors:
 *   - `installTimezoneOverrides()` — installs everything on the top-level
 *     realm.
 *   - `installGetTimezoneOffsetOverrideOn(proto, original, fractional?)` —
 *     installs just the getTimezoneOffset override on an arbitrary
 *     Date.prototype.
 *   - `installDateTimeFormatOverridesOn(intl, opts)` — installs the
 *     Intl.DateTimeFormat constructor + resolvedOptions overrides on an
 *     arbitrary `Intl` object.
 *
 * The iframe patcher calls both realm-parameterized installers against
 * each same-origin iframe realm, so the top-level and iframe realms
 * share one implementation and cannot drift apart.
 */

import {
  spoofingEnabled,
  timezoneData,
  explicitTimezoneInstances,
  originalGetTimezoneOffset,
  nativeFractionalOffset,
} from "./state";
import {
  registerOverride,
  disguiseAsNative,
  installOverride,
  stripExtensionFramesFromStack,
} from "./function-masking";
import { deriveOffsetFromParts, getIntlBasedOffset } from "./timezone-helpers";
import {
  resolveEffectiveLocales,
  noteInjectedLocale,
  applyReportedLocale,
} from "./locale-overrides";
import { seedFromBootstrap } from "./bootstrap";
import { createLogger } from "@/shared/utils/debug-logger";

const logger = createLogger("INJ");

/**
 * Native `getTimezoneOffset` returns +0 for a zero offset (UTC, London in
 * winter). Negating a zero offset gives -0, which `Object.is` tells apart and
 * which the worker payload doesn't return, so normalize it.
 */
function zeroAsPositive(minutes: number): number {
  return minutes === 0 ? 0 : minutes;
}

/**
 * Install the `getTimezoneOffset` override on the supplied Date.prototype.
 *
 * `originalGetTimezoneOffset` is passed in rather than closed over so the
 * iframe patcher can supply the iframe's own native method for the
 * fallback path, keeping each realm self-contained.
 *
 * `fractional` says whether to keep the seconds of a pre-standard-time
 * offset the way this engine's native method does. It defaults to the
 * decision `state.ts` probed at load; same-origin iframes share it (same
 * engine). Tests pass it explicitly to exercise both behaviors.
 */
export function installGetTimezoneOffsetOverrideOn(
  proto: object,
  originalGetTzOffset: (this: Date) => number,
  fractional: boolean = nativeFractionalOffset
): void {
  try {
    installOverride(proto, "getTimezoneOffset", function (this: Date): number {
      // Close the document_start race for synchronous reads: if the early
      // bootstrap global is present (Firefox) and settings haven't arrived
      // yet, apply it before answering. No-op once seeded / settings received.
      seedFromBootstrap();
      try {
        if (spoofingEnabled && timezoneData) {
          const epoch = this.getTime();
          if (isNaN(epoch)) return originalGetTzOffset.call(this);

          if (!fractional) {
            // V8 before Chrome 156 and JavaScriptCore truncate sub-minute LMT
            // offsets toward zero natively. deriveOffsetFromParts uses
            // formatToParts (whole-second precision), the same wall clock the
            // component getters read; truncating it gives the native value.
            const offsetMinutes = deriveOffsetFromParts(this, timezoneData.identifier);
            if (offsetMinutes !== undefined) {
              const result = zeroAsPositive(Math.trunc(-offsetMinutes));
              logger.trace(
                "getTimezoneOffset (truncated): epoch",
                epoch,
                "rawOffset",
                offsetMinutes,
                "result",
                result
              );
              return result;
            }
          } else {
            // SpiderMonkey and V8 from Chrome 156 keep the fraction natively.
            // getIntlBasedOffset reads the shortOffset string directly (e.g.
            // "GMT-9:59:36") and parses it to the full fractional value, matching
            // what offsetNanoseconds, timeZoneName and the getters see.
            const offsetMinutes = getIntlBasedOffset(
              this,
              timezoneData.identifier,
              timezoneData.offset
            );
            const result = zeroAsPositive(-offsetMinutes);
            logger.trace(
              "getTimezoneOffset (fractional): epoch",
              epoch,
              "rawOffset",
              offsetMinutes,
              "result",
              result
            );
            return result;
          }

          logger.warn("getTimezoneOffset: offset resolution failed, epoch", epoch);
        }
        return originalGetTzOffset.call(this);
      } catch (error) {
        logger.error("Error in getTimezoneOffset override:", error);
        return originalGetTzOffset.call(this);
      }
    });
  } catch (error) {
    logger.error("Failed to override getTimezoneOffset:", error);
  }
}

/**
 * Install timezone-related overrides on the top-level realm:
 * - `Date.prototype.getTimezoneOffset`
 * - `Intl.DateTimeFormat` constructor
 * - `Intl.DateTimeFormat.prototype.resolvedOptions`
 */
/**
 * Install the `Intl.DateTimeFormat` constructor + `resolvedOptions`
 * overrides on the supplied `Intl` object.
 *
 * Realm-parameterized so the top-level realm and every same-origin
 * iframe realm share ONE implementation. The spoof logic, explicit-
 * timezone tracking, and — critically — the error-path stack scrub can
 * no longer drift between realms (which is exactly how the iframe realm
 * previously leaked the extension id on invalid `timeZone`).
 *
 * The native constructor is read from `intl` at install time (before the
 * swap), so each realm captures and falls back to its own native
 * reference.
 *
 * `opts.seed` is an optional per-call hook run at the top of the
 * constructor. The top-level realm passes `seedFromBootstrap` to close
 * the document_start race for the first synchronous
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` read. Iframe realms
 * are patched after bootstrap has already run, so they omit it — keeping
 * this a behavior-preserving extraction of the existing per-realm code.
 */
export function installDateTimeFormatOverridesOn(
  intl: typeof Intl,
  opts?: { seed?: () => void }
): void {
  const seed = opts?.seed;
  // Native constructor for this realm — still native at install time,
  // since this function is what performs the swap.
  const NativeDateTimeFormat = intl.DateTimeFormat;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional: re-bound via .call(this) inside the resolvedOptions override
  const nativeResolvedOptions = NativeDateTimeFormat.prototype.resolvedOptions;

  // Override Intl.DateTimeFormat constructor to inject timezone
  try {
    const DateTimeFormatOverride = function (
      this: Intl.DateTimeFormat | void,
      locales?: string | string[],
      options?: Intl.DateTimeFormatOptions
    ): Intl.DateTimeFormat {
      // Close the document_start race for the most common aggressive probe:
      // `Intl.DateTimeFormat().resolvedOptions().timeZone` read in the page's
      // first script. Seed from the early bootstrap global if present.
      seed?.();

      // Honor new.target so `class X extends Intl.DateTimeFormat {}` and
      // `Reflect.construct` preserve the subclass prototype (native fidelity).
      // For the ordinary `new Intl.DateTimeFormat()` case new.target is this
      // override, whose prototype IS NativeDateTimeFormat.prototype; when called
      // without `new` (Intl.DateTimeFormat() as a function still returns an
      // instance) we fall back to the native constructor as the target.
      const newTarget = (new.target ?? NativeDateTimeFormat) as unknown as new (
        ...a: unknown[]
      ) => object;
      // Locale injection rides in this SAME wrapper rather than in a second one
      // layered by locale-overrides.ts. DateTimeFormat is the one surface where
      // both spoofed axes meet, and resolving them together is what guarantees
      // `resolvedOptions()` reports a coherent {locale, timeZone} pair — and that
      // everything ICU derives from the locale (hourCycle, calendar,
      // numberingSystem, month names) matches the tag we claim. Explicit caller
      // locales always win, exactly like an explicit timeZone.
      const effectiveLocales = resolveEffectiveLocales(locales);
      const build = (opts: Intl.DateTimeFormatOptions | undefined): Intl.DateTimeFormat => {
        const instance = Reflect.construct(
          NativeDateTimeFormat as unknown as new (...a: unknown[]) => object,
          [effectiveLocales, opts],
          newTarget
        ) as Intl.DateTimeFormat;
        // Track the injected tag so `resolvedOptions().locale` reports it
        // verbatim, matching how the other eight Intl constructors now answer.
        // DateTimeFormat truncates for far fewer tags than Collator/PluralRules
        // do, but it does truncate for some (e.g. `ak-GH` -> `ak`), and the whole
        // point is that all nine agree. `buildUnspoofed` deliberately skips this.
        noteInjectedLocale(instance, locales);
        return instance;
      };
      // Error-path twin of `build` that uses the caller's ORIGINAL locales. If a
      // construction fails we must reproduce exactly what the page would have
      // got with no extension present, and that means backing out the injected
      // locale as well as the injected timeZone — otherwise a bad injected tag
      // would make the recovery attempt fail too.
      const buildUnspoofed = (opts: Intl.DateTimeFormatOptions | undefined): Intl.DateTimeFormat =>
        Reflect.construct(
          NativeDateTimeFormat as unknown as new (...a: unknown[]) => object,
          [locales, opts],
          newTarget
        ) as Intl.DateTimeFormat;

      try {
        const hasExplicitTimezone = options?.timeZone != null;
        // Treat explicit timezone matching the spoofed timezone as non-explicit
        // so that resolvedOptions() returns the spoofed identifier consistently
        // for both the no-timezone and explicit-spoofed-timezone paths.
        const matchesSpoofedTz =
          hasExplicitTimezone &&
          spoofingEnabled &&
          timezoneData &&
          options.timeZone!.toLowerCase() === timezoneData.identifier.toLowerCase();

        if (spoofingEnabled && timezoneData && (!hasExplicitTimezone || matchesSpoofedTz)) {
          // Inject spoofed timezone when caller did NOT provide an explicit one,
          // or when the explicit timezone matches the spoofed timezone
          logger.debug(
            "Intl.DateTimeFormat: injecting timezone, original",
            options?.timeZone ?? "(none)",
            "injected",
            timezoneData.identifier
          );
          // Do NOT add to explicitTimezoneInstances — treat as default-timezone instance
          return build({ ...options, timeZone: timezoneData.identifier });
        }

        const instance = build(options);
        if (hasExplicitTimezone) {
          explicitTimezoneInstances.add(instance);
        }
        return instance;
      } catch (error) {
        logger.error("Error in DateTimeFormat constructor override:", error);
        // Fall back to the caller's original arguments — both options AND
        // locales, so nothing we injected can affect the recovery. If those are
        // themselves invalid (e.g. a bad `timeZone`/locale from the page), the
        // native constructor throws a RangeError — correct behaviour, but the
        // error's stack would carry our injected frame. Scrub it so the genuine
        // native error can't be used to read the extension id, then rethrow.
        try {
          return buildUnspoofed(options);
        } catch (err) {
          stripExtensionFramesFromStack(err);
          throw err;
        }
      }
    } as unknown as typeof Intl.DateTimeFormat;

    registerOverride(DateTimeFormatOverride, "DateTimeFormat");
    disguiseAsNative(DateTimeFormatOverride, "DateTimeFormat", 0);
    intl.DateTimeFormat = DateTimeFormatOverride;

    // Copy static properties
    Object.defineProperty(intl.DateTimeFormat, "prototype", {
      value: NativeDateTimeFormat.prototype,
      writable: false,
      configurable: false,
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    intl.DateTimeFormat.supportedLocalesOf = NativeDateTimeFormat.supportedLocalesOf;
  } catch (error) {
    logger.error("Failed to override Intl.DateTimeFormat constructor:", error);
  }

  // Override Intl.DateTimeFormat.prototype.resolvedOptions()
  // Scoped: only inject the spoofed timezone for instances that were NOT created
  // with an explicit timeZone option. This prevents self-interference where
  // getIntlBasedOffset / getLongTimezoneName (which use the native constructor
  // with explicit timeZone) would get corrupted by the spoofed timezone.
  try {
    installOverride(
      intl.DateTimeFormat.prototype,
      "resolvedOptions",
      function (this: Intl.DateTimeFormat): Intl.ResolvedDateTimeFormatOptions {
        try {
          const options = nativeResolvedOptions.call(this);
          // For non-explicit instances the constructor already injected the
          // spoofed timezone, so the native resolvedOptions already returns
          // the engine-normalized identifier (e.g. "Asia/Calcutta" for
          // "Asia/Kolkata"). No need to overwrite — just return as-is.
          //
          // `locale` is the exception and DOES need replaying: an explicitly
          // requested tag goes through BestAvailableLocale, which truncates
          // subtags the default-locale path would have kept. See
          // `injectedLocaleTags` in locale-overrides.ts.
          return applyReportedLocale(this, options);
        } catch (error) {
          logger.error("Error in resolvedOptions override:", error);
          return nativeResolvedOptions.call(this);
        }
      }
    );
  } catch (error) {
    logger.error("Failed to override Intl.DateTimeFormat.resolvedOptions:", error);
  }
}

export function installTimezoneOverrides(): void {
  installGetTimezoneOffsetOverrideOn(Date.prototype, originalGetTimezoneOffset);
  // Top-level realm passes the bootstrap seed hook to close the
  // document_start race; the iframe patcher calls the same installer
  // without it.
  installDateTimeFormatOverridesOn(Intl, { seed: seedFromBootstrap });
}
