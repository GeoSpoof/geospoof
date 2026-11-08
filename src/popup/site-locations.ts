/**
 * Popup Per-site locations
 *
 * Per-site locations are optional, so they stay out of the way until used.
 * Surfaces onto `settings.siteLocations`:
 *   - the Main tab's one-line note (`#siteLocationLine`), rendered only when a
 *     site location applies to the active tab: "On twitch.tv: Mexico City",
 *     with Edit, and Use main location when a main location is set and
 *     removing this site's own rule leaves it there. Nothing renders anywhere
 *     else;
 *   - the Filters root's "Per-site locations" row ("2 locations ›"), in a
 *     group of its own, locked under the Safari Pro lock;
 *   - the Per-site locations screen: one site row per entry, with the Filters
 *     mark ("⚠ Not used · Off in Filters") when Filters keep it from being
 *     used, and "＋ Set a location for <site>";
 *   - the editor on its own screen, which returns to where it was opened from
 *     (the Filters root, the Per-site locations screen or the Main tab), and
 *     holds Remove;
 *   - the Details tab's readout, shown only when a site location applies.
 *
 * Hints are in context only: the Filters-conflict and VPN hints show inside the
 * editor (and the VPN hint under the Main line), and the reload hint only right
 * after a change made from this popup, on the screen that change returns to.
 *
 * Filters and site locations are separate axes: Filters decide WHETHER
 * GeoSpoof is on for a site, a site location decides WHICH location it reports
 * there. Both surfaces use the shared resolver the background uses
 * (`resolveSiteSettings`), so the popup can't disagree with the page.
 */

import type { Favorite, LocationName, Settings, SiteLocation } from "@/shared/types/settings";
import { MAX_PATTERNS_PER_SITE_LOCATION, MAX_SITE_LOCATIONS } from "@/shared/types/settings";
import type {
  GeocodeResponse,
  GeocodeResult,
  RemoveSiteLocationPayload,
  SaveSiteLocationPayload,
  SiteLocationResponse,
} from "@/shared/types/messages";
import { isSiteGroupToken } from "@/shared/site-groups/tokens";
import { parseSiteLocationEntry } from "@/shared/utils/filter-entries";
import { matchesPattern } from "@/shared/utils/scope";
import {
  parseSiteLocationPattern,
  resolveSiteSettings,
  siteLocationDisplayName,
  siteLocationEntryKey,
  siteLocationFiltersMark,
  siteLocationPatternKey,
  suggestSiteLocationPattern,
  type FilterListArgs,
} from "@/shared/utils/site-locations";
import { isOwnExtensionPage } from "./active-tab";
import { siteGroupsAvailable } from "@/shared/site-groups/availability";
import { announce, __resetAnnounceForTest } from "./announce";
import { clearCardUndo, getCardUndo } from "./card-undo";
import {
  createEntryAddControl,
  type EntryAddControl,
  type EntrySubmitResult,
} from "./entry-add-control";
import { saveFiltersDraft, type EditorDraft } from "./drafts";
import { getChipDisplayText } from "./favorites";
import {
  filtersActionAriaLabel,
  filtersActionLabel,
  sendFiltersAction,
  type FiltersAction,
} from "./filters-action";
import {
  backFromFiltersScreen,
  getFiltersScreen,
  isFocusable,
  openFiltersScreen,
  setFiltersScreenBackHandler,
  setFiltersScreenFallback,
  wireButtonRow,
  wireFiltersNavOnce,
  type EditorOrigin,
} from "./filters-nav";
import {
  getReloadHintHost,
  setReloadHintHost,
  __resetReloadHintForTest,
  type ReloadHintHost,
} from "./reload-hint";
import { buildEntryMeta, buildSiteRow } from "./site-row";
import { isRestrictedUrl, loadSettings } from "./settings";
import { t } from "./i18n";
import {
  describeEntry,
  formatCount,
  isSiteGroupErrorCode,
  popupSiteGroupLookup,
  siteGroupErrorText,
} from "./site-groups";
import {
  computeThisSiteCard,
  listActionOf,
  ownSiteLocationExists,
  siteLocationMarkText,
  type SiteLocationMarkText,
} from "./this-site";
import { clearChildren } from "./ui";

/** Debounce (ms) for the editor's location search, matching the main search. */
const SEARCH_DEBOUNCE_MS = 300;

/** What the Main-tab line shows for the active tab. */
export type SiteLocationLineState =
  | { kind: "none" }
  /**
   * In scope, and a site location applies. `site` is the host without `www.`.
   * `canUseMain`: "Use main location" would do exactly that here (see
   * {@link useMainDeliversMain}); otherwise the line offers only Edit.
   */
  | { kind: "applied"; site: string; entry: SiteLocation; pattern: string; canUseMain: boolean };

/** A location picked in the editor. `undefined` fields mean "keep the stored value". */
interface ChosenLocation {
  latitude: number;
  longitude: number;
  /** What the editor shows for it. */
  name: string;
  locationName?: LocationName | null;
  label?: string | null;
}

interface EditorState {
  /** The entry being edited, or null for a new one. */
  entry: SiteLocation | null;
  /** The sites, as chips: canonical entries (patterns, exact addresses, tokens). */
  entries: string[];
  chosen: ChosenLocation | null;
  /** The owner offered by a PATTERN_IN_USE error. */
  ownerId: string | null;
  /** Where focus returns when the editor closes. */
  opener: HTMLElement | null;
  /** The screen the editor returns to, which its back row names. */
  origin: EditorOrigin;
  /**
   * The Filters hint's button: the This site card's list change, offered
   * while Filters keep GeoSpoof off on this tab for a site in the Sites field.
   */
  filtersAction: FiltersAction | null;
}

/** The last rendered inputs; the static controls' listeners read them. */
let current: { settings: Settings; tabUrl: string | undefined; proLocked: boolean } | null = null;
let lineState: SiteLocationLineState = { kind: "none" };
let editor: EditorState | null = null;
/** The editor's add control (the Sites input with suggestions, Add). */
let editorControl: EntryAddControl | null = null;
/**
 * A SAVE_SITE_LOCATION is in flight. Its payload is already built and the
 * message can't be called back, so the editor is frozen until it settles.
 */
let saving = false;
/**
 * The entry that save edits (null for a new one). "Use main location" waits
 * for the save too, so this popup can't remove what it's saving.
 */
let savingEntryId: string | null = null;
/** The editor's Remove is in flight. */
let removing = false;
/** The site "＋ Set a location for <site>" fills in, or null for the generic button. */
let addPrefill: string | null = null;
/** Where the editor that's closing returns to, for its focus fallback. */
let closingOrigin: EditorOrigin = "root";
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSeq = 0;

// ── Helpers ────────────────────────────────────────────────────────────────

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setHidden(id: string, hidden: boolean): void {
  const node = el(id);
  if (node) node.hidden = hidden;
}

function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

function storedList(settings: Settings | undefined): SiteLocation[] {
  return Array.isArray(settings?.siteLocations) ? settings.siteLocations : [];
}

/** The suggested pattern for the active tab, or null on restricted pages. */
function currentSuggestion(): string | null {
  const url = current?.tabUrl;
  if (!url || isRestrictedUrl(url)) return null;
  return suggestSiteLocationPattern(url);
}

/**
 * Split a comma-separated sites string into canonical entries (typed
 * patterns, `=` exact addresses, and `geosite:`/`list:` tokens), or report the
 * first bad token. Dedupes by entry identity as the background's save does, so
 * `münchen.de` and `xn--mnchen-3ya.de` count once (the first spelling is
 * kept), and a host with no A-label form is a bad token.
 */
