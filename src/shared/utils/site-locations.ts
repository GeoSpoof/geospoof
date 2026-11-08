/**
 * Site locations: pattern grammar, precedence, resolution, and validation.
 *
 * Two independent axes decide what a page sees:
 *   1. Filters (allowlist/denylist) decide WHETHER GeoSpoof is on for the
 *      tab's top-level URL (`computeEffectiveEnabled`).
 *   2. A matching site location decides WHICH location it reports there.
 *
 * `resolveSiteSettings` is the only place the second axis is applied. Every
 * background consumer (page payloads, workers, Accept-Language, CDP, the
 * badge title) goes through it, so they can't disagree about a tab.
 *
 * Pure: no `browser.*`, no storage, no clock.
 */

import type {
  Location,
  LocationName,
  ScopeMode,
  Settings,
  SiteLocation,
  Timezone,
} from "@/shared/types/settings";
import {
  DEFAULT_ACCURACY_M,
  MAX_PATTERNS_PER_SITE_LOCATION,
  MAX_SITE_LOCATIONS,
} from "@/shared/types/settings";
import { NO_SITE_GROUPS, type SiteGroupLookup } from "@/shared/site-groups/matcher";
import { isSiteGroupToken } from "@/shared/site-groups/tokens";
import { EXACT_PREFIX, parseSiteLocationEntry } from "./filter-entries";
import { hostToASCII } from "./idn";
import {
  computeEffectiveEnabled,
  computeEffectiveSiteLocations,
  decomposePattern,
  isValidIpv4,
  matchesPattern,
  parsePattern,
} from "./scope";
import { isValidIANATimezone } from "./type-guards";

/** Maximum stored id length. */
const MAX_ID_LENGTH = 64;
/** Maximum stored label length, matching the favorites display-name cap. */
const MAX_LABEL_LENGTH = 100;

// ─────────────────────────────── Pattern grammar ───────────────────────────────

/**
 * Parse a site-location pattern: the Filters grammar (`parsePattern`) minus
 * paths and a wildcard-only host (`*`, `*://*`, `https://*:8080`). A site
 * location names sites, not "everything", and a page's location can't vary by
 * path. Every accepted pattern is also a valid Filters pattern with the
 * identical canonical form, so the two lists can share one matcher.
 */
export function parseSiteLocationPattern(input: string): string | null {
  const canonical = parsePattern(input);
  if (canonical === null) {
    return null;
  }
  const { host, path } = decomposePattern(canonical);
  if (path !== "" || host === "*") {
    return null;
  }
  return canonical;
}

/** `siteLocationPatternKey` results by pattern. Affects cost only, never the key. */
const patternKeyCache = new Map<string, string | null>();

/**
 * The identity of a canonical site-location pattern, for the rule that each
 * pattern has one owner: the pattern with its literal host converted to its
 * A-label, the way the compiler converts it (`patternToInit`). So `münchen.de`
 * and `xn--mnchen-3ya.de`, which match the same pages with the same
 * specificity, are the same pattern. The stored spelling isn't changed. Null
 * when the host has no A-label form; such a pattern never matches a page.
 */
export function siteLocationPatternKey(pattern: string): string | null {
  const cached = patternKeyCache.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  const { scheme, host, port } = decomposePattern(pattern);
  const wildcard = host.startsWith("*.") ? "*." : "";
  const literal = host.slice(wildcard.length);
  const ascii = wildcard === "" && isValidIpv4(literal) ? literal : hostToASCII(literal);
  const key =
    ascii === null
      ? null
      : `${scheme === "" ? "" : `${scheme}://`}${wildcard}${ascii}${port === "" ? "" : `:${port}`}`;
  patternKeyCache.set(pattern, key);
  return key;
}

/**
 * The identity of a canonical per-site location entry (a
 * `parseSiteLocationEntry` result), for the one-owner rule: a typed pattern's
 * `siteLocationPatternKey`; `=` + that key for an exact address; the token
 * itself for a site group or link. Null when a host has no A-label form.
 *
 * Lives here rather than in `filter-entries.ts`, which this module imports, so
 * the two don't import each other.
 */
