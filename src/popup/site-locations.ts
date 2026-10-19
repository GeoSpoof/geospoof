/**
 * Popup Site locations
 *
 * Three surfaces onto `settings.siteLocations`:
 *   - the Main tab's "This site" row: which location the active tab's site
 *     gets, with "Use a different location here" / "Change" / "Use main
 *     location" and short, honest hints (Filters, VPN, reload);
 *   - the Filters tab's "Site locations" section: every entry, with edit and
 *     remove (optimistic, reverted on failure like the scope list);
 *   - the Details tab's readout of the site location applied to this tab.
 *
 * One editor (`#siteLocationEditor`) serves both the row and the section. It's
 * moved into whichever host opens it, so its ids stay unique.
 *
 * Filters and site locations are separate axes: Filters decide WHETHER
 * GeoSpoof is on for a site, a site location decides WHICH location it reports
 * there. The row shows both, from the same shared resolver the background
 * uses (`resolveSiteSettings`), so the popup can't disagree with the page.
 */

import type {
  Favorite,
  LocationName,
  ScopeMode,
  Settings,
  SiteLocation,
} from "@/shared/types/settings";
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
import { computeEffectiveSiteLocations } from "@/shared/utils/scope";
import {
  matchSiteLocation,
  parseSiteLocationPattern,
  resolveSiteSettings,
  siteLocationDisplayName,
  suggestSiteLocationPattern,
} from "@/shared/utils/site-locations";
import { getChipDisplayText } from "./favorites";
import { buildMonogram } from "./scope";
import { isRestrictedUrl, loadSettings } from "./settings";
import { t } from "./i18n";
import { clearChildren } from "./ui";

/** Debounce (ms) for the editor's location search, matching the main search. */
const SEARCH_DEBOUNCE_MS = 300;

/** What the "This site" row shows for the active tab. */
export type ThisSiteRowState =
  | { kind: "hidden" }
  /** In scope, no site location: the main location applies. */
  | { kind: "main"; host: string; suggestion: string | null }
  /** In scope, and a site location applies. */
  | { kind: "applied"; host: string; entry: SiteLocation; pattern: string }
  /** Filters keep GeoSpoof off here. `pattern` is what one-tap would allowlist. */
  | { kind: "filtersOff"; host: string; mode: ScopeMode; pattern: string | null };

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
  host: "row" | "filters";
  /** The entry being edited, or null for a new one. */
  entry: SiteLocation | null;
  chosen: ChosenLocation | null;
  /** The owner offered by a PATTERN_IN_USE error. */
  ownerId: string | null;
  /** Where focus returns when the editor closes. */
  opener: HTMLElement | null;
}

/** The last rendered inputs; the static controls' listeners read them. */
let current: { settings: Settings; tabUrl: string | undefined; proLocked: boolean } | null = null;
let rowState: ThisSiteRowState = { kind: "hidden" };
let editor: EditorState | null = null;
/** Set after a change made from this popup; open pages keep old values until reloaded. */
let reloadHintVisible = false;
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

