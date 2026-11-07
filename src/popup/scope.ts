/**
 * Popup Site-Scoping (Filters tab)
 *
 * Renders "Where GeoSpoof works" on the Filters root (the mode selector, its
 * sentence and the active list's row) and the list's own screen: its caption,
 * "＋ Add <site>" or whether the site is already listed, the add field, the
 * entries and "What can I add?". The allowlist/denylist arrays are read
 * straight from the full `Settings` the popup receives (they never cross into
 * a content/injected script). List removals are optimistic and reverted on
 * failure; the mode selector is optimistic, and everything that depends on
 * the mode recomputes once it saved.
 *
 * Requirements: 9.5, 13.1–13.8, 14.1, 14.2, 14.4, 14.5, 14.6, 14.8
 */

import type { ScopeMode, Settings } from "@/shared/types/settings";
import type { ScopeResponse, ScopeSitePayload, SetScopeModePayload } from "@/shared/types/messages";
import { siteGroupsAvailable } from "@/shared/site-groups/availability";
import { isSiteGroupToken, LINK_PREFIX } from "@/shared/site-groups/tokens";
import type { EntryInputKind } from "@/shared/utils/filter-entries";
import { loadSettings, isRestrictedUrl } from "./settings";
import { t } from "./i18n";
import { announce } from "./announce";
import { isOwnExtensionPage } from "./active-tab";
import { clearCardUndo } from "./card-undo";
import { saveFiltersDraft } from "./drafts";
import {
  createEntryAddControl,
  entryInvalidText,
  type EntryAddControl,
  type EntrySubmitResult,
} from "./entry-add-control";
import {
  backFromFiltersScreen,
  getFiltersScreen,
  isFocusable,
  openFiltersScreen,
  setFiltersScreenFallback,
  wireButtonRow,
  wireFiltersNavOnce,
} from "./filters-nav";
import { buildEntryMeta } from "./site-row";
import {
  describeEntry,
  formatCatalogDate,
  formatCount,
  isSiteGroupErrorCode,
  linkAddedText,
  popupSiteGroupLookup,
  requestSiteGroupUpdate,
  siteGroupErrorText,
  siteGroupsStatus,
} from "./site-groups";
import { listScreenSiteStatus, type ListScreenSiteStatus } from "./this-site";
import { cardStatusText, statusAnnouncement } from "./this-site-card";

type ListKey = "allowlist" | "denylist";

/** Timeout (ms) after which an unconfirmed scope mutation is reverted (Req 13.5). */
const REVERT_TIMEOUT_MS = 5000;

/** The mode currently reflected as persisted, used to revert optimistic changes. */
let lastPersistedMode: ScopeMode = "all";

/** The list the add control adds to (null in "all" mode), and the control itself. */
let activeListKey: ListKey | null = null;
let addControl: EntryAddControl | null = null;

/** What the list screen offers for the current tab ("＋ Add twitch.tv", "✓ twitch.tv · Listed"). */
let siteStatus: ListScreenSiteStatus = { kind: "none" };
/** "＋ Add <site>" is in flight. */
let addingSite = false;

/** "Update now" is running. */
let siteGroupsUpdating = false;
/** The release a manual check found already in use, for "up to date". */
let upToDateRelease: string | null = null;
/** The last render's inputs, so "Update now" can re-render the status lines at once. */
let lastStatusArgs: { settings: Settings; listKey: ListKey | null; proLocked: boolean } | null =
  null;

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** Resolve the active scope mode, defaulting to "all" for legacy/partial settings. */
function resolveScopeMode(value: unknown): ScopeMode {
  return value === "allowlist" || value === "denylist" ? value : "all";
}

/** The settings list key backing a given list mode. */
function listKeyForMode(mode: ScopeMode): ListKey | null {
  if (mode === "allowlist") return "allowlist";
  if (mode === "denylist") return "denylist";
  return null;
}