export function siteLocationEntryKey(canonical: string): string | null {
  if (isSiteGroupToken(canonical)) {
    return canonical;
  }
  if (canonical.startsWith(EXACT_PREFIX)) {
    const key = siteLocationPatternKey(canonical.slice(EXACT_PREFIX.length));
    return key === null ? null : `${EXACT_PREFIX}${key}`;
  }
  return siteLocationPatternKey(canonical);
}

// ─────────────────────────────── Precedence ───────────────────────────────

/**
 * How specific a canonical typed site-location entry (a pattern or an exact
 * address) is, compared lexicographically:
 *   - `labels`: label count of the host literal (`*.` and `=` stripped; IPv4 =
 *     4; `localhost` = 1). More labels name a narrower site.
 *   - `hostKind`: 2 for an exact `=L` (that host only), 1 for `*.L` (excludes
 *     the apex, so narrower than `L`), 0 for a bare `L` or an IPv4 literal.
 *   - `scheme`: explicit `http`/`https` = 2, unset (http + https) = 1, `*` = 0.
 *   - `port`: 1 when an explicit port is given.
 */
export type SiteLocationSpecificity = readonly [
  labels: number,
  hostKind: 0 | 1 | 2,
  scheme: 0 | 1 | 2,
  port: 0 | 1,
];

/** Compute the specificity tuple of a canonical typed site-location entry. */
export function siteLocationSpecificity(pattern: string): SiteLocationSpecificity {
  const exact = pattern.startsWith(EXACT_PREFIX);
  const { scheme, host, port } = decomposePattern(exact ? pattern.slice(1) : pattern);
  const hostKind = exact ? 2 : host.startsWith("*.") ? 1 : 0;
  const literal = hostKind === 1 ? host.slice(2) : host;
  const labels = literal.length === 0 ? 0 : literal.split(".").length;
  const schemeRank = scheme === "" ? 1 : scheme === "*" ? 0 : 2;
  return [labels, hostKind, schemeRank, port === "" ? 0 : 1];
}

