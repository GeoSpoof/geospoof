/**
 * Site groups in the background: the catalog, building each token's data,
 * downloading lists from links, the weekly refresh, and pruning.
 *
 * Data flow:
 *   - The bundled catalog (`dist/site-groups/catalog.json`, fetched from the
 *     extension package, never imported into a bundle) makes the first add of
 *     any group work offline. A newer catalog downloaded from the CDN is kept
 *     in `storage.local.siteGroupCatalog`; the newer of the two is used.
 *   - Adding a `geosite:` or `list:` entry builds that token's data first
 *     (`withSiteGroupData`): from the catalog, or by downloading the link. The
 *     data is stored before the settings write, so the entry never exists
 *     without its data. Nothing is stored when the build fails.
 *   - The weekly refresh (`refreshSiteGroups`) downloads a small pointer and,
 *     when it names a newer release, the whole catalog, checked against the
 *     pointer's sha256. One file for everyone means no request reveals which
 *     groups a user picked. Links are downloaded again. A list that went
 *     missing upstream, or a link that failed, keeps its last good copy.
 *   - No request is made unless some token is referenced (or the user presses
 *     "Update now").
 *
 * Queues: the site-group queue (`runSiteGroupJob`) serializes every read,
 * merge and write of the group data. Lock order is site-location queue, then
 * site-group queue, then settings queue, never the reverse: a site-group job
 * may read settings (`loadSettings` never waits on a queue) but never waits on
 * the site-location or settings queue, and network requests run outside every
 * queue. Tokens being added are "pending" until their settings write settles,
 * so a prune can't drop their data in between.
 *
 * Every entry point is a no-op where site groups aren't available (Safari,
 * until geospoof-ios supports the new entry forms): no alarm, no request.
 *
 * Never imports `messages.ts` (it imports this module).
 */

import type { Settings } from "@/shared/types/settings";
import type {
  SiteGroupErrorCode,
  SiteGroupIndexResponse,
  SiteGroupsResponse,
  SiteGroupsStatus,
  SiteGroupsUpdateResponse,
  SiteGroupSummary,
} from "@/shared/types/messages";
import { siteGroupsAvailable } from "@/shared/site-groups/availability";
import {
  buildCatalogGroupData,
  catalogIndex,
  isNewerRelease,
  validateCatalog,
  type SiteGroupCatalog,
  type SiteGroupIndexEntry,
} from "@/shared/site-groups/catalog";
import { parseDomainList } from "@/shared/site-groups/list-formats";
import { frameEntries } from "@/shared/site-groups/matcher";
import {
  GROUP_PREFIX,
  LINK_PREFIX,
  isSiteGroupToken,
  linkDisplayName,
  parseGroupToken,
  parseLinkToken,
} from "@/shared/site-groups/tokens";
import { createLogger } from "@/shared/utils/debug-logger";
import { loadSettings } from "./settings";
import { broadcastSettingsToTabs } from "./tabs";
import { updateBadge } from "./badge";
import { syncDebuggerSpoofing } from "./debugger-spoof";
import { updateBootstrapRegistration } from "./bootstrap-register";
import {
  currentSiteGroupData,
  loadSiteGroupCache,
  referencedSiteGroupTokens,
  writeSiteGroupData,
  type LinkRefreshError,
  type StoredSiteGroup,
} from "./site-groups-store";

const logger = createLogger("BG");

/** `storage.local` key of the last good CDN catalog. */
export const SITE_GROUP_CATALOG_KEY = "siteGroupCatalog";
/** `storage.local` key of `{ checkedAt, lastError }`. */
export const SITE_GROUP_STATUS_KEY = "siteGroupStatus";
/** The weekly refresh alarm. */
export const SITE_GROUPS_REFRESH_ALARM = "site-groups-refresh";
/** The release pointer. Fetched with `cache: "no-cache"`. */
export const SITE_GROUPS_POINTER_URL = "https://cdn.geospoof.com/site-groups/v1/latest.json";
/** Where a pointer's `path` is resolved. */
const CDN_ORIGIN = "https://cdn.geospoof.com/";
/** The bundled catalog, relative to the extension root. */
export const BUNDLED_CATALOG_PATH = "site-groups/catalog.json";

