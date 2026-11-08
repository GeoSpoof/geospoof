/**
 * Popup site groups: what the popup knows about site groups and lists from a
 * link, and the display strings for every Filters entry kind.
 *
 * `loadPopupSiteGroups` asks the background (GET_SITE_GROUPS) for every stored
 * token's summary and framed strings. It asks only where site groups are
 * available and the settings reference a token, so a popup with no tokens
 * sends nothing extra. The reply drives the rows ("Google", "Site group · 964 sites"), the
 * status line, and `popupSiteGroupLookup()`, which the popup's resolver calls
 * pass so they agree with the background.
 *
 * The catalog index (every list's name and count) loads only when the picker
 * opens (GET_SITE_GROUP_INDEX), once per popup session.
 */

import type { Settings } from "@/shared/types/settings";
import type {
  SiteGroupErrorCode,
  SiteGroupIndexResponse,
  SiteGroupsResponse,
  SiteGroupsStatus,
  SiteGroupSummary,
} from "@/shared/types/messages";
import { siteGroupsAvailable } from "@/shared/site-groups/availability";
import { FEATURED_SITE_GROUPS, type FeaturedSiteGroup } from "@/shared/site-groups/featured";
import { MAX_LIST_ENTRIES } from "@/shared/site-groups/list-formats";
import {
  createSiteGroupLookup,
  NO_SITE_GROUPS,
  type SiteGroupData,
  type SiteGroupLookup,
} from "@/shared/site-groups/matcher";
import {
  GROUP_PREFIX,
  isSiteGroupToken,
  linkDisplayName,
  parseGroupToken,
} from "@/shared/site-groups/tokens";
import { classifyFilterEntry } from "@/shared/utils/filter-entries";
import { t, uiLocale } from "./i18n";

type StoredGroup = SiteGroupsResponse["groups"][string];

/** The last GET_SITE_GROUPS reply, parsed. Empty until one arrives. */
let groups: Readonly<Record<string, StoredGroup>> = {};
let status: SiteGroupsStatus | null = null;
let lookup: SiteGroupLookup = NO_SITE_GROUPS;
/** Only the newest request's reply is applied. */
let requestSeq = 0;
/** The memoized GET_SITE_GROUP_INDEX reply; a failed load is retried next time. */
let indexReply: Promise<SiteGroupIndexResponse | null> | null = null;
/** Each catalog list's count from the loaded index, or null until it loads. */
let indexCounts: ReadonlyMap<string, number> | null = null;

// ── Loading ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** True when the allowlist, the denylist or any site location holds a group or link token. */
export function referencesSiteGroupToken(settings: Settings): boolean {
  const lists: unknown[] = [settings.allowlist, settings.denylist];
  if (Array.isArray(settings.siteLocations)) {
    for (const entry of settings.siteLocations) lists.push(entry?.patterns);
  }
  return lists.some(
    (list) => Array.isArray(list) && list.some((p) => typeof p === "string" && isSiteGroupToken(p))
  );
}

function parseStatus(raw: unknown): SiteGroupsStatus | null {
  if (!isRecord(raw)) return null;
  const { release, releasedAt, checkedAt, lastError, updating } = raw;
  if (!isNullableString(release) || !isNullableString(releasedAt)) return null;
  if (!(checkedAt === null || isCount(checkedAt))) return null;
  if (!(lastError === null || lastError === "NETWORK" || lastError === "INVALID")) return null;
  if (typeof updating !== "boolean") return null;
  return { release, releasedAt, checkedAt, lastError, updating };
}

function parseGroup(token: string, raw: unknown): StoredGroup | null {
  if (!isRecord(raw) || !isSiteGroupToken(token)) return null;
  const { kind, name, count, skipped, updatedAt, d, f, missingUpstream, lastError } = raw;
  if (kind !== "group" && kind !== "link") return null;
  if (typeof name !== "string" || typeof d !== "string" || typeof f !== "string") return null;
  if (!isCount(count) || !isCount(skipped) || !isCount(updatedAt)) return null;
  const group: StoredGroup = { token, kind, name, count, skipped, updatedAt, d, f };
  if (missingUpstream === true) group.missingUpstream = true;
  if (
    lastError === "LINK_FAILED" ||
    lastError === "LINK_EMPTY" ||
    lastError === "LINK_TOO_LARGE" ||
    lastError === null
  ) {
    group.lastError = lastError;
  }
  return group;
}

