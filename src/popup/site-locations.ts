/**
 * Popup Per-site locations
 *
 * Per-site locations are optional, so they stay out of the way until used.
 * Three surfaces onto `settings.siteLocations`:
 *   - the Main tab's one-line note (`#siteLocationLine`), rendered only when a
 *     site location applies to the active tab: "On twitch.tv: Mexico City",
 *     with Edit, and Use main location when removing this site's own rule
 *     leaves it on the main location. Nothing renders anywhere else;
 *   - the Filters tab's collapsed "Per-site locations" disclosure at the
 *     bottom: every entry, with edit and remove (optimistic, reverted on failure
 *     like the scope list), and the one editor;
 *   - the Details tab's readout, shown only when a site location applies.
 *
 * Hints are in context only: the Filters-conflict and VPN hints show inside the
 * editor (and the VPN hint under the Main line), and the reload hint only right
 * after a change made from this popup.
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
  ScopeResponse,
  ScopeSitePayload,
  SiteLocationResponse,
} from "@/shared/types/messages";
import { matchesPattern } from "@/shared/utils/scope";
import {
  parseSiteLocationPattern,
  resolveSiteSettings,
  siteLocationDisplayName,
  siteLocationPatternKey,
  suggestSiteLocationPattern,
} from "@/shared/utils/site-locations";
import { getChipDisplayText } from "./favorites";
import { buildMonogram } from "./scope";
import { isRestrictedUrl, loadSettings } from "./settings";
import { t } from "./i18n";
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
  chosen: ChosenLocation | null;
  /** The owner offered by a PATTERN_IN_USE error. */
  ownerId: string | null;
  /** Where focus returns when the editor closes. */
  opener: HTMLElement | null;
  /** Filters keep GeoSpoof off on this tab for a site in the Sites field. */
  conflict: { mode: "allowlist" | "denylist"; pattern: string } | null;
}

/** The last rendered inputs; the static controls' listeners read them. */
let current: { settings: Settings; tabUrl: string | undefined; proLocked: boolean } | null = null;
let lineState: SiteLocationLineState = { kind: "none" };
let editor: EditorState | null = null;
/**
 * A SAVE_SITE_LOCATION is in flight. Its payload is already built and the
 * message can't be called back, so the editor is frozen until it settles.
 */
let saving = false;
/**
 * Where the reload hint shows after a change made from this popup (open pages
 * keep old values until reloaded): under the Main line after "Use main
 * location", or in the Filters disclosure after any change made there.
 */
let reloadHintHost: "line" | "filters" | null = null;
/** The disclosure's open state is set once per popup session, then left to the user. */
let disclosureInitialized = false;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSeq = 0;
let announceTimer: ReturnType<typeof setTimeout> | undefined;

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
 * Split the sites field on commas into canonical patterns, or report the first
 * bad token. Dedupes by pattern identity as the background's save does, so
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
    const canonical = parseSiteLocationPattern(token);
    const key = canonical === null ? null : siteLocationPatternKey(canonical);
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
 * Called from loadSettings() right after renderScope(). Reads the active tab's
 * top-level URL (as Filters' "Add current site" does) and renders all three
 * surfaces. Resolves true when a site location applies to the active tab, so
 * loadSettings can keep the no-main-location warning off that tab only.
 */
export async function renderSiteLocations(settings: Settings, proLocked = false): Promise<boolean> {
  let tabUrl: string | undefined;
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    tabUrl = tabs[0]?.url;
  } catch (error: unknown) {
    console.error("Failed to read the current tab:", error);
  }
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
  const resolution = resolveSiteSettings({ ...effective, enabled: true }, tabUrl, isRestrictedUrl);
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
 * gives exactly this site the main location. Both must hold:
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
    isRestrictedUrl
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
  setHidden("siteLocationLine", !applied && reloadHintHost !== "line");
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
  setHidden("siteLocationLineReloadHint", reloadHintHost !== "line");
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
 * button, so index.ts stays the one place that switches views), expand the
 * disclosure, and open the applied entry in the editor.
 */
