/**
 * The suggestions under the add field (K1, `evaluation.md` 6.6 and A-2): the
 * readings of what was typed, offered for picking. The add control shows them
 * with manual selection, so nothing is highlighted until an arrow key is
 * pressed and Enter adds the typed text as auto-detection reads it.
 *
 *   - A bare host (`twitch.tv`) suggests "Site and its subdomains", "Exact
 *     address only" (where site groups are available) and "Subdomains only".
 *     Other typed forms (`*.ru`, `=mail.example.com`, `site.com/app/*`) get no
 *     typed rows, because Enter already adds exactly what was typed.
 *   - Site groups whose name, label or alias matches the text's search term
 *     (`twitch.tv` searches `twitch`), up to three, popular first.
 *   - A pasted list link suggests that one list.
 *   - In the per-site editor, a comma list suggests nothing (Enter adds it).
 *
 * No DOM. The rows' words come from `t()`.
 */

import { GROUP_PREFIX } from "@/shared/site-groups/tokens";
import {
  detectEntryKind,
  parseFilterEntry,
  type EntryInputKind,
} from "@/shared/utils/filter-entries";
import { decomposePattern, parsePattern } from "@/shared/utils/scope";
import { parseSiteLocationPattern } from "@/shared/utils/site-locations";
import type { EntryAddContext } from "./entry-add-control";
import { t } from "./i18n";
import {
  describeEntry,
  searchSiteGroups,
  siteCountText,
  type SiteGroupIndexItem,
} from "./site-groups";

/** One suggestion: picking it adds `entry`. */
export interface EntrySuggestion {
  /** The canonical entry to add. */
  entry: string;
  /** The row's first line: the pattern, the address, or the group's label. */
  title: string;
  /** The row's muted second line: what the entry covers ("Exact address only"). */
  meta: string;
  kind: EntryInputKind;
}

export interface EntrySuggestionList {
  items: EntrySuggestion[];
  /** Offer "Browse all site groups…" after the items. */
  browse: boolean;
}

/** Most site group rows a typed search suggests. */
export const MAX_GROUP_SUGGESTIONS = 3;

/** Shortest search term that searches the site groups. */
const MIN_GROUP_TERM_LENGTH = 2;

/** The meta line for an entry of `kind`. */
function kindText(kind: EntryInputKind): string {
  switch (kind) {
    case "exact":
      return t("filters_typeExact") || "Exact address only";
    case "subdomains":
      return t("filters_typeSubdomains") || "Subdomains only";
    case "group":
      return t("filters_typeGroup") || "Site group";
    case "link":
      return t("filters_typeLink") || "List from a link";
    default:
      return t("filters_typeSite") || "Site and its subdomains";
  }
}

/** The text without a leading `geosite:` (any case), trimmed. */
function withoutGroupPrefix(text: string): string {
  const trimmed = text.trim();
  return trimmed.slice(0, GROUP_PREFIX.length).toLowerCase() === GROUP_PREFIX
    ? trimmed.slice(GROUP_PREFIX.length).trim()
    : trimmed;
}

/** The typed `@attr` part ("@cn" in "google@cn"), carried over to a group row, or "". */
function typedAttrs(text: string): string {
  const rest = withoutGroupPrefix(text);
  const at = rest.indexOf("@");
  return at === -1 ? "" : rest.slice(at).trim();
}

/**
 * The site group search term for typed text: lowercase, without `geosite:`
 * and any `@attr`; for text with a dot, its second-to-last label (`twitch.tv`
 * → `twitch`, `www.google.com` → `google`). "" (search nothing) when shorter
 * than two characters.
 */
export function groupSearchTerm(text: string): string {
  let term = withoutGroupPrefix(text).toLowerCase();
  const at = term.indexOf("@");
  if (at !== -1) term = term.slice(0, at).trim();
  if (term.includes(".")) {
    const labels = term.split(".").filter((label) => label.length > 0);
    term = labels.length >= 2 ? labels[labels.length - 2] : (labels[0] ?? "");
  }
  return term.length >= MIN_GROUP_TERM_LENGTH ? term : "";
}

