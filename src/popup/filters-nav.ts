/**
 * Filters tab navigation (design H, direction.md 4.4 and 6.3–6.4): a root and
 * three screens, one shown at a time.
 *
 *   - `root` (#filtersRoot): "Where GeoSpoof works", the active list's row and
 *     the Per-site locations row;
 *   - `list` (#scopeListScreen): the Allowlist or the Denylist;
 *   - `perSite` (#siteLocationsScreen): Per-site locations;
 *   - `editor` (#siteLocationEditorScreen): one per-site location.
 *
 * Opening a screen scrolls to the top and moves focus to its title (or to an
 * element the caller names). The back row names the screen it returns to;
 * the back row and Escape go back, and focus returns to the element that
 * opened the screen, else to a fallback the caller registers. The editor
 * returns to where it was opened from: the root, the Per-site locations
 * screen, or the Main tab.
 *
 * Rows that open something are `role="button"` elements: Enter or Space
 * activates them, and `aria-disabled="true"` makes them inert while they stay
 * focusable (so a screen-reader user still hears why they're locked).
 */

import { t } from "./i18n";

export type FiltersScreen = "root" | "list" | "perSite" | "editor";
/** Where the editor was opened from, and so where it returns. */
export type EditorOrigin = "root" | "perSite" | "main";

const SCREEN_IDS: Readonly<Record<FiltersScreen, string>> = {
  root: "filtersRoot",
  list: "scopeListScreen",
  perSite: "siteLocationsScreen",
  editor: "siteLocationEditorScreen",
};

const BACK_ROWS: ReadonlyArray<[Exclude<FiltersScreen, "root">, string]> = [
  ["list", "scopeListBack"],
  ["perSite", "siteLocationsBack"],
  ["editor", "siteLocationEditorBack"],
];

export interface FiltersScreenChange {
  screen: FiltersScreen;
  /** Set when `screen` is the editor. */
  editorOrigin: EditorOrigin | null;
}

let current: FiltersScreen = "root";
let editorOrigin: EditorOrigin = "root";
/** The element that opened each screen, for focus on the way back. */
let openers: Partial<Record<FiltersScreen, HTMLElement | null>> = {};
/** A screen's own way back (the editor waits for a save in flight). */
const backHandlers: Partial<Record<FiltersScreen, () => void>> = {};
/** Where focus goes when leaving a screen whose opener is gone. */
const fallbacks: Partial<Record<FiltersScreen, () => HTMLElement | null>> = {};
const listeners = new Set<(change: FiltersScreenChange) => void>();

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** Connected and not inside anything `hidden`. */
export function isFocusable(node: HTMLElement | null | undefined): node is HTMLElement {
  return node != null && node.isConnected && node.closest("[hidden]") === null;
}

/** The screen showing now. */
export function getFiltersScreen(): FiltersScreen {
  return current;
}

/** Where the editor returns to (meaningful while the editor shows). */
export function getEditorOrigin(): EditorOrigin {
  return editorOrigin;
}

/**
 * Wire the back rows and Escape once per markup. Fresh markup (a new popup,
 * or a test's new body) starts on the root.
 */
export function wireFiltersNavOnce(): void {
  const view = el("filtersView");
  if (!view || view.dataset.navWired === "1") return;
  view.dataset.navWired = "1";
  current = "root";
  editorOrigin = "root";
  openers = {};

  for (const [, id] of BACK_ROWS) {
    el(id)?.addEventListener("click", goBack);
  }
  // A combobox's Escape closes only its suggestions; it stops the event, so
  // it never reaches this.
  view.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || current === "root") return;
    e.preventDefault();
    goBack();
  });
}

/** The back row or Escape on the current screen. */
function goBack(): void {
  const handler = backHandlers[current];
  if (handler) handler();
  else backFromFiltersScreen();
}

/** Run `handler` instead of the plain way back when leaving `screen` by its back row or Escape. */
export function setFiltersScreenBackHandler(screen: FiltersScreen, handler: () => void): void {
  backHandlers[screen] = handler;
}