/** Timeout for every download (pointer, catalog, link), body included. */
export const FETCH_TIMEOUT_MS = 30_000;
/** Largest list downloaded from a link. */
export const MAX_LINK_BYTES = 10 * 1024 * 1024;
/** Largest catalog download. */
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
/** Largest pointer download. */
const MAX_POINTER_BYTES = 64 * 1024;
/** Cap on the stored group data: the sum of every kept token's `d.length + f.length`. */
export const MAX_SITE_GROUP_CHARS = 5_000_000;
/** The refresh period: one week. */
export const SITE_GROUPS_REFRESH_PERIOD_MINUTES = 10_080;
/** Random spread added to the first refresh, so installs don't all ask at once. */
const REFRESH_JITTER_MINUTES = 360;

const RELEASE_PATTERN = /^\d{14}$/;
const POINTER_PATH_PATTERN = /^site-groups\/v1\/catalog-\d{14}\.json$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** A refresh's failure: the CDN couldn't be reached, or it served something invalid. */
type RefreshError = "NETWORK" | "INVALID";

/** The release pointer (`site-groups/v1/latest.json`), as validated. */
interface CatalogPointer {
  format: 1;
  release: string;
  path: string;
  sha256: string;
  bytes: number;
}

/** A downloaded list's entries and counts. */
interface LinkListData {
  d: string;
  f: string;
  n: number;
  skipped: number;
}

/** What downloading a list from a link gave. */
export type LinkListResult =
  { ok: true; data: LinkListData } | { ok: false; error: LinkRefreshError; skipped?: number };

/** Usable entries and skipped rules per token. */
export type SiteGroupCounts = Record<string, { count: number; skipped: number }>;

/** What `withSiteGroupData` gave. */
export type WithSiteGroupDataResult<T> =
  | { ok: true; value: T; added: SiteGroupCounts }
  | {
      ok: false;
      error: SiteGroupErrorCode | "STORAGE_ERROR";
      token?: string;
      skipped?: number;
    };

// ── Queue and pending tokens ─────────────────────────────────────────────────

let queue: Promise<unknown> = Promise.resolve();

/**
 * Run `job` after every site-group job queued before it. A failed job doesn't
 * wedge the queue. `job` may read settings but must not wait on the
 * site-location or settings queue.
 */
export function runSiteGroupJob<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job);
  queue = run.catch(() => undefined);
  return run;
}

/** Tokens being added, with how many adds hold each. Kept by every prune. */
const pendingTokens = new Map<string, number>();

function markPending(token: string): void {
  pendingTokens.set(token, (pendingTokens.get(token) ?? 0) + 1);
}

function unmarkPending(token: string): void {
  const n = (pendingTokens.get(token) ?? 0) - 1;
  if (n > 0) pendingTokens.set(token, n);
  else pendingTokens.delete(token);
}

/** The tokens whose data a write must keep: referenced by `settings`, or pending. */
function keptTokens(settings: Settings): Set<string> {
  return new Set([...referencedSiteGroupTokens(settings), ...pendingTokens.keys()]);
}