/** The sentence under the selector: what the mode does, stated positively. */
function modeDescription(mode: ScopeMode): string {
  switch (mode) {
    case "allowlist":
      return t("filters_descAllow") || "GeoSpoof works only on sites in the Allowlist.";
    case "denylist":
      return t("filters_descDeny") || "GeoSpoof works on every site except those in the Denylist.";
    default:
      return t("filters_descAll") || "GeoSpoof works on every site.";
  }
}

/** The list's name as a noun: the root row, the screen's title. */
function listName(listKey: ListKey): string {
  return listKey === "denylist"
    ? t("filters_denylistName") || "Denylist"
    : t("filters_allowlistName") || "Allowlist";
}

/**
 * Show the "settings could not be loaded" state: default the selector to "all"
 * and surface the inline message (Req 13.3). Called from loadSettings() on a
 * GET_SETTINGS failure.
 */
export function renderScopeLoadError(): void {
  wireFiltersNavOnce();
  lastPersistedMode = "all";
  reflectModeSelection("all");
  setListCardVisible(false);
  if (getFiltersScreen() === "list") backFromFiltersScreen({ restoreFocus: false });

  const loadError = el("scopeLoadError");
  if (loadError) loadError.style.display = "block";

  const desc = el("scopeModeDesc");
  if (desc) desc.textContent = modeDescription("all");
}

/**
 * Main entry point, called from loadSettings() after the favorites render.
 * Renders the root's mode, sentence and list row, and the list screen, for
 * the loaded settings and the active tab's URL.
 *
 * `proLocked` (Safari/iOS non-Pro) disables the mode selector and the add
 * controls, and the Pro note replaces the sentence: Filters are a Pro feature
 * and the background already forces scope "all" for these users, so the popup
 * reflects "all" and prevents interaction rather than letting it silently
 * no-op.
 */
export function renderScope(settings: Settings, proLocked = false, tabUrl?: string): void {
  wireFiltersNavOnce();
  const loadError = el("scopeLoadError");
  if (loadError) loadError.style.display = "none";

  hideModeError();
  hideAddError();

  // Locked free iOS users always reflect "all" (what the background enforces),
  // regardless of any stale stored mode from a lapsed subscription.
  const mode = proLocked ? "all" : resolveScopeMode(settings.scopeMode);
  lastPersistedMode = mode;

  reflectModeSelection(mode);
  wireModeSelector();
  wireListScreenOnce();
  wireAddControls(mode);
  applyScopeLock(proLocked);

  const desc = el("scopeModeDesc");
  if (desc) desc.textContent = modeDescription(mode);

  const listKey = listKeyForMode(mode);
  renderSiteGroupsStatus(settings, listKey, proLocked);
  if (listKey === null) {
    // "all" mode: no list row, and its screen no longer applies (Req 13.8).
    setListCardVisible(false);
    siteStatus = { kind: "none" };
    if (getFiltersScreen() === "list") backFromFiltersScreen({ restoreFocus: false });
    return;
  }

  const entries = settings[listKey] ?? [];
  renderListRow(listKey, entries);
  renderListScreen(settings, listKey, entries, tabUrl);
}

/**
 * Enable/disable the scope controls for the Pro gate. Disabled buttons can't be
 * clicked (so the mode can't change) and the Pro note, in place of the
 * sentence, explains why; toggling it off restores normal interaction
 * (loadSettings can run multiple times in one popup session).
 */
function applyScopeLock(locked: boolean): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".scope-mode-btn");
  buttons.forEach((btn) => {
    btn.disabled = locked;
  });

  const note = el("scopeProNote");
  if (note) note.hidden = !locked;
  const desc = el("scopeModeDesc");
  if (desc) desc.hidden = locked;

  // The add controls live on the list screen, which a locked user can't
  // reach, but disable them defensively too.
  for (const id of ["scopeAddInput", "scopeAddButton", "scopeAddSiteButton"]) {
    const node = el<HTMLInputElement | HTMLButtonElement>(id);
    if (node) node.disabled = locked;
  }
}

// ── Mode selector ──────────────────────────────────────────────────────────

/** Reflect the selected mode in the segmented control (Req 13.1). */
function reflectModeSelection(mode: ScopeMode): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".scope-mode-btn");
  buttons.forEach((btn) => {
    const isActive = btn.dataset.scopeMode === mode;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-checked", String(isActive));
  });
}

