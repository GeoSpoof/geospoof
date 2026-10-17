/**
 * Session Cache — typed async key-value cache backed by browser.storage.session.
 * Survives background script suspension; cleared on browser restart.
 */

import { createLogger } from "@/shared/utils/debug-logger";

const logger = createLogger("BG");

/** Storage key prefix to namespace all cache entries */
const PREFIX = "cache:";

/**
 * Read a single cached value.
 * Returns undefined if the key is missing or storage.session is unavailable.
 */
export async function sessionGet<T>(key: string): Promise<T | undefined> {
  try {
    const storageKey = PREFIX + key;
    const result = await browser.storage.session.get(storageKey);
    return result[storageKey] as T | undefined;
  } catch {
    return undefined;
  }
}

/** Result of {@link sessionRead}: a failed read is distinguishable from a missing key. */
export type SessionReadResult<T> = { ok: true; value: T | undefined } | { ok: false };

/**
 * Read a single cached value, reporting whether the read itself succeeded.
 * Unlike {@link sessionGet}, a rejected read (or a missing `storage.session`)
 * returns `{ ok: false }` instead of looking like an absent key, so callers can
 * avoid minting-and-writing over a value they merely failed to read. Doesn't
 * log; callers decide.
 */
export async function sessionRead<T>(key: string): Promise<SessionReadResult<T>> {
  try {
    const storageKey = PREFIX + key;
    const result = await browser.storage.session.get(storageKey);
    return { ok: true, value: result[storageKey] as T | undefined };
  } catch {
    return { ok: false };
  }
}

/**
 * Write a single cached value.
 * Logs a warning on failure but never throws.
 */
export async function sessionSet<T>(key: string, value: T): Promise<void> {
  try {
    await browser.storage.session.set({ [PREFIX + key]: value });
  } catch (error) {
    logger.warn("session-cache: write failed for key", key, error);
  }
}

/**
 * Delete a single cached key.
 */
export async function sessionDelete(key: string): Promise<void> {
  try {
    await browser.storage.session.remove(PREFIX + key);
  } catch (error) {
    logger.warn("session-cache: delete failed for key", key, error);
  }
}

/**
 * Read all cache entries under a namespace prefix.
 * Returns a Record<string, T> mapping unprefixed keys to values,
 * or an empty object on failure.
 */
export async function sessionGetAll<T>(namespace: string): Promise<Record<string, T>> {
  try {
    const all = await browser.storage.session.get(null);
    const fullPrefix = PREFIX + namespace + ":";
    const result: Record<string, T> = {};
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(fullPrefix)) {
        result[key.slice(fullPrefix.length)] = value as T;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Clear all entries under a namespace prefix.
 */
export async function sessionClearNamespace(namespace: string): Promise<void> {
  try {
    const all = await browser.storage.session.get(null);
    const fullPrefix = PREFIX + namespace + ":";
    const keysToRemove = Object.keys(all).filter((k) => k.startsWith(fullPrefix));
    if (keysToRemove.length > 0) {
      await browser.storage.session.remove(keysToRemove);
    }
  } catch (error) {
    logger.warn("session-cache: clearNamespace failed for", namespace, error);
  }
}
