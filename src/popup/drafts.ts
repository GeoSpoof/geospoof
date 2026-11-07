/**
 * Unfinished work on the Filters tab survives closing the popup (S7): the
 * open screen, the text typed in a list's add field, and an open editor (its
 * sites, the text still in its Sites input, the chosen place, the search
 * text, and where it was opened from).
 *
 * The draft lives in `browser.storage.session`, which the browser clears when
 * it quits. It is keyed to the site the popup opened on, so it comes back
 * only on that site: a popup opened on `twitch.tv` never shows an editor
 * filled in on `chatgpt.com`, and that stale draft is dropped. It's never part
 * of Settings, never sent in a runtime message, and never bridged to the app.
 *
 * Every change writes the draft at once, unawaited and with no debounce,
 * because the popup can close at any moment. Going back to the Filters root
 * removes it, and so does closing the editor (Cancel, Save, Remove), except
 * that the screen the editor returns to is kept like any other screen. A
 * successful list add keeps the screen and drops the typed text.
 */

import type { LocationName, Settings } from "@/shared/types/settings";
import { suggestSiteLocationPattern } from "@/shared/utils/site-locations";
import { isOwnExtensionPage } from "./active-tab";
import {
  getFiltersScreen,
  onFiltersScreenChange,
  openFiltersScreen,
  type EditorOrigin,
  type FiltersScreen,
} from "./filters-nav";
import { getActiveListKey } from "./scope";
import { isRestrictedUrl } from "./settings";
import { applyEditorDraft, openSiteLocationEditor, readEditorDraft } from "./site-locations";

/** The one `storage.session` key the draft lives under. */
export const FILTERS_DRAFT_STORAGE_KEY = "popupFiltersDraft";

/** A place chosen in the editor, as the editor holds it. */
export interface DraftChosenLocation {
  latitude: number;
  longitude: number;
  name: string;
  locationName?: LocationName | null;
  label?: string | null;
}

/** An open editor's unsaved state. */
export interface EditorDraft {
  origin: EditorOrigin;
  /** The entry being edited, or null for a new one. */
  entryId: string | null;
  /** The sites, as chips. */
  entries: string[];
  /** The text still in the Sites input. */
  pending: string;
  chosen: DraftChosenLocation | null;
  /** The text in the Location search field. */
  search: string;
}

export interface FiltersDraft {
  v: 1;
  /** The site the popup opened on (see {@link draftKey}). */
  key: string;
  screen: Exclude<FiltersScreen, "root">;
  /**
   * Set when `screen` is the list: the list it showed, so a mode changed
   * elsewhere (the app, another window) never puts its text in the other list.
   */
  list?: "allowlist" | "denylist";
  /** The text in the list screen's add field. */
  listField?: string;
  /** Set when `screen` is the editor. */
  editor?: EditorDraft;
}

/** The key of the popup this module serves, or null when drafts aren't kept. */
let activeKey: string | null = null;
let unsubscribe: (() => void) | null = null;

type SessionArea = typeof browser.storage.session;

/** `storage.session`, or null where this browser doesn't have it. */
function sessionArea(): SessionArea | null {
  try {
    const area = (browser.storage as { session?: SessionArea } | undefined)?.session;
    return area && typeof area.set === "function" ? area : null;
  } catch {
    return null;
  }
}

/**
 * What a draft is keyed to: "options" in the Chromium options tab (the popup
 * page itself), the suggested site pattern for an ordinary page, and null for
 * a restricted or host-less tab, where no draft is kept.
 */
export function draftKey(tabUrl: string | undefined): string | null {
  if (!tabUrl) return null;
  if (isOwnExtensionPage(tabUrl)) return "options";
  if (isRestrictedUrl(tabUrl)) return null;
  return suggestSiteLocationPattern(tabUrl);
}

function write(draft: FiltersDraft): void {
  const area = sessionArea();
  if (!area) return;
  try {
    void area.set({ [FILTERS_DRAFT_STORAGE_KEY]: draft }).catch((error: unknown) => {
      console.error("Failed to keep the Filters draft:", error);
    });
  } catch (error: unknown) {
    console.error("Failed to keep the Filters draft:", error);
  }
}

/** Remove the draft. */
export function clearFiltersDraft(): void {
  const area = sessionArea();
  if (!area) return;
  try {
    void area.remove(FILTERS_DRAFT_STORAGE_KEY).catch((error: unknown) => {
      console.error("Failed to remove the Filters draft:", error);
    });
  } catch (error: unknown) {
    console.error("Failed to remove the Filters draft:", error);
  }
}

/**
 * Write what's open now. On the root this removes the draft. `overrides`
 * stand in for a field that's about to be emptied (after an add, the add
 * control clears its input only once the add resolves).
 */
export function saveFiltersDraft(overrides: { listField?: string; pending?: string } = {}): void {
  if (activeKey === null || !sessionArea()) return;
  const screen = getFiltersScreen();
  if (screen === "root") {
    clearFiltersDraft();
    return;
  }
  const draft: FiltersDraft = { v: 1, key: activeKey, screen };
  if (screen === "list") {
    const list = getActiveListKey();
    if (list === null) return;
    draft.list = list;
  }
  const listField =
    overrides.listField ??
    (document.getElementById("scopeAddInput") as HTMLInputElement | null)?.value ??
    "";
  if (listField !== "") draft.listField = listField;
  if (screen === "editor") {
    const editor = readEditorDraft();
    if (editor === null) return;
    draft.editor =
      overrides.pending === undefined ? editor : { ...editor, pending: overrides.pending };
  }
  write(draft);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function parseChosen(value: unknown): DraftChosenLocation | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { latitude, longitude, name, locationName, label } = value;
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    typeof name !== "string" ||
    !isOptionalString(label) ||
    !(locationName === undefined || locationName === null || isRecord(locationName))
  ) {
    return undefined;
  }
  const chosen: DraftChosenLocation = { latitude, longitude, name };
  if (locationName !== undefined) chosen.locationName = locationName as LocationName | null;
  if (label !== undefined) chosen.label = label as string | null;
  return chosen;
}

