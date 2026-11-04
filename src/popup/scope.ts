/**
 * Popup Site-Scoping (Filters tab)
 *
 * Renders the scope-mode selector (All / Allowlist / Denylist) and the active
 * site-list manager into the `filtersView` panel. The allowlist/denylist arrays
 * are read straight from the full `Settings` the popup receives (they never
 * cross into a content/injected script). All list mutations follow the same
 * optimistic-update + revert-on-failure pattern as the protection toggle.
 *
 * Manual domain entry and the "add current site" convenience are both add
 * paths here; both run the typed/derived value through the Domain_Normalizer
 * before sending to the background.
 *
 * Requirements: 9.5, 13.1–13.8, 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9
 */

import type { ScopeMode, Settings } from "@/shared/types/settings";
import type { ScopeResponse, ScopeSitePayload, SetScopeModePayload } from "@/shared/types/messages";
import { siteGroupsAvailable } from "@/shared/site-groups/availability";
import { isSiteGroupToken, LINK_PREFIX } from "@/shared/site-groups/tokens";
import type { EntryInputKind } from "@/shared/utils/filter-entries";
import { parsePattern } from "@/shared/utils/scope";
import { loadSettings, isRestrictedUrl } from "./settings";
import { t } from "./i18n";
import {
  createEntryAddControl,
  entryInvalidText,
  type EntryAddControl,
  type EntrySubmitResult,
} from "./entry-add-control";
import {
  describeEntry,
  formatCatalogDate,
  isSiteGroupErrorCode,
  linkAddedText,
  requestSiteGroupUpdate,
  siteGroupErrorText,
  siteGroupsStatus,
} from "./site-groups";

/** Modes that show the list manager. */
const LIST_MODES: ReadonlyArray<ScopeMode> = ["allowlist", "denylist"];

/** Timeout (ms) after which an unconfirmed scope mutation is reverted (Req 13.5). */
const REVERT_TIMEOUT_MS = 5000;

/** The mode currently reflected as persisted, used to revert optimistic changes. */
let lastPersistedMode: ScopeMode = "all";

/** The list the add control adds to (null in "all" mode), and the control itself. */
let activeListKey: "allowlist" | "denylist" | null = null;
let addControl: EntryAddControl | null = null;

/** "Update now" is running. */
let siteGroupsUpdating = false;
/** The release a manual check found already in use, for "up to date". */
let upToDateRelease: string | null = null;
let announceTimer: ReturnType<typeof setTimeout> | undefined;

/** Resolve the active scope mode, defaulting to "all" for legacy/partial settings. */
function resolveScopeMode(value: unknown): ScopeMode {
  return value === "allowlist" || value === "denylist" ? value : "all";
}

/** The settings list key backing a given list mode. */
function listKeyForMode(mode: ScopeMode): "allowlist" | "denylist" | null {
  if (mode === "allowlist") return "allowlist";
  if (mode === "denylist") return "denylist";
  return null;
}

/** Localized mode description shown under the selector. */
function modeDescription(mode: ScopeMode): string {
  switch (mode) {
    case "allowlist":
      return t("filters_modeAllowlistDesc") || "Spoofing applies only to listed sites.";
    case "denylist":
      return t("filters_modeDenylistDesc") || "Spoofing applies to every site except listed ones.";
    default:
      return t("filters_modeAllDesc") || "Spoofing applies to every site.";
  }
}

/** Localized header label for the active list. */
function listTitle(listKey: "allowlist" | "denylist"): string {
  return listKey === "denylist"
    ? t("filters_blockedSites") || "Blocked sites"
    : t("filters_allowedSites") || "Allowed sites";
}

/** Sync the header count chip to the number of rows currently in the DOM. */
function updateListCountFromDom(): void {
  const listEl = document.getElementById("scopeList");
  const countEl = document.getElementById("scopeListCount");
  if (listEl && countEl) countEl.textContent = String(listEl.children.length);
}

/**
 * Show the "settings could not be loaded" state: default the selector to "all"
 * and surface the inline message (Req 13.3). Called from loadSettings() on a
 * GET_SETTINGS failure.
 */
