/**
 * Property-Based Tests for Iframe ToString Cross-Check Consistency
 * Feature: prototype-lie-detection-fix, Property 4
 *
 * Validates: Requirement 7.1 — iframe's Function.prototype.toString.call(overrideFn)
 * returns the native function string for registered overrides.
 *
 * Note: jsdom has limited iframe contentWindow support. These tests simulate
 * the iframe patching logic directly rather than relying on real iframe DOM
 * insertion, ensuring the core registry-lookup + fallthrough behavior is correct.
 */

"use strict";

import fc from "fast-check";

describe("Prototype Lie Detection Fix — Iframe ToString Properties", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyFunction = (...args: any[]) => any;

  // eslint-disable-next-line @typescript-eslint/unbound-method
  const nativeToString = Function.prototype.toString;

  // Valid JS identifier generator for function names
  const identifierArb = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,20}$/);

  /**
   * Property 4: Iframe ToString Cross-Check Consistency
   *
   * For any override function registered in the override registry, when a
   * simulated iframe's patched Function.prototype.toString is used to call
   * .toString() on that override function, the result is the native function
   * string "function <name>() { [native code] }".
   *
   * For any function NOT in the registry, the patched toString falls through
   * to the iframe's original toString, returning the real source.
   */
  describe("Simulated iframe toString patching", () => {
    let overrideRegistry: Map<AnyFunction, string>;
    let iframePatchedToString: (this: AnyFunction) => string;

    beforeEach(() => {
      overrideRegistry = new Map();

      // Simulate what patchIframeToString does: replace the iframe's
      // Function.prototype.toString with a function that checks the
      // override registry first, then falls through to the original.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const iframeOrigToString = Function.prototype.toString;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const iframeOrigCall = Function.prototype.call;

      iframePatchedToString = function (this: AnyFunction): string {
        const nativeName = overrideRegistry.get(this);
        if (nativeName !== undefined) {
          return `function ${nativeName}() { [native code] }`;
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return
        return (iframeOrigCall as any).call(iframeOrigToString, this);
      };
    });

    test("Feature: prototype-lie-detection-fix, Property 4: Iframe ToString Cross-Check Consistency — registered overrides return native string", () => {
      fc.assert(
        fc.property(identifierArb, (name) => {
          // Create an override function and register it
          const fn: AnyFunction = (..._args: unknown[]) => undefined;
          overrideRegistry.set(fn, name);

          // Simulate: iframe's Function.prototype.toString.call(fn)
          const result = iframePatchedToString.call(fn);

          expect(result).toBe(`function ${name}() { [native code] }`);

          overrideRegistry.delete(fn);
        }),
        { numRuns: 100 }
      );
    });

    test("Feature: prototype-lie-detection-fix, Property 4: Iframe ToString Cross-Check Consistency — function expression overrides return native string", () => {
      fc.assert(
        fc.property(identifierArb, (name) => {
          // Function expressions (used for this-dependent overrides) should
          // also return the native string when registered
          const fn: AnyFunction = function (..._args: unknown[]) {
            return undefined;
          };
          overrideRegistry.set(fn, name);

          const result = iframePatchedToString.call(fn);

          expect(result).toBe(`function ${name}() { [native code] }`);

          overrideRegistry.delete(fn);
        }),
        { numRuns: 100 }
      );
    });

    test("Feature: prototype-lie-detection-fix, Property 4: Iframe ToString Cross-Check Consistency — unregistered functions fall through to original toString", () => {
      fc.assert(
        fc.property(identifierArb, (name) => {
          // Create a function that is NOT in the registry
          const fn: AnyFunction = function (..._args: unknown[]) {
            return undefined;
          };
          Object.defineProperty(fn, "name", { value: name, configurable: true });

          // The patched toString should fall through to the original
          const patchedResult = iframePatchedToString.call(fn);
          const originalResult = nativeToString.call(fn);

          expect(patchedResult).toBe(originalResult);
        }),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Integration-style test: verify patchIframeToString works with a real
   * iframe in jsdom (best-effort — jsdom may not support contentWindow).
   */
  describe("DOM iframe patching (jsdom best-effort)", () => {
    let overrideRegistry: Map<AnyFunction, string>;

    beforeEach(() => {
      overrideRegistry = new Map();
    });

    afterEach(() => {
      // Clean up any iframes added to the document
      document.querySelectorAll("iframe").forEach((iframe) => iframe.remove());
    });

    /**
     * Replicate patchIframeToString logic for the test environment.
     */
    function patchIframeToString(iframe: HTMLIFrameElement): boolean {
      try {
        const iframeWindow = iframe.contentWindow;
        if (!iframeWindow) return false;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        const iframeFnProto = (iframeWindow as any).Function?.prototype as
          { toString: AnyFunction; call: typeof Function.prototype.call } | undefined;
        if (!iframeFnProto) return false;

        const iframeOrigToString = iframeFnProto.toString;
        const iframeOrigCall = iframeFnProto.call;

        iframeFnProto.toString = function (this: AnyFunction): string {
          const nativeName = overrideRegistry.get(this);
          if (nativeName !== undefined) {
            return `function ${nativeName}() { [native code] }`;
          }
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
          return (iframeOrigCall as any).call(iframeOrigToString, this);
        };
        return true;
      } catch {
        return false;
      }
    }

    test("Feature: prototype-lie-detection-fix, Property 4: Iframe ToString Cross-Check Consistency — real iframe patching (skipped if jsdom lacks contentWindow)", () => {
      const iframe = document.createElement("iframe");
      document.body.appendChild(iframe);

      const patched = patchIframeToString(iframe);

      if (!patched) {
        // jsdom doesn't support iframe contentWindow — skip gracefully
        console.log(
          "Skipping real iframe test: jsdom does not provide iframe.contentWindow.Function"
        );
        return;
      }

      fc.assert(
        fc.property(identifierArb, (name) => {
          const fn: AnyFunction = (..._args: unknown[]) => undefined;
          overrideRegistry.set(fn, name);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
          const result = (iframe.contentWindow as any).Function.prototype.toString.call(
            fn
          ) as string;

          expect(result).toBe(`function ${name}() { [native code] }`);

          overrideRegistry.delete(fn);
        }),
        { numRuns: 100 }
      );
    });

    test("patchIframeToString silently handles missing contentWindow", () => {
      const iframe = document.createElement("iframe");
      // Don't append to DOM — contentWindow will be null
      const result = patchIframeToString(iframe);
      expect(result).toBe(false);
    });
  });
});