/**
 * Parse a GET_SITE_GROUPS reply defensively. Anything not shaped like a
 * `SiteGroupsResponse`, or one with `available: false`, counts as empty; a
 * single malformed group is dropped.
 */
function parseSiteGroupsReply(raw: unknown): {
  status: SiteGroupsStatus | null;
  groups: Record<string, StoredGroup>;
} {
  const empty = { status: null, groups: {} };
  if (!isRecord(raw) || raw.available !== true || !isRecord(raw.groups)) return empty;
  const parsedStatus = parseStatus(raw.status);
  if (parsedStatus === null) return empty;
  const parsedGroups: Record<string, StoredGroup> = {};
  for (const [token, value] of Object.entries(raw.groups)) {
    const group = parseGroup(token, value);
    if (group !== null) parsedGroups[token] = group;
  }
  return { status: parsedStatus, groups: parsedGroups };
}

function applyReply(reply: {
  status: SiteGroupsStatus | null;
  groups: Record<string, StoredGroup>;
}) {
  groups = reply.groups;
  status = reply.status;
  const data: Record<string, SiteGroupData> = {};
  for (const [token, group] of Object.entries(groups)) {
    data[token] = { d: group.d, f: group.f, n: group.count };
  }
  lookup = Object.keys(data).length > 0 ? createSiteGroupLookup(data) : NO_SITE_GROUPS;
}

/**
 * Refresh the popup's site group state for `settings`. Returns null (and
 * clears the state) without sending anything when site groups are unavailable
 * or no token is referenced; otherwise a promise that never rejects.
 */
export function loadPopupSiteGroups(settings: Settings): Promise<void> | null {
  const seq = ++requestSeq;
  if (!siteGroupsAvailable() || !referencesSiteGroupToken(settings)) {
    applyReply({ status: null, groups: {} });
    return null;
  }
  return (async () => {
    let raw: unknown = null;
    try {
      raw = await browser.runtime.sendMessage({ type: "GET_SITE_GROUPS" });
    } catch (error: unknown) {
      console.error("Failed to load site groups:", error);
    }
    if (seq === requestSeq) applyReply(parseSiteGroupsReply(raw));
  })();
}

/** Group membership for the popup's resolver calls, from the last reply. */
export function popupSiteGroupLookup(): SiteGroupLookup {
  return lookup;
}

/** Every stored token's summary, from the last reply. */
export function siteGroupSummaries(): Readonly<Record<string, SiteGroupSummary>> {
  return groups;
}

/** The catalog and refresh state from the last reply, or null. */
export function siteGroupsStatus(): SiteGroupsStatus | null {
  return status;
}

/**
 * "Update now": a manual refresh. `ok` is false when the refresh failed or the
 * message did; `status` is the background's state after it, when it sent one.
 */
export async function requestSiteGroupUpdate(): Promise<{
  ok: boolean;
  status: SiteGroupsStatus | null;
}> {
  try {
    const reply: unknown = await browser.runtime.sendMessage({ type: "UPDATE_SITE_GROUPS" });
    if (!isRecord(reply)) return { ok: false, status: null };
    return { ok: reply.success === true, status: parseStatus(reply.status) };
  } catch (error: unknown) {
    console.error("Failed to update site groups:", error);
    return { ok: false, status: null };
  }
}

// ── The catalog index and search ───────────────────────────────────────────

/** One catalog list, as the picker shows and searches it. */
export interface SiteGroupIndexItem {
  /** The catalog list name (`google`). */
  name: string;
  /** Usable entries. */
  count: number;
  /** The featured label in the UI language, else the name. */
  label: string;
  /** Extra search terms (featured groups only). */
  aliases: readonly string[];
  /** Position in `FEATURED_SITE_GROUPS`, or null when not featured. */
  featured: number | null;
}

/** English labels for the featured groups whose names come from locale keys. */
const FEATURED_LABEL_FALLBACKS: Readonly<Record<string, string>> = {
  siteGroups_nameAi: "AI services",
  siteGroups_nameChina: "China sites",
  siteGroups_nameOutsideChina: "Sites outside China",
};

const FEATURED_BY_NAME = new Map<string, { group: FeaturedSiteGroup; rank: number }>(
  FEATURED_SITE_GROUPS.map((group, rank) => [group.name, { group, rank }])
);