export function renderScopeLoadError(): void {
  lastPersistedMode = "all";
  reflectModeSelection("all");
  setListManagerVisible(false);

  const loadError = document.getElementById("scopeLoadError");
  if (loadError) loadError.style.display = "block";

  const desc = document.getElementById("scopeModeDesc");
  if (desc) desc.textContent = modeDescription("all");
}

/**
 * Main entry point, called from loadSettings() after the favorites render.
 * Renders the selector + list manager for the loaded settings.
 *
 * `proLocked` (Safari/iOS non-Pro) disables the mode selector + add controls
 * and surfaces the Pro note: per-site filtering is a Pro feature and the
 * background already forces scope "all" for these users, so the popup reflects
 * "all" and prevents interaction rather than letting it silently no-op.
 */
export function renderScope(settings: Settings, proLocked = false): void {
  const loadError = document.getElementById("scopeLoadError");
  if (loadError) loadError.style.display = "none";

  hideModeError();
  hideAddError();
  hideCurrentMsg();

  // Locked free iOS users always reflect "all" (what the background enforces),
  // regardless of any stale stored mode from a lapsed subscription.
  const mode = proLocked ? "all" : resolveScopeMode(settings.scopeMode);
  lastPersistedMode = mode;

  reflectModeSelection(mode);
  wireModeSelector();
  wireAddControls(mode);
  applyScopeLock(proLocked);

  const desc = document.getElementById("scopeModeDesc");
  if (desc) desc.textContent = modeDescription(mode);

  const listKey = listKeyForMode(mode);
  renderSiteGroupsStatus(settings, listKey, proLocked);
  if (listKey === null) {
    // "all" mode — hide the list manager entirely (Req 13.8).
    setListManagerVisible(false);
    return;
  }

  setListManagerVisible(true);
  renderSiteList(listKey, settings[listKey] ?? []);
}

/**
 * Enable/disable the scope controls for the Pro gate. Disabled buttons can't be
 * clicked (so the mode can't change) and the Pro note explains why; toggling it
 * off restores normal interaction (loadSettings can run multiple times in one
 * popup session).
 */
function applyScopeLock(locked: boolean): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".scope-mode-btn");
  buttons.forEach((btn) => {
    btn.disabled = locked;
  });

  const note = document.getElementById("scopeProNote");
  if (note) note.style.display = locked ? "block" : "none";

  // The add controls live inside the list manager (hidden in "all" mode, which
  // is what a locked user always sees), but disable them defensively too.
  for (const id of ["scopeAddKind", "scopeAddInput", "scopeAddButton", "scopeAddCurrentButton"]) {
    const el = document.getElementById(id) as
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement | null;
    if (el) el.disabled = locked;
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
  const container = document.getElementById("scopeModeTabs");
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
 * Optimistically reflect the new mode, then persist it. Revert the selection
 * and surface an inline message on failure or 5s timeout (Req 13.4, 13.5, 9.5).
 */
async function handleModeChange(next: ScopeMode): Promise<void> {
  const previous = lastPersistedMode;
  hideModeError();

  // Optimistic update.
  reflectModeSelection(next);
  const desc = document.getElementById("scopeModeDesc");
  if (desc) desc.textContent = modeDescription(next);
  setListManagerVisible(LIST_MODES.includes(next));

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
      // Re-render lists for the new mode from authoritative settings.
      await loadSettings();
      return;
    }

    // { error } response — not saved.
    revertMode(previous);
  } catch (error: unknown) {
    console.error("Failed to set scope mode:", error);
    revertMode(previous);
  }
}

/** Revert the selector to the previously persisted mode and show the message. */
function revertMode(previous: ScopeMode): void {
  lastPersistedMode = previous;
  reflectModeSelection(previous);
  const desc = document.getElementById("scopeModeDesc");
  if (desc) desc.textContent = modeDescription(previous);
  setListManagerVisible(LIST_MODES.includes(previous));
  showModeError();
}

// ── List manager ─────────────────────────────────────────────────────────────

function setListManagerVisible(visible: boolean): void {
  const manager = document.getElementById("scopeListManager");
  if (manager) manager.style.display = visible ? "block" : "none";
}

/**
 * Render the active list's entries with per-entry remove controls, or the
 * empty-list indicator when there are none (Req 14.1, 14.8).
 */