/**
 * Wire the mode buttons once. Uses a data flag so repeated renders don't stack
 * listeners (the buttons are static markup, so the same nodes persist).
 */
function wireModeSelector(): void {
  const container = el("scopeModeTabs");
  if (!container || container.dataset.wired === "1") return;
  container.dataset.wired = "1";

  const buttons = container.querySelectorAll<HTMLButtonElement>(".scope-mode-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = resolveScopeMode(btn.dataset.scopeMode);
      if (next === lastPersistedMode) return;
      void handleModeChange(next);
    });
  });
}

/**
 * Optimistically reflect the new mode and its sentence, then persist it. The
 * list row and the This site card recompute only from the saved settings, in
 * the reload after success, and the live region then speaks what changed
 * (6.2). Revert the selection and surface an inline message on failure or 5s
 * timeout (Req 13.4, 13.5, 9.5).
 */
async function handleModeChange(next: ScopeMode): Promise<void> {
  const previous = lastPersistedMode;
  const cardBefore = cardStatusText();
  hideModeError();

  // Optimistic update.
  reflectModeSelection(next);
  const desc = el("scopeModeDesc");
  if (desc) desc.textContent = modeDescription(next);

  const payload: SetScopeModePayload = { scopeMode: next };

  let timedOut = false;
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve("timeout");
    }, REVERT_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([
      browser.runtime.sendMessage({ type: "SET_SCOPE_MODE", payload }) as Promise<ScopeResponse>,
      timeout,
    ]);

    if (timedOut || result === "timeout") {
      revertMode(previous);
      return;
    }

    if (result && "success" in result && result.success) {
      lastPersistedMode = next;
      clearCardUndo();
      // Re-render the list row and screen for the new mode from authoritative settings.
      await loadSettings();
      announceModeChange(cardBefore);
      return;
    }

    // { error } response — not saved.
    revertMode(previous);
  } catch (error: unknown) {
    console.error("Failed to set scope mode:", error);
    revertMode(previous);
  }
}

/**
 * After a saved mode change: the sentence as rendered, then the Allowlist
 * row's warning if it shows one, then the This site card's status if it
 * changed. "GeoSpoof works only on sites in the Allowlist. Allowlist: Empty,
 * Off on every site. twitch.tv: Off." (6.2, N25).
 */
function announceModeChange(cardBefore: string | null): void {
  const parts: string[] = [];
  const sentence = el("scopeModeDesc")?.textContent?.trim() ?? "";
  if (sentence.length > 0) parts.push(sentence);
  const rowValue = el("scopeListRowValue");
  if (el("scopeListCard")?.hidden === false && rowValue?.classList.contains("warn")) {
    parts.push(
      statusAnnouncement(
        listName("allowlist"),
        t("filters_listEmptyAllow") || "Empty · Off on every site"
      )
    );
  }
  const cardAfter = cardStatusText();
  if (cardAfter !== null && cardAfter !== cardBefore) parts.push(cardAfter);
  if (parts.length > 0) announce(parts.join(" "));
}

/** Revert the selector to the previously persisted mode and show the message. */
function revertMode(previous: ScopeMode): void {
  lastPersistedMode = previous;
  reflectModeSelection(previous);
  const desc = el("scopeModeDesc");
  if (desc) desc.textContent = modeDescription(previous);
  showModeError();
}

// ── The root's list row ────────────────────────────────────────────────────

function setListCardVisible(visible: boolean): void {
  const card = el("scopeListCard");
  if (card) card.hidden = !visible;
}

/**
 * "Allowlist / 4 on the list ›". An empty Denylist reads "Empty"; an empty
 * Allowlist "⚠ Empty · Off on every site", because nothing is spoofed then.
 */