function featuredLabel(group: FeaturedSiteGroup): string {
  if (group.label !== undefined) return group.label;
  if (group.labelKey !== undefined) {
    return t(group.labelKey) || FEATURED_LABEL_FALLBACKS[group.labelKey] || group.name;
  }
  return group.name;
}

/** What a catalog list is called in the popup: its featured label, else its name. */
export function siteGroupLabel(name: string): string {
  const featured = FEATURED_BY_NAME.get(name);
  return featured ? featuredLabel(featured.group) : name;
}

function parseIndexReply(raw: unknown): SiteGroupIndexResponse | null {
  if (!isRecord(raw) || !isNullableString(raw.release) || !Array.isArray(raw.lists)) return null;
  const lists: SiteGroupIndexResponse["lists"] = [];
  for (const item of raw.lists as unknown[]) {
    if (!isRecord(item) || typeof item.name !== "string" || !isCount(item.count)) return null;
    lists.push({ name: item.name, count: item.count });
  }
  return lists.length > 0 ? { release: raw.release, lists } : null;
}

async function requestIndex(): Promise<SiteGroupIndexResponse | null> {
  try {
    return parseIndexReply(await browser.runtime.sendMessage({ type: "GET_SITE_GROUP_INDEX" }));
  } catch (error: unknown) {
    console.error("Failed to load the site group list:", error);
    return null;
  }
}

/**
 * Every catalog list, with the featured labels and aliases merged in. Loaded
 * once and memoized; empty when unavailable or when the load failed (retried
 * on the next call).
 */
export async function loadCatalogIndex(): Promise<SiteGroupIndexItem[]> {
  if (!siteGroupsAvailable()) return [];
  indexReply ??= requestIndex();
  const reply = await indexReply;
  if (reply === null) {
    indexReply = null;
    return [];
  }
  indexCounts ??= new Map(reply.lists.map(({ name, count }) => [name, count]));
  return reply.lists.map(({ name, count }) => {
    const featured = FEATURED_BY_NAME.get(name);
    return {
      name,
      count,
      label: featured ? featuredLabel(featured.group) : name,
      aliases: featured?.group.aliases ?? [],
      featured: featured ? featured.rank : null,
    };
  });
}

/** A catalog list's entry count, or null when the index hasn't loaded or lacks it. */
export function catalogIndexCount(name: string): number | null {
  return indexCounts?.get(name) ?? null;
}

/** Most results a typed search shows. */
export const MAX_SEARCH_RESULTS = 50;

/** The search term in a picker query: lowercase, without `geosite:` or any `@attr`. */
function searchTerm(query: string): string {
  let q = query.trim().toLowerCase();
  if (q.startsWith(GROUP_PREFIX)) q = q.slice(GROUP_PREFIX.length);
  const at = q.indexOf("@");
  return (at === -1 ? q : q.slice(0, at)).trim();
}

/** 0 for a prefix match on the name, label or an alias; 1 for a substring match; null for none. */
function matchTier(item: SiteGroupIndexItem, q: string): 0 | 1 | null {
  const fields = [item.name, item.label.toLowerCase(), ...item.aliases];
  if (fields.some((field) => field.startsWith(q))) return 0;
  if (fields.some((field) => field.includes(q))) return 1;
  return null;
}

function byName(a: SiteGroupIndexItem, b: SiteGroupIndexItem): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function byFeaturedRank(a: SiteGroupIndexItem, b: SiteGroupIndexItem): number {
  return (a.featured ?? Infinity) - (b.featured ?? Infinity);
}

/**
 * Search the index for the picker. An empty query gives the featured groups
 * in table order under `popular` and every other list, alphabetical, under
 * `all`. Otherwise prefix matches on the name, label or an alias come first,
 * then substring matches (featured first, then by name within each), capped at
 * {@link MAX_SEARCH_RESULTS} and split into the two sections. Pure.
 */
