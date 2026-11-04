/**
 * The background's copy of site group data, and the one place that reads and
 * writes `storage.local.siteGroupData`.
 *
 * `siteGroupData` holds `{ v: 1, groups: { [token]: StoredSiteGroup } }`, one
 * entry per referenced `geosite:` or `list:` token. Each entry's `d`/`f` are
 * `"\n"`-framed strings (see `matcher.ts`), so waking with the data costs one
 * storage read and no parse. The domain lists stay out of `settings`; only the
 * short tokens live there.
 *
 * `loadSettings()` calls `ensureSiteGroupCache` before it returns whenever the
 * settings reference a token, so every resolver call that follows can pass
 * `currentSiteGroups()` synchronously. A token whose data is absent matches
 * nothing (plan decision 5).
 *
 * Imports only shared modules: `bootstrap-register.ts` and `page-payload.ts`
 * import this module, and their closure must never reach the settings,
 * messages, tabs, app-bridge, index or site-location-queue modules
 * (tests/unit/background/queue-dependencies.test.ts).
 */

import type { Settings } from "@/shared/types/settings";
import {
  createSiteGroupLookup,
  NO_SITE_GROUPS,
  type SiteGroupLookup,
} from "@/shared/site-groups/matcher";
import { isSiteGroupToken, LINK_PREFIX } from "@/shared/site-groups/tokens";
import { createLogger } from "@/shared/utils/debug-logger";

const logger = createLogger("BG");

/** The `storage.local` key of the group data. */
export const SITE_GROUP_DATA_KEY = "siteGroupData";

/** Why a link's last refresh failed; the last good copy stays in use. */
export type LinkRefreshError = "LINK_FAILED" | "LINK_EMPTY" | "LINK_TOO_LARGE";

/** One token's stored data. */
export interface StoredSiteGroup {
  /** `"\n"`-framed `domain` entries. */
  d: string;
  /** `"\n"`-framed `full` entries. */
  f: string;
  /** Unique usable entries (domains plus fulls). */
  n: number;
  /** Rules that were read but not used (regexp, keyword, other). */
  skipped: number;
  source: "catalog" | "link";
  /** Catalog tokens: the catalog release the data was built from. */
  release?: string;
  /** Link tokens: when the list was last downloaded successfully (ms). */
  fetchedAt?: number;
  /** Link tokens: the last refresh's failure, or null when it succeeded. */
  lastError?: LinkRefreshError | null;
  /** Catalog tokens: a newer catalog lacks this list or leaves it empty. */
  missingUpstream?: boolean;
  /** When this data was built (ms). */
  materializedAt: number;
}

const LINK_ERRORS = new Set<string>(["LINK_FAILED", "LINK_EMPTY", "LINK_TOO_LARGE"]);

function isFramed(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.startsWith("\n") && value.endsWith("\n")
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** One stored entry, repaired, or null when it's unusable. */
function validateStoredSiteGroup(token: string, raw: unknown): StoredSiteGroup | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (!isFramed(e.d) || !isFramed(e.f) || !isCount(e.n)) return null;
  const derivedSource = token.startsWith(LINK_PREFIX) ? "link" : "catalog";
  const group: StoredSiteGroup = {
    d: e.d,
    f: e.f,
    n: e.n,
    skipped: isCount(e.skipped) ? e.skipped : 0,
    source: e.source === "catalog" || e.source === "link" ? e.source : derivedSource,
    materializedAt: isCount(e.materializedAt) ? e.materializedAt : 0,
  };
  if (typeof e.release === "string") group.release = e.release;
  if (isCount(e.fetchedAt)) group.fetchedAt = e.fetchedAt;
  if (e.lastError === null || (typeof e.lastError === "string" && LINK_ERRORS.has(e.lastError))) {
    group.lastError = e.lastError as LinkRefreshError | null;
  }
  if (e.missingUpstream === true) group.missingUpstream = true;
  return group;
}

/**
 * Validate a stored `siteGroupData` value into its `groups` map. Anything that
 * isn't `{ v: 1, groups: {...} }` gives `{}`; an entry whose key isn't a token,
 * whose `d`/`f` aren't framed strings, or whose `n` isn't a finite count is
 * dropped. Optional fields are repaired.
 */
export function validateStoredSiteGroupData(raw: unknown): Record<string, StoredSiteGroup> {
  const out: Record<string, StoredSiteGroup> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const value = raw as { v?: unknown; groups?: unknown };
  if (value.v !== 1) return out;
  const groups = value.groups;
  if (typeof groups !== "object" || groups === null || Array.isArray(groups)) return out;
  for (const [token, entry] of Object.entries(groups as Record<string, unknown>)) {
    if (!isSiteGroupToken(token)) continue;
    const group = validateStoredSiteGroup(token, entry);
    if (group !== null) out[token] = group;
  }
  return out;
}

/**
 * Every `geosite:`/`list:` token the settings reference, deduped in first-seen
 * order: the allowlist, the denylist, then every stored site location's
 * patterns (the stored list, not the Pro-gated effective one, so a locked
 * entry keeps its data).
 */