function renderSiteList(listKey: "allowlist" | "denylist", entries: string[]): void {
  const listEl = document.getElementById("scopeList");
  const emptyEl = document.getElementById("scopeEmptyIndicator");
  if (!listEl) return;

  while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

  // Keep the slim header label + count in sync on every render.
  const titleEl = document.getElementById("scopeListTitle");
  if (titleEl) titleEl.textContent = listTitle(listKey);
  const countEl = document.getElementById("scopeListCount");
  if (countEl) countEl.textContent = String(entries.length);

  if (entries.length === 0) {
    if (emptyEl) emptyEl.style.display = "block";
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";

  for (const domain of entries) {
    listEl.appendChild(buildSiteRow(listKey, domain));
  }
}

/**
 * Deterministic hue (0–359) derived from the domain string, so each site keeps
 * a stable colour across renders without any stored state.
 */
function monogramHue(domain: string): number {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = (hash * 31 + domain.charCodeAt(i)) % 360;
  }
  return hash;
}

/**
 * Build a decorative monogram tile for a domain: the first character on a
 * deterministic coloured background. Generated entirely locally — we never
 * fetch a favicon, so the user's site list never leaves the device (a network
 * request, even for a public icon, would reveal the list to that host or a
 * third-party favicon service).
 */
export function buildMonogram(domain: string): HTMLElement {
  const tile = document.createElement("span");
  tile.className = "scope-site-icon";
  tile.setAttribute("aria-hidden", "true");
  tile.textContent = (domain.charAt(0) || "?").toUpperCase();
  tile.style.backgroundColor = `hsl(${monogramHue(domain)}, 52%, 38%)`;
  return tile;
}

/**
 * The meta text of an entry row or chip ("964 sites"). A warning ("Not
 * available") gets a ⚠ sign and the `warning` class, so it isn't colour alone.
 */
export function buildEntryMeta(meta: string, warning: boolean, className: string): HTMLElement {
  const metaEl = document.createElement("span");
  metaEl.className = warning ? `${className} warning` : className;
  if (warning) {
    const sign = document.createElement("span");
    sign.setAttribute("aria-hidden", "true");
    sign.textContent = "⚠ ";
    metaEl.appendChild(sign);
  }
  metaEl.appendChild(document.createTextNode(meta));
  return metaEl;
}

/**
 * Build a single list row: the domain label + its remove button. An exact
 * address, site group or list from a link shows as one row too: its name, and
 * a muted meta line ("964 sites"), in the warning style when its data is
 * missing or its last refresh failed.
 */