function parseEditor(value: unknown): EditorDraft | null {
  if (!isRecord(value)) return null;
  const { origin, entryId, entries, pending, search } = value;
  const chosen = parseChosen(value.chosen);
  if (
    (origin !== "root" && origin !== "perSite" && origin !== "main") ||
    !(entryId === null || typeof entryId === "string") ||
    !Array.isArray(entries) ||
    !entries.every((entry): entry is string => typeof entry === "string") ||
    typeof pending !== "string" ||
    typeof search !== "string" ||
    chosen === undefined
  ) {
    return null;
  }
  return { origin, entryId, entries, pending, chosen, search };
}

/** The stored draft, or null when it isn't one this version wrote. */
function parseDraft(value: unknown): FiltersDraft | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.key !== "string") return null;
  const { screen, list, listField } = value;
  if (screen !== "list" && screen !== "perSite" && screen !== "editor") return null;
  if (listField !== undefined && typeof listField !== "string") return null;
  const draft: FiltersDraft = { v: 1, key: value.key, screen };
  if (screen === "list") {
    if (list !== "allowlist" && list !== "denylist") return null;
    draft.list = list;
  }
  if (typeof listField === "string") draft.listField = listField;
  if (screen === "editor") {
    const editor = parseEditor(value.editor);
    if (editor === null) return null;
    draft.editor = editor;
  }
  return draft;
}

/** Whether the screen the draft was on can still open with these settings. */
function canRestore(draft: FiltersDraft, settings: Settings, proLocked: boolean): boolean {
  if (proLocked) return false;
  if (draft.screen === "list") return settings.scopeMode === draft.list;
  if (draft.screen === "editor") {
    const id = draft.editor?.entryId ?? null;
    const stored = Array.isArray(settings.siteLocations) ? settings.siteLocations : [];
    return id === null || stored.some((entry) => entry.id === id);
  }
  return true;
}

const POPUP_VIEW_TRIGGERS = ["mainTab", "filtersTab", "detailsTab", "settingsTab"] as const;
/** The popup view showing now, by its trigger's `aria-current`. */
function currentPopupView(): string | null {
  return (
    POPUP_VIEW_TRIGGERS.find(
      (id) => document.getElementById(id)?.getAttribute("aria-current") === "true"
    ) ?? null
  );
}
/**
 * Run once, after the popup's first render: start keeping drafts for this
 * tab, and bring back the one kept for it. A draft for another site, for a
 * screen that's locked or no longer applies, or for an entry that's gone, is
 * removed and the popup opens as usual. If the user switched views or opened
 * a Filters screen while the tab and the draft were being read, their move
 * stands and nothing is restored.
 */
export async function restoreFiltersDraft(
  settings: Settings,
  tabUrl: string | undefined | Promise<string | undefined>,
  proLocked: boolean
): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  const startView = currentPopupView();
  const startScreen = getFiltersScreen();
  const moved = (): boolean =>
    currentPopupView() !== startView || getFiltersScreen() !== startScreen;
  activeKey = draftKey(await tabUrl);
  unsubscribe?.();
  unsubscribe = onFiltersScreenChange(() => {
    saveFiltersDraft();
  });

  let stored: unknown;
  try {
    const result = await area.get(FILTERS_DRAFT_STORAGE_KEY);
    stored = (result as Record<string, unknown> | undefined)?.[FILTERS_DRAFT_STORAGE_KEY];
  } catch (error: unknown) {
    console.error("Failed to read the Filters draft:", error);
    return;
  }
  if (stored === undefined) return;

  const draft = parseDraft(stored);
  if (
    draft === null ||
    activeKey === null ||
    draft.key !== activeKey ||
    !canRestore(draft, settings, proLocked)
  ) {
    clearFiltersDraft();
    return;
  }
  // The user's own first move wins; the draft (or what that move saved) stays.
  if (moved()) return;

  document.getElementById("filtersTab")?.click();
  const input = document.getElementById("scopeAddInput") as HTMLInputElement | null;
  if (input && draft.listField !== undefined) input.value = draft.listField;

  if (draft.screen === "list") {
    openFiltersScreen("list", {
      opener: document.getElementById("scopeListRow"),
      focus: input && draft.listField ? input : null,
    });
    return;
  }
  if (draft.screen === "perSite") {
    openFiltersScreen("perSite", { opener: document.getElementById("siteLocationsRow") });
    return;
  }
  const editor = draft.editor;
  if (!editor) return;
  openSiteLocationEditor({ entryId: editor.entryId, opener: null, origin: editor.origin });
  if (getFiltersScreen() !== "editor") {
    clearFiltersDraft();
    return;
  }
  applyEditorDraft(editor);
}

/** Test hook: stop keeping drafts. */
export function __resetDraftsForTest(): void {
  activeKey = null;
  unsubscribe?.();
  unsubscribe = null;
}