export function parsePatternsField(raw: string): {
  patterns: string[];
  invalid: string | null;
} {
  const patterns: string[] = [];
  const keys = new Set<string>();
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  for (const token of tokens) {
    const canonical = parseSiteLocationEntry(token);
    const key = canonical === null ? null : siteLocationEntryKey(canonical);
    if (canonical === null || key === null) return { patterns, invalid: token };
    if (!keys.has(key)) {
      keys.add(key);
      patterns.push(canonical);
    }
  }
  return { patterns, invalid: null };
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Called from loadSettings() right after renderScope(), with the active tab's
 * top-level URL loadSettings read. Renders every surface. Returns true when a
 * site location applies to the active tab, so loadSettings can keep the
 * no-main-location warning off that tab only.
 */
export function renderSiteLocations(
  settings: Settings,
  proLocked = false,
  tabUrl?: string
): boolean {
  const applies = renderSiteLocationLine(settings, tabUrl, proLocked);
  renderSiteLocationsSection(settings, tabUrl, proLocked);
  renderSiteLocationDetails(settings, tabUrl, proLocked);
  return applies;
}

// ── Main tab: the one-line note ──────────────────────────────────────────────

/**
 * Decide the line's state. With the Pro lock on, the background forces scope
 * "all" and ignores site locations, so nothing applies. With the master switch
 * off it shows what this site WOULD get, as the location card above it keeps
 * naming the main location while protection is off. Filters-off sites,
 * unmatched sites, and restricted pages get nothing.
 */
export function computeSiteLocationLineState(
  settings: Settings,
  tabUrl: string | undefined,
  proLocked: boolean
): SiteLocationLineState {
  if (!tabUrl || isRestrictedUrl(tabUrl)) return { kind: "none" };
  const host = hostOf(tabUrl);
  if (host === null) return { kind: "none" };

  const effective: Settings = proLocked
    ? { ...settings, scopeMode: "all", siteLocations: [] }
    : settings;
  const resolution = resolveSiteSettings(
    { ...effective, enabled: true },
    tabUrl,
    isRestrictedUrl,
    popupSiteGroupLookup()
  );
  if (
    resolution.enabled &&
    resolution.siteLocation !== null &&
    resolution.matchedPattern !== null
  ) {
    return {
      kind: "applied",
      site: suggestSiteLocationPattern(tabUrl) ?? host,
      entry: resolution.siteLocation,
      pattern: resolution.matchedPattern,
      canUseMain: useMainDeliversMain(
        effective,
        tabUrl,
        host,
        resolution.siteLocation,
        resolution.matchedPattern
      ),
    };
  }
  return { kind: "none" };
}

/**
 * Whether "Use main location", which removes only the winning `pattern`,
 * gives exactly this site the main location. All must hold:
 *   - a main location is set, so removing the rule doesn't leave the site
 *     unspoofed;
 *   - the pattern is this site's own: its identity is the host's or the
 *     suggested pattern's, so `twitch.tv` on www.twitch.tv qualifies, while a
 *     wildcard like `*.ru` or a parent domain covering other sites doesn't;
 *   - with it removed, no other pattern gives this page a site location.
 */
function useMainDeliversMain(
  effective: Settings,
  tabUrl: string,
  host: string,
  entry: SiteLocation,
  pattern: string
): boolean {
  if (!effective.location) return false;
  const key = siteLocationPatternKey(pattern);
  const ownKeys = [parseSiteLocationPattern(host), suggestSiteLocationPattern(tabUrl)].map((own) =>
    own === null ? null : siteLocationPatternKey(own)
  );
  if (key === null || !ownKeys.includes(key)) return false;

  const remaining = storedList(effective).flatMap((e) => {
    if (e.id !== entry.id) return [e];
    const patterns = e.patterns.filter((p) => p !== pattern);
    return patterns.length > 0 ? [{ ...e, patterns }] : [];
  });
  const after = resolveSiteSettings(
    { ...effective, enabled: true, siteLocations: remaining },
    tabUrl,
    isRestrictedUrl,
    popupSiteGroupLookup()
  );
  return after.siteLocation === null;
}

/**
 * Render the Main-tab line for the active tab's URL. Returns true when a site
 * location applies. When none does, the line is hidden (no empty container),
 * unless it's showing the reload hint right after "Use main location".
 */
export function renderSiteLocationLine(
  settings: Settings,
  tabUrl: string | undefined,
  proLocked: boolean
): boolean {
  current = { settings, tabUrl, proLocked };
  wireLineOnce();
  wireEditorOnce();

  // A locked user can't edit; close an editor left open by an earlier render.
  if (proLocked && editor !== null) closeEditor(false);

  lineState = computeSiteLocationLineState(settings, tabUrl, proLocked);
  const applied = lineState.kind === "applied";
  setHidden("siteLocationLineError", true);
  setHidden("siteLocationLine", !applied && getReloadHintHost() !== "line");
  setHidden("siteLocationLineMain", !applied);
  setHidden("siteLocationLineUseMain", !(lineState.kind === "applied" && lineState.canUseMain));

  const status = el("siteLocationLineStatus");
  const editBtn = el("siteLocationLineEdit");
  if (lineState.kind === "applied") {
    const { site } = lineState;
    const place = siteLocationDisplayName(lineState.entry);
    if (status) {
      status.textContent = t("siteLocation_statusSite", [site, place]) || `On ${site}: ${place}`;
    }
    editBtn?.setAttribute(
      "aria-label",
      `${t("siteLocation_editAriaLabel") || "Edit location"} ${place}`
    );
  } else {
    if (status) status.textContent = "";
    editBtn?.removeAttribute("aria-label");
  }

  // VPN sync moves only the IP-derived main location; say so where one applies.
  setHidden("siteLocationLineVpnHint", !(applied && settings.vpnSyncEnabled === true));
  setHidden("siteLocationLineReloadHint", getReloadHintHost() !== "line");
  syncSavingEntryLocks();
  return applied;
}

function showLineError(text: string): void {
  const node = el("siteLocationLineError");
  if (!node) return;
  node.textContent = text;
  node.hidden = false;
}

function wireLineOnce(): void {
  const line = el("siteLocationLine");
  if (!line || line.dataset.wired === "1") return;
  line.dataset.wired = "1";

  el("siteLocationLineEdit")?.addEventListener("click", () => {
    openEditorFromLine();
  });
  el("siteLocationLineUseMain")?.addEventListener("click", () => {
    void handleUseMain();
  });
}

/**
 * "Edit" on the Main line: switch to the Filters tab (through its own tab
 * button, so index.ts stays the one place that switches views) and open the
 * applied entry in the editor, whose back row reads "‹ Main".
 */
function openEditorFromLine(): void {
  if (lineState.kind !== "applied" || current?.proLocked) return;
  const { entry } = lineState;
  el("filtersTab")?.click();
  openEditor({ entry, opener: el("siteLocationLineEdit"), origin: "main" });
}

/**
 * Drop the matched pattern only, so a multi-site entry keeps its other sites.
 * Offered only when that leaves this site on the main location.
 */
async function handleUseMain(): Promise<void> {
  if (lineState.kind !== "applied" || !lineState.canUseMain || current?.proLocked) return;
  const { entry, pattern } = lineState;
  if (entry.id === savingEntryId) return;
  setHidden("siteLocationLineError", true);
  const payload: RemoveSiteLocationPayload = { id: entry.id, pattern };
  try {
    const result = (await browser.runtime.sendMessage({
      type: "REMOVE_SITE_LOCATION",
      payload,
    })) as SiteLocationResponse;
    if (result && "success" in result && result.success) {
      if (editor?.entry?.id === entry.id) closeEditor(false);
      clearCardUndo();
      setReloadHintHost("line");
      await loadSettings();
      // The re-render hid this button along with the rest of the line.
      focusReloadHint("siteLocationLineReloadHint");
      announceReloadHint();
      return;
    }
  } catch (error: unknown) {
    console.error("Failed to remove the site location:", error);
  }
  showLineError(t("filters_notSaved") || "⚠ Change not saved");
}

/**
 * After an action whose button the re-render hides, focus the reload hint it
 * revealed, so Tab continues from there instead of from the top of the popup.
 * `announce` speaks the confirmation.
 */
function focusReloadHint(id: string): void {
  const hint = el(id);
  if (isFocusable(hint)) hint.focus();
}

/** The reload hint a change returns to: on the screen the editor goes back to. */
function hostForOrigin(origin: EditorOrigin): ReloadHintHost {
  return origin === "perSite" ? "perSite" : origin === "main" ? "line" : "card";
}

/** The element of each reload hint host. */
function reloadHintIdFor(origin: EditorOrigin): string {
  return origin === "perSite"
    ? "siteLocationsReloadHint"
    : origin === "main"
      ? "siteLocationLineReloadHint"
      : "thisSiteReloadHint";
}

/** Show the reload hint where the last change from this popup put it, and nowhere else. */
function syncReloadHints(): void {
  const host = getReloadHintHost();
  setHidden("siteLocationsReloadHint", host !== "perSite");
  setHidden("siteLocationEditorReloadHint", host !== "editor");
  setHidden("siteLocationLineReloadHint", host !== "line");
  setHidden("siteLocationLine", lineState.kind !== "applied" && host !== "line");
  // The This site card's hint, for an editor opened from the card that closes
  // without a re-render. Its action area isn't rendered when it would be
  // empty (this-site-card.ts applies the same rule).
  setHidden("thisSiteReloadHint", host !== "card");
  const cardActions = el("thisSiteActions");
  if (cardActions) {
    cardActions.hidden = Array.from(cardActions.children).every(
      (child) => (child as HTMLElement).hidden
    );
  }
}

/**
 * Where focus goes on the Filters root when the card's opener is gone: the
 * card's row when it opens something, else its reload hint.
 */
function cardFocusTarget(): HTMLElement | null {
  const row = el("thisSiteRow")?.querySelector<HTMLElement>(".site-row[role='button']") ?? null;
  if (isFocusable(row)) return row;
  const hint = el("thisSiteReloadHint");
  return isFocusable(hint) ? hint : null;
}

/** The confirmation after a change: the same words as the visible reload hint. */
function announceReloadHint(): void {
  announce(t("siteLocation_reloadHint") || "Reload affected pages to apply the change.");
}

// ── Filters: the root's row and the Per-site locations screen ───────────────

/**
 * Render the Filters root's "Per-site locations" row and the Per-site
 * locations screen: one site row per entry, and "＋ Set a location for <site>".
 */
export function renderSiteLocationsSection(
  settings: Settings,
  tabUrl: string | undefined,
  proLocked: boolean
): void {
  current = { settings, tabUrl, proLocked };
  wireFiltersNavOnce();
  wireSectionOnce();
  wireEditorOnce();

  // A locked user can't edit; close an editor left open by an earlier render,
  // and leave the screen that no longer applies.
  if (proLocked && editor !== null) closeEditor(false);
  if (proLocked && getFiltersScreen() === "perSite") {
    backFromFiltersScreen({ restoreFocus: false });
  }

  const entries = storedList(settings);
  renderRootRow(entries.length, proLocked);

  const listEl = el("siteLocationsList");
  if (!listEl) return;
  clearChildren(listEl);
  const args = filterArgs(settings);
  entries.forEach((entry, index) => {
    listEl.appendChild(buildSiteLocationRow(entry, index, args));
  });
  syncSavingEntryLocks();

  setHidden("siteLocationsError", true);
  renderAddButton(entries, tabUrl, proLocked);
  syncReloadHints();
  if (editor !== null) {
    renderEditorChrome();
    updateEditorHints();
  }
}

/**
 * "Per-site locations   2 ›" on the root, described as "2 locations".
 * Locked, it stays a Tab stop, also described by the Pro note, but it's
 * inert and shows 🔒 (H-8).
 */
function renderRootRow(count: number, proLocked: boolean): void {
  const n = formatCount(count);
  const value = el("siteLocationsRowValue");
  if (value) value.textContent = n;
  const desc = el("siteLocationsRowDesc");
  if (desc) {
    desc.textContent =
      count === 0
        ? t("siteLocation_noLocations") || "None"
        : count === 1
          ? t("siteLocation_countLocationsOne") || "1 location"
          : t("siteLocation_countLocations", [n]) || `${n} locations`;
  }
  const row = el("siteLocationsRow");
  if (row) {
    if (proLocked) {
      row.setAttribute("aria-disabled", "true");
      row.setAttribute("aria-describedby", "siteLocationsRowDesc scopeProNote");
    } else {
      row.removeAttribute("aria-disabled");
      row.setAttribute("aria-describedby", "siteLocationsRowDesc");
    }
  }
  const chev = el("siteLocationsRowChev");
  if (chev) chev.textContent = proLocked ? "🔒" : "›";
}

/** The mark check reads the active list only (siteLocationFiltersMark). */
function filterArgs(settings: Settings): FilterListArgs {
  return {
    scopeMode: settings.scopeMode ?? "all",
    allowlist: settings.allowlist ?? [],
    denylist: settings.denylist ?? [],
    siteGroups: popupSiteGroupLookup(),
    proFeaturesBlocked: settings.proFeaturesBlocked,
  };
}

/**
 * Up to two sites by name; more reads "a.com, b.com and 3 more", so a mark
 * stays one line.
 */
function formatHostList(hosts: readonly string[]): string {
  if (hosts.length <= 2) return hosts.join(", ");
  const first = hosts.slice(0, 2).join(", ");
  const more = formatCount(hosts.length - 2);
  return t("siteLocation_sitesAndMore", [first, more]) || `${first} and ${more} more`;
}

/**
 * The mark under an entry's sites (M2, M13): the plain wording only when the
 * entry has one site; otherwise it names the sites it's about.
 */
function markText(mark: SiteLocationMarkText): string | null {
  if (mark === null) return null;
  switch (mark.key) {
    case "siteLocation_notUsed":
      return t("siteLocation_notUsed") || "Not used · Off in Sites";
    case "siteLocation_notUsedOn": {
      const sites = formatHostList(mark.hosts);
      return t("siteLocation_notUsedOn", [sites]) || `Not used on ${sites} · Off in Sites`;
    }
    case "siteLocation_somePages":
      return t("siteLocation_somePages") || "Used on some pages only";
    case "siteLocation_somePagesOn": {
      const sites = formatHostList(mark.hosts);
      return t("siteLocation_somePagesOn", [sites]) || `Used on some pages of ${sites} only`;
    }
  }
}

/** One entry as a site row: its sites, its place and ›, and any Filters mark. Opens the editor. */
function buildSiteLocationRow(
  entry: SiteLocation,
  index: number,
  args: FilterListArgs
): HTMLElement {
  const item = document.createElement("div");
  item.setAttribute("role", "listitem");
  item.dataset.siteLocationId = entry.id;

  const titles = entry.patterns.map((pattern) => describeEntry(pattern).title);
  const sites = titles.join(", ");
  const mark = markText(siteLocationMarkText(siteLocationFiltersMark(entry.patterns, args)));
  const { row, description } = buildSiteRow({
    host: sites,
    value: siteLocationDisplayName(entry),
    sub: mark,
    warn: mark !== null,
    opens: true,
    description: t("siteLocation_changeAria", [sites]) || `Change the location for ${sites}`,
    idPrefix: `sl-${index}`,
    // Local monogram from the first site; never a favicon fetch.
    badge: titles[0] ?? siteLocationDisplayName(entry),
    onActivate: () => {
      openEditor({ entry, opener: row, origin: "perSite" });
    },
  });
  item.appendChild(row);
  if (description) item.appendChild(description);
  return item;
}

/** The site row of the entry with this id on the Per-site locations screen. */
function siteRowFor(id: string): HTMLElement | null {
  for (const item of Array.from(el("siteLocationsList")?.children ?? [])) {
    if ((item as HTMLElement).dataset.siteLocationId === id) {
      return item.querySelector<HTMLElement>(".site-row");
    }
  }
  return null;
}

/**
 * "＋ Set a location for twitch.tv" fills the site in, when it has no entry of
 * its own; otherwise "＋ Set a location for a site" opens with no sites, so it
 * can't run into the entry that already has it.
 */
function renderAddButton(
  entries: readonly SiteLocation[],
  tabUrl: string | undefined,
  proLocked: boolean
): void {
  const site = currentSuggestion();
  addPrefill =
    site !== null && tabUrl !== undefined && !ownSiteLocationExists(entries, site, tabUrl)
      ? site
      : null;
  const label = el("siteLocationsAddLabel");
  if (label) {
    label.textContent =
      addPrefill !== null
        ? t("siteLocation_setForSite", [addPrefill]) || `Set a location for ${addPrefill}`
        : t("siteLocation_add") || "Set a location for a site";
  }
  const btn = el<HTMLButtonElement>("siteLocationsAddButton");
  if (btn) btn.disabled = proLocked;
}

function wireSectionOnce(): void {
  const btn = el("siteLocationsAddButton");
  if (!btn || btn.dataset.wired === "1") return;
  btn.dataset.wired = "1";
  btn.addEventListener("click", () => {
    openEditor({ entry: null, opener: btn, origin: "perSite", prefill: addPrefill });
  });

  const row = el("siteLocationsRow");
  if (row) {
    wireButtonRow(row, () => {
      if (current?.proLocked) return;
      openFiltersScreen("perSite", { opener: row });
    });
  }
  setFiltersScreenFallback("perSite", () => el("siteLocationsRow"));
}

// ── Details tab ─────────────────────────────────────────────────────────────

/**
 * "Place (host) · Area/Zone" when a site location applies to this tab;
 * otherwise the section is hidden. Uses the real master switch, since Details
 * reports what is actually spoofed right now.
 */
export function renderSiteLocationDetails(
  settings: Settings,
  tabUrl: string | undefined,
  proLocked = false
): void {
  const node = el("detailSiteLocation");
  const section = el("detailSiteLocationSection");
  if (!node || !section) return;

  if (!proLocked && tabUrl && !isRestrictedUrl(tabUrl)) {
    const resolution = resolveSiteSettings(
      settings,
      tabUrl,
      isRestrictedUrl,
      popupSiteGroupLookup()
    );
    const host = hostOf(tabUrl);
    if (resolution.siteLocation !== null && host !== null) {
      const place = siteLocationDisplayName(resolution.siteLocation);
      node.textContent = `${place} (${host}) · ${resolution.siteLocation.timezone.identifier}`;
      section.hidden = false;
      return;
    }
  }
  node.textContent = "";
  section.hidden = true;
}

// ── The shared editor ───────────────────────────────────────────────────────

/**
 * Open the editor on its own screen. A new entry starts with `prefill` as its
 * site, else with none. Focus goes to what's left to do: Location when the
 * site is filled in, Sites when it isn't, and the title for an existing entry.
 */
function openEditor(args: {
  entry: SiteLocation | null;
  opener: HTMLElement | null;
  origin: EditorOrigin;
  prefill?: string | null;
}): void {
  if (current?.proLocked || saving) return;
  const editorEl = el("siteLocationEditor");
  if (!editorEl) return;

  const { entry } = args;
  const prefill = entry ? null : (args.prefill ?? null);
  editor = {
    entry,
    entries: entry ? [...entry.patterns] : prefill !== null ? [prefill] : [],
    chosen: entry
      ? {
          latitude: entry.location.latitude,
          longitude: entry.location.longitude,
          name: siteLocationDisplayName(entry),
        }
      : null,
    ownerId: null,
    opener: args.opener,
    origin: args.origin,
    filtersAction: null,
  };

  // The sites show as chips; the input starts empty for adding more.
  const patternsInput = el<HTMLInputElement>("siteLocationPatterns");
  editorControl?.reset();
  if (patternsInput) {
    patternsInput.value = "";
    patternsInput.removeAttribute("aria-invalid");
  }
  renderEntryChips();
  const searchInput = el<HTMLInputElement>("siteLocationSearch");
  if (searchInput) searchInput.value = "";
  // "What can I add?" starts collapsed for each entry.
  const syntax = el<HTMLDetailsElement>("siteLocationSyntax");
  if (syntax) syntax.open = false;
  clearSearchResults();
  hideEditorError();

  renderEditorChrome();
  updateChosen();
  updateEditorHints();
  // With the site already filled in, what's left to do is pick the place (S6).
  const focus = entry !== null ? null : prefill !== null ? searchInput : patternsInput;
  openFiltersScreen("editor", { opener: args.opener, editorOrigin: args.origin, focus });
}

/**
 * Open the editor from outside this module (the This site card's row): on
 * the stored entry with `entryId`, or a new entry with `prefill` as its site
 * when `entryId` is null. Nothing opens for an id that's no longer stored.
 */
export function openSiteLocationEditor(args: {
  entryId: string | null;
  opener: HTMLElement | null;
  origin: EditorOrigin;
  prefill?: string | null;
}): void {
  const entry =
    args.entryId === null
      ? null
      : (storedList(current?.settings).find((e) => e.id === args.entryId) ?? null);
  if (args.entryId !== null && entry === null) return;
  openEditor({ entry, opener: args.opener, origin: args.origin, prefill: args.prefill });
}

/** The open editor's unsaved state, for the S7 draft; null when no editor is open. */
export function readEditorDraft(): EditorDraft | null {
  if (editor === null) return null;
  return {
    origin: editor.origin,
    entryId: editor.entry?.id ?? null,
    entries: [...editor.entries],
    pending: el<HTMLInputElement>("siteLocationPatterns")?.value ?? "",
    chosen: editor.chosen === null ? null : { ...editor.chosen },
    search: el<HTMLInputElement>("siteLocationSearch")?.value ?? "",
  };
}

/**
 * Put a kept draft back into the editor that's open (drafts.ts opens it with
 * {@link openSiteLocationEditor} first): its sites, the text still in the
 * Sites input, the chosen place, and the search text, whose search runs again.
 */
export function applyEditorDraft(
  draft: Pick<EditorDraft, "entries" | "pending" | "chosen" | "search">
): void {
  if (editor === null || saving) return;
  editor.entries = mergeEntries([], draft.entries).slice(0, MAX_PATTERNS_PER_SITE_LOCATION);
  editor.chosen = draft.chosen === null ? null : { ...draft.chosen };
  const patternsInput = el<HTMLInputElement>("siteLocationPatterns");
  if (patternsInput) patternsInput.value = draft.pending;
  const search = el<HTMLInputElement>("siteLocationSearch");
  const query = editor.chosen === null ? draft.search : "";
  if (search) search.value = query;
  renderEntryChips();
  hideEditorError();
  updateChosen();
  updateEditorHints();
  if (query.trim() !== "") onSearchInput(query.trim());
  saveFiltersDraft();
}

/** The editor's title, and Remove for an existing entry. */
function renderEditorChrome(): void {
  const title = el("siteLocationEditorTitle");
  if (title && editor) {
    title.textContent = editor.entry
      ? t("siteLocation_srcSite") || "Per-site location"
      : t("siteLocation_newLocation") || "New per-site location";
  }
  setHidden("siteLocationRemove", editor?.entry == null);
}

/**
 * Close the editor and go back to where it was opened from. A reload hint
 * shown in the editor moves with it to that screen.
 */
function closeEditor(restoreFocus: boolean): void {
  const state = editor;
  editor = null;
  clearSearchResults();
  hideEditorError();
  updateEditorHints();
  if (state !== null) {
    closingOrigin = state.origin;
    if (getReloadHintHost() === "editor") setReloadHintHost(hostForOrigin(state.origin));
  }
  syncReloadHints();
  // Leaving the screen rewrites the S7 draft without the editor; otherwise
  // (the Pro lock closed it elsewhere) drop the editor from it here.
  if (getFiltersScreen() === "editor") backFromFiltersScreen({ restoreFocus });
  else saveFiltersDraft();
}

/**
 * After a save, focus the opener if it's still on screen. The list and the
 * card's row are rebuilt on every loadSettings, so a row that opened the
 * editor is usually detached by then: focus the entry's new row (the card's
 * row, from the root), else the reload hint of the screen the editor
 * returned to.
 */
function focusAfterEditorChange(state: EditorState, entryId: string | null): void {
  if (isFocusable(state.opener)) {
    state.opener.focus();
    return;
  }
  if (state.origin === "root") {
    cardFocusTarget()?.focus();
    return;
  }
  const row = state.origin === "perSite" && entryId !== null ? siteRowFor(entryId) : null;
  if (isFocusable(row)) {
    row.focus();
    return;
  }
  focusReloadHint(reloadHintIdFor(state.origin));
}

/** Where focus goes when the editor closes and its opener is gone. */
function editorFallback(): HTMLElement | null {
  if (closingOrigin === "perSite") return el("siteLocationsAddButton");
  if (closingOrigin === "main") return el("siteLocationLineEdit");
  return cardFocusTarget();
}

/**
 * The editor's in-context hints. VPN: with Sync with VPN on, sites still see
 * the VPN's IP. Filters: when Filters keep GeoSpoof off on this tab and a site
 * in the Sites field covers it, the location isn't used here: "Not used · Off
 * in Filters" with one site, else "Not used on twitch.tv · Off in Filters",
 * which names the tab's site (M13). Its button is the This site card's list
 * change, by the card's rule, so it's offered only when that one change turns
 * this site on, and not at all when a broad or path entry keeps it off.
 */
function updateEditorHints(): void {
  updateSaveEnabled();
  setHidden("siteLocationVpnHint", !(editor !== null && current?.settings.vpnSyncEnabled === true));

  const button = el("siteLocationFiltersAction");
  const conflict = editor !== null && current !== null && computeConflict();
  if (!conflict || editor === null || current === null) {
    if (editor !== null) editor.filtersAction = null;
    setHidden("siteLocationFiltersHint", true);
    if (button) button.hidden = true;
    return;
  }
  const { settings, tabUrl, proLocked } = current;
  const card = computeThisSiteCard({
    settings: { ...settings, enabled: true },
    tabUrl,
    proLocked,
    isOptionsPage: tabUrl !== undefined && isOwnExtensionPage(tabUrl),
    isRestricted: isRestrictedUrl,
    siteGroups: popupSiteGroupLookup(),
    undo: getCardUndo(),
  });
  const action = card.kind === "shown" ? listActionOf(card.button) : null;
  editor.filtersAction = action;
  const site = currentSuggestion() ?? (tabUrl ? hostOf(tabUrl) : null) ?? "";

  const text = el("siteLocationFiltersHintText");
  if (text) {
    text.textContent =
      editorEntriesWithPending().entries.length === 1
        ? t("siteLocation_notUsed") || "Not used · Off in Sites"
        : t("siteLocation_notUsedOn", [site]) || `Not used on ${site} · Off in Sites`;
  }
  if (button) {
    if (action === null || card.kind !== "shown") {
      button.hidden = true;
      button.removeAttribute("aria-label");
    } else {
      const label = filtersActionLabel(action);
      button.textContent = label;
      button.setAttribute("aria-label", filtersActionAriaLabel(label, card.site));
      button.hidden = false;
    }
  }
  setHidden("siteLocationFiltersHint", false);
}

/** Filters keep GeoSpoof off on this tab, and a site in the Sites field covers it. */
function computeConflict(): boolean {
  if (!current) return false;
  const { settings, tabUrl } = current;
  if (!tabUrl || isRestrictedUrl(tabUrl)) return false;
  const mode = settings.scopeMode;
  if (mode !== "allowlist" && mode !== "denylist") return false;
  const groups = popupSiteGroupLookup();
  if (
    resolveSiteSettings({ ...settings, enabled: true }, tabUrl, isRestrictedUrl, groups).enabled
  ) {
    return false;
  }
  const host = hostOf(tabUrl);
  return editorEntriesWithPending().entries.some((p) =>
    isSiteGroupToken(p) ? host !== null && groups.has(p, host) : matchesPattern(tabUrl, p)
  );
}

/** Add `more` to `base`, skipping entries `base` already has by identity. */
function mergeEntries(base: readonly string[], more: readonly string[]): string[] {
  const merged = [...base];
  const keys = new Set(base.map((entry) => siteLocationEntryKey(entry) ?? entry));
  for (const entry of more) {
    const key = siteLocationEntryKey(entry) ?? entry;
    if (!keys.has(key)) {
      keys.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

/**
 * The editor's chips plus what's still typed in the Sites input (which Save
 * adds too), or the message for the first bad typed site.
 */
function editorEntriesWithPending(): { entries: string[]; error: string | null } {
  const entries = editor?.entries ?? [];
  const pending = editorControl?.readPending() ?? null;
  if (pending === null) return { entries: [...entries], error: null };
  if (pending.error !== null) return { entries: [...entries], error: pending.error };
  return { entries: mergeEntries(entries, pending.entries), error: null };
}

/** Render the editor's sites as chips, each with a ✕. */
function renderEntryChips(): void {
  const list = el("siteLocationEntries");
  if (!list) return;
  clearChildren(list);
  (editor?.entries ?? []).forEach((entry, index) => {
    list.appendChild(buildEntryChip(entry, index));
  });
  updateSaveEnabled();
}

function buildEntryChip(entry: string, index: number): HTMLElement {
  // A chip added in this editor has no group or list data until Save builds
  // it, so it isn't "Not available".
  const unsaved = !(editor?.entry?.patterns.includes(entry) ?? false);
  const display = describeEntry(entry, { unsaved });
  const chip = document.createElement("div");
  chip.className = "entry-chip";
  chip.setAttribute("role", "listitem");
  chip.title = display.tooltip;

  const text = document.createElement("span");
  text.className = "entry-chip-text";
  const title = document.createElement("span");
  title.className = "entry-chip-title";
  title.textContent = display.title;
  text.appendChild(title);
  if (display.meta !== null) {
    text.appendChild(buildEntryMeta(display.meta, display.warning, "entry-chip-meta"));
  }
  chip.appendChild(text);

  const label = `${t("filters_removeAriaLabel") || "Remove site"} ${display.title}`;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "entry-chip-remove";
  remove.textContent = "✕";
  remove.setAttribute("aria-label", label);
  remove.title = label;
  remove.disabled = saving;
  remove.addEventListener("click", () => {
    removeEntryChip(index);
  });
  chip.appendChild(remove);
  return chip;
}

/** Drop a chip; focus moves to the ✕ that took its place, else the one before, else the input. */
function removeEntryChip(index: number): void {
  if (!editor || saving) return;
  editor.entries.splice(index, 1);
  renderEntryChips();
  hideEditorError();
  updateChosen();
  updateEditorHints();
  saveFiltersDraft();
  const buttons = el("siteLocationEntries")?.querySelectorAll<HTMLElement>(".entry-chip-remove");
  const next = buttons?.[Math.min(index, buttons.length - 1)] ?? null;
  const target = isFocusable(next) ? next : el("siteLocationPatterns");
  if (isFocusable(target)) target.focus();
}

/**
 * The add control's submit in the editor: add the sites as chips (typed
 * sites may be comma-separated). One already there is skipped; more than
 * {@link MAX_PATTERNS_PER_SITE_LOCATION} keeps the input and says so.
 */
function addEditorEntries(entries: string[]): Promise<EntrySubmitResult> {
  if (!editor || saving) return Promise.resolve({ ok: false, message: notSavedText() });
  const merged = mergeEntries(editor.entries, entries);
  if (merged.length > MAX_PATTERNS_PER_SITE_LOCATION) {
    return Promise.resolve({ ok: false, message: tooManySitesError() });
  }
  editor.entries = merged;
  renderEntryChips();
  hideEditorError();
  // The input still holds the added text until this resolves; merging it again
  // changes nothing, so the summary and hints are already right.
  updateChosen();
  updateEditorHints();
  // The control empties the input once this resolves.
  saveFiltersDraft({ pending: "" });
  return Promise.resolve({ ok: true });
}

function notSavedText(): string {
  return t("filters_notSaved") || "⚠ Change not saved";
}

/** The Filters hint's button: the card's list change (ADD_SCOPE_SITE or REMOVE_SCOPE_SITE). */
async function handleFiltersAction(): Promise<void> {
  const action = editor?.filtersAction ?? null;
  if (action === null || current?.proLocked) return;
  hideEditorError();
  if (await sendFiltersAction(action)) {
    clearCardUndo();
    // The editor stays open; the re-render recomputes the hint and hides
    // this button with it, and the reload hint shows in the editor.
    setReloadHintHost("editor");
    await loadSettings();
    focusReloadHint("siteLocationEditorReloadHint");
    announceReloadHint();
    return;
  }
  showEditorError(notSavedText());
}

function clearSearchResults(): void {
  clearTimeout(searchTimer);
  searchSeq++;
  const results = el("siteLocationResults");
  if (results) clearChildren(results);
}

/**
 * The favorites under the Location field, as suggestions (S6): those whose
 * name, city or country contains the field's text. Shown only while no place
 * is chosen, and not at all when none match.
 */
function renderFavorites(): void {
  const wrap = el("siteLocationFavorites");
  const list = el("siteLocationFavoritesList");
  if (!wrap || !list) return;
  clearChildren(list);
  const query = (el<HTMLInputElement>("siteLocationSearch")?.value ?? "").trim().toLowerCase();
  const favorites =
    editor !== null && editor.chosen === null ? (current?.settings.favorites ?? []) : [];
  for (const favorite of favorites) {
    const name = getChipDisplayText(favorite);
    const fields = [name, favorite.city, favorite.country];
    if (query !== "" && !fields.some((field) => field.toLowerCase().includes(query))) continue;
    list.appendChild(buildFavoriteSuggestion(favorite, name));
  }
  wrap.hidden = list.childElementCount === 0;
}

function buildFavoriteSuggestion(favorite: Favorite, name: string): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "favorite-suggestion";
  button.dataset.favoriteId = favorite.id;
  button.disabled = saving;
  const nameEl = document.createElement("span");
  nameEl.className = "favorite-suggestion-name";
  nameEl.textContent = name;
  button.appendChild(nameEl);
  if (favorite.country.length > 0) {
    const sub = document.createElement("span");
    sub.className = "favorite-suggestion-sub";
    sub.textContent = favorite.country;
    button.appendChild(sub);
  }
  button.addEventListener("click", () => {
    const picked = choose({
      latitude: favorite.latitude,
      longitude: favorite.longitude,
      name,
      locationName: {
        city: favorite.city,
        country: favorite.country,
        displayName: favorite.displayName,
      },
      label: favorite.label,
    });
    if (picked) focusAfterChoose();
  });
  return button;
}

/**
 * The chosen place as a token in the Location field, with a ✕ that clears it.
 * Rebuilt only when the place changes, so the live region speaks once and a
 * focused ✕ keeps focus.
 */
function renderChosenToken(chosen: ChosenLocation | null): void {
  const host = el("siteLocationChosen");
  if (!host) return;
  const name = chosen?.name ?? null;
  if ((host.dataset.name ?? null) === name) return;
  clearChildren(host);
  if (name === null) {
    delete host.dataset.name;
    return;
  }
  host.dataset.name = name;

  const field = document.createElement("div");
  field.className = "token-field";
  field.setAttribute("role", "group");
  field.setAttribute("aria-labelledby", "siteLocationSearchLabel");
  const chip = document.createElement("span");
  chip.className = "entry-chip";
  const text = document.createElement("span");
  text.className = "entry-chip-text";
  const title = document.createElement("span");
  title.className = "entry-chip-title";
  title.textContent = name;
  text.appendChild(title);
  chip.appendChild(text);

  const label = `${t("siteLocation_removeAriaLabel") || "Remove location"} ${name}`;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "entry-chip-remove";
  remove.textContent = "✕";
  remove.setAttribute("aria-label", label);
  remove.title = label;
  remove.disabled = saving;
  remove.addEventListener("click", clearChosen);
  chip.appendChild(remove);
  field.appendChild(chip);
  host.appendChild(field);
}

/** The token's ✕: forget the place and go back to the Location field. */
function clearChosen(): void {
  if (!editor || saving) return;
  editor.chosen = null;
  hideEditorError();
  updateChosen();
  saveFiltersDraft();
  const search = el("siteLocationSearch");
  if (isFocusable(search)) search.focus();
}

/**
 * Show the chosen place (a token in place of the search field, results and
 * favorites) and the plain-language summary of what saving does.
 */
function updateChosen(): void {
  const chosen = editor?.chosen ?? null;
  renderChosenToken(chosen);
  setHidden("siteLocationSearch", chosen !== null);
  setHidden("siteLocationResults", chosen !== null);
  renderFavorites();
  updateSaveEnabled();

  const explainEl = el("siteLocationExplain");
  if (!explainEl) return;
  const { entries, error } = editorEntriesWithPending();
  if (!chosen || error !== null || entries.length === 0) {
    explainEl.textContent = "";
    return;
  }
  const sites = entries.map((entry) => describeEntry(entry).title).join(", ");
  explainEl.textContent =
    t("siteLocation_explain", [sites, chosen.name]) || `Pages on ${sites} will see ${chosen.name}.`;
}

/**
 * Save works only once there's a site and a place (S6). Text in the Sites
 * input that doesn't parse leaves the chips as the sites; Save then shows why.
 */
function updateSaveEnabled(): void {
  const save = el<HTMLButtonElement>("siteLocationSave");
  if (!save) return;
  const ready =
    editor !== null && editor.chosen !== null && editorEntriesWithPending().entries.length > 0;
  save.disabled = saving || !ready;
}

/** Pick a place. False when nothing changed (no editor, or a save in flight). */
function choose(chosen: ChosenLocation): boolean {
  if (!editor || saving) return false;
  editor.chosen = chosen;
  // The token takes the typed text's place in the field.
  const search = el<HTMLInputElement>("siteLocationSearch");
  if (search) search.value = "";
  clearSearchResults();
  hideEditorError();
  updateChosen();
  saveFiltersDraft();
  return true;
}

/** The picker hid with the choice; continue at Save, else at the token's ✕. */
function focusAfterChoose(): void {
  const save = el<HTMLButtonElement>("siteLocationSave");
  if (save && !save.disabled && isFocusable(save)) {
    save.focus();
    return;
  }
  const remove = el("siteLocationChosen")?.querySelector<HTMLElement>(".entry-chip-remove") ?? null;
  if (isFocusable(remove)) remove.focus();
}

function showEditorError(text: string, ownerId: string | null = null): void {
  const errorEl = el("siteLocationError");
  const textEl = el("siteLocationErrorText");
  if (!errorEl || !textEl) return;
  textEl.textContent = text;
  if (editor) editor.ownerId = ownerId;
  setHidden("siteLocationEditOwner", ownerId === null);
  errorEl.hidden = false;
}

function hideEditorError(): void {
  setHidden("siteLocationError", true);
  setHidden("siteLocationEditOwner", true);
  if (editor) editor.ownerId = null;
}

function patternError(): string {
  return (
    t("siteLocation_errorPattern") || "Use a site like example.com, with no path and not just *."
  );
}

function tooManySitesError(): string {
  const max = String(MAX_PATTERNS_PER_SITE_LOCATION);
  return t("siteLocation_errorTooManySites", [max]) || `One location can cover up to ${max} sites.`;
}

function wireEditorOnce(): void {
  const editorEl = el("siteLocationEditor");
  if (!editorEl || editorEl.dataset.wired === "1") return;
  editorEl.dataset.wired = "1";
  // The help's rows for the forms this build can't add, as the field can't.
  editorEl.querySelectorAll<HTMLElement>("[data-site-groups-only]").forEach((row) => {
    row.hidden = !siteGroupsAvailable();
  });

  editorControl = createEntryAddControl({
    ids: {
      input: "siteLocationPatterns",
      button: "siteLocationAddEntry",
      listbox: "siteLocationGroupListbox",
      attribution: "siteLocationGroupAttribution",
      error: "siteLocationError",
    },
    context: "siteLocation",
    onSubmit: (entries) => addEditorEntries(entries),
    emptySuggestion: () => {
      const site = currentSuggestion();
      const entry = site === null ? null : parseSiteLocationPattern(site);
      const key = entry === null ? null : siteLocationEntryKey(entry);
      if (entry === null || key === null || editor === null) return null;
      if (editor.entries.some((e) => (siteLocationEntryKey(e) ?? e) === key)) return null;
      return {
        entry,
        title: t("filters_addSite", [entry]) || `Add ${entry}`,
        meta: t("filters_typeSite") || "Site and its subdomains",
        kind: "site",
      };
    },
    showError: (message) => {
      showEditorError(message);
    },
    hideError: hideEditorError,
  });

  const patternsInput = el<HTMLInputElement>("siteLocationPatterns");
  patternsInput?.addEventListener("input", () => {
    patternsInput.removeAttribute("aria-invalid");
    hideEditorError();
    updateChosen();
    updateEditorHints();
    saveFiltersDraft();
  });

  el<HTMLInputElement>("siteLocationSearch")?.addEventListener("input", (e) => {
    onSearchInput((e.target as HTMLInputElement).value.trim());
    renderFavorites();
    saveFiltersDraft();
  });

  el("siteLocationSave")?.addEventListener("click", () => {
    void handleSave();
  });
  el("siteLocationCancel")?.addEventListener("click", () => {
    closeEditor(true);
  });
  el("siteLocationRemove")?.addEventListener("click", () => {
    void handleRemove();
  });
  el("siteLocationEditOwner")?.addEventListener("click", () => {
    const ownerId = editor?.ownerId;
    const owner = storedList(current?.settings).find((e) => e.id === ownerId);
    if (!editor || !owner) return;
    openEditor({ entry: owner, opener: editor.opener, origin: editor.origin });
  });
  el("siteLocationFiltersAction")?.addEventListener("click", () => {
    void handleFiltersAction();
  });
  // Escape and the back row go back like Cancel. A save in flight can't be
  // called back; the editor closes when it lands.
  setFiltersScreenBackHandler("editor", () => {
    if (!saving) closeEditor(true);
  });
  setFiltersScreenFallback("editor", editorFallback);
}

function onSearchInput(query: string): void {
  clearSearchResults();
  if (query.length < 3) return;

  const container = el("siteLocationResults");
  if (container) {
    const loading = document.createElement("div");
    loading.className = "loading";
    loading.textContent = t("search_searching") || "Searching...";
    container.appendChild(loading);
  }

  const seq = searchSeq;
  searchTimer = setTimeout(() => {
    void runSearch(query, seq);
  }, SEARCH_DEBOUNCE_MS);
}

async function runSearch(query: string, seq: number): Promise<void> {
  let results: GeocodeResult[] | null = null;
  try {
    const response = (await browser.runtime.sendMessage({
      type: "GEOCODE_QUERY",
      payload: { query },
    })) as GeocodeResponse;
    results = response?.results ?? [];
  } catch (error: unknown) {
    console.error("Geocoding failed:", error);
  }
  // A newer query, or closing the editor, supersedes this one.
  if (seq !== searchSeq || editor === null) return;
  renderSearchResults(results);
}

/** Results are real buttons so they're reachable and operable from the keyboard. */
export function renderSearchResults(results: GeocodeResult[] | null): void {
  const container = el("siteLocationResults");
  if (!container) return;
  clearChildren(container);

  if (results === null || results.length === 0) {
    const message = document.createElement("div");
    message.className = "no-results";
    message.textContent =
      results === null
        ? t("search_failed") || "Search failed. Please try again."
        : t("search_noResults") || "No locations found";
    container.appendChild(message);
    return;
  }

  for (const result of results) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "site-location-result";

    const nameEl = document.createElement("div");
    nameEl.className = "result-name";
    nameEl.textContent = result.name;
    const coordsEl = document.createElement("div");
    coordsEl.className = "result-coords";
    coordsEl.textContent = `${result.latitude.toFixed(5)}, ${result.longitude.toFixed(5)}`;
    button.append(nameEl, coordsEl);

    button.addEventListener("click", () => {
      const picked = choose({
        latitude: result.latitude,
        longitude: result.longitude,
        name: result.name,
        locationName: { city: result.city, country: result.country, displayName: result.name },
        label: null,
      });
      clearSearchResults();
      if (picked) focusAfterChoose();
    });
    container.appendChild(button);
  }
}

/** Map a SAVE_SITE_LOCATION error to its message (and the owner, for PATTERN_IN_USE). */
function saveErrorText(result: Extract<SiteLocationResponse, { error: unknown }>): {
  text: string;
  ownerId: string | null;
} {
  switch (result.error) {
    case "PATTERN_IN_USE": {
      const owner = storedList(current?.settings).find((e) => e.id === result.ownerId);
      const site = result.pattern ?? "";
      const place = owner ? siteLocationDisplayName(owner) : "";
      return {
        text: t("siteLocation_errorInUse", [site, place]) || `${site} already uses ${place}.`,
        ownerId: owner ? owner.id : null,
      };
    }
    case "AT_CAPACITY": {
      const max = String(MAX_SITE_LOCATIONS);
      return {
        text:
          t("siteLocation_errorCapacity", [max]) ||
          `You can have up to ${max} locations here. Remove one first.`,
        ownerId: null,
      };
    }
    case "TOO_MANY_PATTERNS":
      return { text: tooManySitesError(), ownerId: null };
    case "INVALID_PATTERN":
      return { text: patternError(), ownerId: null };
    case "INVALID_LOCATION":
      return {
        text: t("siteLocation_errorNoLocation") || "Choose a location first.",
        ownerId: null,
      };
    case "TIMEZONE_UNAVAILABLE":
      return {
        text:
          t("siteLocation_errorTimezone") ||
          "Couldn't look up this place's time zone. Check your connection and try again.",
        ownerId: null,
      };
    default:
      if (isSiteGroupErrorCode(result.error)) {
        return { text: siteGroupErrorText(result.error, result.pattern), ownerId: null };
      }
      return { text: t("filters_notSaved") || "⚠ Change not saved", ownerId: null };
  }
}

/** Validate inline, then send SAVE_SITE_LOCATION. Nothing is sent while the input is invalid. */
async function handleSave(): Promise<void> {
  if (!editor || removing || current?.proLocked) return;
  const state = editor;
  hideEditorError();

  // The chips, plus text still in the Sites input: Save adds it, as if Add
  // had been pressed.
  const patternsInput = el<HTMLInputElement>("siteLocationPatterns");
  const { entries: patterns, error: pendingError } = editorEntriesWithPending();
  if (pendingError !== null || patterns.length === 0) {
    patternsInput?.setAttribute("aria-invalid", "true");
    showEditorError(pendingError ?? patternError());
    patternsInput?.focus();
    return;
  }
  if (patterns.length > MAX_PATTERNS_PER_SITE_LOCATION) {
    patternsInput?.setAttribute("aria-invalid", "true");
    showEditorError(tooManySitesError());
    patternsInput?.focus();
    return;
  }
  const chosen = state.chosen;
  if (!chosen) {
    showEditorError(t("siteLocation_errorNoLocation") || "Choose a location first.");
    el("siteLocationSearch")?.focus();
    return;
  }

  const payload: SaveSiteLocationPayload = {
    patterns,
    latitude: chosen.latitude,
    longitude: chosen.longitude,
  };
  if (state.entry) payload.id = state.entry.id;
  if (chosen.locationName !== undefined) payload.locationName = chosen.locationName;
  if (chosen.label !== undefined) payload.label = chosen.label;

  // Results still listed, or a search reply still on its way, would offer a
  // choice the sent payload no longer reflects.
  clearSearchResults();
  setEditorSaving(true, state.entry?.id ?? null);
  let result: SiteLocationResponse | null = null;
  try {
    result = (await browser.runtime.sendMessage({
      type: "SAVE_SITE_LOCATION",
      payload,
    })) as SiteLocationResponse;
  } catch (error: unknown) {
    console.error("Failed to save the site location:", error);
  } finally {
    setEditorSaving(false);
  }

  if (result && "success" in result && result.success) {
    clearCardUndo();
    // The reload hint shows on the screen the editor returns to.
    setReloadHintHost(hostForOrigin(state.origin));
    // Nothing in the frozen editor can close it, but the Pro lock still can.
    // The list and the hint show the save anyway.
    const stillOpen = editor === state;
    if (stillOpen) closeEditor(false);
    await loadSettings();
    if (stillOpen) focusAfterEditorChange(state, result.id ?? state.entry?.id ?? null);
    announceReloadHint();
    return;
  }
  // The editor closed meanwhile, so there's no error area to show.
  if (editor !== state) return;

  const failure = result as Extract<SiteLocationResponse, { error: unknown }> | null;
  const { text, ownerId } = failure
    ? saveErrorText(failure)
    : { text: t("filters_notSaved") || "⚠ Change not saved", ownerId: null };
  showEditorError(text, ownerId);

  // Disabling the focused Save can drop focus to the page. Put it back on the
  // Sites field when the error is about a site, else on Save.
  const active = document.activeElement;
  if (active === null || active === document.body || active === el("siteLocationSave")) {
    const aboutSites =
      failure?.error === "PATTERN_IN_USE" ||
      failure?.error === "INVALID_PATTERN" ||
      failure?.error === "TOO_MANY_PATTERNS" ||
      isSiteGroupErrorCode(failure?.error);
    el(aboutSites ? "siteLocationPatterns" : "siteLocationSave")?.focus();
  }
}

/**
 * "Remove location": the entry goes, the editor returns to where it was
 * opened from, and the reload hint shows there. A failure keeps the editor,
 * and focus on Remove (aria-disabled, never disabled, while it's in flight).
 */
async function handleRemove(): Promise<void> {
  const state = editor;
  if (state === null || state.entry === null || saving || removing || current?.proLocked) return;
  hideEditorError();
  const button = el("siteLocationRemove");
  removing = true;
  button?.setAttribute("aria-disabled", "true");
  const payload: RemoveSiteLocationPayload = { id: state.entry.id };
  let removed = false;
  try {
    const result = (await browser.runtime.sendMessage({
      type: "REMOVE_SITE_LOCATION",
      payload,
    })) as SiteLocationResponse;
    removed = !!(result && "success" in result && result.success);
  } catch (error: unknown) {
    console.error("Failed to remove the site location:", error);
  } finally {
    removing = false;
    button?.removeAttribute("aria-disabled");
  }

  if (removed) {
    clearCardUndo();
    setReloadHintHost(hostForOrigin(state.origin));
    if (editor === state) closeEditor(false);
    await loadSettings();
    // The button that was pressed is gone; the confirmation took its place.
    // From the card, its row is rebuilt for the new answer, so focus that.
    if (state.origin === "root") cardFocusTarget()?.focus();
    else focusReloadHint(reloadHintIdFor(state.origin));
    announceReloadHint();
    return;
  }
  if (editor === state) showEditorError(notSavedText());
}

/** The editor's controls, all disabled while a save is in flight. */
const EDITOR_CONTROL_IDS = [
  "siteLocationPatterns",
  "siteLocationAddEntry",
  "siteLocationSearch",
  "siteLocationFiltersAction",
  "siteLocationEditOwner",
  "siteLocationSave",
  "siteLocationCancel",
  "siteLocationRemove",
] as const;

/**
 * Freeze or release the editor around SAVE_SITE_LOCATION. Cancel and Escape
 * can't undo a save already sent, and an edit made meanwhile would be
 * discarded when it lands, so every control is disabled and `aria-busy` tells
 * assistive tech the editor is updating. `entryId` is the edited entry, whose
 * removal waits for the save too.
 */
function setEditorSaving(on: boolean, entryId: string | null = null): void {
  saving = on;
  savingEntryId = on ? entryId : null;
  const editorEl = el("siteLocationEditor");
  if (on) editorEl?.setAttribute("aria-busy", "true");
  else editorEl?.removeAttribute("aria-busy");
  for (const id of EDITOR_CONTROL_IDS) {
    const control = el<HTMLInputElement | HTMLButtonElement>(id);
    if (control) control.disabled = on;
  }
  // The built buttons: each site's ✕, the place token's ✕, and the favorites.
  editorEl
    ?.querySelectorAll<HTMLButtonElement>(".entry-chip-remove, .favorite-suggestion")
    .forEach((button) => {
      button.disabled = on;
    });
  syncSavingEntryLocks();
  if (!on) updateSaveEnabled();
}

/**
 * Disable "Use main location" while a save in flight edits its entry, so a
 * remove from this popup can't overtake the save. (The editor's own Remove is
 * frozen with the rest of the editor.) Every render calls this too, so a
 * re-render during the save keeps it off.
 */
function syncSavingEntryLocks(): void {
  const useMain = el<HTMLButtonElement>("siteLocationLineUseMain");
  if (useMain) {
    useMain.disabled = lineState.kind === "applied" && lineState.entry.id === savingEntryId;
  }
}

/** Test hook: forget popup-session state between cases. */
export function __resetSiteLocationsForTest(): void {
  current = null;
  lineState = { kind: "none" };
  editor = null;
  editorControl = null;
  saving = false;
  savingEntryId = null;
  removing = false;
  addPrefill = null;
  closingOrigin = "root";
  clearTimeout(searchTimer);
  searchSeq = 0;
  __resetReloadHintForTest();
  __resetAnnounceForTest();
  clearCardUndo();
}