function buildSiteRow(listKey: "allowlist" | "denylist", domain: string): HTMLElement {
  const display = describeEntry(domain);
  const row = document.createElement("div");
  row.className = "scope-site-row";
  row.setAttribute("role", "listitem");

  // Decorative monogram tile: deterministic colour from the domain, generated
  // locally — no favicon fetch, so the list never leaves the device.
  row.appendChild(buildMonogram(display.title));

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
 * Wire the add control (type menu, input, Add) for the active list mode. The
 * control is wired once per element and adds to `activeListKey`; switching
 * lists clears what was typed for the previous one.
 */
function wireAddControls(mode: ScopeMode): void {
  const listKey = listKeyForMode(mode);
  if (listKey === null) {
    activeListKey = null;
    return;
  }

  const control = createEntryAddControl({
    ids: {
      kind: "scopeAddKind",
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

  // The syntax rows for the forms this build can't add.
  document.querySelectorAll<HTMLElement>("[data-site-groups-only]").forEach((row) => {
    row.hidden = !siteGroupsAvailable();
  });

  // "Add current site" convenience: reads the active tab's top-level URL,
  // normalizes its hostname, and adds it to the active list (Req 14.3, 14.7,
  // 14.9). Clone the button to drop listeners from a prior render/mode.
  const currentBtn = document.getElementById("scopeAddCurrentButton") as HTMLButtonElement | null;
  if (currentBtn) {
    const freshCurrentBtn = currentBtn.cloneNode(true) as HTMLButtonElement;
    currentBtn.parentNode?.replaceChild(freshCurrentBtn, currentBtn);
    freshCurrentBtn.addEventListener("click", () => {
      void handleAddCurrent(listKey);
    });
  }
}

/**
 * Add the current tab's site to the active list.
 *
 * Reads the active tab's top-level URL, then short-circuits with an inline
 * message and sends nothing when the page is a Restricted_URL (Req 14.7) or
 * when the derived hostname normalizes to null (Req 14.9). Otherwise sends
 * ADD_SCOPE_SITE with the normalized domain (Req 14.3).
 */
async function handleAddCurrent(listKey: "allowlist" | "denylist"): Promise<void> {
  hideAddError();
  hideCurrentMsg();

  let url: string | undefined;
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    url = tabs[0]?.url;
  } catch (error: unknown) {
    console.error("Failed to read the current tab:", error);
    showCurrentMsg(t("filters_currentPageInvalid") || "This site cannot be added");
    return;
  }

  // Restricted pages (about:, chrome:, store pages, …) cannot be added (Req 14.7).
  if (isRestrictedUrl(url)) {
    showCurrentMsg(t("filters_currentPageRestricted") || "This page cannot be added");
    return;
  }

  // Derive the top-level hostname, then parse it as a bare-host Pattern
  // (Req 14.3 / 14.9). Add-current scopes the current site's host; port/path
  // are intentionally not included.
  let hostname = "";
  try {
    hostname = new URL(url as string).hostname;
  } catch {
    hostname = "";
  }
  const canonical = parsePattern(hostname);
  if (canonical === null) {
    showCurrentMsg(t("filters_currentPageInvalid") || "This site cannot be added");
    return;
  }

  const payload: ScopeSitePayload = { list: listKey, pattern: canonical };

  try {
    const result = (await browser.runtime.sendMessage({
      type: "ADD_SCOPE_SITE",
      payload,
    })) as ScopeResponse;

    if (result && "success" in result && result.success) {
      await loadSettings();
      return;
    }

    // Defensive: background reported INVALID_PATTERN / STORAGE_ERROR.
    showCurrentMsg(t("filters_currentPageInvalid") || "This site cannot be added");
  } catch (error: unknown) {
    console.error("Failed to add current site:", error);
    showCurrentMsg(t("filters_currentPageInvalid") || "This site cannot be added");
  }
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
    if (pattern.startsWith(LINK_PREFIX) && result.siteGroup) {
      announce(linkAddedText(pattern, result.siteGroup));
    }
    await loadSettings();
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

/** Long enough for screen readers to register the cleared region first. */
const ANNOUNCE_DELAY_MS = 100;

/**
 * Speak a confirmation through #siteLocationAnnouncer, the popup's polite live
 * region outside every view: cleared first and set a moment later, so the same
 * message repeated is spoken again.
 */
function announce(text: string): void {
  const region = document.getElementById("siteLocationAnnouncer");
  if (!region) return;
  clearTimeout(announceTimer);
  region.textContent = "";
  announceTimer = setTimeout(() => {
    region.textContent = text;
  }, ANNOUNCE_DELAY_MS);
}

// ── Site group status ──────────────────────────────────────────────────────

/**
 * The status line under the list: where site group data comes from and
 * whether its last update worked, with "Update now". Shown only when the
 * active list or any site location holds a site group or a list from a link.
 */
function renderSiteGroupsStatus(
  settings: Settings,
  listKey: "allowlist" | "denylist" | null,
  proLocked: boolean
): void {
  const box = document.getElementById("siteGroupsStatus");
  const textEl = document.getElementById("siteGroupsStatusText");
  const button = document.getElementById("siteGroupsUpdateNow");
  if (!box || !textEl || !button) return;
  if (button.dataset.wired !== "1") {
    button.dataset.wired = "1";
    button.addEventListener("click", () => {
      void handleUpdateNow();
    });
  }

  const hasToken = (list: unknown): boolean =>
    Array.isArray(list) && list.some((p) => typeof p === "string" && isSiteGroupToken(p));
  const status = siteGroupsStatus();
  const shown =
    !proLocked &&
    siteGroupsAvailable() &&
    status !== null &&
    ((listKey !== null && hasToken(settings[listKey])) ||
      (Array.isArray(settings.siteLocations) &&
        settings.siteLocations.some((entry) => hasToken(entry?.patterns))));
  box.hidden = !shown;
  if (!shown || status === null) return;

  const date = status.releasedAt === null ? "" : formatCatalogDate(Date.parse(status.releasedAt));
  let text: string;
  if (siteGroupsUpdating || status.updating) {
    text = t("siteGroups_statusUpdating") || "Updating site groups…";
  } else if (status.lastError !== null) {
    text =
      t("siteGroups_statusFailed", [date]) ||
      `Couldn't update site groups. Using lists from ${date}.`;
  } else if (upToDateRelease !== null && upToDateRelease === status.release) {
    text =
      t("siteGroups_statusUpToDate", [date]) || `Site groups are up to date (lists from ${date})`;
  } else {
    text = t("siteGroups_statusFrom", [date]) || `Site group lists from ${date}`;
  }
  // Only a real change, so the polite region isn't re-read on every render.
  if (textEl.textContent !== text) textEl.textContent = text;
  // aria-disabled rather than disabled, so a focused button keeps focus.
  if (siteGroupsUpdating) button.setAttribute("aria-disabled", "true");
  else button.removeAttribute("aria-disabled");
}

/** "Update now": a manual refresh, then a reload that re-renders the status. */
async function handleUpdateNow(): Promise<void> {
  if (siteGroupsUpdating) return;
  const before = siteGroupsStatus()?.release ?? null;
  siteGroupsUpdating = true;
  upToDateRelease = null;
  const textEl = document.getElementById("siteGroupsStatusText");
  if (textEl) textEl.textContent = t("siteGroups_statusUpdating") || "Updating site groups…";
  document.getElementById("siteGroupsUpdateNow")?.setAttribute("aria-disabled", "true");

  const result = await requestSiteGroupUpdate();
  siteGroupsUpdating = false;
  document.getElementById("siteGroupsUpdateNow")?.removeAttribute("aria-disabled");
  if (result.ok && before !== null && result.status?.release === before) {
    upToDateRelease = before;
  }
  await loadSettings();
}

/**
 * Remove an entry with optimistic removal + revert-on-failure (Req 14.6).
 */
async function handleRemove(
  listKey: "allowlist" | "denylist",
  domain: string,
  row: HTMLElement
): Promise<void> {
  // Optimistically remove the row.
  const parent = row.parentNode;
  const nextSibling = row.nextSibling;
  row.remove();

  const listEl = document.getElementById("scopeList");
  const emptyEl = document.getElementById("scopeEmptyIndicator");
  if (listEl && emptyEl && listEl.children.length === 0) {
    emptyEl.style.display = "block";
  }
  updateListCountFromDom();

  const payload: ScopeSitePayload = { list: listKey, pattern: domain };

  try {
    const result = (await browser.runtime.sendMessage({
      type: "REMOVE_SCOPE_SITE",
      payload,
    })) as ScopeResponse;

    if (result && "success" in result && result.success) {
      await loadSettings();
      return;
    }

    // Revert: restore the row and surface the message.
    restoreRow(parent, row, nextSibling, emptyEl);
    showModeError();
  } catch (error: unknown) {
    console.error("Failed to remove scope site:", error);
    restoreRow(parent, row, nextSibling, emptyEl);
    showModeError();
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
  updateListCountFromDom();
}

// ── Inline messages ────────────────────────────────────────────────────────

function hideAddError(): void {
  const el = document.getElementById("scopeAddError");
  if (el) el.style.display = "none";
}

/** Show the add-current-site inline status with the given text. */
function showCurrentMsg(text: string): void {
  const el = document.getElementById("scopeCurrentMsg");
  if (el) {
    el.textContent = text;
    el.style.display = "block";
  }
}

function hideCurrentMsg(): void {
  const el = document.getElementById("scopeCurrentMsg");
  if (el) el.style.display = "none";
}

/** Test hook: forget popup-session state between cases. */
export function __resetScopeForTest(): void {
  lastPersistedMode = "all";
  activeListKey = null;
  addControl = null;
  siteGroupsUpdating = false;
  upToDateRelease = null;
  clearTimeout(announceTimer);
  announceTimer = undefined;
}

function showModeError(): void {
  const el = document.getElementById("scopeModeError");
  if (el) el.style.display = "block";
}

function hideModeError(): void {
  const el = document.getElementById("scopeModeError");
  if (el) el.style.display = "none";
}
