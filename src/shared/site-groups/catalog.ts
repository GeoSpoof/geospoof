/**
 * The site group catalog: every v2fly/domain-list-community list, converted by
 * `scripts/site-groups/build-catalog.ts`. Bundled at
 * `assets/site-groups/catalog.json` and refreshed from the CDN.
 *
 * Each list's `rules` is one rule per line, `[=]host[@attr]...`: `=` marks a
 * v2fly `full:` rule (that host only), otherwise the line is a `domain:` rule
 * (the host and its subdomains). `regexp:` and `keyword:` rules are dropped by
 * the converter; `skipped` keeps each dropped rule's attrs joined by `@` (`""`
 * when it had none), so a tagged token can report its own skipped count.
 *
 * Pure. `validateCatalog` is the trust boundary for both the bundled file and
 * a CDN download.
 */

import { frameEntries } from "./matcher";
import { parseGroupToken } from "./tokens";

/** One converted list. */
export interface SiteGroupCatalogList {
  /** `"\n"`-separated rule lines, `[=]host[@attr]...`; `""` when the list has none. */
  rules: string;
  /** Attr sets of the dropped regexp/keyword rules, each joined by `@`. */
  skipped: string[];
}

/** The catalog file. */
export interface SiteGroupCatalog {
  format: 1;
  /** Upstream project URL. */
  source: string;
  /** Upstream data license (SPDX id). */
  license: string;
  /** The upstream release tag, 14 digits (`20261104112839`). */
  release: string;
  /** The upstream release's publish time, ISO 8601 UTC. */
  releasedAt: string;
  /** sha256 of the upstream `dlc.dat_plain.yml`, lowercase hex. */
  upstreamSha256: string;
  lists: Record<string, SiteGroupCatalogList>;
}

/** One row of the picker's index. */
export interface SiteGroupIndexEntry {
  name: string;
  /** Unique domain plus full entries with no attr filter. */
  count: number;
}

/** A group's data, built from the catalog for one token. */
export interface CatalogGroupData {
  /** `"\n"`-framed `domain` entries. */
  d: string;
  /** `"\n"`-framed `full` entries. */
  f: string;
  /** Unique domains plus fulls. */
  n: number;
  /** Dropped rules whose attrs include every attr of the token. */
  skipped: number;
}

export type CatalogGroupResult =
  { ok: true; data: CatalogGroupData } | { ok: false; error: "UNKNOWN_GROUP" | "EMPTY_GROUP" };

/** Most lists a catalog may hold. */
const MAX_LISTS = 5_000;
/** Most rule lines across all lists. */
const MAX_TOTAL_LINES = 400_000;
/** Most `skipped` items across all lists. */
const MAX_TOTAL_SKIPPED = 10_000;
/** Longest accepted `source`/`license` string. */
const MAX_META_LENGTH = 512;
/** Longest host in a rule line (DNS total-length cap). */
const MAX_HOST_LENGTH = 253;

const LIST_NAME_PATTERN = /^[a-z0-9!-]{1,64}$/;
const RELEASE_PATTERN = /^\d{14}$/;
const RELEASED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const ATTR = "[a-z0-9!-]{1,32}";
/** A rule line: optional `=`, a host of strict ASCII labels, then `@attr`s. */
const RULE_LINE_PATTERN = new RegExp(`^=?(${LABEL}(?:\\.${LABEL})*)((?:@${ATTR})*)$`);
/** A `skipped` item: `""` or attrs joined by `@`. */
const SKIPPED_PATTERN = new RegExp(`^(?:${ATTR}(?:@${ATTR})*)?$`);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMetaString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_META_LENGTH;
}

/** Split `rules` into lines; `""` has none. */
function ruleLines(rules: string): string[] {
  return rules.length === 0 ? [] : rules.split("\n");
}

/**
 * Validate a parsed catalog, or return null. Strict: any malformed field,
 * list name, rule line or skipped item, or a cap exceeded (5,000 lists,
 * 400,000 rule lines, 10,000 skipped items), rejects the whole file. Returns a
 * copy holding only the known fields.
 */
