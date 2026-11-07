/**
 * The THIS SITE card's model (design H, direction.md 6.1, option a), and the
 * list screens' status line for the current site. Every answer is computed
 * from the settings and the tab URL; nothing is stored.
 *
 * Pure: no DOM, no `browser.*`, no strings. The renderer turns the result
 * into markup and messages.
 */
import type { ScopeMode, Settings, SiteLocation } from "@/shared/types/settings";
import type { SiteGroupLookup } from "@/shared/site-groups/matcher";
import { isSiteGroupToken } from "@/shared/site-groups/tokens";
import { EXACT_PREFIX } from "@/shared/utils/filter-entries";
import { hostToASCII } from "@/shared/utils/idn";
import {
  computeEffectiveEnabled,
  decomposePattern,
  isValidIpv4,
  parsePattern,
} from "@/shared/utils/scope";
import {
  filterEntryRelation,
  findDecidingFilterEntry,
  resolveSiteSettings,
  siteLocationDisplayName,
  suggestSiteLocationPattern,
  type SiteLocationFiltersMark,
} from "@/shared/utils/site-locations";

/** A Filters list the card can write to. */
export type FilterListName = "allowlist" | "denylist";

/** A host compared as its A-label (an IPv4 literal as itself); null without one. */
function hostKey(host: string): string | null {
  return isValidIpv4(host) ? host : hostToASCII(host);
}