function openEditorFromLine(): void {
  if (lineState.kind !== "applied" || current?.proLocked) return;
  const { entry } = lineState;
  el("filtersTab")?.click();
  const disclosure = el<HTMLDetailsElement>("siteLocationsDisclosure");
  if (disclosure) disclosure.open = true;

  let opener: HTMLElement | null = null;
  const listEl = el("siteLocationsList");
  if (listEl) {
    for (const row of Array.from(listEl.children)) {
      if ((row as HTMLElement).dataset.siteLocationId === entry.id) {
        opener = row.querySelector<HTMLElement>(".site-location-edit");
        break;
      }
    }
  }
  openEditor({ entry, opener: opener ?? el("siteLocationsAddButton") });
}

/**
 * Drop the matched pattern only, so a multi-site entry keeps its other sites.
 * Offered only when that leaves this site on the main location.
 */
async function handleUseMain(): Promise<void> {
  if (lineState.kind !== "applied" || !lineState.canUseMain || current?.proLocked) return;
  const { entry, pattern } = lineState;
  setHidden("siteLocationLineError", true);
  const payload: RemoveSiteLocationPayload = { id: entry.id, pattern };
  try {
    const result = (await browser.runtime.sendMessage({
      type: "REMOVE_SITE_LOCATION",
      payload,
    })) as SiteLocationResponse;
    if (result && "success" in result && result.success) {
      if (editor?.entry?.id === entry.id) closeEditor(false);
      reloadHintHost = "line";
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

/** Long enough for screen readers to register the cleared region first. */
const ANNOUNCE_DELAY_MS = 100;

/**
 * Speak a confirmation through #siteLocationAnnouncer, the popup's one polite
 * live region for these changes. It sits outside every view, so it works from
 * either tab and with the disclosure closed. The region is cleared first and
 * the text set a moment later, so the same message repeated is spoken again; a
 * newer message replaces one still pending.
 */
function announce(text: string): void {
  const region = el("siteLocationAnnouncer");
  if (!region) return;
  clearTimeout(announceTimer);
  region.textContent = "";
  announceTimer = setTimeout(() => {
    region.textContent = text;
  }, ANNOUNCE_DELAY_MS);
}

/** The confirmation after a change: the same words as the visible reload hint. */
function announceReloadHint(): void {
  announce(t("siteLocation_reloadHint") || "Reload affected pages to apply the change.");
}

// ── Filters tab: the "Per-site locations" disclosure ────────────────────────

/** Render the Filters-tab disclosure and its list of site locations. */
export function renderSiteLocationsSection(
  settings: Settings,
  tabUrl: string | undefined,
  proLocked: boolean
): void {
  current = { settings, tabUrl, proLocked };
  wireSectionOnce();
  wireEditorOnce();

  // A locked user can't edit; close an editor left open by an earlier render.
  if (proLocked && editor !== null) closeEditor(false);

  const listEl = el("siteLocationsList");
  if (!listEl) return;

  const entries = storedList(settings);

  // Collapsed unless there's something in it. Only on the first render, so
  // the re-render after each action doesn't undo the user's own toggle.
  const disclosure = el<HTMLDetailsElement>("siteLocationsDisclosure");
  if (disclosure && !disclosureInitialized) {
    disclosure.open = !proLocked && entries.length > 0;
    disclosureInitialized = true;
  }

  clearChildren(listEl);
  for (const entry of entries) {
    listEl.appendChild(buildSiteLocationRow(entry, proLocked));
  }
  updateSectionCountFromDom();

  setHidden("siteLocationsError", true);
  setHidden("siteLocationsProNote", !proLocked);
  const addBtn = el<HTMLButtonElement>("siteLocationsAddButton");
  if (addBtn) addBtn.disabled = proLocked;
  setHidden("siteLocationsAddRow", editor !== null);
  setHidden("siteLocationsReloadHint", reloadHintHost !== "filters");
  if (editor !== null) updateEditorHints();
}

/** The count chip shows only when there's something to count. */
function updateSectionCountFromDom(): void {
  const listEl = el("siteLocationsList");
  const count = listEl ? listEl.children.length : 0;
  const countEl = el("siteLocationsCount");
  if (countEl) {
    countEl.textContent = String(count);
    countEl.hidden = count === 0;
  }
}

function buildSiteLocationRow(entry: SiteLocation, proLocked: boolean): HTMLElement {
  const name = siteLocationDisplayName(entry);
  const sites = entry.patterns.join(", ");

  const row = document.createElement("div");
  row.className = "scope-site-row";
  row.setAttribute("role", "listitem");
  row.dataset.siteLocationId = entry.id;

  // Local monogram from the first site; never a favicon fetch.
  row.appendChild(buildMonogram(entry.patterns[0] ?? name));

  const text = document.createElement("span");
  text.className = "site-location-text";
  const nameEl = document.createElement("span");
  nameEl.className = "site-location-name";
  nameEl.textContent = name;
  nameEl.title = name;
  const sitesEl = document.createElement("span");
  sitesEl.className = "site-location-patterns";
  sitesEl.textContent = sites;
  sitesEl.title = sites;
  text.append(nameEl, sitesEl);
  row.appendChild(text);

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "site-location-edit";
  editBtn.textContent = t("siteLocation_edit") || "Edit";
  editBtn.setAttribute(
    "aria-label",
    `${t("siteLocation_editAriaLabel") || "Edit location"} ${name}`
  );
  editBtn.disabled = proLocked;
  editBtn.addEventListener("click", () => {
    openEditor({ entry, opener: editBtn });
  });
  row.appendChild(editBtn);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "scope-site-remove";
  removeBtn.textContent = "✕";
  removeBtn.setAttribute(
    "aria-label",
    `${t("siteLocation_removeAriaLabel") || "Remove location"} ${name}`
  );
  removeBtn.disabled = proLocked;
  removeBtn.addEventListener("click", () => {
    void handleRemoveEntry(entry, row);
  });
  row.appendChild(removeBtn);

  return row;
}

function wireSectionOnce(): void {
  const btn = el("siteLocationsAddButton");
  if (!btn || btn.dataset.wired === "1") return;
  btn.dataset.wired = "1";
  btn.addEventListener("click", () => {
    openEditor({ entry: null, opener: btn });
  });
}

/**
 * After a remove, the focused ✕ is gone. Focus the Edit button of the row that
 * took its place, else the row before it, else "Set a location for a site".
 * Edit rather than the next ✕, so a repeated keypress can't remove a second
 * entry.
 */
function focusAfterRemove(index: number): void {
  const rows = el("siteLocationsList")?.children;
  for (const i of [index, index - 1]) {
    const edit = rows?.[i]?.querySelector<HTMLElement>(".site-location-edit") ?? null;
    if (isFocusable(edit)) {
      edit.focus();
      return;
    }
  }
  const addBtn = el("siteLocationsAddButton");
  if (isFocusable(addBtn)) addBtn.focus();
}

/** Optimistic removal with revert on failure, like the scope list's handleRemove. */
async function handleRemoveEntry(entry: SiteLocation, row: HTMLElement): Promise<void> {
  if (current?.proLocked) return;
  setHidden("siteLocationsError", true);

  const parent = row.parentNode;
  const nextSibling = row.nextSibling;
  const index = parent ? Array.from(parent.children).indexOf(row) : 0;
  row.remove();
  updateSectionCountFromDom();

  const payload: RemoveSiteLocationPayload = { id: entry.id };
  try {
    const result = (await browser.runtime.sendMessage({
      type: "REMOVE_SITE_LOCATION",
      payload,
    })) as SiteLocationResponse;
    if (result && "success" in result && result.success) {
      if (editor?.entry?.id === entry.id) closeEditor(false);
      reloadHintHost = "filters";
      await loadSettings();
      focusAfterRemove(index);
      announceReloadHint();
      return;
    }
  } catch (error: unknown) {
    console.error("Failed to remove the site location:", error);
  }

  if (parent) parent.insertBefore(row, nextSibling);
  updateSectionCountFromDom();
  setHidden("siteLocationsError", false);
  // The row is back; so is focus, on the ✕ that was pressed.
  const removeBtn = row.querySelector<HTMLElement>(".scope-site-remove");
  if (isFocusable(removeBtn)) removeBtn.focus();
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
    const resolution = resolveSiteSettings(settings, tabUrl, isRestrictedUrl);
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

function openEditor(args: { entry: SiteLocation | null; opener: HTMLElement | null }): void {
  if (current?.proLocked || saving) return;
  const editorEl = el("siteLocationEditor");
  if (!editorEl) return;

  const { entry } = args;
  editor = {
    entry,
    chosen: entry
      ? {
          latitude: entry.location.latitude,
          longitude: entry.location.longitude,
          name: siteLocationDisplayName(entry),
        }
      : null,
    ownerId: null,
    opener: args.opener,
    conflict: null,
  };

  const patternsInput = el<HTMLInputElement>("siteLocationPatterns");
  if (patternsInput) {
    patternsInput.value = entry ? entry.patterns.join(", ") : (currentSuggestion() ?? "");
    patternsInput.removeAttribute("aria-invalid");
  }
  const searchInput = el<HTMLInputElement>("siteLocationSearch");
  if (searchInput) searchInput.value = "";
  clearSearchResults();
  fillFavorites(current ? (current.settings.favorites ?? []) : []);
  hideEditorError();

  // The "Set a location for a site" row would only duplicate the open editor.
  setHidden("siteLocationsAddRow", true);
  editorEl.hidden = false;
  updateChosen();
  updateEditorHints();
  patternsInput?.focus();
}

function closeEditor(restoreFocus: boolean): void {
  const editorEl = el("siteLocationEditor");
  if (editorEl) editorEl.hidden = true;
  const opener = editor?.opener ?? null;
  editor = null;
  clearSearchResults();
  hideEditorError();
  setHidden("siteLocationsAddRow", false);
  updateEditorHints();
  if (restoreFocus) restoreFocusAfterEditor(opener);
}

/**
 * Focus the opener if it's still on screen. The list is rebuilt on every
 * loadSettings, so a row's Edit button is usually detached by then; fall back
 * to "Set a location for a site".
 */
function restoreFocusAfterEditor(opener: HTMLElement | null): void {
  if (isFocusable(opener)) {
    opener.focus();
    return;
  }
  const addBtn = el("siteLocationsAddButton");
  if (isFocusable(addBtn)) addBtn.focus();
}

function isFocusable(node: HTMLElement | null): node is HTMLElement {
  return node !== null && node.isConnected && node.closest("[hidden]") === null;
}

/**
 * The editor's in-context hints. VPN: with Sync with VPN on, sites still see
 * the VPN's IP. Filters: when Filters keep GeoSpoof off on this tab and a site
 * in the Sites field covers it, the site location wouldn't apply here. The
 * "this site" copy is exact then. Allowlist mode offers a one-tap add;
 * denylist mode only explains, because the blocking entry may be a broad
 * wildcard or a path pattern that removing this host wouldn't lift.
 */
function updateEditorHints(): void {
  setHidden("siteLocationVpnHint", !(editor !== null && current?.settings.vpnSyncEnabled === true));

  const conflict = editor !== null ? computeConflict() : null;
  if (editor !== null) editor.conflict = conflict;
  if (conflict === null) {
    setHidden("siteLocationFiltersHint", true);
    setHidden("siteLocationAddToAllowlist", true);
    return;
  }
  const text = el("siteLocationFiltersHintText");
  if (text) {
    text.textContent =
      conflict.mode === "allowlist"
        ? t("siteLocation_hintAllowlist") ||
          "Filters don't spoof this site. Add it to the allowlist?"
        : t("siteLocation_hintDenylist") ||
          "Filters don't spoof this site because it's on your denylist.";
  }
  setHidden("siteLocationAddToAllowlist", conflict.mode !== "allowlist");
  setHidden("siteLocationFiltersHint", false);
}

function computeConflict(): EditorState["conflict"] {
  if (!current) return null;
  const { settings, tabUrl } = current;
  if (!tabUrl || isRestrictedUrl(tabUrl)) return null;
  const mode = settings.scopeMode;
  if (mode !== "allowlist" && mode !== "denylist") return null;
  if (resolveSiteSettings({ ...settings, enabled: true }, tabUrl, isRestrictedUrl).enabled) {
    return null;
  }
  const { patterns } = parsePatternsField(
    el<HTMLInputElement>("siteLocationPatterns")?.value ?? ""
  );
  const pattern = patterns.find((p) => matchesPattern(tabUrl, p));
  return pattern === undefined ? null : { mode, pattern };
}

async function handleAddToAllowlist(): Promise<void> {
  const conflict = editor?.conflict ?? null;
  if (conflict === null || conflict.mode !== "allowlist" || current?.proLocked) return;
  hideEditorError();
  const payload: ScopeSitePayload = { list: "allowlist", pattern: conflict.pattern };
  try {
    const result = (await browser.runtime.sendMessage({
      type: "ADD_SCOPE_SITE",
      payload,
    })) as ScopeResponse;
    if (result && "success" in result && result.success) {
      // The editor stays open; the re-render recomputes the hint and hides
      // this button with it.
      reloadHintHost = "filters";
      await loadSettings();
      focusReloadHint("siteLocationsReloadHint");
      announceReloadHint();
      return;
    }
  } catch (error: unknown) {
    console.error("Failed to add the site to the allowlist:", error);
  }
  showEditorError(t("filters_notSaved") || "⚠ Change not saved");
}

function clearSearchResults(): void {
  clearTimeout(searchTimer);
  searchSeq++;
  const results = el("siteLocationResults");
  if (results) clearChildren(results);
}

function fillFavorites(favorites: Favorite[]): void {
  const select = el<HTMLSelectElement>("siteLocationFavorite");
  if (!select) return;
  while (select.options.length > 1) select.remove(1);
  for (const favorite of favorites) {
    const option = document.createElement("option");
    option.value = favorite.id;
    option.textContent = getChipDisplayText(favorite);
    select.appendChild(option);
  }
  select.value = "";
  setHidden("siteLocationFavoriteField", favorites.length === 0);
}

/** Show the chosen place and the plain-language summary of what saving does. */
function updateChosen(): void {
  const chosenEl = el("siteLocationChosen");
  const explainEl = el("siteLocationExplain");
  const chosen = editor?.chosen ?? null;
  if (chosenEl) {
    chosenEl.textContent = chosen
      ? chosen.name
      : t("siteLocation_chosenNone") || "No location chosen yet";
  }
  if (!explainEl) return;
  const { patterns, invalid } = parsePatternsField(
    el<HTMLInputElement>("siteLocationPatterns")?.value ?? ""
  );
  if (!chosen || invalid !== null || patterns.length === 0) {
    explainEl.textContent = "";
    return;
  }
  const sites = patterns.join(", ");
  explainEl.textContent =
    t("siteLocation_explain", [sites, chosen.name]) || `Pages on ${sites} will see ${chosen.name}.`;
}

function choose(chosen: ChosenLocation): void {
  if (!editor || saving) return;
  editor.chosen = chosen;
  hideEditorError();
  updateChosen();
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

  const patternsInput = el<HTMLInputElement>("siteLocationPatterns");
  patternsInput?.addEventListener("input", () => {
    patternsInput.removeAttribute("aria-invalid");
    hideEditorError();
    updateChosen();
    updateEditorHints();
  });

  el<HTMLInputElement>("siteLocationSearch")?.addEventListener("input", (e) => {
    onSearchInput((e.target as HTMLInputElement).value.trim());
  });

  const select = el<HTMLSelectElement>("siteLocationFavorite");
  select?.addEventListener("change", () => {
    const favorite = (current?.settings.favorites ?? []).find((f) => f.id === select.value);
    if (!favorite) return;
    choose({
      latitude: favorite.latitude,
      longitude: favorite.longitude,
      name: getChipDisplayText(favorite),
      locationName: {
        city: favorite.city,
        country: favorite.country,
        displayName: favorite.displayName,
      },
      label: favorite.label,
    });
  });

  el("siteLocationSave")?.addEventListener("click", () => {
    void handleSave();
  });
  el("siteLocationCancel")?.addEventListener("click", () => {
    closeEditor(true);
  });
  el("siteLocationEditOwner")?.addEventListener("click", () => {
    const ownerId = editor?.ownerId;
    const owner = storedList(current?.settings).find((e) => e.id === ownerId);
    if (!editor || !owner) return;
    openEditor({ entry: owner, opener: editor.opener });
  });
  el("siteLocationAddToAllowlist")?.addEventListener("click", () => {
    void handleAddToAllowlist();
  });
  editorEl.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // A save in flight can't be called back; the editor closes when it lands.
      if (!saving) closeEditor(true);
    }
  });
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
      choose({
        latitude: result.latitude,
        longitude: result.longitude,
        name: result.name,
        locationName: { city: result.city, country: result.country, displayName: result.name },
        label: null,
      });
      clearSearchResults();
      el("siteLocationSave")?.focus();
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
      return { text: t("filters_notSaved") || "⚠ Change not saved", ownerId: null };
  }
}