export function validateCatalog(raw: unknown): SiteGroupCatalog | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const { format, source, license, release, releasedAt, upstreamSha256, lists } = raw;
  if (
    format !== 1 ||
    !isMetaString(source) ||
    !isMetaString(license) ||
    typeof release !== "string" ||
    !RELEASE_PATTERN.test(release) ||
    typeof releasedAt !== "string" ||
    !RELEASED_AT_PATTERN.test(releasedAt) ||
    !Number.isFinite(Date.parse(releasedAt)) ||
    typeof upstreamSha256 !== "string" ||
    !SHA256_PATTERN.test(upstreamSha256) ||
    !isPlainObject(lists)
  ) {
    return null;
  }

  const names = Object.keys(lists);
  if (names.length > MAX_LISTS) {
    return null;
  }
  const out: Record<string, SiteGroupCatalogList> = {};
  let totalLines = 0;
  let totalSkipped = 0;
  for (const name of names) {
    if (!LIST_NAME_PATTERN.test(name)) {
      return null;
    }
    const list = lists[name];
    if (!isPlainObject(list) || typeof list.rules !== "string" || !Array.isArray(list.skipped)) {
      return null;
    }
    const lines = ruleLines(list.rules);
    totalLines += lines.length;
    if (totalLines > MAX_TOTAL_LINES) {
      return null;
    }
    for (const line of lines) {
      const m = RULE_LINE_PATTERN.exec(line);
      if (m === null || m[1].length > MAX_HOST_LENGTH) {
        return null;
      }
    }
    const skipped = list.skipped as unknown[];
    totalSkipped += skipped.length;
    if (totalSkipped > MAX_TOTAL_SKIPPED) {
      return null;
    }
    for (const item of skipped) {
      if (typeof item !== "string" || !SKIPPED_PATTERN.test(item)) {
        return null;
      }
    }
    out[name] = { rules: list.rules, skipped: skipped as string[] };
  }

  return { format: 1, source, license, release, releasedAt, upstreamSha256, lists: out };
}

/** A rule line split into its parts. */
function parseRuleLine(line: string): { full: boolean; host: string; attrs: string[] } {
  const full = line.startsWith("=");
  const [host, ...attrs] = (full ? line.slice(1) : line).split("@");
  return { full, host, attrs };
}

/** Unique domain and full entries of a list whose attrs include every one of `attrs`. */
function collectEntries(
  list: SiteGroupCatalogList,
  attrs: readonly string[]
): { domains: string[]; fulls: string[] } {
  const domains = new Set<string>();
  const fulls = new Set<string>();
  for (const line of ruleLines(list.rules)) {
    const rule = parseRuleLine(line);
    if (!attrs.every((a) => rule.attrs.includes(a))) {
      continue;
    }
    (rule.full ? fulls : domains).add(rule.host);
  }
  return { domains: [...domains], fulls: [...fulls] };
}

/** Every list's name and unfiltered entry count, sorted by name (plain `<`). */
export function catalogIndex(catalog: SiteGroupCatalog): SiteGroupIndexEntry[] {
  return Object.keys(catalog.lists)
    .sort()
    .map((name) => {
      const { domains, fulls } = collectEntries(catalog.lists[name], []);
      return { name, count: domains.length + fulls.length };
    });
}

/**
 * Build one token's data from the catalog. Attrs combine with AND (a rule
 * qualifies only when it carries every attr of the token). `UNKNOWN_GROUP`
 * when the token doesn't parse or names no list; `EMPTY_GROUP` when no rule
 * qualifies.
 */
export function buildCatalogGroupData(
  catalog: SiteGroupCatalog,
  groupToken: string
): CatalogGroupResult {
  const parsed = parseGroupToken(groupToken);
  if (parsed === null || !Object.hasOwn(catalog.lists, parsed.name)) {
    return { ok: false, error: "UNKNOWN_GROUP" };
  }
  const list = catalog.lists[parsed.name];
  const { domains, fulls } = collectEntries(list, parsed.attrs);
  const n = domains.length + fulls.length;
  if (n === 0) {
    return { ok: false, error: "EMPTY_GROUP" };
  }
  const skipped = list.skipped.filter((item) => {
    const itemAttrs = item.length === 0 ? [] : item.split("@");
    return parsed.attrs.every((a) => itemAttrs.includes(a));
  }).length;
  return { ok: true, data: { d: frameEntries(domains), f: frameEntries(fulls), n, skipped } };
}

/** True when release tag `a` is newer than `b` (both 14-digit tags; `b` may be absent). */
export function isNewerRelease(a: string, b: string | null | undefined): boolean {
  if (!RELEASE_PATTERN.test(a)) {
    return false;
  }
  if (b === null || b === undefined || !RELEASE_PATTERN.test(b)) {
    return true;
  }
  return a > b;
}
