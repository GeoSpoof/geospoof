/**
 * Settings revision rule, shared by the background (issuing, the worker-filter
 * and Accept-Language caches, the Firefox bootstrap) and the content script
 * (dropping deliveries built from older settings), so the rule exists once.
 * No imports: the content script and the bootstrap queue both import it.
 */

/** The largest revision. `nextSettingsRevision` saturates here instead of overflowing. */
export const MAX_SETTINGS_REVISION = Number.MAX_SAFE_INTEGER;

/**
 * A usable revision: an integer with 0 ≤ v ≤ MAX_SETTINGS_REVISION. Anything
 * else (absent, NaN, Infinity, 2 ** 53, 1.5, "5") is "no revision".
 */
export function readRevision(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_SETTINGS_REVISION
    ? value
    : undefined;
}

/** True only when both are known and `revision < newest`. Equal or unknown is never older. */
export function isOlderRevision(revision: number | undefined, newest: number | undefined): boolean {
  return revision !== undefined && newest !== undefined && revision < newest;
}