function renderListRow(listKey: ListKey, entries: readonly string[]): void {
  setListCardVisible(true);
  const title = el("scopeListRowTitle");
  if (title) title.textContent = listName(listKey);
  const value = el("scopeListRowValue");
  if (!value) return;
  value.replaceChildren();
  const warn = entries.length === 0 && listKey === "allowlist";
  value.classList.toggle("warn", warn);
  if (entries.length > 0) {
    const count = formatCount(entries.length);
    value.textContent = t("filters_countOnList", [count]) || `${count} on the list`;
  } else if (warn) {
    const sign = document.createElement("span");
    sign.setAttribute("aria-hidden", "true");
    sign.textContent = "⚠ ";
    value.append(sign, t("filters_listEmptyAllow") || "Empty · Off on every site");
  } else {
    value.textContent = t("filters_listEmpty") || "Empty";
  }
}

/** The root's list row opens the list screen; leaving it, focus returns to the row. */
function wireListScreenOnce(): void {
  const row = el("scopeListRow");
  if (!row || row.dataset.wired === "1") return;
  row.dataset.wired = "1";
  wireButtonRow(row, () => {
    if (activeListKey === null) return;
    openFiltersScreen("list", { opener: row });
  });
  setFiltersScreenFallback("list", () => el("scopeListRow"));

  const addSite = el("scopeAddSiteButton");
  addSite?.addEventListener("click", () => {
    void handleAddSite();
  });

  // The typed text is kept with the open screen (S7).
  el("scopeAddInput")?.addEventListener("input", () => {
    saveFiltersDraft();
  });
}

// ── The list screen ────────────────────────────────────────────────────────

function renderListScreen(
  settings: Settings,
  listKey: ListKey,
  entries: string[],
  tabUrl: string | undefined
): void {
  const title = el("scopeListTitle");
  if (title) title.textContent = listName(listKey);
  const caption = el("scopeListCaption");
  if (caption) {
    caption.textContent =
      listKey === "denylist"
        ? t("filters_captionDeny") || "GeoSpoof works on every site except these."
        : t("filters_captionAllow") || "GeoSpoof works only on these sites.";
  }

  siteStatus = listScreenSiteStatus({
    settings,
    list: listKey,
    tabUrl,
    isOptionsPage: tabUrl !== undefined && isOwnExtensionPage(tabUrl),
    isRestricted: isRestrictedUrl,
    siteGroups: popupSiteGroupLookup(),
  });
  renderSiteStatus(siteStatus);
  renderSiteList(listKey, entries);
}

/**
 * "＋ Add twitch.tv" when the site isn't in the list (`www.` dropped, as
 * everywhere "this site" is named); "✓ twitch.tv · Listed" or "✓ twitch.tv ·
 * Covered by *.tv" when it is; nothing on restricted pages and the options
 * page.
 */
function renderSiteStatus(status: ListScreenSiteStatus): void {
  const button = el("scopeAddSiteButton");
  const label = el("scopeAddSiteLabel");
  const line = el("scopeSiteStatus");
  if (button) button.hidden = status.kind !== "add";
  if (label) {
    label.textContent =
      status.kind === "add" ? t("filters_addSite", [status.site]) || `Add ${status.site}` : "";
  }
  if (!line) return;
  line.hidden = status.kind !== "listed" && status.kind !== "coveredBy";
  line.replaceChildren();
  if (status.kind !== "listed" && status.kind !== "coveredBy") return;
  const detail =
    status.kind === "listed"
      ? t("filters_listed") || "Listed"
      : t("filters_coveredBy", [describeEntry(status.entry).title]) ||
        `Covered by ${describeEntry(status.entry).title}`;
  const sign = document.createElement("span");
  sign.setAttribute("aria-hidden", "true");
  sign.textContent = "✓ ";
  line.append(sign, `${status.site} · ${detail}`);
}

/** "＋ Add <site>": add exactly the site the button names, then say it's listed. */
async function handleAddSite(): Promise<void> {
  const listKey = activeListKey;
  if (addingSite || listKey === null || siteStatus.kind !== "add") return;
  hideAddError();
  addingSite = true;
  const payload: ScopeSitePayload = { list: listKey, pattern: siteStatus.site };
  try {
    const result = (await browser.runtime.sendMessage({
      type: "ADD_SCOPE_SITE",
      payload,
    })) as ScopeResponse | undefined;
    if (result && "success" in result && result.success) {
      clearCardUndo();
      await loadSettings();
      // The button hid itself; its status line took its place.
      const line = el("scopeSiteStatus");
      if (isFocusable(line)) line.focus();
      return;
    }
  } catch (error: unknown) {
    console.error("Failed to add the current site:", error);
  } finally {
    addingSite = false;
  }
  showAddError(t("filters_notSaved") || "⚠ Change not saved");
}