/** Split the sites field on commas into canonical patterns, or report the first bad token. */
export function parsePatternsField(raw: string): {
  patterns: string[];
  invalid: string | null;
} {
  const patterns: string[] = [];
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  for (const token of tokens) {
    const canonical = parseSiteLocationPattern(token);
    if (canonical === null) return { patterns, invalid: token };
    if (!patterns.includes(canonical)) patterns.push(canonical);
  }
  return { patterns, invalid: null };
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Called from loadSettings() right after renderScope(). Reads the active tab's
 * top-level URL (as Filters' "Add current site" does) and renders all three
 * surfaces.
 */
export async function renderSiteLocations(settings: Settings, proLocked = false): Promise<void> {
  let tabUrl: string | undefined;
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    tabUrl = tabs[0]?.url;
  } catch (error: unknown) {
    console.error("Failed to read the current tab:", error);
  }
  renderThisSiteRow(settings, tabUrl, proLocked);
  renderSiteLocationsSection(settings, tabUrl, proLocked);
  renderSiteLocationDetails(settings, tabUrl);
}

// ── Main tab: the "This site" row ─────────────────────────────────────────────

/**
 * Decide the row's state. With the Pro lock on, the background forces scope
 * "all" and ignores site locations, so the row reflects exactly that. With the
 * master switch off it shows what this site WOULD get, as the location card
 * above it shows the main location while protection is off.
 */
export function computeThisSiteRowState(
  settings: Settings,
  tabUrl: string | undefined,
  proLocked: boolean
): ThisSiteRowState {
  if (!tabUrl || isRestrictedUrl(tabUrl)) return { kind: "hidden" };
  const host = hostOf(tabUrl);
  if (host === null) return { kind: "hidden" };

  const effective: Settings = proLocked
    ? { ...settings, scopeMode: "all", siteLocations: [] }
    : settings;
  const resolution = resolveSiteSettings(
    effective.enabled ? effective : { ...effective, enabled: true },
    tabUrl,
    isRestrictedUrl
  );
  const suggestion = suggestSiteLocationPattern(tabUrl);

  if (!resolution.enabled) {
    const entries = computeEffectiveSiteLocations(
      effective.siteLocations,
      effective.proFeaturesBlocked
    );
    const match = matchSiteLocation(tabUrl, entries);
    return {
      kind: "filtersOff",
      host,
      mode: effective.scopeMode,
      pattern: match?.pattern ?? suggestion,
    };
  }
  if (resolution.siteLocation !== null && resolution.matchedPattern !== null) {
    return {
      kind: "applied",
      host,
      entry: resolution.siteLocation,
      pattern: resolution.matchedPattern,
    };
  }
  return { kind: "main", host, suggestion };
}

/** Render the Main-tab "This site" row for the active tab's URL. */
export function renderThisSiteRow(
  settings: Settings,
  tabUrl: string | undefined,
  proLocked: boolean
): void {
  current = { settings, tabUrl, proLocked };
  wireRowOnce();
  wireEditorOnce();

  const row = el("thisSiteRow");
  if (!row) return;

  // A locked user can't edit; close an editor left open by an earlier render.
  if (proLocked && editor !== null) closeEditor(false);

  rowState = computeThisSiteRowState(settings, tabUrl, proLocked);
  setHidden("thisSiteError", true);

  if (rowState.kind === "hidden") {
    if (editor?.host === "row") closeEditor(false);
    row.hidden = true;
    return;
  }
  row.hidden = false;

  const status = el("thisSiteStatus");
  if (status) status.textContent = statusText(rowState);

  setHidden("thisSiteUseDifferent", rowState.kind !== "main");
  setHidden("thisSiteChange", rowState.kind !== "applied");
  setHidden("thisSiteUseMain", rowState.kind !== "applied");
  for (const id of ["thisSiteUseDifferent", "thisSiteChange", "thisSiteUseMain"]) {
    const btn = el<HTMLButtonElement>(id);
    if (btn) btn.disabled = proLocked;
  }

  renderFiltersHint(rowState, proLocked);
  updateVpnHint();
  setHidden("thisSiteReloadHint", !reloadHintVisible);
  setHidden("thisSiteProNote", !proLocked);
}

function statusText(state: ThisSiteRowState): string {
  switch (state.kind) {
    case "applied": {
      const place = siteLocationDisplayName(state.entry);
      return (
        t("siteLocation_statusSite", [state.host, place]) ||
        `${state.host} · ${place} (site location)`
      );
    }
    case "filtersOff":
      return t("siteLocation_statusFiltersOff") || "GeoSpoof is off on this site (Filters)";
    case "main":
      // With no main location the page gets no location or zone at all, so
      // say so rather than naming a location that doesn't exist.
      if (!current?.settings.location) {
        return (
          t("siteLocation_statusNoMain", [state.host]) ||
          `${state.host} · Not spoofed (no main location set)`
        );
      }
      return t("siteLocation_statusMain", [state.host]) || `${state.host} · Main location`;
    default:
      return "";
  }
}

/**
 * Out of scope only. Allowlist mode offers a one-tap add; denylist mode only
 * explains, because the blocking entry may be a broad wildcard or a path
 * pattern that removing this host wouldn't lift.
 */
function renderFiltersHint(state: ThisSiteRowState, proLocked: boolean): void {
  const text = el("thisSiteFiltersHintText");
  if (state.kind !== "filtersOff" || state.mode === "all") {
    setHidden("thisSiteFiltersHint", true);
    return;
  }
  setHidden("thisSiteFiltersHint", false);
  if (state.mode === "allowlist") {
    if (text) {
      text.textContent =
        t("siteLocation_hintAllowlist") ||
        "Filters don't spoof this site. Add it to the allowlist?";
    }
    setHidden("thisSiteAddToAllowlist", state.pattern === null || proLocked);
  } else {
    if (text) {
      text.textContent =
        t("siteLocation_hintDenylist") ||
        "Filters don't spoof this site because it's on your denylist.";
    }
    setHidden("thisSiteAddToAllowlist", true);
  }
}

/** VPN sync moves only the IP-derived main location; say so where a site location is in play. */
function updateVpnHint(): void {
  const vpnOn = current?.settings.vpnSyncEnabled === true;
  setHidden("thisSiteVpnHint", !(vpnOn && (rowState.kind === "applied" || editor !== null)));
}

function showRowError(text: string): void {
  const node = el("thisSiteError");
  if (!node) return;
  node.textContent = text;
  node.hidden = false;
}

function wireRowOnce(): void {
  const row = el("thisSiteRow");
  if (!row || row.dataset.wired === "1") return;
  row.dataset.wired = "1";

  el("thisSiteUseDifferent")?.addEventListener("click", (e) => {
    openEditor({ host: "row", entry: null, opener: e.currentTarget as HTMLElement });
  });
  el("thisSiteChange")?.addEventListener("click", (e) => {
    if (rowState.kind !== "applied") return;
    openEditor({ host: "row", entry: rowState.entry, opener: e.currentTarget as HTMLElement });
  });
  el("thisSiteUseMain")?.addEventListener("click", () => {
    void handleUseMain();
  });
  el("thisSiteAddToAllowlist")?.addEventListener("click", () => {
    void handleAddToAllowlist();
  });
}

/** Drop the matched pattern only, so a multi-site entry keeps its other sites. */
async function handleUseMain(): Promise<void> {
  if (rowState.kind !== "applied" || current?.proLocked) return;
  const { entry, pattern } = rowState;
  setHidden("thisSiteError", true);
  const payload: RemoveSiteLocationPayload = { id: entry.id, pattern };
  try {
    const result = (await browser.runtime.sendMessage({
      type: "REMOVE_SITE_LOCATION",
      payload,
    })) as SiteLocationResponse;
    if (result && "success" in result && result.success) {
      if (editor?.entry?.id === entry.id) closeEditor(false);
      reloadHintVisible = true;
      await loadSettings();
      return;
    }
  } catch (error: unknown) {
    console.error("Failed to remove the site location:", error);
  }
  showRowError(t("filters_notSaved") || "⚠ Change not saved");
}

async function handleAddToAllowlist(): Promise<void> {
  if (rowState.kind !== "filtersOff" || rowState.pattern === null || current?.proLocked) return;
  setHidden("thisSiteError", true);
  const payload: ScopeSitePayload = { list: "allowlist", pattern: rowState.pattern };
  try {
    const result = (await browser.runtime.sendMessage({
      type: "ADD_SCOPE_SITE",
      payload,
    })) as ScopeResponse;
    if (result && "success" in result && result.success) {
      reloadHintVisible = true;
      await loadSettings();
      return;
    }
  } catch (error: unknown) {
    console.error("Failed to add the site to the allowlist:", error);
  }
  showRowError(t("filters_notSaved") || "⚠ Change not saved");
}

// ── Filters tab: the "Site locations" section ───────────────────────────────

/** Render the Filters-tab list of site locations. */
export function renderSiteLocationsSection(
  settings: Settings,
  tabUrl: string | undefined,
  proLocked: boolean
): void {
  current = { settings, tabUrl, proLocked };
  wireSectionOnce();
  wireEditorOnce();

  const listEl = el("siteLocationsList");
  if (!listEl) return;

  const entries = storedList(settings);
  clearChildren(listEl);
  for (const entry of entries) {
    listEl.appendChild(buildSiteLocationRow(entry, proLocked));
  }
  updateSectionCountFromDom();

  setHidden("siteLocationsError", true);
  setHidden("siteLocationsProNote", !proLocked);
  const addBtn = el<HTMLButtonElement>("siteLocationsAddButton");
  if (addBtn) addBtn.disabled = proLocked;
}

function updateSectionCountFromDom(): void {
  const listEl = el("siteLocationsList");
  const count = listEl ? listEl.children.length : 0;
  const countEl = el("siteLocationsCount");
  if (countEl) countEl.textContent = String(count);
  setHidden("siteLocationsEmpty", count > 0);
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
    `${t("siteLocation_editAriaLabel") || "Edit site location"} ${name}`
  );
  editBtn.disabled = proLocked;
  editBtn.addEventListener("click", () => {
    openEditor({ host: "filters", entry, opener: editBtn });
  });
  row.appendChild(editBtn);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "scope-site-remove";
  removeBtn.textContent = "✕";
  removeBtn.setAttribute(
    "aria-label",
    `${t("siteLocation_removeAriaLabel") || "Remove site location"} ${name}`
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
    openEditor({ host: "filters", entry: null, opener: btn });
  });
}