// ── Downloads ────────────────────────────────────────────────────────────────

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Read a response body, or null once it passes `cap` bytes (the read is cancelled). */
async function readCapped(
  response: Response,
  cap: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  const body = response.body;
  if (body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > cap ? null : bytes;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

type FetchBytesResult =
  { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; reason: "NETWORK" | "TOO_LARGE" };

/**
 * Download `url` with no credentials, following redirects, within
 * FETCH_TIMEOUT_MS (body included). NETWORK when the request fails, times
 * out, isn't `ok`, or ends on a non-https URL; TOO_LARGE when the declared or
 * actual size passes `cap`.
 */
async function fetchBytes(
  url: string,
  cache: RequestCache,
  cap: number
): Promise<FetchBytesResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: "omit",
      cache,
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok || !isHttpsUrl(response.url)) {
      controller.abort();
      return { ok: false, reason: "NETWORK" };
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > cap) {
      controller.abort();
      return { ok: false, reason: "TOO_LARGE" };
    }
    const bytes = await readCapped(response, cap);
    return bytes === null ? { ok: false, reason: "TOO_LARGE" } : { ok: true, bytes };
  } catch (error) {
    logger.debug("Site group download failed:", url, error);
    return { ok: false, reason: "NETWORK" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download and parse a list from a link (plan decision 3): https only, no
 * credentials, 30 s, at most 10 MB and 250,000 entries, redirects must stay on
 * https. LINK_FAILED for a failed download, LINK_TOO_LARGE past a cap,
 * LINK_EMPTY when nothing usable is left (with the skipped count).
 */
export async function fetchLinkList(url: string): Promise<LinkListResult> {
  if (!isHttpsUrl(url)) return { ok: false, error: "LINK_FAILED" };
  const download = await fetchBytes(url, "no-cache", MAX_LINK_BYTES);
  if (!download.ok) {
    return { ok: false, error: download.reason === "TOO_LARGE" ? "LINK_TOO_LARGE" : "LINK_FAILED" };
  }
  const parsed = parseDomainList(new TextDecoder("utf-8").decode(download.bytes));
  if ("error" in parsed) return { ok: false, error: "LINK_TOO_LARGE" };
  const skipped = parsed.skipped.regexp + parsed.skipped.keyword + parsed.skipped.other;
  const n = parsed.domains.length + parsed.fulls.length;
  if (n === 0) return { ok: false, error: "LINK_EMPTY", skipped };
  return {
    ok: true,
    data: { d: frameEntries(parsed.domains), f: frameEntries(parsed.fulls), n, skipped },
  };
}

// ── Catalogs ─────────────────────────────────────────────────────────────────

let bundledCatalog: Promise<SiteGroupCatalog | null> | null = null;
let storedCatalog: { catalog: SiteGroupCatalog | null } | null = null;

/**
 * The catalog shipped in the package, validated. Memoized; a failed load is
 * retried on the next call.
 */
export function loadBundledCatalog(): Promise<SiteGroupCatalog | null> {
  bundledCatalog ??= (async () => {
    try {
      const response = await fetch(browser.runtime.getURL(BUNDLED_CATALOG_PATH));
      if (!response.ok) throw new Error(`status ${response.status}`);
      const catalog = validateCatalog(await response.json());
      if (catalog === null) throw new Error("the bundled catalog is invalid");
      return catalog;
    } catch (error) {
      logger.error("Couldn't load the bundled site group catalog:", error);
      bundledCatalog = null;
      return null;
    }
  })();
  return bundledCatalog;
}

/** The last good CDN catalog from `storage.local`, validated, or null. Memoized. */
export async function loadStoredCatalog(): Promise<SiteGroupCatalog | null> {
  if (storedCatalog !== null) return storedCatalog.catalog;
  try {
    const result = (await browser.storage.local.get(SITE_GROUP_CATALOG_KEY)) as Record<
      string,
      unknown
    >;
    // A download stored while the read was in flight is newer: keep it.
    storedCatalog ??= { catalog: validateCatalog(result?.[SITE_GROUP_CATALOG_KEY]) };
    return storedCatalog.catalog;
  } catch (error) {
    logger.warn("Couldn't read the stored site group catalog:", error);
    return null;
  }
}

/** The catalog in use: the newer release of the bundled and the stored one. */
export async function currentCatalog(): Promise<SiteGroupCatalog | null> {
  const [bundled, stored] = await Promise.all([loadBundledCatalog(), loadStoredCatalog()]);
  if (stored !== null && (bundled === null || isNewerRelease(stored.release, bundled.release))) {
    return stored;
  }
  return bundled ?? stored;
}

async function storeCatalog(catalog: SiteGroupCatalog): Promise<void> {
  storedCatalog = { catalog };
  try {
    await browser.storage.local.set({ [SITE_GROUP_CATALOG_KEY]: catalog });
  } catch (error) {
    // Still used for this session; the next refresh downloads it again.
    logger.warn("Couldn't store the downloaded site group catalog:", error);
  }
}

function validatePointer(raw: unknown): CatalogPointer | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { format, release, path, sha256, bytes } = raw as Record<string, unknown>;
  if (
    format !== 1 ||
    typeof release !== "string" ||
    !RELEASE_PATTERN.test(release) ||
    typeof path !== "string" ||
    !POINTER_PATH_PATTERN.test(path) ||
    path !== `site-groups/v1/catalog-${release}.json` ||
    typeof sha256 !== "string" ||
    !SHA256_PATTERN.test(sha256) ||
    typeof bytes !== "number" ||
    !Number.isInteger(bytes) ||
    bytes <= 0 ||
    bytes > MAX_CATALOG_BYTES
  ) {
    return null;
  }
  return { format: 1, release, path, sha256, bytes };
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchPointer(): Promise<
  { ok: true; pointer: CatalogPointer } | { ok: false; error: RefreshError }
> {
  const download = await fetchBytes(SITE_GROUPS_POINTER_URL, "no-cache", MAX_POINTER_BYTES);
  if (!download.ok)
    return { ok: false, error: download.reason === "NETWORK" ? "NETWORK" : "INVALID" };
  let pointer: CatalogPointer | null;
  try {
    pointer = validatePointer(parseJson(download.bytes));
  } catch {
    pointer = null;
  }
  return pointer === null ? { ok: false, error: "INVALID" } : { ok: true, pointer };
}

/** Download the catalog a pointer names, checked against its sha256, then validated strictly. */
async function downloadCatalog(
  pointer: CatalogPointer
): Promise<{ ok: true; catalog: SiteGroupCatalog } | { ok: false; error: RefreshError }> {
  const download = await fetchBytes(`${CDN_ORIGIN}${pointer.path}`, "default", MAX_CATALOG_BYTES);
  if (!download.ok)
    return { ok: false, error: download.reason === "NETWORK" ? "NETWORK" : "INVALID" };
  if ((await sha256Hex(download.bytes)) !== pointer.sha256) {
    logger.warn("The downloaded site group catalog doesn't match its pointer's sha256");
    return { ok: false, error: "INVALID" };
  }
  let catalog: SiteGroupCatalog | null;
  try {
    catalog = validateCatalog(parseJson(download.bytes));
  } catch {
    catalog = null;
  }
  if (catalog === null || catalog.release !== pointer.release)
    return { ok: false, error: "INVALID" };
  return { ok: true, catalog };
}

// ── Status ───────────────────────────────────────────────────────────────────

interface StoredStatus {
  checkedAt: number | null;
  lastError: RefreshError | null;
}

const UNAVAILABLE_STATUS: SiteGroupsStatus = {
  release: null,
  releasedAt: null,
  checkedAt: null,
  lastError: null,
  updating: false,
};

async function readStatus(): Promise<StoredStatus> {
  try {
    const result = (await browser.storage.local.get(SITE_GROUP_STATUS_KEY)) as Record<
      string,
      unknown
    >;
    const raw = result?.[SITE_GROUP_STATUS_KEY] as Record<string, unknown> | undefined;
    const checkedAt = raw?.checkedAt;
    const lastError = raw?.lastError;
    return {
      checkedAt: typeof checkedAt === "number" && Number.isFinite(checkedAt) ? checkedAt : null,
      lastError: lastError === "NETWORK" || lastError === "INVALID" ? lastError : null,
    };
  } catch {
    return { checkedAt: null, lastError: null };
  }
}

async function writeStatus(status: StoredStatus): Promise<void> {
  try {
    await browser.storage.local.set({ [SITE_GROUP_STATUS_KEY]: status });
  } catch (error) {
    logger.warn("Couldn't store the site group refresh status:", error);
  }
}

async function statusSnapshot(updating: boolean): Promise<SiteGroupsStatus> {
  const [catalog, status] = await Promise.all([currentCatalog(), readStatus()]);
  return {
    release: catalog?.release ?? null,
    releasedAt: catalog?.releasedAt ?? null,
    checkedAt: status.checkedAt,
    lastError: status.lastError,
    updating,
  };
}

// ── Building and storing token data ──────────────────────────────────────────

type Materialized =
  { ok: true; group: StoredSiteGroup } | { ok: false; error: SiteGroupErrorCode; skipped?: number };

/** Build one token's data: from the catalog, or by downloading the link. */
async function materializeToken(token: string): Promise<Materialized> {
  if (token.startsWith(LINK_PREFIX)) {
    const link = parseLinkToken(token);
    if (link === null) return { ok: false, error: "LINK_FAILED" };
    const result = await fetchLinkList(link.url);
    if (!result.ok) {
      return result.skipped === undefined
        ? { ok: false, error: result.error }
        : { ok: false, error: result.error, skipped: result.skipped };
    }
    const now = Date.now();
    return {
      ok: true,
      group: {
        ...result.data,
        source: "link",
        fetchedAt: now,
        lastError: null,
        materializedAt: now,
      },
    };
  }
  const catalog = await currentCatalog();
  if (catalog === null) return { ok: false, error: "UNKNOWN_GROUP" };
  const built = buildCatalogGroupData(catalog, token);
  if (!built.ok) return { ok: false, error: built.error };
  return {
    ok: true,
    group: {
      ...built.data,
      source: "catalog",
      release: catalog.release,
      materializedAt: Date.now(),
    },
  };
}

/**
 * Make sure every token in `tokens` has stored data, then run `write` (the
 * settings write that adds them).
 *
 * Tokens without data are built first, outside every queue (links download
 * here). Then, in the site-group queue, the new data is merged into the stored
 * data, keeping only referenced and pending tokens, and stored, unless the
 * kept data would pass MAX_SITE_GROUP_CHARS (STORAGE_FULL). Only then does
 * `write` run, after the job, so the lock order holds. The tokens stay pending
 * until `write` settles. A failure writes nothing and `write` doesn't run.
 *
 * `added` holds the counts of every requested token that has data. Rejects
 * only when `write` does. Where site groups aren't available, nothing is built
 * and `write` runs as is (the handlers reject the new forms first).
 */
export async function withSiteGroupData<T>(
  tokens: readonly string[],
  write: () => Promise<T>
): Promise<WithSiteGroupDataResult<T>> {
  const wanted = [...new Set(tokens.filter(isSiteGroupToken))];
  if (wanted.length === 0 || !siteGroupsAvailable()) {
    return { ok: true, value: await write(), added: {} };
  }

  for (const token of wanted) markPending(token);
  let builtAny = false;
  try {
    let existing: Readonly<Record<string, StoredSiteGroup>>;
    try {
      existing = await loadSiteGroupCache();
    } catch (error) {
      logger.warn("Couldn't read site group data before an add:", error);
      return { ok: false, error: "STORAGE_ERROR" };
    }

    const fresh: Record<string, StoredSiteGroup> = {};
    for (const token of wanted) {
      if (Object.hasOwn(existing, token)) continue;
      const built = await materializeToken(token);
      if (!built.ok) {
        return built.skipped === undefined
          ? { ok: false, error: built.error, token }
          : { ok: false, error: built.error, token, skipped: built.skipped };
      }
      fresh[token] = built.group;
    }

    const freshTokens = Object.keys(fresh);
    if (freshTokens.length > 0) {
      const failure = await runSiteGroupJob(
        async (): Promise<"STORAGE_FULL" | "STORAGE_ERROR" | null> => {
          const data = currentSiteGroupData();
          const keep = keptTokens(await loadSettings());
          const next: Record<string, StoredSiteGroup> = {};
          let total = 0;
          for (const token of keep) {
            // Data an overlapping add or refresh stored meanwhile wins.
            const group = Object.hasOwn(data, token) ? data[token] : fresh[token];
            if (group === undefined) continue;
            next[token] = group;
            total += group.d.length + group.f.length;
          }
          if (total > MAX_SITE_GROUP_CHARS) return "STORAGE_FULL";
          try {
            await writeSiteGroupData(next);
          } catch (error) {
            logger.warn("Couldn't store site group data:", error);
            return "STORAGE_ERROR";
          }
          return null;
        }
      );
      if (failure !== null) return { ok: false, error: failure, token: freshTokens[0] };
      builtAny = true;
    }

    const value = await write();
    const data = currentSiteGroupData();
    const added: SiteGroupCounts = {};
    for (const token of wanted) {
      if (Object.hasOwn(data, token)) {
        added[token] = { count: data[token].n, skipped: data[token].skipped };
      }
    }
    return { ok: true, value, added };
  } finally {
    for (const token of wanted) unmarkPending(token);
    if (builtAny) {
      // A write that stored nothing (a duplicate, a late conflict, a failed
      // save) leaves the new data unreferenced; this drops it. And the first
      // group of a session needs the weekly refresh.
      void pruneSiteGroupDataSoon();
      void ensureSiteGroupRefreshAlarm();
    }
  }
}

function sameStrings(a: StoredSiteGroup, b: StoredSiteGroup): boolean {
  return a.d === b.d && a.f === b.f;
}

function sameGroup(a: StoredSiteGroup, b: StoredSiteGroup): boolean {
  return (
    sameStrings(a, b) &&
    a.n === b.n &&
    a.skipped === b.skipped &&
    a.source === b.source &&
    a.release === b.release &&
    a.fetchedAt === b.fetchedAt &&
    a.lastError === b.lastError &&
    a.missingUpstream === b.missingUpstream &&
    a.materializedAt === b.materializedAt
  );
}

/** One kept token's data after a rebuild, or undefined when it has none. */
function rebuildToken(
  token: string,
  old: StoredSiteGroup | undefined,
  catalog: SiteGroupCatalog | null,
  link: LinkListResult | undefined,
  now: number
): StoredSiteGroup | undefined {
  if (token.startsWith(LINK_PREFIX)) {
    if (link === undefined) return old;
    if (link.ok) {
      return { ...link.data, source: "link", fetchedAt: now, lastError: null, materializedAt: now };
    }
    // The last good copy stays in use.
    return old === undefined ? undefined : { ...old, lastError: link.error };
  }
  if (!token.startsWith(GROUP_PREFIX) || catalog === null) return old;
  // Built from this release (or a newer one): nothing to do.
  if (old?.release !== undefined && !isNewerRelease(catalog.release, old.release)) return old;
  const built = buildCatalogGroupData(catalog, token);
  if (built.ok) {
    return { ...built.data, source: "catalog", release: catalog.release, materializedAt: now };
  }
  // Gone or empty upstream: the last good copy stays in use, flagged.
  return old === undefined ? undefined : { ...old, missingUpstream: true };
}

/**
 * In the site-group queue: rebuild every kept token's data from the catalog
 * in use and the given link downloads, drop tokens that are neither
 * referenced nor pending, and store the result when it differs. Resolves true
 * when some kept token's entries changed (pages must be told), false
 * otherwise.
 */
async function reconcileSiteGroupData(
  links: ReadonlyMap<string, LinkListResult>
): Promise<boolean> {
  const catalog = await currentCatalog();
  return runSiteGroupJob(async () => {
    const data = await loadSiteGroupCache();
    const keep = keptTokens(await loadSettings());
    const now = Date.now();
    const next: Record<string, StoredSiteGroup> = {};
    for (const token of keep) {
      const old = Object.hasOwn(data, token) ? data[token] : undefined;
      const group = rebuildToken(token, old, catalog, links.get(token), now);
      if (group !== undefined) next[token] = group;
    }

    const oldTokens = Object.keys(data);
    const newTokens = Object.keys(next);
    let stored = oldTokens.length !== newTokens.length;
    let entries = false;
    for (const token of newTokens) {
      const old = Object.hasOwn(data, token) ? data[token] : undefined;
      if (old === undefined) {
        stored = true;
        entries = true;
      } else if (!sameGroup(old, next[token])) {
        stored = true;
        if (!sameStrings(old, next[token])) entries = true;
      }
    }
    if (stored) await writeSiteGroupData(next);
    return entries;
  });
}

/** In the site-group queue: drop data no kept token uses. Resolves whether it wrote. */
function pruneSiteGroupData(): Promise<boolean> {
  return runSiteGroupJob(async () => {
    const data = await loadSiteGroupCache();
    const keep = keptTokens(await loadSettings());
    const next: Record<string, StoredSiteGroup> = {};
    for (const token of Object.keys(data)) {
      if (keep.has(token)) next[token] = data[token];
    }
    if (Object.keys(next).length === Object.keys(data).length) return false;
    await writeSiteGroupData(next);
    return true;
  });
}

/**
 * Tell every surface that group data changed: tabs, badges, the Firefox head
 * start and Engine-level spoofing. A failed step is logged and the rest run.
 */
async function deliverSiteGroupChange(): Promise<void> {
  const settings = await loadSettings();
  const steps: Array<[string, () => Promise<void>]> = [
    ["broadcast", () => broadcastSettingsToTabs(settings)],
    ["badge", () => updateBadge()],
    ["bootstrap", () => updateBootstrapRegistration(settings)],
    ["engine-level sync", () => syncDebuggerSpoofing(settings)],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      logger.error(`Site group data changed, but its ${name} failed:`, error);
    }
  }
}

/**
 * Drop stored data that no entry references and no add holds. Fire-and-forget
 * (after a remove); never rejects.
 */
export function pruneSiteGroupDataSoon(): Promise<void> {
  if (!siteGroupsAvailable()) return Promise.resolve();
  return pruneSiteGroupData().then(
    () => undefined,
    (error: unknown) => logger.warn("Site group prune failed:", error)
  );
}

async function repairSiteGroupData(): Promise<void> {
  const settings = await loadSettings();
  const tokens = referencedSiteGroupTokens(settings);
  if (tokens.length === 0 && Object.keys(currentSiteGroupData()).length === 0) return;
  const data = await loadSiteGroupCache();
  const links = new Map<string, LinkListResult>();
  for (const token of tokens) {
    if (!token.startsWith(LINK_PREFIX) || Object.hasOwn(data, token)) continue;
    const link = parseLinkToken(token);
    if (link !== null) links.set(token, await fetchLinkList(link.url));
  }
  if (await reconcileSiteGroupData(links)) await deliverSiteGroupChange();
}

/**
 * Build data for referenced tokens that have none (a bridged entry, cleared
 * storage) or were built from an older catalog, drop unreferenced data, and
 * deliver when entries changed. Links without data are downloaded. Runs after
 * startup and after the Safari bridge adopts lists; never rejects.
 */
export function repairSiteGroupDataSoon(): Promise<void> {
  if (!siteGroupsAvailable()) return Promise.resolve();
  return repairSiteGroupData().catch((error: unknown) =>
    logger.warn("Site group repair failed:", error)
  );
}

// ── Refresh ──────────────────────────────────────────────────────────────────

let refreshing: Promise<SiteGroupsUpdateResponse> | null = null;

async function clearRefreshAlarm(): Promise<void> {
  try {
    await browser.alarms.clear(SITE_GROUPS_REFRESH_ALARM);
  } catch {
    // No alarm.
  }
}

async function runRefresh(manual: boolean): Promise<SiteGroupsUpdateResponse> {
  try {
    const tokens = referencedSiteGroupTokens(await loadSettings());
    if (tokens.length === 0 && !manual) {
      // Nothing uses site groups: no request. Drop leftovers and the alarm.
      await pruneSiteGroupDataSoon();
      await clearRefreshAlarm();
      return { success: true, status: await statusSnapshot(false) };
    }

    // 1–2. The pointer, then the catalog when the pointer is newer.
    let lastError: RefreshError | null = null;
    const pointer = await fetchPointer();
    if (!pointer.ok) {
      lastError = pointer.error;
    } else if (isNewerRelease(pointer.pointer.release, (await currentCatalog())?.release)) {
      const download = await downloadCatalog(pointer.pointer);
      if (download.ok) await storeCatalog(download.catalog);
      else lastError = download.error;
    }

    // 4. Links, outside the queue.
    const links = new Map<string, LinkListResult>();
    for (const token of tokens) {
      const link = token.startsWith(LINK_PREFIX) ? parseLinkToken(token) : null;
      if (link !== null) links.set(token, await fetchLinkList(link.url));
    }

    // 3, 5. Rebuild, keep last good copies, prune, store.
    let changed = false;
    try {
      changed = await reconcileSiteGroupData(links);
    } catch (error) {
      logger.warn("Couldn't store refreshed site group data:", error);
    }

    // 6. Status.
    await writeStatus({ checkedAt: Date.now(), lastError });

    // 7. Deliver.
    if (changed) await deliverSiteGroupChange();

    const status = await statusSnapshot(false);
    return lastError === null ? { success: true, status } : { error: lastError, status };
  } catch (error) {
    logger.error("Site group refresh failed:", error);
    return { error: "NETWORK", status: await statusSnapshot(false) };
  }
}

/**
 * Refresh the catalog and every link (plan item 10). Single-flight: a call
 * while one runs gets that run's result. Without a referenced token, a
 * scheduled (not manual) refresh makes no request. Never rejects.
 */
export function refreshSiteGroups({
  manual,
}: {
  manual: boolean;
}): Promise<SiteGroupsUpdateResponse> {
  if (!siteGroupsAvailable()) {
    return Promise.resolve({ error: "NOT_AVAILABLE", status: UNAVAILABLE_STATUS });
  }
  if (refreshing !== null) return refreshing;
  const run = runRefresh(manual).finally(() => {
    if (refreshing === run) refreshing = null;
  });
  refreshing = run;
  return run;
}

/**
 * Minutes until the next refresh: the time left until a week after
 * `checkedAt` (now when it's unknown), at least 1 and at most a week, plus
 * `random` (in [0, 1)) times 360. Exported for tests.
 */
export function siteGroupRefreshDelayMinutes(
  checkedAt: number | null,
  now: number,
  random: number
): number {
  const due = checkedAt === null ? now : checkedAt + SITE_GROUPS_REFRESH_PERIOD_MINUTES * 60_000;
  const left = Math.min(SITE_GROUPS_REFRESH_PERIOD_MINUTES, Math.max(1, (due - now) / 60_000));
  return left + random * REFRESH_JITTER_MINUTES;
}

/**
 * Create the weekly refresh alarm when some token is referenced and it
 * doesn't exist yet. Never rejects.
 */
export async function ensureSiteGroupRefreshAlarm(settings?: Settings): Promise<void> {
  if (!siteGroupsAvailable()) return;
  try {
    const current = settings ?? (await loadSettings());
    if (referencedSiteGroupTokens(current).length === 0) return;
    if (await browser.alarms.get(SITE_GROUPS_REFRESH_ALARM)) return;
    const { checkedAt } = await readStatus();
    await browser.alarms.create(SITE_GROUPS_REFRESH_ALARM, {
      delayInMinutes: siteGroupRefreshDelayMinutes(checkedAt, Date.now(), Math.random()),
      periodInMinutes: SITE_GROUPS_REFRESH_PERIOD_MINUTES,
    });
  } catch (error) {
    logger.warn("Couldn't schedule the site group refresh:", error);
  }
}

/**
 * Startup: schedule the refresh, then build data for tokens that have none or
 * were built from an older catalog, and deliver when that changed anything.
 * Nothing happens unless some token is referenced. Never rejects.
 */
export async function onSiteGroupsStartup(settings: Settings): Promise<void> {
  if (!siteGroupsAvailable()) return;
  if (referencedSiteGroupTokens(settings).length === 0) return;
  await ensureSiteGroupRefreshAlarm(settings);
  await repairSiteGroupDataSoon();
}

// ── Message handlers ─────────────────────────────────────────────────────────

function summarize(token: string, group: StoredSiteGroup): SiteGroupSummary {
  const isLink = token.startsWith(LINK_PREFIX);
  const summary: SiteGroupSummary = {
    token,
    kind: isLink ? "link" : "group",
    name: isLink
      ? linkDisplayName(token)
      : (parseGroupToken(token)?.name ?? token.slice(GROUP_PREFIX.length)),
    count: group.n,
    skipped: group.skipped,
    updatedAt: group.fetchedAt ?? group.materializedAt,
  };
  if (group.missingUpstream === true) summary.missingUpstream = true;
  if (group.lastError !== undefined) summary.lastError = group.lastError;
  return summary;
}

/** GET_SITE_GROUPS: availability, the refresh status, and every stored token's data. */
export async function handleGetSiteGroups(): Promise<SiteGroupsResponse> {
  if (!siteGroupsAvailable()) return { available: false, status: UNAVAILABLE_STATUS, groups: {} };
  let data: Readonly<Record<string, StoredSiteGroup>> = {};
  try {
    data = await loadSiteGroupCache();
  } catch (error) {
    logger.warn("Couldn't read site group data:", error);
  }
  const groups: SiteGroupsResponse["groups"] = {};
  for (const [token, group] of Object.entries(data)) {
    groups[token] = { ...summarize(token, group), d: group.d, f: group.f };
  }
  return { available: true, status: await statusSnapshot(refreshing !== null), groups };
}

let indexMemo: { release: string; lists: SiteGroupIndexEntry[] } | null = null;

/** GET_SITE_GROUP_INDEX: every catalog list's name and entry count, for the picker. */
export async function handleGetSiteGroupIndex(): Promise<SiteGroupIndexResponse> {
  if (!siteGroupsAvailable()) return { release: null, lists: [] };
  const catalog = await currentCatalog();
  if (catalog === null) return { release: null, lists: [] };
  if (indexMemo?.release !== catalog.release) {
    indexMemo = { release: catalog.release, lists: catalogIndex(catalog) };
  }
  return { release: indexMemo.release, lists: indexMemo.lists };
}

/** UPDATE_SITE_GROUPS ("Update now"): a manual refresh. */
export function handleUpdateSiteGroups(): Promise<SiteGroupsUpdateResponse> {
  return refreshSiteGroups({ manual: true });
}

/** Forget the memoized catalogs, the index and the queue state. Tests only. */
export function __resetSiteGroupsForTest(): void {
  bundledCatalog = null;
  storedCatalog = null;
  indexMemo = null;
  refreshing = null;
  pendingTokens.clear();
  queue = Promise.resolve();
}