export function searchSiteGroups(
  index: readonly SiteGroupIndexItem[],
  query: string
): { popular: SiteGroupIndexItem[]; all: SiteGroupIndexItem[] } {
  const q = searchTerm(query);
  if (q === "") {
    return {
      popular: index.filter((item) => item.featured !== null).sort(byFeaturedRank),
      all: index.filter((item) => item.featured === null).sort(byName),
    };
  }
  const ranked: { item: SiteGroupIndexItem; tier: 0 | 1 }[] = [];
  for (const item of index) {
    const tier = matchTier(item, q);
    if (tier !== null) ranked.push({ item, tier });
  }
  ranked.sort(
    (a, b) => a.tier - b.tier || byFeaturedRank(a.item, b.item) || byName(a.item, b.item)
  );
  const top = ranked.slice(0, MAX_SEARCH_RESULTS).map(({ item }) => item);
  return {
    popular: top.filter((item) => item.featured !== null),
    all: top.filter((item) => item.featured === null),
  };
}

// ── Display strings ────────────────────────────────────────────────────────

/** A count in the popup's UI language ("110,197"). */
export function formatCount(n: number): string {
  try {
    return new Intl.NumberFormat(uiLocale() || undefined).format(n);
  } catch {
    return String(n);
  }
}

/** A catalog release date in the popup's UI language, medium style ("Nov 4, 2026"). */
export function formatCatalogDate(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(uiLocale() || undefined, { dateStyle: "medium" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** "964 sites", or "1 site" (WebExtension i18n has no plural forms). */
export function siteCountText(n: number): string {
  if (n === 1) return t("siteGroups_countOne") || "1 site";
  const count = formatCount(n);
  return t("siteGroups_count", [count]) || `${count} sites`;
}

function skippedText(n: number): string {
  if (n === 1) return t("siteGroups_skippedOne") || "1 rule skipped";
  const count = formatCount(n);
  return t("siteGroups_skipped", [count]) || `${count} rules skipped`;
}

/** A site group's meta line: "Site group · 964 sites" (H-5). */
function groupMetaText(count: number): string {
  return `${t("filters_typeGroup") || "Site group"} · ${siteCountText(count)}`;
}

/** A picker option: "Google · 964 sites". */
export function siteGroupOptionText(item: SiteGroupIndexItem): string {
  return `${item.label} · ${siteCountText(item.count)}`;
}

/** How a stored entry shows in a row or chip. */
export interface EntryDisplay {
  /** The main text: the pattern, the address, the group's label, or the list's name. */
  title: string;
  /** A muted second line ("Site group · 964 sites"), or null for typed patterns. */
  meta: string | null;
  /** Full text for the tooltip (the token, or the list's URL). */
  tooltip: string;
  /** The meta is a problem ("Not available"); shown with a warning sign, not color alone. */
  warning: boolean;
  kind: "typed" | "exact" | "group" | "link";
}

function unavailable(title: string, tooltip: string, kind: "group" | "link"): EntryDisplay {
  return {
    title,
    meta: t("siteGroups_unavailable") || "Not available",
    tooltip,
    warning: true,
    kind,
  };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Describe a canonical entry for a row or chip:
 *   - typed: the pattern as stored, no meta;
 *   - exact: the address without `=`, meta "Exact address only";
 *   - group: the featured label or the name, plus " @attr" per attr, meta
 *     "Site group · 964 sites" (no skipped count: built-in skips aren't
 *     actionable);
 *   - link: the list's derived name, meta "110,197 sites · from host" (plus
 *     skipped), or "Couldn't update this list" when its last refresh failed;
 *     the tooltip is the URL.
 * A group or link with no data shows "Not available" as a warning, unless
 * it's `unsaved` (a chip added in the per-site editor, whose data Save
 * builds): then an untagged group shows its catalog count when the index has
 * loaded, and a tagged group or a link shows no meta.
 */
export function describeEntry(
  canonical: string,
  { unsaved = false }: { unsaved?: boolean } = {}
): EntryDisplay {
  const entry = classifyFilterEntry(canonical);
  if (entry === null || entry.type === "pattern") {
    return { title: canonical, meta: null, tooltip: canonical, warning: false, kind: "typed" };
  }
  if (entry.type === "exact") {
    return {
      title: entry.pattern,
      meta: t("filters_typeExact") || "Exact address only",
      tooltip: canonical,
      warning: false,
      kind: "exact",
    };
  }

  const summary = Object.hasOwn(groups, canonical) ? groups[canonical] : undefined;
  if (entry.type === "group") {
    const title = [siteGroupLabel(entry.name), ...entry.attrs.map((attr) => `@${attr}`)].join(" ");
    if (summary === undefined && unsaved) {
      // The index counts the whole list, so it's exact only without tags.
      const count = entry.attrs.length === 0 ? catalogIndexCount(entry.name) : null;
      const meta = count === null ? null : groupMetaText(count);
      return { title, meta, tooltip: canonical, warning: false, kind: "group" };
    }
    if (summary === undefined) return unavailable(title, canonical, "group");
    // No skipped count here: a built-in group's skipped rules (v2fly's few
    // regexp entries) aren't something the user chose or can act on. A list
    // from a link keeps its count, because the user picked that source.
    return {
      title,
      meta: groupMetaText(summary.count),
      tooltip: canonical,
      warning: false,
      kind: "group",
    };
  }

  const title = linkDisplayName(entry.url);
  if (summary === undefined && unsaved) {
    return { title, meta: null, tooltip: entry.url, warning: false, kind: "link" };
  }
  if (summary === undefined) return unavailable(title, entry.url, "link");
  if (summary.lastError !== undefined && summary.lastError !== null) {
    return {
      title,
      meta: t("siteGroups_linkFailed") || "Couldn't update this list",
      tooltip: entry.url,
      warning: true,
      kind: "link",
    };
  }
  const host = hostnameOf(entry.url);
  const meta = [siteCountText(summary.count), t("siteGroups_fromHost", [host]) || `from ${host}`];
  if (summary.skipped > 0) meta.push(skippedText(summary.skipped));
  return { title, meta: meta.join(" · "), tooltip: entry.url, warning: false, kind: "link" };
}

/** What an add or save error calls a token: a group's label, or a list's name. */
function tokenName(token: string): string {
  const group = parseGroupToken(token);
  if (group !== null) return siteGroupLabel(group.name);
  return token.startsWith(GROUP_PREFIX) ? token.slice(GROUP_PREFIX.length) : linkDisplayName(token);
}

const SITE_GROUP_ERROR_CODES: ReadonlySet<string> = new Set<SiteGroupErrorCode>([
  "UNKNOWN_GROUP",
  "EMPTY_GROUP",
  "LINK_FAILED",
  "LINK_EMPTY",
  "LINK_TOO_LARGE",
  "STORAGE_FULL",
]);

export function isSiteGroupErrorCode(code: unknown): code is SiteGroupErrorCode {
  return typeof code === "string" && SITE_GROUP_ERROR_CODES.has(code);
}

/** The message for a site group add or save error about `token`. */
export function siteGroupErrorText(code: SiteGroupErrorCode, token: string | undefined): string {
  const name = token === undefined ? "" : tokenName(token);
  switch (code) {
    case "UNKNOWN_GROUP":
      return t("siteGroups_errorUnknown", [name]) || `No site group is called ${name}.`;
    case "EMPTY_GROUP":
      return t("siteGroups_errorEmpty", [name]) || `${name} has no sites with that tag.`;
    case "LINK_FAILED":
      return (
        t("siteGroups_errorLinkFailed") ||
        "Couldn't download that list. Check the link and try again."
      );
    case "LINK_EMPTY":
      return t("siteGroups_errorLinkEmpty") || "That list has no sites GeoSpoof can use.";
    case "LINK_TOO_LARGE": {
      const max = formatCount(MAX_LIST_ENTRIES);
      return (
        t("siteGroups_errorLinkTooLarge", [max]) ||
        `That list is too large. GeoSpoof supports up to ${max} sites per list.`
      );
    }
    case "STORAGE_FULL":
      return (
        t("siteGroups_errorStorageFull") ||
        "Site groups are out of space. Remove a large list first."
      );
  }
}

/**
 * The announcement after a list from a link is added: "Added direct-list:
 * 110,197 sites." The counts are the row's own strings, so one site or one
 * skipped rule reads in the singular.
 */
export function linkAddedText(token: string, added: { count: number; skipped: number }): string {
  const name = linkDisplayName(token);
  const sites = siteCountText(added.count);
  if (added.skipped > 0) {
    const skipped = skippedText(added.skipped);
    return (
      t("siteGroups_addedLinkSkipped", [name, sites, skipped]) ||
      `Added ${name}: ${sites}, ${skipped}.`
    );
  }
  return t("siteGroups_addedLink", [name, sites]) || `Added ${name}: ${sites}.`;
}

/** Test hook: forget the replies and the memoized index. */
export function __resetPopupSiteGroupsForTest(): void {
  applyReply({ status: null, groups: {} });
  requestSeq = 0;
  indexReply = null;
  indexCounts = null;
}
