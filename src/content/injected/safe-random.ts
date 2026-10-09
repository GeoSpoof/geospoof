/**
 * Randomness for page-context overrides that the page can't observe.
 *
 * Overrides must not call the page's `Math.random`:
 *   - A page can wrap `Math.random` and watch for calls during an API call
 *     whose native implementation never makes one. That is a detection signal.
 *   - `Math.random` is the page's own PRNG stream. V8 (Chromium), SpiderMonkey
 *     (Firefox) and JavaScriptCore (Safari) all implement it with xorshift128+,
 *     whose state is recoverable from a few outputs, so a value consumed by an
 *     override shows up as a skip in the sequence the page predicts.
 *
 * `crypto.getRandomValues` is standard Web Crypto, available in every engine we
 * ship to, in secure and insecure contexts alike (only `crypto.subtle` requires
 * HTTPS).
 *
 * `crypto.getRandomValues` draws from a separate CSPRNG the page can't predict.
 * It's captured and bound when this module is evaluated, which is before any
 * page script runs (see "Extension initialization race" in index.ts), so a
 * later page patch of `crypto.getRandomValues`, `Function.prototype.bind` or
 * `Uint32Array` never sees our calls. Indexing the pre-allocated typed array
 * goes through no patchable method.
 */

// ArrayBuffer-backed, matching getRandomValues: it rejects SharedArrayBuffer views.
type Fill = (array: Uint32Array<ArrayBuffer>) => Uint32Array<ArrayBuffer>;

function captureFill(): Fill | null {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.getRandomValues === "function") {
      return c.getRandomValues.bind(c);
    }
  } catch {
    // Treated the same as a missing `crypto`; see randomUnit().
  }
  return null;
}

const fill = captureFill();
const buffer = new Uint32Array(2);

/**
 * A uniform float in [0, 1) with 53 bits of entropy, drawn without touching
 * any page-patchable global.
 */
export function randomUnit(): number {
  // getRandomValues ships in every browser we support, so this branch should
  // never run. If it ever does, return the midpoint instead of falling back to
  // Math.random: callers get zero jitter and mid-range delays, which is safe,
  // whereas Math.random would reopen the leak this module exists to close.
  if (fill === null) return 0.5;
  fill(buffer);
  // 27 high bits of the first word and 26 of the second give 53 bits, the full
  // precision of a double in [0, 1). Plain integer arithmetic, so the result is
  // identical in every engine.
  return ((buffer[0] >>> 5) * 2 ** 26 + (buffer[1] >>> 6)) / 2 ** 53;
}