/** Lexicographic comparison of two specificity tuples; positive when `a` is more specific. */
export function compareSpecificity(a: SiteLocationSpecificity, b: SiteLocationSpecificity): number {
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * How well one entry of a site location matches a URL. Typed entries (tier 1)
 * beat site group and link tokens (tier 0); typed entries then compare by
 * specificity, and groups by size, the smaller (narrower) group winning.
 */
export type SiteLocationScore =
  { tier: 1; spec: SiteLocationSpecificity } | { tier: 0; size: number };

/** Compare two scores; positive when `a` wins. */
export function compareSiteLocationScore(a: SiteLocationScore, b: SiteLocationScore): number {
  if (a.tier === 1 && b.tier === 1) {
    return compareSpecificity(a.spec, b.spec);
  }
  if (a.tier === 0 && b.tier === 0) {
    return b.size - a.size;
  }
  return a.tier - b.tier;
}

/** The winning entry for a URL and the pattern that made it win. */
export interface SiteLocationMatch {
  entry: SiteLocation;
  pattern: string;
}

/**
 * Find the site location for `url`, ignoring Filters. Each entry scores the
 * best of its entries that match (`compareSiteLocationScore`): a typed
 * pattern or exact address by its specificity, a site group or link token
 * whose data in `siteGroups` holds the URL's hostname by its size. The best
 * score wins. Ties (two groups of one size, or defensively two typed entries
 * with one tuple) go to the higher `updatedAt`, then to the lexicographically
 * smaller `id` (plain `<`, so the order is locale-free). The result doesn't
 * depend on list order.
 */
export function matchSiteLocation(
  url: string,
  entries: readonly SiteLocation[],
  siteGroups: SiteGroupLookup = NO_SITE_GROUPS
): SiteLocationMatch | null {
  let best: { entry: SiteLocation; pattern: string; score: SiteLocationScore } | null = null;
  // The URL's hostname, parsed only when an entry holds a token.
  let host: string | null | undefined;
  const hostOf = (): string | null => {
    if (host === undefined) {
      try {
        host = new URL(url).hostname;
      } catch {
        host = null;
      }
    }
    return host;
  };

  for (const entry of entries) {
    let entryBest: { pattern: string; score: SiteLocationScore } | null = null;
    for (const pattern of entry.patterns) {
      let score: SiteLocationScore;
      if (isSiteGroupToken(pattern)) {
        const h = hostOf();
        if (h === null || !siteGroups.has(pattern, h)) {
          continue;
        }
        score = { tier: 0, size: siteGroups.size(pattern) ?? Number.MAX_SAFE_INTEGER };
      } else {
        if (!matchesPattern(url, pattern)) {
          continue;
        }
        score = { tier: 1, spec: siteLocationSpecificity(pattern) };
      }
      if (entryBest === null || compareSiteLocationScore(score, entryBest.score) > 0) {
        entryBest = { pattern, score };
      }
    }
    if (entryBest === null) {
      continue;
    }

    if (best === null) {
      best = { entry, ...entryBest };
      continue;
    }
    const cmp = compareSiteLocationScore(entryBest.score, best.score);
    const wins =
      cmp > 0 ||
      (cmp === 0 &&
        (entry.updatedAt > best.entry.updatedAt ||
          (entry.updatedAt === best.entry.updatedAt && entry.id < best.entry.id)));
    if (wins) {
      best = { entry, ...entryBest };
    }
  }

  return best === null ? null : { entry: best.entry, pattern: best.pattern };
}

// ─────────────────────────────── Resolution ───────────────────────────────

/** The per-tab decision: whether GeoSpoof is on, and with which settings. */
export interface SiteResolution {
  /** The tab's Effective_Enabled value (Filters, master switch, restricted URLs). */
  enabled: boolean;
  /** The applied site location, or null when the main location applies. */
  siteLocation: SiteLocation | null;
  /** The pattern that matched, or null. */
  matchedPattern: string | null;
  /**
   * The settings to build from. The SAME reference as the input unless a site
   * location applies; then a copy with `location`, `timezone`, and
   * `locationName` taken from the entry and every other field global.
   */
  settings: Settings;
}

/**
 * Resolve the effective settings for a tab whose top-level URL is
 * `topLevelUrl`. Filters run first: out of scope, no entry applies, so an
 * entry's coordinates can never reach a page Filters keep GeoSpoof off.
 * `siteGroups` supplies the data for site group and link tokens on both axes;
 * omitted, every token matches nothing.
 */
export function resolveSiteSettings(
  settings: Settings,
  topLevelUrl: string | undefined,
  isRestricted: (url: string) => boolean,
  siteGroups: SiteGroupLookup = NO_SITE_GROUPS
): SiteResolution {
  const enabled = computeEffectiveEnabled({
    masterEnabled: settings.enabled,
    scopeMode: settings.scopeMode,
    allowlist: settings.allowlist,
    denylist: settings.denylist,
    proFeaturesBlocked: settings.proFeaturesBlocked,
    topLevelUrl,
    isRestricted,
    siteGroups,
  });
  if (!enabled || !topLevelUrl) {
    return { enabled, siteLocation: null, matchedPattern: null, settings };
  }

  const entries = computeEffectiveSiteLocations(
    settings.siteLocations,
    settings.proFeaturesBlocked
  );
  const match = matchSiteLocation(topLevelUrl, entries, siteGroups);
  if (match === null) {
    return { enabled, siteLocation: null, matchedPattern: null, settings };
  }

  const { entry } = match;
  return {
    enabled,
    siteLocation: entry,
    matchedPattern: match.pattern,
    settings: {
      ...settings,
      location: entry.location,
      timezone: entry.timezone,
      locationName: entry.locationName,
    },
  };
}

// ─────────────────────────────── Popup helpers ───────────────────────────────

/**
 * Suggest a pattern for the page at `url`: its hostname, with one leading
 * `www.` stripped when what's left still has a dot (so `www.com` stays
 * whole). No scheme or port, so the suggestion covers http and https and the
 * apex plus subdomains. Returns null for URLs without a usable host.
 */
export function suggestSiteLocationPattern(url: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  if (hostname.length === 0) {
    return null;
  }
  if (hostname.startsWith("www.")) {
    const stripped = hostname.slice(4);
    if (stripped.includes(".")) {
      const parsed = parseSiteLocationPattern(stripped);
      if (parsed !== null) {
        return parsed;
      }
    }
  }
  return parseSiteLocationPattern(hostname);
}

/**
 * The name shown for a site location: its label, else the place's city, else
 * its display name, else the coordinates to four decimals.
 */
export function siteLocationDisplayName(entry: SiteLocation): string {
  if (entry.label !== null && entry.label.length > 0) {
    return entry.label;
  }
  if (entry.locationName !== null) {
    if (entry.locationName.city.length > 0) {
      return entry.locationName.city;
    }
    if (entry.locationName.displayName.length > 0) {
      return entry.locationName.displayName;
    }
  }
  return `${entry.location.latitude.toFixed(4)}, ${entry.location.longitude.toFixed(4)}`;
}

/**
 * How a Filters entry relates to a site: every URL the site matches, the entry
 * matches too (`covers`); some URLs match both (`intersects`); none do
 * (`disjoint`).
 */
export type FilterRelation = "covers" | "intersects" | "disjoint";

/**
 * The hosts a canonical typed pattern's host matches, as the compiler reads
 * it (`patternToInit`): `*` any host; `*.L` strict subdomains of L; an IPv4
 * literal or an exact address's host exactly itself; any other L itself and
 * its subdomains. L is held as its A-label; null when it has none, since such
 * a pattern compiles to nothing.
 */
type HostSet =
  | { kind: "any" }
  | { kind: "exactly"; host: string }
  | { kind: "itselfAndSubdomains"; host: string }
  | { kind: "subdomains"; host: string };

function hostSetOf(host: string, exact: boolean): HostSet | null {
  if (host === "*") {
    return exact ? null : { kind: "any" };
  }
  if (host.startsWith("*.")) {
    if (exact) {
      return null;
    }
    const ascii = hostToASCII(host.slice(2));
    return ascii === null ? null : { kind: "subdomains", host: ascii };
  }
  if (isValidIpv4(host)) {
    return { kind: "exactly", host };
  }
  const ascii = hostToASCII(host);
  if (ascii === null) {
    return null;
  }
  return exact ? { kind: "exactly", host: ascii } : { kind: "itselfAndSubdomains", host: ascii };
}

/** Dot-suffix containment only, so `witch.tv` never contains `twitch.tv`. */
function isStrictlyWithin(host: string, domain: string): boolean {
  return host.endsWith(`.${domain}`);
}

function isWithin(host: string, domain: string): boolean {
  return host === domain || isStrictlyWithin(host, domain);
}

/** Site hosts ⊆ entry hosts. */
function hostCovers(e: HostSet, p: HostSet): boolean {
  if (e.kind === "any") {
    return true;
  }
  if (p.kind === "any") {
    return false;
  }
  if (e.kind === "exactly") {
    return p.kind === "exactly" && p.host === e.host;
  }
  if (e.kind === "subdomains" && p.kind !== "subdomains") {
    return isStrictlyWithin(p.host, e.host);
  }
  return isWithin(p.host, e.host);
}

function hostsMeet(e: HostSet, p: HostSet): boolean {
  if (e.kind === "any" || p.kind === "any") {
    return true;
  }
  if (e.kind === "exactly" && p.kind === "exactly") {
    return e.host === p.host;
  }
  if (e.kind === "exactly") {
    return p.kind === "subdomains" ? isStrictlyWithin(e.host, p.host) : isWithin(e.host, p.host);
  }
  if (p.kind === "exactly") {
    return e.kind === "subdomains" ? isStrictlyWithin(p.host, e.host) : isWithin(p.host, e.host);
  }
  return isWithin(e.host, p.host) || isWithin(p.host, e.host);
}

/** The schemes a canonical scheme matches; unset is http and https. `*` is handled by callers. */
function schemesOf(scheme: string): readonly string[] {
  return scheme === "" ? ["http", "https"] : [scheme];
}

/** A canonical typed entry split into its parts, with an exact address's `=` removed. */
function typedParts(pattern: string): {
  exact: boolean;
  scheme: string;
  host: string;
  port: string;
  path: string;
} {
  const exact = pattern.startsWith(EXACT_PREFIX);
  return { exact, ...decomposePattern(exact ? pattern.slice(EXACT_PREFIX.length) : pattern) };
}

/**
 * The relation of one canonical Filters entry to one canonical site-location
 * entry (`site` has no path). A port of the app's
 * `SiteLocationFiltersCheck.relation`, plus exact addresses (an exact host
 * set). Hosts compare as A-labels; a side with no A-label form is disjoint.
 * Site group and link tokens are disjoint: their data answers for them, so
 * callers probe a URL instead.
 */
export function filterEntryRelation(entry: string, site: string): FilterRelation {
  if (isSiteGroupToken(entry) || isSiteGroupToken(site)) {
    return "disjoint";
  }
  const e = typedParts(entry);
  const p = typedParts(site);
  const eHost = hostSetOf(e.host, e.exact);
  const pHost = hostSetOf(p.host, p.exact);
  if (eHost === null || pHost === null) {
    return "disjoint";
  }
  const eSchemes = schemesOf(e.scheme);
  const pSchemes = schemesOf(p.scheme);
  const schemesCover =
    e.scheme === "*" || (p.scheme !== "*" && pSchemes.every((s) => eSchemes.includes(s)));
  const schemesMeet =
    e.scheme === "*" || p.scheme === "*" || pSchemes.some((s) => eSchemes.includes(s));
  const portsCover = e.port === "" || (p.port !== "" && p.port === e.port);
  const portsMeet = e.port === "" || p.port === "" || p.port === e.port;
  const everyPath = e.path === "" || e.path === "/*";
  if (schemesCover && portsCover && everyPath && hostCovers(eHost, pHost)) {
    return "covers";
  }
  if (schemesMeet && portsMeet && hostsMeet(eHost, pHost)) {
    return "intersects";
  }
  return "disjoint";
}

/**
 * A URL standing for a site-location pattern, for asking Filters about it:
 * the pattern's scheme when it's `http` or `https` (else `https`), its host as
 * an A-label, its port, and path `/`. Null for tokens, a wildcard host, and a
 * host without an A-label form.
 */
export function filterProbeUrl(pattern: string): string | null {
  if (isSiteGroupToken(pattern)) {
    return null;
  }
  const { scheme, host, port } = typedParts(pattern);
  if (host === "*" || host.startsWith("*.")) {
    return null;
  }
  const ascii = isValidIpv4(host) ? host : hostToASCII(host);
  if (ascii === null) {
    return null;
  }
  const probeScheme = scheme === "http" || scheme === "https" ? scheme : "https";
  return `${probeScheme}://${ascii}${port === "" ? "" : `:${port}`}/`;
}

/** The Filters state a per-site location check reads. Only the active list counts. */
export interface FilterListArgs {
  scopeMode: ScopeMode;
  allowlist: readonly string[];
  denylist: readonly string[];
  siteGroups: SiteGroupLookup;
  proFeaturesBlocked?: boolean;
}

/**
 * What Filters do to one site-location pattern: on everywhere it reaches
 * (`on`), off there (`off`), on only some pages of it (`somePages`), or not
 * checked (`skipped`: tokens, wildcard hosts, hosts without an A-label form,
 * All sites mode, and the Safari Pro lock).
 */
export type SiteFilterOutcome = "on" | "off" | "somePages" | "skipped";

/**
 * Check one site-location pattern against the active Filters list, in the
 * order the design record fixes (direction.md section 7, M2). Typed entries
 * answer through `filterEntryRelation`; when none does, a probe URL for the
 * pattern goes through `computeEffectiveEnabled` with the master switch
 * forced on, so tokens are answered too and Location Protection being off
 * never marks anything.
 *   - Allowlist: a covering entry → on; else an intersecting one → somePages;
 *     else the probe decides.
 *   - Denylist: a covering entry or a probe that's off → off; else an
 *     intersecting entry → somePages; else on.
 */
export function siteFilterOutcome(pattern: string, args: FilterListArgs): SiteFilterOutcome {
  const { scopeMode } = args;
  if (scopeMode === "all" || (__SAFARI__ && args.proFeaturesBlocked === true)) {
    return "skipped";
  }
  const probe = filterProbeUrl(pattern);
  if (probe === null) {
    return "skipped";
  }
  const list = scopeMode === "allowlist" ? args.allowlist : args.denylist;
  const relations = list.map((entry) => filterEntryRelation(entry, pattern));
  const covered = relations.includes("covers");
  const intersects = relations.includes("intersects");
  const probeOn = (): boolean =>
    computeEffectiveEnabled({
      masterEnabled: true,
      scopeMode,
      allowlist: [...args.allowlist],
      denylist: [...args.denylist],
      topLevelUrl: probe,
      isRestricted: () => false,
      siteGroups: args.siteGroups,
      proFeaturesBlocked: args.proFeaturesBlocked,
    });
  if (scopeMode === "allowlist") {
    if (covered) {
      return "on";
    }
    if (intersects) {
      return "somePages";
    }
    return probeOn() ? "on" : "off";
  }
  if (covered || !probeOn()) {
    return "off";
  }
  return intersects ? "somePages" : "on";
}

/**
 * The mark a per-site location's row carries: none, "Not used" (`off`), or
 * "some pages" (`somePages`). `hosts` are the display hosts of the patterns
 * with that outcome (no `=`, scheme or port), de-duplicated, in pattern order.
 * `single` is true only when the entry has exactly one pattern, so the mark
 * needn't name it (direction review M13).
 */
export type SiteLocationFiltersMark =
  | { kind: "none" }
  | { kind: "off"; hosts: string[]; single: boolean }
  | { kind: "somePages"; hosts: string[]; single: boolean };

/** The Filters mark for an entry's patterns. `off` wins over `somePages`. */
export function siteLocationFiltersMark(
  patterns: readonly string[],
  args: FilterListArgs
): SiteLocationFiltersMark {
  const off: string[] = [];
  const somePages: string[] = [];
  for (const pattern of patterns) {
    const outcome = siteFilterOutcome(pattern, args);
    const target = outcome === "off" ? off : outcome === "somePages" ? somePages : null;
    if (target === null) {
      continue;
    }
    const { host } = typedParts(pattern);
    if (!target.includes(host)) {
      target.push(host);
    }
  }
  const single = patterns.length === 1;
  if (off.length > 0) {
    return { kind: "off", hosts: off, single };
  }
  if (somePages.length > 0) {
    return { kind: "somePages", hosts: somePages, single };
  }
  return { kind: "none" };
}

/**
 * The entry of the active Filters list that decides `topLevelUrl`
 * (evaluation.md 8.5.3): among the entries that match the page (a typed entry
 * by `matchesPattern`, a token by `siteGroups.has` on the hostname, the test
 * `computeEffectiveEnabled` runs), typed entries before tokens; typed entries
 * by label count, then host kind (exact, wildcard, plain), both descending,
 * then entries with a path or a port first; tokens by the smallest group; list
 * order last. Null in All sites mode, under the Safari Pro lock, for a URL
 * without a hostname, and when nothing in the active list matches.
 */
export function findDecidingFilterEntry(args: {
  scopeMode: ScopeMode;
  allowlist: readonly string[];
  denylist: readonly string[];
  topLevelUrl: string;
  siteGroups: SiteGroupLookup;
  proFeaturesBlocked?: boolean;
}): string | null {
  const { scopeMode, topLevelUrl, siteGroups } = args;
  if (scopeMode === "all" || (__SAFARI__ && args.proFeaturesBlocked === true)) {
    return null;
  }
  let host: string;
  try {
    host = new URL(topLevelUrl).hostname;
  } catch {
    return null;
  }
  if (host.length === 0) {
    return null;
  }
  const list = scopeMode === "allowlist" ? args.allowlist : args.denylist;
  let best: { entry: string; rank: readonly number[] } | null = null;
  for (const entry of list) {
    let rank: readonly number[];
    if (isSiteGroupToken(entry)) {
      if (!siteGroups.has(entry, host)) {
        continue;
      }
      rank = [0, -(siteGroups.size(entry) ?? Number.MAX_SAFE_INTEGER)];
    } else {
      if (!matchesPattern(topLevelUrl, entry)) {
        continue;
      }
      const [labels, hostKind] = siteLocationSpecificity(entry);
      const { port, path } = typedParts(entry);
      rank = [1, labels, hostKind, path !== "" || port !== "" ? 1 : 0];
    }
    // Strictly greater, so a tie keeps the earlier entry.
    if (best === null || compareRank(rank, best.rank) > 0) {
      best = { entry, rank };
    }
  }
  return best === null ? null : best.entry;
}

/** Lexicographic comparison of two ranks; positive when `a` is higher. Ties keep the earlier entry. */
function compareRank(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return 0;
}

// ─────────────────────────────── Validation ───────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateEntryLocation(value: unknown): Location | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { latitude, longitude, accuracy } = value as Record<string, unknown>;
  if (
    !isFiniteNumber(latitude) ||
    !isFiniteNumber(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return {
    latitude,
    longitude,
    accuracy: isFiniteNumber(accuracy) && accuracy > 0 ? accuracy : DEFAULT_ACCURACY_M,
  };
}

function validateEntryTimezone(value: unknown): Timezone | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { identifier, offset, dstOffset, fallback } = value as Record<string, unknown>;
  if (
    !isValidIANATimezone(identifier) ||
    !isFiniteNumber(offset) ||
    !isFiniteNumber(dstOffset) ||
    fallback === true
  ) {
    return null;
  }
  return { identifier: identifier as string, offset, dstOffset };
}

/**
 * Normalize a place name the way `validateSettings` does for the main
 * location: `displayName` is required, `city`/`country` default to "".
 */
export function normalizeSiteLocationName(value: unknown): LocationName | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { city, country, displayName } = value as Record<string, unknown>;
  if (typeof displayName !== "string") {
    return null;
  }
  return {
    city: typeof city === "string" ? city : "",
    country: typeof country === "string" ? country : "",
    displayName,
  };
}

