/**
 * Ambient type declaration for the `tr46` package (UTS #46 / IDNA).
 *
 * `tr46` (the implementation jsdom/`whatwg-url` use) ships as an untyped
 * CommonJS module — no bundled `.d.ts` and no `@types/tr46`. Under this repo's
 * `strict` + `noImplicitAny` config, importing it without a declaration is a
 * type error, so we declare the small surface GeoSpoof uses here. This is the
 * only place `tr46`'s shape is described; runtime use is wrapped by
 * `src/shared/utils/idn.ts`.
 *
 * Signatures mirror `tr46@7.0.0` (`toASCII` returns `null` on failure).
 */
declare module "tr46" {
  /**
   * UTS #46 processing options. All flags default to `false` in `tr46`. The
   * names and semantics follow Unicode Technical Standard #46 and the WHATWG
   * URL Standard's "domain to ASCII" operation.
   */
  export interface Tr46Options {
    checkHyphens?: boolean;
    checkBidi?: boolean;
    checkJoiners?: boolean;
    useSTD3ASCIIRules?: boolean;
    verifyDNSLength?: boolean;
    transitionalProcessing?: boolean;
    ignoreInvalidPunycode?: boolean;
  }

  /**
   * Convert a Unicode domain name to its ASCII (A-label / Punycode) form.
   * Returns the ASCII string, or `null` when processing fails.
   */
  export function toASCII(domainName: string, options?: Tr46Options): string | null;

  /**
   * Convert a domain name to its Unicode form. `error` is `true` when
   * processing encountered an invalid label.
   */
  export function toUnicode(
    domainName: string,
    options?: Tr46Options
  ): { domain: string; error: boolean };
}
