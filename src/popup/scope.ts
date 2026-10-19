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
import { parsePattern } from "@/shared/utils/scope";
import { loadSettings, isRestrictedUrl } from "./settings";
import { t } from "./i18n";

/** Modes that show the list manager. */
const LIST_MODES: ReadonlyArray<ScopeMode> = ["allowlist", "denylist"];

/** Timeout (ms) after which an unconfirmed scope mutation is reverted (Req 13.5). */
const REVERT_TIMEOUT_MS = 5000;

/** The mode currently reflected as persisted, used to revert optimistic changes. */
let lastPersistedMode: ScopeMode = "all";

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
  for (const id of ["scopeAddInput", "scopeAddButton", "scopeAddCurrentButton"]) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLButtonElement | null;
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

/** Build a single list row: the domain label + its remove button. */
function buildSiteRow(listKey: "allowlist" | "denylist", domain: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "scope-site-row";
  row.setAttribute("role", "listitem");

  // Decorative monogram tile: deterministic colour from the domain, generated
  // locally — no favicon fetch, so the list never leaves the device.
  row.appendChild(buildMonogram(domain));

  const label = document.createElement("span");
  label.className = "scope-site-domain";
  label.textContent = domain;
  label.title = domain;
  row.appendChild(label);

  const removeBtn = document.createElement("button");
  removeBtn.className = "scope-site-remove";
  removeBtn.type = "button";
  removeBtn.textContent = "✕";
  removeBtn.setAttribute(
    "aria-label",
    `${t("filters_removeAriaLabel") || "Remove site"} ${domain}`
  );
  removeBtn.addEventListener("click", () => {
    void handleRemove(listKey, domain, row);
  });
  row.appendChild(removeBtn);

  return row;
}

/**
 * Wire the manual add input + button for the active list mode. Replaces the
 * input node to drop stale listeners bound to a previous mode.
 */
function wireAddControls(mode: ScopeMode): void {
  const listKey = listKeyForMode(mode);
  if (listKey === null) return;

  const input = document.getElementById("scopeAddInput") as HTMLInputElement | null;
  const button = document.getElementById("scopeAddButton") as HTMLButtonElement | null;
  if (!input || !button) return;

  // Replace nodes to clear listeners from a prior render/mode.
  const freshInput = input.cloneNode(true) as HTMLInputElement;
  freshInput.value = "";
  input.parentNode?.replaceChild(freshInput, input);

  const freshButton = button.cloneNode(true) as HTMLButtonElement;
  button.parentNode?.replaceChild(freshButton, button);

  const submit = (): void => {
    void handleAdd(listKey, freshInput);
  };

  freshButton.addEventListener("click", submit);
  freshInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });
  freshInput.addEventListener("input", () => {
    hideAddError();
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
 * Validate the typed domain inline. On invalid input, retain the text and show
 * the inline message without sending (Req 14.4). On valid input, send
 * ADD_SCOPE_SITE and reload on success (Req 14.2).
 */
async function handleAdd(
  listKey: "allowlist" | "denylist",
  input: HTMLInputElement
): Promise<void> {
  hideAddError();
  const raw = input.value;
  const canonical = parsePattern(raw);

  if (canonical === null) {
    // Retain input, show inline message, send nothing (Req 12.3, 14.4).
    showAddError();
    return;
  }

  const payload: ScopeSitePayload = { list: listKey, pattern: canonical };

  try {
    const result = (await browser.runtime.sendMessage({
      type: "ADD_SCOPE_SITE",
      payload,
    })) as ScopeResponse;

    if (result && "success" in result && result.success) {
      input.value = "";
      await loadSettings();
      return;
    }

    // Defensive: background also reports INVALID_PATTERN.
    showAddError();
  } catch (error: unknown) {
    console.error("Failed to add scope site:", error);
    showAddError();
  }
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

function showAddError(): void {
  const el = document.getElementById("scopeAddError");
  if (el) el.style.display = "block";
}

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

function showModeError(): void {
  const el = document.getElementById("scopeModeError");
  if (el) el.style.display = "block";
}

function hideModeError(): void {
  const el = document.getElementById("scopeModeError");
  if (el) el.style.display = "none";
}