/** The typed readings of a bare host: site and subdomains, exact address, subdomains only. */
function typedReadings(
  text: string,
  context: EntryAddContext,
  groupsAvailable: boolean
): EntrySuggestion[] {
  const site = context === "filters" ? parsePattern(text) : parseSiteLocationPattern(text);
  if (site === null) return [];
  const { scheme, host, port, path } = decomposePattern(site);
  if (scheme !== "" || port !== "" || path !== "" || host.includes("*")) return [];

  const rows: EntrySuggestion[] = [
    { entry: site, title: site, meta: kindText("site"), kind: "site" },
  ];
  if (groupsAvailable) {
    // An IPv4 address is already exact, so it gets no second row.
    const exact = parseFilterEntry(host, "exact");
    if (exact !== null && exact !== site) {
      rows.push({ entry: exact, title: host, meta: kindText("exact"), kind: "exact" });
    }
  }
  const subdomains = parseFilterEntry(host, "subdomains");
  if (subdomains !== null && subdomains !== site) {
    rows.push({
      entry: subdomains,
      title: subdomains,
      meta: kindText("subdomains"),
      kind: "subdomains",
    });
  }
  return rows;
}

/** Up to `max` site groups matching the text's search term, popular first. */
function groupRows(
  text: string,
  index: readonly SiteGroupIndexItem[],
  max: number
): EntrySuggestion[] {
  const term = groupSearchTerm(text);
  if (term === "" || max <= 0) return [];
  const { popular, all } = searchSiteGroups(index, term);
  const attrs = typedAttrs(text);
  const rows: EntrySuggestion[] = [];
  for (const item of [...popular, ...all]) {
    if (rows.length >= max) break;
    const entry = parseFilterEntry(`${item.name}${attrs}`, "group");
    if (entry === null) continue;
    // The index counts the whole list, so a tagged group shows no count.
    const meta =
      attrs === "" ? `${kindText("group")} · ${siteCountText(item.count)}` : kindText("group");
    rows.push({ entry, title: describeEntry(entry, { unsaved: true }).title, meta, kind: "group" });
  }
  return rows;
}

/**
 * The suggestions for `text` in the add field of `context`. `groupsAvailable`
 * is false on Safari (no exact addresses, site groups or links); `index` is
 * the site group index, or null while it loads (no group rows then).
 */
export function entrySuggestions(
  text: string,
  opts: {
    context: EntryAddContext;
    groupsAvailable: boolean;
    index: readonly SiteGroupIndexItem[] | null;
    maxGroups?: number;
  }
): EntrySuggestionList {
  const { context, groupsAvailable, index, maxGroups = MAX_GROUP_SUGGESTIONS } = opts;
  const trimmed = text.trim();
  if (trimmed === "") return { items: [], browse: false };
  // The editor adds a comma list as typed.
  if (context === "siteLocation" && trimmed.includes(",")) return { items: [], browse: false };

  const kind = groupsAvailable ? detectEntryKind(trimmed) : null;
  if (kind === "link") {
    const entry = parseFilterEntry(trimmed, "link");
    const items: EntrySuggestion[] =
      entry === null
        ? []
        : [
            {
              entry,
              title: describeEntry(entry, { unsaved: true }).title,
              meta: kindText("link"),
              kind: "link",
            },
          ];
    return { items, browse: false };
  }
  // A typed marker says what to add; Enter adds exactly that.
  if (kind === "exact" || kind === "subdomains") return { items: [], browse: false };

  const items = kind === "group" ? [] : typedReadings(trimmed, context, groupsAvailable);
  if (groupsAvailable && index !== null) items.push(...groupRows(trimmed, index, maxGroups));
  return { items, browse: groupsAvailable };
}