/** Optimistic removal with revert on failure, like the scope list's handleRemove. */
async function handleRemoveEntry(entry: SiteLocation, row: HTMLElement): Promise<void> {
  if (current?.proLocked) return;
  setHidden("siteLocationsError", true);

  const parent = row.parentNode;
  const nextSibling = row.nextSibling;
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
      reloadHintVisible = true;
      await loadSettings();
      return;
    }
  } catch (error: unknown) {
    console.error("Failed to remove the site location:", error);
  }

  if (parent) parent.insertBefore(row, nextSibling);
  updateSectionCountFromDom();
  setHidden("siteLocationsError", false);
}

// ── Details tab ─────────────────────────────────────────────────────────────

/** "Place (host) · Area/Zone" when a site location applies to this tab. */
export function renderSiteLocationDetails(settings: Settings, tabUrl: string | undefined): void {
  const node = el("detailSiteLocation");
  if (!node) return;

  if (tabUrl && !isRestrictedUrl(tabUrl)) {
    const resolution = resolveSiteSettings(settings, tabUrl, isRestrictedUrl);
    const host = hostOf(tabUrl);
    if (resolution.siteLocation !== null && host !== null) {
      const place = siteLocationDisplayName(resolution.siteLocation);
      node.textContent = `${place} (${host}) · ${resolution.siteLocation.timezone.identifier}`;
      return;
    }
  }
  node.textContent = t("details_siteLocationNone") || "None. This site uses your main location.";
}