/** Where focus goes when leaving `screen` and its opener is gone or hidden. */
export function setFiltersScreenFallback(
  screen: FiltersScreen,
  fallback: () => HTMLElement | null
): void {
  fallbacks[screen] = fallback;
}

/** Called on every screen change (FEAT-005 keeps drafts with it). Returns an unsubscribe. */
export function onFiltersScreenChange(listener: (change: FiltersScreenChange) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function show(screen: FiltersScreen): void {
  for (const [key, id] of Object.entries(SCREEN_IDS) as Array<[FiltersScreen, string]>) {
    const node = el(id);
    if (node) node.hidden = key !== screen;
  }
  current = screen;
  const change: FiltersScreenChange = {
    screen,
    editorOrigin: screen === "editor" ? editorOrigin : null,
  };
  for (const listener of listeners) listener(change);
}

/** The editor's back row names where it returns to (6.4). */
function renderEditorBackLabel(): void {
  const label = el("siteLocationEditorBackLabel");
  if (!label) return;
  label.textContent =
    editorOrigin === "perSite"
      ? t("siteLocation_sectionTitle") || "Per-site locations"
      : editorOrigin === "main"
        ? t("tab_main") || "Main"
        : t("tab_filters") || "Filters";
}

/**
 * Show `screen`, scrolled to the top, with focus on `focus` or else on the
 * screen's title. `opener` gets focus back when the screen is left.
 */
export function openFiltersScreen(
  screen: FiltersScreen,
  opts: {
    opener?: HTMLElement | null;
    focus?: HTMLElement | null;
    editorOrigin?: EditorOrigin;
  } = {}
): void {
  wireFiltersNavOnce();
  if (screen !== "root") openers[screen] = opts.opener ?? null;
  if (screen === "editor") {
    editorOrigin = opts.editorOrigin ?? "root";
    renderEditorBackLabel();
  }
  show(screen);

  const container = document.querySelector<HTMLElement>(".popup-container");
  if (container) container.scrollTop = 0;

  const target =
    opts.focus ?? el(SCREEN_IDS[screen])?.querySelector<HTMLElement>(".view-title") ?? null;
  if (isFocusable(target)) target.focus();
}

/**
 * Go back one level: the editor to where it was opened from, the other
 * screens to the root. Leaving an editor opened from the Main tab shows the
 * root underneath and switches to the Main tab. With `restoreFocus`, focus
 * returns to the opener if it's still on screen, else to the registered
 * fallback.
 */
export function backFromFiltersScreen(opts: { restoreFocus?: boolean } = {}): void {
  const restoreFocus = opts.restoreFocus ?? true;
  const leaving = current;
  if (leaving === "root") return;
  const opener = openers[leaving] ?? null;
  delete openers[leaving];

  const origin = editorOrigin;
  show(leaving === "editor" && origin === "perSite" ? "perSite" : "root");
  if (leaving === "editor") {
    editorOrigin = "root";
    // index.ts's own tab handler switches the view.
    if (origin === "main") el("mainTab")?.click();
  }
  if (!restoreFocus) return;
  if (isFocusable(opener)) {
    opener.focus();
    return;
  }
  const fallback = fallbacks[leaving]?.() ?? null;
  if (isFocusable(fallback)) fallback.focus();
}

/**
 * Wire a `role="button"` row: click, Enter or Space runs `onActivate`, unless
 * the row is `aria-disabled="true"`. Space doesn't scroll the popup.
 */
export function wireButtonRow(row: HTMLElement, onActivate: () => void): void {
  const inert = (): boolean => row.getAttribute("aria-disabled") === "true";
  row.addEventListener("click", () => {
    if (!inert()) onActivate();
  });
  row.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target !== row) return;
    e.preventDefault();
    if (!inert()) onActivate();
  });
}

/** Test hook: back to the root, with no openers or listeners. */
export function __resetFiltersNavForTest(): void {
  current = "root";
  editorOrigin = "root";
  openers = {};
  listeners.clear();
}