/** Validate inline, then send SAVE_SITE_LOCATION. Nothing is sent while the input is invalid. */
async function handleSave(): Promise<void> {
  if (!editor || current?.proLocked) return;
  const state = editor;
  hideEditorError();

  const patternsInput = el<HTMLInputElement>("siteLocationPatterns");
  const { patterns, invalid } = parsePatternsField(patternsInput?.value ?? "");
  if (invalid !== null || patterns.length === 0) {
    patternsInput?.setAttribute("aria-invalid", "true");
    showEditorError(patternError());
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
  setEditorSaving(true);
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
    reloadHintHost = "filters";
    // Nothing in the frozen editor can close it, but removing the edited entry
    // or the Pro lock still can. The list and the hint show the save anyway.
    const stillOpen = editor === state;
    if (stillOpen) closeEditor(false);
    await loadSettings();
    if (stillOpen) restoreFocusAfterEditor(state.opener);
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
      failure?.error === "TOO_MANY_PATTERNS";
    el(aboutSites ? "siteLocationPatterns" : "siteLocationSave")?.focus();
  }
}

/** The editor's controls, all disabled while a save is in flight. */
const EDITOR_CONTROL_IDS = [
  "siteLocationPatterns",
  "siteLocationSearch",
  "siteLocationFavorite",
  "siteLocationAddToAllowlist",
  "siteLocationEditOwner",
  "siteLocationSave",
  "siteLocationCancel",
] as const;

/**
 * Freeze or release the editor around SAVE_SITE_LOCATION. Cancel and Escape
 * can't undo a save already sent, and an edit made meanwhile would be
 * discarded when it lands, so every control is disabled and `aria-busy` tells
 * assistive tech the editor is updating.
 */
function setEditorSaving(on: boolean): void {
  saving = on;
  const editorEl = el("siteLocationEditor");
  if (on) editorEl?.setAttribute("aria-busy", "true");
  else editorEl?.removeAttribute("aria-busy");
  for (const id of EDITOR_CONTROL_IDS) {
    const control = el<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(id);
    if (control) control.disabled = on;
  }
}

/** Test hook: forget popup-session state between cases. */
export function __resetSiteLocationsForTest(): void {
  current = null;
  lineState = { kind: "none" };
  editor = null;
  saving = false;
  reloadHintHost = null;
  disclosureInitialized = false;
  clearTimeout(searchTimer);
  searchSeq = 0;
  clearTimeout(announceTimer);
  announceTimer = undefined;
}