export function referencedSiteGroupTokens(
  settings: Pick<Settings, "allowlist" | "denylist" | "siteLocations">
): string[] {
  const seen = new Set<string>();
  const add = (entry: unknown): void => {
    if (typeof entry === "string" && isSiteGroupToken(entry)) seen.add(entry);
  };
  for (const entry of settings.allowlist ?? []) add(entry);
  for (const entry of settings.denylist ?? []) add(entry);
  for (const location of settings.siteLocations ?? []) {
    for (const pattern of location?.patterns ?? []) add(pattern);
  }
  return [...seen];
}

let cache: Record<string, StoredSiteGroup> | null = null;
let cacheVersion = 0;
let memo: { version: number; lookup: SiteGroupLookup } | null = null;
let loading: Promise<Readonly<Record<string, StoredSiteGroup>>> | null = null;
const loadedListeners = new Set<() => void>();

function setCache(groups: Record<string, StoredSiteGroup>): void {
  cache = groups;
  cacheVersion += 1;
}

/**
 * True once the cache holds what storage has: a read or a write filled it.
 * False means `currentSiteGroupData()` is `{}` because nothing could be read
 * yet, not because no group has data.
 */
export function siteGroupCacheLoaded(): boolean {
  return cache !== null;
}

/**
 * Call `listener` each time a storage read fills a cache that wasn't loaded,
 * for example the first successful read after an earlier one failed. Writes
 * don't call it: they run in write windows, which register for themselves.
 * Lets `bootstrap-register.ts` redo a registration it had to skip without
 * this module importing it.
 */
export function onSiteGroupCacheLoaded(listener: () => void): void {
  loadedListeners.add(listener);
}

function notifyLoaded(): void {
  for (const listener of loadedListeners) {
    try {
      listener();
    } catch (error) {
      logger.warn("A site group data listener failed:", error);
    }
  }
}

/**
 * Load the cache from storage if it isn't loaded yet, whatever the settings
 * reference, and resolve it. Concurrent calls share one read. Rejects when the
 * read fails (the cache stays unloaded, so the next call retries); writers use
 * this so a failed read can't make them overwrite the stored data with `{}`.
 */
export function loadSiteGroupCache(): Promise<Readonly<Record<string, StoredSiteGroup>>> {
  if (cache !== null) return Promise.resolve(cache);
  if (loading !== null) return loading;
  const run = (async () => {
    try {
      const result = (await browser.storage.local.get(SITE_GROUP_DATA_KEY)) as Record<
        string,
        unknown
      >;
      // A write that landed while the read was in flight is newer: keep it.
      const filled = cache === null;
      const loaded = cache ?? validateStoredSiteGroupData(result?.[SITE_GROUP_DATA_KEY]);
      if (filled) {
        setCache(loaded);
        notifyLoaded();
      }
      return loaded;
    } finally {
      loading = null;
    }
  })();
  loading = run;
  return run;
}

/**
 * Load the cache before resolvers run, when `settings` reference a token and
 * it isn't loaded. One storage read; the promise never rejects (a failed read
 * leaves every token matching nothing until the next load retries).
 *
 * Null when there is nothing to load, so `loadSettings` adds no await (and no
 * microtask turns) for the settings that use no site group, which is nearly
 * all of them: `if (loading) await loading`.
 */
export function ensureSiteGroupCache(
  settings: Pick<Settings, "allowlist" | "denylist" | "siteLocations">
): Promise<void> | null {
  if (cache !== null) return null;
  if (referencedSiteGroupTokens(settings).length === 0) return null;
  return loadSiteGroupCache().then(
    () => undefined,
    (error: unknown) => logger.warn("Couldn't read site group data:", error)
  );
}

/**
 * The lookup every background resolver passes for group entries. Synchronous:
 * it reads the in-memory cache, which `loadSettings()` has loaded. Memoized
 * until the cache changes, so its lazily built `Set`s are reused.
 */
export function currentSiteGroups(): SiteGroupLookup {
  if (cache === null) return NO_SITE_GROUPS;
  if (memo === null || memo.version !== cacheVersion) {
    memo = { version: cacheVersion, lookup: createSiteGroupLookup(cache) };
  }
  return memo.lookup;
}

/** The cached group data by token, or `{}` when it isn't loaded. Treat as read-only. */
export function currentSiteGroupData(): Readonly<Record<string, StoredSiteGroup>> {
  return cache ?? {};
}

function isQuotaError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("QuotaExceededError") ||
    msg.includes("Exceeded storage quota") ||
    msg.includes("quota")
  );
}

/**
 * Store `groups` as the whole group data and make it the cache. A quota-looking
 * rejection is retried once as remove-then-set (the Safari shrink bug that
 * `saveSettings` works around too). Rejects when the write fails; the cache is
 * unchanged then.
 */
export async function writeSiteGroupData(groups: Record<string, StoredSiteGroup>): Promise<void> {
  const value = { [SITE_GROUP_DATA_KEY]: { v: 1, groups } };
  try {
    await browser.storage.local.set(value);
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    logger.warn("Site group data write hit a quota error, retrying via remove+set");
    await browser.storage.local.remove(SITE_GROUP_DATA_KEY);
    await browser.storage.local.set(value);
  }
  setCache(groups);
}

/** Forget the cache. Tests only. */
export function __resetSiteGroupStoreForTest(): void {
  cache = null;
  cacheVersion += 1;
  memo = null;
  loading = null;
}