/**
 * Render the active list's entries with per-entry remove controls, or the
 * empty-list indicator when there are none (Req 14.1, 14.8).
 */
function renderSiteList(listKey: ListKey, entries: string[]): void {
  const listEl = el("scopeList");
  const emptyEl = el("scopeEmptyIndicator");
  if (!listEl) return;

  while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

  if (entries.length === 0) {
    if (emptyEl) emptyEl.style.display = "block";
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";

  for (const domain of entries) {
    listEl.appendChild(buildFilterRow(listKey, domain));
  }
}

/**
 * Build a single list row: the entry + its remove button. An exact address,
 * site group or list from a link shows as one row too: its name, and a muted
 * meta line ("Site group · 964 sites"), in the warning style when its data is
 * missing or its last refresh failed. No letter badge (S4).
 */
function buildFilterRow(listKey: ListKey, domain: string): HTMLElement {
  const display = describeEntry(domain);
  const row = document.createElement("div");
  row.className = "scope-site-row";
  row.setAttribute("role", "listitem");

  const label = document.createElement("span");
  label.className = "scope-site-domain";
  label.textContent = display.title;
  label.title = display.tooltip;
  if (display.meta === null) {
    row.appendChild(label);
  } else {
    const text = document.createElement("span");
    text.className = "scope-site-text";
    text.append(label, buildEntryMeta(display.meta, display.warning, "scope-site-meta"));
    row.appendChild(text);
  }

  const removeBtn = document.createElement("button");
  removeBtn.className = "scope-site-remove";
  removeBtn.type = "button";
  removeBtn.textContent = "✕";
  removeBtn.setAttribute(
    "aria-label",
    `${t("filters_removeAriaLabel") || "Remove site"} ${display.title}`
  );
  removeBtn.addEventListener("click", () => {
    void handleRemove(listKey, domain, row);
  });
  row.appendChild(removeBtn);

  return row;
}

/**
 * Wire the add control (input with suggestions, Add) for the active list
 * mode. The control is wired once per element and adds to `activeListKey`;
 * switching lists clears what was typed for the previous one.
 */
function wireAddControls(mode: ScopeMode): void {
  const listKey = listKeyForMode(mode);
  if (listKey === null) {
    activeListKey = null;
    return;
  }

  const control = createEntryAddControl({
    ids: {
      input: "scopeAddInput",
      button: "scopeAddButton",
      listbox: "scopeGroupListbox",
      attribution: "scopeGroupAttribution",
      error: "scopeAddError",
    },
    context: "filters",
    onSubmit: handleAdd,
  });
  if (control !== addControl || listKey !== activeListKey) control?.reset();
  addControl = control;
  activeListKey = listKey;

  // The help rows for the forms this build can't add.
  document.querySelectorAll<HTMLElement>("[data-site-groups-only]").forEach((row) => {
    row.hidden = !siteGroupsAvailable();
  });
}

/**
 * The add control's submit: the control has already validated the input
 * inline (an invalid entry keeps its text and sends nothing, Req 12.3, 14.4).
 * Send ADD_SCOPE_SITE with the canonical entry and reload on success (Req
 * 14.2). A list from a link announces how many sites it added. On failure the
 * control keeps the text and shows the returned message.
 */
async function handleAdd(entries: string[], kind: EntryInputKind): Promise<EntrySubmitResult> {
  const notSaved = t("filters_notSaved") || "⚠ Change not saved";
  const listKey = activeListKey;
  const pattern = entries[0];
  if (listKey === null || pattern === undefined) return { ok: false, message: notSaved };

  const payload: ScopeSitePayload = { list: listKey, pattern };

  let result: ScopeResponse | undefined;
  try {
    result = (await browser.runtime.sendMessage({
      type: "ADD_SCOPE_SITE",
      payload,
    })) as ScopeResponse | undefined;
  } catch (error: unknown) {
    console.error("Failed to add scope site:", error);
    return { ok: false, message: notSaved };
  }

  if (result && "success" in result && result.success) {
    clearCardUndo();
    if (pattern.startsWith(LINK_PREFIX) && result.siteGroup) {
      announce(linkAddedText(pattern, result.siteGroup));
    }
    await loadSettings();
    // The control empties the field once this resolves.
    saveFiltersDraft({ listField: "" });
    return { ok: true };
  }

  const error = result && "error" in result ? result.error : null;
  if (isSiteGroupErrorCode(error)) {
    const token = result && "error" in result ? result.token : undefined;
    return { ok: false, message: siteGroupErrorText(error, token ?? pattern) };
  }
  if (error === "INVALID_PATTERN") {
    return { ok: false, message: entryInvalidText(kind, pattern, "filters") };
  }
  return { ok: false, message: notSaved };
}

// ── Site group status (S5) ─────────────────────────────────────────────────

/** The three status lines and their Update now buttons. */
const STATUS_LINES = [
  {
    box: "siteGroupsHelpStatus",
    text: "siteGroupsHelpStatusText",
    button: "siteGroupsHelpUpdateNow",
  },
  { box: "siteGroupsStatus", text: "siteGroupsStatusText", button: "siteGroupsUpdateNow" },
  {
    box: "siteLocationsGroupsStatus",
    text: "siteLocationsGroupsStatusText",
    button: "siteLocationsGroupsUpdateNow",
  },
] as const;

/**
 * Where site group data comes from and whether its last update worked, with
 * "Update now". The date line lives in "What can I add?", shown when the
 * active list or any site location holds a site group or a list from a link.
 * While an update runs, or after one failed, the list screen and the
 * Per-site locations screen say so too, each where its own entries use one.
 */
function renderSiteGroupsStatus(
  settings: Settings,
  listKey: ListKey | null,
  proLocked: boolean
): void {
  lastStatusArgs = { settings, listKey, proLocked };
  for (const ids of STATUS_LINES) {
    const button = el(ids.button);
    if (button && button.dataset.wired !== "1") {
      button.dataset.wired = "1";
      button.addEventListener("click", () => {
        void handleUpdateNow();
      });
    }
  }

  const hasToken = (list: unknown): boolean =>
    Array.isArray(list) && list.some((p) => typeof p === "string" && isSiteGroupToken(p));
  const status = siteGroupsStatus();
  const known = !proLocked && siteGroupsAvailable() && status !== null;
  const listHasToken = listKey !== null && hasToken(settings[listKey]);
  const perSiteHasToken =
    Array.isArray(settings.siteLocations) &&
    settings.siteLocations.some((entry) => hasToken(entry?.patterns));
  const problem =
    status !== null && (siteGroupsUpdating || status.updating || status.lastError !== null);
  const shown = [
    known && (listHasToken || perSiteHasToken),
    known && problem && listHasToken,
    known && problem && perSiteHasToken,
  ];

  const text = status === null ? "" : siteGroupsStatusText(status);
  STATUS_LINES.forEach((ids, index) => {
    const box = el(ids.box);
    const textEl = el(ids.text);
    const button = el(ids.button);
    if (box) box.hidden = !shown[index];
    if (!shown[index]) return;
    // Only a real change, so the polite region isn't re-read on every render.
    if (textEl && textEl.textContent !== text) textEl.textContent = text;
    // aria-disabled rather than disabled, so a focused button keeps focus.
    if (siteGroupsUpdating) button?.setAttribute("aria-disabled", "true");
    else button?.removeAttribute("aria-disabled");
  });
}

function siteGroupsStatusText(status: NonNullable<ReturnType<typeof siteGroupsStatus>>): string {
  const date = status.releasedAt === null ? "" : formatCatalogDate(Date.parse(status.releasedAt));
  if (siteGroupsUpdating || status.updating) {
    return t("siteGroups_statusUpdating") || "Updating site groups…";
  }
  if (status.lastError !== null) {
    return (
      t("siteGroups_statusFailed", [date]) ||
      `Couldn't update site groups. Using lists from ${date}.`
    );
  }
  if (upToDateRelease !== null && upToDateRelease === status.release) {
    return (
      t("siteGroups_statusUpToDate", [date]) || `Site groups are up to date (lists from ${date})`
    );
  }
  return t("siteGroups_statusFrom", [date]) || `Site group lists from ${date}`;
}

/** "Update now": a manual refresh, then a reload that re-renders the status. */
async function handleUpdateNow(): Promise<void> {
  if (siteGroupsUpdating) return;
  const before = siteGroupsStatus()?.release ?? null;
  siteGroupsUpdating = true;
  upToDateRelease = null;
  if (lastStatusArgs) {
    renderSiteGroupsStatus(
      lastStatusArgs.settings,
      lastStatusArgs.listKey,
      lastStatusArgs.proLocked
    );
  }

  const result = await requestSiteGroupUpdate();
  siteGroupsUpdating = false;
  for (const ids of STATUS_LINES) el(ids.button)?.removeAttribute("aria-disabled");
  if (result.ok && before !== null && result.status?.release === before) {
    upToDateRelease = before;
  }
  await loadSettings();
}

/**
 * Remove an entry with optimistic removal + revert-on-failure (Req 14.6).
 */
async function handleRemove(listKey: ListKey, domain: string, row: HTMLElement): Promise<void> {
  // Optimistically remove the row.
  const parent = row.parentNode;
  const nextSibling = row.nextSibling;
  row.remove();

  const listEl = el("scopeList");
  const emptyEl = el("scopeEmptyIndicator");
  if (listEl && emptyEl && listEl.children.length === 0) {
    emptyEl.style.display = "block";
  }

  const payload: ScopeSitePayload = { list: listKey, pattern: domain };

  try {
    const result = (await browser.runtime.sendMessage({
      type: "REMOVE_SCOPE_SITE",
      payload,
    })) as ScopeResponse;

    if (result && "success" in result && result.success) {
      clearCardUndo();
      await loadSettings();
      return;
    }

    // Revert: restore the row and say so on the list screen, where the
    // remove happened (the mode error sits on the hidden root).
    restoreRow(parent, row, nextSibling, emptyEl);
    showAddError(t("filters_notSaved") || "⚠ Change not saved");
  } catch (error: unknown) {
    console.error("Failed to remove scope site:", error);
    restoreRow(parent, row, nextSibling, emptyEl);
    showAddError(t("filters_notSaved") || "⚠ Change not saved");
  }
}

/** Re-insert an optimistically-removed row at its original position. */
function restoreRow(
  parent: ParentNode | null,
  row: HTMLElement,
  nextSibling: ChildNode | null,
  emptyEl: HTMLElement | null
): void {
  if (parent) {
    parent.insertBefore(row, nextSibling);
  }
  if (emptyEl) emptyEl.style.display = "none";
}

// ── Inline messages ────────────────────────────────────────────────────────

function showAddError(text: string): void {
  const node = el("scopeAddError");
  if (!node) return;
  node.textContent = text;
  node.style.display = "block";
}

function hideAddError(): void {
  const node = el("scopeAddError");
  if (node) node.style.display = "none";
}

/** The list the list screen shows, or null in All sites mode. */
export function getActiveListKey(): ListKey | null {
  return activeListKey;
}
/** Test hook: forget popup-session state between cases. */
export function __resetScopeForTest(): void {
  lastPersistedMode = "all";
  activeListKey = null;
  addControl = null;
  siteStatus = { kind: "none" };
  addingSite = false;
  siteGroupsUpdating = false;
  upToDateRelease = null;
  lastStatusArgs = null;
}

function showModeError(): void {
  const node = el("scopeModeError");
  if (node) node.style.display = "block";
}

function hideModeError(): void {
  const node = el("scopeModeError");
  if (node) node.style.display = "none";
}