// ── The shared editor ───────────────────────────────────────────────────────

function openEditor(args: {
  host: "row" | "filters";
  entry: SiteLocation | null;
  opener: HTMLElement | null;
}): void {
  if (current?.proLocked) return;
  const editorEl = el("siteLocationEditor");
  const hostEl = el(args.host === "row" ? "thisSiteEditorHost" : "siteLocationsEditorHost");
  if (!editorEl || !hostEl) return;

  const { entry } = args;
  editor = {
    host: args.host,
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
  };

  hostEl.appendChild(editorEl);

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

  editorEl.hidden = false;
  updateChosen();
  updateVpnHint();
  patternsInput?.focus();
}

function closeEditor(restoreFocus: boolean): void {
  const editorEl = el("siteLocationEditor");
  if (editorEl) editorEl.hidden = true;
  const opener = editor?.opener ?? null;
  editor = null;
  clearSearchResults();
  hideEditorError();
  updateVpnHint();
  if (restoreFocus) focusIfVisible(opener);
}

function focusIfVisible(node: HTMLElement | null): void {
  if (node && node.isConnected && node.closest("[hidden]") === null) node.focus();
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
    t("siteLocation_explain", [sites, chosen.name]) ||
    `Pages on ${sites}, and everything embedded in them, will see ${chosen.name}. Other sites keep your main location.`;
}

function choose(chosen: ChosenLocation): void {
  if (!editor) return;
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
  return (
    t("siteLocation_errorTooManySites", [max]) || `One site location can cover up to ${max} sites.`
  );
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
    openEditor({ host: editor.host, entry: owner, opener: editor.opener });
  });
  editorEl.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeEditor(true);
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
        text:
          t("siteLocation_errorInUse", [site, place]) ||
          `${site} already has a site location (${place}).`,
        ownerId: owner ? owner.id : null,
      };
    }
    case "AT_CAPACITY": {
      const max = String(MAX_SITE_LOCATIONS);
      return {
        text:
          t("siteLocation_errorCapacity", [max]) ||
          `You can have up to ${max} site locations. Remove one first.`,
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

  const saveBtn = el<HTMLButtonElement>("siteLocationSave");
  if (saveBtn) saveBtn.disabled = true;
  let result: SiteLocationResponse | null = null;
  try {
    result = (await browser.runtime.sendMessage({
      type: "SAVE_SITE_LOCATION",
      payload,
    })) as SiteLocationResponse;
  } catch (error: unknown) {
    console.error("Failed to save the site location:", error);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
  // The user cancelled or reopened the editor meanwhile.
  if (editor !== state) return;

  if (result && "success" in result && result.success) {
    const opener = state.opener;
    reloadHintVisible = true;
    closeEditor(false);
    await loadSettings();
    focusIfVisible(opener);
    return;
  }

  const { text, ownerId } = result
    ? saveErrorText(result as Extract<SiteLocationResponse, { error: unknown }>)
    : { text: t("filters_notSaved") || "⚠ Change not saved", ownerId: null };
  showEditorError(text, ownerId);
}

/** Test hook: forget popup-session state between cases. */
export function __resetSiteLocationsForTest(): void {
  current = null;
  rowState = { kind: "hidden" };
  editor = null;
  reloadHintVisible = false;
  clearTimeout(searchTimer);
  searchSeq = 0;
}