function hostnameOf(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

/**
 * Whether a Filters or per-site location entry is the site's own (6.1 "Own
 * entry"): a typed entry with no path and no wildcard host, whose host equals
 * the host of `site` or of the tab. Hosts compare as A-labels after a leading
 * `=`, the scheme and the port are removed, so `=mail.example.com`,
 * `https://example.com`, `localhost:3000` and a legacy `www.twitch.tv` (on
 * `www.twitch.tv`) all count.
 */
export function isOwnFilterEntry(entry: string, site: string, tabUrl: string): boolean {
  if (isSiteGroupToken(entry)) {
    return false;
  }
  const typed = entry.startsWith(EXACT_PREFIX) ? entry.slice(EXACT_PREFIX.length) : entry;
  const { host, path } = decomposePattern(typed);
  if (path !== "" || host === "*" || host.startsWith("*.")) {
    return false;
  }
  const key = hostKey(host);
  if (key === null) {
    return false;
  }
  const siteTyped = site.startsWith(EXACT_PREFIX) ? site.slice(EXACT_PREFIX.length) : site;
  const siteHost = decomposePattern(siteTyped).host;
  if (hostKey(siteHost) === key) {
    return true;
  }
  const tabHost = hostnameOf(tabUrl);
  return tabHost !== null && hostKey(tabHost) === key;
}

/** What a card Remove took out, so the next card Add puts back that exact entry. */
export type CardUndo = { tabUrl: string; list: FilterListName; entry: string };

/** The rows of direction.md 6.1 that show the card (row 1 hides it). */
export type ThisSiteRow = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export type ThisSiteValue = { kind: "off" } | { kind: "notSet" } | { kind: "place"; name: string };

/**
 * The line under the site: none (an off value), "Location Protection: Off",
 * "Main location", "Per-site location", or "Per-site location · <entry>" with
 * the pattern that matched as stored.
 */
export type ThisSiteSource = "none" | "protection" | "main" | "site" | { entry: string };

export type ThisSiteOpens =
  { kind: "none" } | { kind: "main" } | { kind: "edit"; entryId: string } | { kind: "new" };

/** `coveredBy.entry` is the stored entry; the renderer names it the way its list row does. */
export type ThisSiteReason =
  { kind: "none" } | { kind: "coveredBy"; entry: string } | { kind: "somePages" };

export type ThisSiteButton = null | {
  action: "add" | "remove";
  list: FilterListName;
  pattern: string;
};

export type ThisSiteCard =
  | { kind: "hidden" }
  | {
      kind: "shown";
      row: ThisSiteRow;
      site: string;
      tabUrl: string;
      value: ThisSiteValue;
      source: ThisSiteSource;
      opens: ThisSiteOpens;
      reason: ThisSiteReason;
      button: ThisSiteButton;
    };

export interface ThisSiteInput {
  settings: Settings;
  tabUrl: string | undefined;
  proLocked: boolean;
  isOptionsPage: boolean;
  isRestricted: (url: string) => boolean;
  siteGroups: SiteGroupLookup;
  undo: CardUndo | null;
}

/** The main location's name: city, else display name, else coordinates; null when unset. */
function mainPlaceName(settings: Settings): string | null {
  if (settings.location === null) {
    return null;
  }
  const name = settings.locationName;
  if (name !== null && name.city.length > 0) {
    return name.city;
  }
  if (name !== null && name.displayName.length > 0) {
    return name.displayName;
  }
  return `${settings.location.latitude.toFixed(4)}, ${settings.location.longitude.toFixed(4)}`;
}

/** Filters' answer for the page with the master switch on, given an active list. */
function enabledWith(
  settings: Settings,
  list: FilterListName,
  entries: readonly string[],
  tabUrl: string,
  isRestricted: (url: string) => boolean,
  siteGroups: SiteGroupLookup
): boolean {
  return computeEffectiveEnabled({
    masterEnabled: true,
    scopeMode: list,
    allowlist: list === "allowlist" ? [...entries] : [...settings.allowlist],
    denylist: list === "denylist" ? [...entries] : [...settings.denylist],
    topLevelUrl: tabUrl,
    isRestricted,
    siteGroups,
    proFeaturesBlocked: settings.proFeaturesBlocked,
  });
}

/** Compute the THIS SITE card for the tab. The first row of 6.1 that matches applies. */
export function computeThisSiteCard(input: ThisSiteInput): ThisSiteCard {
  const { settings, tabUrl, proLocked, isOptionsPage, isRestricted, siteGroups, undo } = input;
  if (tabUrl === undefined || isOptionsPage || isRestricted(tabUrl)) {
    return { kind: "hidden" };
  }
  const site = suggestSiteLocationPattern(tabUrl);
  if (site === null) {
    return { kind: "hidden" };
  }
  const base = { kind: "shown" as const, site, tabUrl };
  const none = { kind: "none" } as const;

  // Row 2: Location Protection off.
  if (!settings.enabled) {
    return {
      ...base,
      row: 2,
      value: { kind: "off" },
      source: "protection",
      opens: { kind: "main" },
      reason: none,
      button: null,
    };
  }

  const effective: Settings = proLocked
    ? { ...settings, scopeMode: "all", siteLocations: [] }
    : settings;
  const resolution = resolveSiteSettings(
    { ...effective, enabled: true },
    tabUrl,
    isRestricted,
    siteGroups
  );

  // The value, source and target of a page GeoSpoof is on for.
  const onParts = (): {
    value: ThisSiteValue;
    source: ThisSiteSource;
    opens: ThisSiteOpens;
  } => {
    const { siteLocation, matchedPattern } = resolution;
    if (siteLocation !== null && matchedPattern !== null) {
      return {
        value: { kind: "place", name: siteLocationDisplayName(siteLocation) },
        source: isOwnFilterEntry(matchedPattern, site, tabUrl) ? "site" : { entry: matchedPattern },
        opens: { kind: "edit", entryId: siteLocation.id },
      };
    }
    const name = mainPlaceName(effective);
    return name === null
      ? { value: { kind: "notSet" }, source: "main", opens: { kind: "main" } }
      : { value: { kind: "place", name }, source: "main", opens: { kind: "new" } };
  };

  // Row 3: Safari without Pro. A place is plain text; "Not set" opens Main.
  if (proLocked) {
    const parts = onParts();
    return {
      ...base,
      row: 3,
      ...parts,
      opens: parts.value.kind === "notSet" ? { kind: "main" } : none,
      reason: none,
      button: null,
    };
  }

  // Row 4: All sites.
  if (settings.scopeMode === "all") {
    return { ...base, row: 4, ...onParts(), reason: none, button: null };
  }

  const list: FilterListName = settings.scopeMode;
  const entries = list === "allowlist" ? settings.allowlist : settings.denylist;
  const on = resolution.enabled;
  const offParts = {
    value: { kind: "off" } as const,
    source: "none" as const,
    opens: none,
  };
  const pageParts = on ? onParts() : offParts;
  const deciding = findDecidingFilterEntry({
    scopeMode: list,
    allowlist: settings.allowlist,
    denylist: settings.denylist,
    topLevelUrl: tabUrl,
    siteGroups,
    proFeaturesBlocked: settings.proFeaturesBlocked,
  });
  // The active list decides the page: Allowlist and on, or Denylist and off.
  const covered = deciding !== null;

  if (covered) {
    const own = isOwnFilterEntry(deciding, site, tabUrl);
    const without = entries.filter((e) => e !== deciding);
    const flips = enabledWith(settings, list, without, tabUrl, isRestricted, siteGroups) !== on;
    if (own && flips) {
      return {
        ...base,
        row: list === "allowlist" ? 5 : 9,
        ...pageParts,
        reason: none,
        button: { action: "remove", list, pattern: deciding },
      };
    }
    // M12: name the entry that keeps the state. When the deciding entry is
    // the site's own, that's whichever entry decides without it.
    const named = own
      ? (findDecidingFilterEntry({
          scopeMode: list,
          allowlist: list === "allowlist" ? without : settings.allowlist,
          denylist: list === "denylist" ? without : settings.denylist,
          topLevelUrl: tabUrl,
          siteGroups,
          proFeaturesBlocked: settings.proFeaturesBlocked,
        }) ?? deciding)
      : deciding;
    return {
      ...base,
      row: list === "allowlist" ? 6 : 10,
      ...pageParts,
      reason: { kind: "coveredBy", entry: named },
      button: null,
    };
  }

  // Not covered: rows 7/8 (Allowlist, off) and 11/12 (Denylist, on).
  const somePages = entries.some(
    (e) => !isSiteGroupToken(e) && filterEntryRelation(e, site) === "intersects"
  );
  const addFlips =
    parsePattern(site) !== null &&
    enabledWith(settings, list, [...entries, site], tabUrl, isRestricted, siteGroups) !== on;
  let button: ThisSiteButton = addFlips ? { action: "add", list, pattern: site } : null;
  if (button !== null && undo !== null && undo.tabUrl === tabUrl && undo.list === list) {
    button = { action: "add", list, pattern: undo.entry };
  }
  const row: ThisSiteRow = list === "allowlist" ? (somePages ? 7 : 8) : somePages ? 11 : 12;
  return {
    ...base,
    row,
    ...pageParts,
    reason: somePages ? { kind: "somePages" } : none,
    button,
  };
}

/** The list screen's line for the current site (S3): "＋ Add", "✓ Listed", or "✓ Covered by". */
export type ListScreenSiteStatus =
  | { kind: "none" }
  | { kind: "add"; site: string }
  | { kind: "listed"; site: string }
  | { kind: "coveredBy"; site: string; entry: string };

/**
 * The status of the current site on one list's screen. None without a
 * usable site (restricted page, the options tab, no suggestion, or one that
 * isn't a Filters pattern). Otherwise the entry of that list deciding the
 * page: none → add; the site's own → listed; another → covered by it. The
 * screen shows membership, so the Safari Pro lock (which ignores the lists)
 * isn't applied here.
 */
export function listScreenSiteStatus(args: {
  settings: Settings;
  list: FilterListName;
  tabUrl: string | undefined;
  isOptionsPage: boolean;
  isRestricted: (url: string) => boolean;
  siteGroups: SiteGroupLookup;
}): ListScreenSiteStatus {
  const { settings, list, tabUrl, isOptionsPage, isRestricted, siteGroups } = args;
  if (tabUrl === undefined || isOptionsPage || isRestricted(tabUrl)) {
    return { kind: "none" };
  }
  const site = suggestSiteLocationPattern(tabUrl);
  if (site === null || parsePattern(site) === null) {
    return { kind: "none" };
  }
  const scopeMode: ScopeMode = list;
  const deciding = findDecidingFilterEntry({
    scopeMode,
    allowlist: settings.allowlist,
    denylist: settings.denylist,
    topLevelUrl: tabUrl,
    siteGroups,
  });
  if (deciding === null) {
    return { kind: "add", site };
  }
  if (isOwnFilterEntry(deciding, site, tabUrl)) {
    return { kind: "listed", site };
  }
  return { kind: "coveredBy", site, entry: deciding };
}

/** Whether some per-site location already has the site's own pattern (hides "＋ Set a location for <site>"). */
export function ownSiteLocationExists(
  siteLocations: readonly SiteLocation[],
  site: string,
  tabUrl: string
): boolean {
  return siteLocations.some((entry) =>
    entry.patterns.some((pattern) => isOwnFilterEntry(pattern, site, tabUrl))
  );
}

/** The message key for a per-site row's Filters mark; the plain key only for a one-site entry (M13). */
export type SiteLocationMarkText =
  | null
  | { key: "siteLocation_notUsed" }
  | { key: "siteLocation_notUsedOn"; hosts: string[] }
  | { key: "siteLocation_somePages" }
  | { key: "siteLocation_somePagesOn"; hosts: string[] };

export function siteLocationMarkText(mark: SiteLocationFiltersMark): SiteLocationMarkText {
  switch (mark.kind) {
    case "none":
      return null;
    case "off":
      return mark.single
        ? { key: "siteLocation_notUsed" }
        : { key: "siteLocation_notUsedOn", hosts: mark.hosts };
    case "somePages":
      return mark.single
        ? { key: "siteLocation_somePages" }
        : { key: "siteLocation_somePagesOn", hosts: mark.hosts };
  }
}
