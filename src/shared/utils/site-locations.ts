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
  Settings,
  SiteLocation,
  Timezone,
} from "@/shared/types/settings";
import {
  DEFAULT_ACCURACY_M,
  MAX_PATTERNS_PER_SITE_LOCATION,
  MAX_SITE_LOCATIONS,
} from "@/shared/types/settings";
import {
  computeEffectiveEnabled,
  computeEffectiveSiteLocations,
  decomposePattern,
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

// ─────────────────────────────── Precedence ───────────────────────────────

/**
 * How specific a canonical site-location pattern is, compared
 * lexicographically:
 *   - `labels`: label count of the host literal (`*.` stripped; IPv4 = 4;
 *     `localhost` = 1). More labels name a narrower site.
 *   - `subdomainsOnly`: 1 for `*.L` (excludes the apex, so narrower than `L`).
 *   - `scheme`: explicit `http`/`https` = 2, unset (http + https) = 1, `*` = 0.
 *   - `port`: 1 when an explicit port is given.
 */
export type SiteLocationSpecificity = readonly [
  labels: number,
  subdomainsOnly: 0 | 1,
  scheme: 0 | 1 | 2,
  port: 0 | 1,
];

/** Compute the specificity tuple of a canonical site-location pattern. */
export function siteLocationSpecificity(pattern: string): SiteLocationSpecificity {
  const { scheme, host, port } = decomposePattern(pattern);
  const subdomainsOnly = host.startsWith("*.") ? 1 : 0;
  const literal = subdomainsOnly === 1 ? host.slice(2) : host;
  const labels = literal.length === 0 ? 0 : literal.split(".").length;
  const schemeRank = scheme === "" ? 1 : scheme === "*" ? 0 : 2;
  return [labels, subdomainsOnly, schemeRank, port === "" ? 0 : 1];
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

/** The winning entry for a URL and the pattern that made it win. */
export interface SiteLocationMatch {
  entry: SiteLocation;
  pattern: string;
}

/**
 * Find the site location for `url`, ignoring Filters. Each entry scores the
 * highest specificity among its patterns that match; the most specific score
 * wins. Ties (defensive: two distinct canonical patterns matching one URL
 * can't share a whole tuple) go to the higher `updatedAt`, then to the
 * lexicographically smaller `id` (plain `<`, so the order is locale-free). The
 * result doesn't depend on list order.
 */
export function matchSiteLocation(
  url: string,
  entries: readonly SiteLocation[]
): SiteLocationMatch | null {
  let best: { entry: SiteLocation; pattern: string; score: SiteLocationSpecificity } | null = null;

  for (const entry of entries) {
    let entryBest: { pattern: string; score: SiteLocationSpecificity } | null = null;
    for (const pattern of entry.patterns) {
      if (!matchesPattern(url, pattern)) {
        continue;
      }
      const score = siteLocationSpecificity(pattern);
      if (entryBest === null || compareSpecificity(score, entryBest.score) > 0) {
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
    const cmp = compareSpecificity(entryBest.score, best.score);
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
 */
export function resolveSiteSettings(
  settings: Settings,
  topLevelUrl: string | undefined,
  isRestricted: (url: string) => boolean
): SiteResolution {
  const enabled = computeEffectiveEnabled({
    masterEnabled: settings.enabled,
    scopeMode: settings.scopeMode,
    allowlist: settings.allowlist,
    denylist: settings.denylist,
    proFeaturesBlocked: settings.proFeaturesBlocked,
    topLevelUrl,
    isRestricted,
  });
  if (!enabled || !topLevelUrl) {
    return { enabled, siteLocation: null, matchedPattern: null, settings };
  }

  const entries = computeEffectiveSiteLocations(
    settings.siteLocations,
    settings.proFeaturesBlocked
  );
  const match = matchSiteLocation(topLevelUrl, entries);
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
 * failing any rule is dropped rather than half-applied. Patterns are
 * re-parsed to canonical form, deduped within the entry, and dropped when an
 * EARLIER entry already claims them (first occurrence wins), so no two
 * entries ever share a pattern. Both caps are enforced; order is preserved.
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
    for (const rawPattern of candidate.patterns as unknown[]) {
      if (typeof rawPattern !== "string") {
        continue;
      }
      const canonical = parseSiteLocationPattern(rawPattern);
      if (canonical === null || claimed.has(canonical) || patterns.includes(canonical)) {
        continue;
      }
      patterns.push(canonical);
      if (patterns.length >= MAX_PATTERNS_PER_SITE_LOCATION) {
        break;
      }
    }
    if (patterns.length === 0) {
      continue;
    }

    const { updatedAt } = candidate;
    for (const p of patterns) {
      claimed.add(p);
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