/** Trim and cap a label; an empty or non-string label becomes null. */
export function normalizeSiteLocationLabel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().slice(0, MAX_LABEL_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Repair a stored `siteLocations` value. Non-arrays become `[]`; an entry
 * failing any rule is dropped rather than half-applied. Patterns (typed
 * patterns, exact addresses, and site group and link tokens) are re-parsed to
 * canonical form with `parseSiteLocationEntry`, deduped within the entry, and
 * dropped when an EARLIER entry already claims them (first occurrence wins),
 * so no two entries ever share a pattern. Patterns are compared by
 * `siteLocationEntryKey`, so a Unicode and an A-label spelling of one host
 * count as one, and a pattern without a key is dropped. A token counts once
 * toward the per-entry cap. Both caps are enforced; order is preserved.
 */
export function validateSiteLocations(value: unknown): SiteLocation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: SiteLocation[] = [];
  const seenIds = new Set<string>();
  const claimed = new Set<string>();

  for (const raw of value) {
    if (out.length >= MAX_SITE_LOCATIONS) {
      break;
    }
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const candidate = raw as Record<string, unknown>;

    const { id } = candidate;
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH || seenIds.has(id)) {
      continue;
    }
    // Unknown kinds are dropped: this build can't apply them.
    if (candidate.kind !== "location") {
      continue;
    }
    const location = validateEntryLocation(candidate.location);
    if (location === null) {
      continue;
    }
    const timezone = validateEntryTimezone(candidate.timezone);
    if (timezone === null) {
      continue;
    }
    if (!Array.isArray(candidate.patterns)) {
      continue;
    }

    const patterns: string[] = [];
    const keys = new Set<string>();
    for (const rawPattern of candidate.patterns as unknown[]) {
      if (typeof rawPattern !== "string") {
        continue;
      }
      const canonical = parseSiteLocationEntry(rawPattern);
      const key = canonical === null ? null : siteLocationEntryKey(canonical);
      if (canonical === null || key === null || claimed.has(key) || keys.has(key)) {
        continue;
      }
      patterns.push(canonical);
      keys.add(key);
      if (patterns.length >= MAX_PATTERNS_PER_SITE_LOCATION) {
        break;
      }
    }
    if (patterns.length === 0) {
      continue;
    }

    const { updatedAt } = candidate;
    for (const key of keys) {
      claimed.add(key);
    }
    seenIds.add(id);
    out.push({
      id,
      kind: "location",
      patterns,
      location,
      timezone,
      locationName: normalizeSiteLocationName(candidate.locationName),
      label: normalizeSiteLocationLabel(candidate.label),
      updatedAt: isFiniteNumber(updatedAt) && updatedAt >= 0 ? updatedAt : 0,
    });
  }

  return out;
}
