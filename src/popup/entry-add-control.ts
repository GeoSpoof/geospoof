/**
 * The add control shared by the Filters list and the per-site location
 * editor: one text input with suggestions (an ARIA 1.2 combobox over a
 * listbox), an Add button and an inline error. There is no type menu (K1).
 *
 *   - Typing lists the readings of the text (`entrySuggestions`): for a bare
 *     host "Site and its subdomains", "Exact address only" and "Subdomains
 *     only", then matching site groups, or the one list a pasted link names.
 *     Nothing is highlighted until an arrow key is pressed (manual selection,
 *     `evaluation.md` 6.6), so Enter adds what was typed, read as
 *     auto-detection reads it: `geosite:` is a site group, `list:` or an
 *     https link to a .txt/.list/.conf/.yaml/.yml file is a list from a link,
 *     `=` is an exact address, `*.` is subdomains only, anything else a site.
 *   - The last option, "Browse all site groups…", shows the "Popular" and "All
 *     site groups" sections; typing returns to the suggestions.
 *   - Arrow keys, Home/End (while an option is active), Enter, Escape, Tab and
 *     click work. Escape closes the listbox only, so the per-site editor's own
 *     Escape doesn't also run.
 *   - A list from a link shows "Downloading list…" and disables the control
 *     while the add runs.
 *
 * Where site groups are unavailable (Safari, until the app supports them)
 * nothing is auto-detected and only the two typed readings are suggested, so
 * only typed patterns can be added.
 *
 * The control parses what's typed into canonical entries and hands them to
 * `onSubmit`, which stores them (Filters) or adds chips (per-site editor).
 */

import { siteGroupsAvailable } from "@/shared/site-groups/availability";
import { GROUP_PREFIX } from "@/shared/site-groups/tokens";
import {
  detectEntryKind,
  normalizeInputForKind,
  parseFilterEntry,
  parseSiteLocationEntry,
  type EntryInputKind,
} from "@/shared/utils/filter-entries";
import { parsePattern } from "@/shared/utils/scope";
import { parseSiteLocationPattern, siteLocationEntryKey } from "@/shared/utils/site-locations";
import { entrySuggestions, groupSearchTerm, type EntrySuggestion } from "./entry-suggestions";
import { t } from "./i18n";
import {
  loadCatalogIndex,
  searchSiteGroups,
  siteGroupOptionText,
  type SiteGroupIndexItem,
} from "./site-groups";

export type EntryAddContext = "filters" | "siteLocation";

/** What `onSubmit` reports: added, or a message to show (the input is kept). */
export type EntrySubmitResult = { ok: true } | { ok: false; message: string };

export interface EntryAddControlOptions {
  ids: {
    input: string;
    button: string;
    listbox: string;
    attribution: string;
    /** The `role=alert` element errors render into (unless `showError` is given). */
    error: string;
  };
  /**
   * `filters`: one entry per add, full typed-pattern grammar. `siteLocation`:
   * typed kinds may list several sites separated by commas, with no paths.
   */
  context: EntryAddContext;
  onSubmit(canonicalEntries: string[], kind: EntryInputKind): Promise<EntrySubmitResult>;
  /** Render errors elsewhere (the per-site editor's shared alert). */
  showError?(message: string): void;
  hideError?(): void;
}

export interface EntryAddControl {
  /** Clear the input, close the suggestions, and hide the error. */
  reset(): void;
  /**
   * Parse what's in the input as Add would, without adding it: the canonical
   * entries, or the error message for the first bad one. Null when empty.
   */
  readPending(): { entries: string[]; error: string | null } | null;
}

/** An option in the listbox. */
type PickerOption =
  | { type: "suggestion"; suggestion: EntrySuggestion }
  | { type: "group"; item: SiteGroupIndexItem }
  | { type: "browse" };

const controls = new WeakMap<HTMLElement, EntryAddControl>();

/** The kind a typed marker asks for, where auto-detection is on. */
function detectKind(input: string): EntryInputKind | null {
  return siteGroupsAvailable() ? detectEntryKind(input) : null;
}

/** The name part of a group search ("goo" in "geosite:goo@cn"), as typed. */
function typedGroupName(raw: string): string {
  let s = normalizeInputForKind(raw, "group").trim();
  if (s.slice(0, GROUP_PREFIX.length).toLowerCase() === GROUP_PREFIX) {
    s = s.slice(GROUP_PREFIX.length);
  }
  return s;
}

/** The `@attr` part of a group search ("@cn" in "goo@cn"), or "". */
function typedGroupAttrs(raw: string): string {
  const name = typedGroupName(raw);
  const at = name.indexOf("@");
  return at === -1 ? "" : name.slice(at);
}

/** The inline message for an entry of `kind` that doesn't parse. */
export function entryInvalidText(
  kind: EntryInputKind,
  raw: string,
  context: EntryAddContext
): string {
  switch (kind) {
    case "exact":
      return t("filters_errorExact") || "Enter one address, like mail.example.com, without *";
    case "group": {
      const name = typedGroupName(raw);
      return t("siteGroups_errorUnknown", [name]) || `No site group is called ${name}.`;
    }
    case "link":
      return t("siteGroups_errorLinkInvalid") || "Enter a link that starts with https://";
    default:
      if (context === "siteLocation") {
        return (
          t("siteLocation_errorPattern") ||
          "Use a site like example.com, with no path and not just *."
        );
      }
      // K1: name the fix. Where there are no site groups, there's only one.
      return siteGroupsAvailable()
        ? t("filters_errorSiteOrGroup") ||
            "Use a site like example.com, or pick a site group below."
        : t("filters_errorSite") || "Use a site like example.com.";
  }
}

/**
 * Parse `raw` as `kind` for `context`: the canonical entries, or the message
 * for the first one that doesn't parse. Per-site typed kinds split on commas,
 * dedupe by entry identity, and (with kind "site") read each site's own marker.
 */
function parseEntries(
  raw: string,
  kind: EntryInputKind,
  context: EntryAddContext
): { entries: string[]; error: string | null } {
  const invalid = (k: EntryInputKind, text: string) => ({
    entries: [] as string[],
    error: entryInvalidText(k, text, context),
  });

  if (context === "filters") {
    const canonical = kind === "site" ? parsePattern(raw) : parseFilterEntry(raw, kind);
    return canonical === null ? invalid(kind, raw) : { entries: [canonical], error: null };
  }

  if (kind === "group" || kind === "link") {
    const canonical = parseSiteLocationEntry(raw, kind);
    return canonical === null ? invalid(kind, raw) : { entries: [canonical], error: null };
  }

  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return invalid(kind, raw);
  const entries: string[] = [];
  const keys = new Set<string>();
  for (const token of tokens) {
    const tokenKind = kind === "site" ? (detectKind(token) ?? "site") : kind;
    const canonical =
      tokenKind === "site"
        ? parseSiteLocationPattern(token)
        : parseSiteLocationEntry(token, tokenKind);
    const key = canonical === null ? null : siteLocationEntryKey(canonical);
    if (canonical === null || key === null) return invalid(tokenKind, token);
    if (!keys.has(key)) {
      keys.add(key);
      entries.push(canonical);
    }
  }
  return { entries, error: null };
}

/** Identifies an option across re-renders, so the active one survives the index loading. */
function optionKey(option: PickerOption): string {
  switch (option.type) {
    case "suggestion":
      return `s:${option.suggestion.entry}`;
    case "group":
      return `g:${option.item.name}`;
    default:
      return "browse";
  }
}

/**
 * Wire the control for `options.ids` and return it. Wiring happens once per
 * input element; later calls for the same elements return the same control.
 * Null when the markup is missing.
 */
export function createEntryAddControl(options: EntryAddControlOptions): EntryAddControl | null {
  const { ids, context } = options;
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const inputEl = byId<HTMLInputElement>(ids.input);
  const buttonEl = byId<HTMLButtonElement>(ids.button);
  const listboxEl = byId<HTMLElement>(ids.listbox);
  if (!inputEl || !buttonEl || !listboxEl) return null;
  const input: HTMLInputElement = inputEl;
  const button: HTMLButtonElement = buttonEl;
  const listbox: HTMLElement = listboxEl;
  const attribution = byId<HTMLElement>(ids.attribution);

  const existing = controls.get(input);
  if (existing && input.dataset.wired === "1") return existing;
  input.dataset.wired = "1";

  let busy = false;
  let open = false;
  /** "Browse all site groups…" was picked; typing returns to the suggestions. */
  let browsing = false;
  let index: SiteGroupIndexItem[] | null = null;
  let indexLoading: Promise<void> | null = null;
  let optionItems: PickerOption[] = [];
  let activeIndex = -1;

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", listbox.id);

  function showError(message: string): void {
    input.setAttribute("aria-invalid", "true");
    if (options.showError) {
      options.showError(message);
      return;
    }
    const errorEl = byId<HTMLElement>(ids.error);
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.hidden = false;
      errorEl.style.display = "block";
    }
  }

  function hideError(): void {
    input.removeAttribute("aria-invalid");
    if (options.hideError) {
      options.hideError();
      return;
    }
    const errorEl = byId<HTMLElement>(ids.error);
    if (errorEl) errorEl.style.display = "none";
  }

  // ── The listbox ──

  function optionId(i: number): string {
    return `${listbox.id}-opt-${i}`;
  }

  function setActive(i: number): void {
    const previous = activeIndex >= 0 ? byId<HTMLElement>(optionId(activeIndex)) : null;
    if (previous) {
      previous.setAttribute("aria-selected", "false");
      previous.classList.remove("active");
    }
    activeIndex = i;
    const next = i >= 0 ? byId<HTMLElement>(optionId(i)) : null;
    if (next) {
      next.setAttribute("aria-selected", "true");
      next.classList.add("active");
      input.setAttribute("aria-activedescendant", next.id);
      if (typeof next.scrollIntoView === "function") next.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function move(delta: 1 | -1): void {
    const count = optionItems.length;
    if (count === 0) return;
    if (activeIndex < 0) setActive(delta > 0 ? 0 : count - 1);
    else setActive((activeIndex + delta + count) % count);
  }

  function clearOptions(): void {
    while (listbox.firstChild) listbox.removeChild(listbox.firstChild);
    optionItems = [];
    activeIndex = -1;
    input.removeAttribute("aria-activedescendant");
  }

  /** A new option element for `option`, registered at the next index. */
  function buildOption(option: PickerOption, className: string): HTMLElement {
    const node = document.createElement("div");
    node.className = className;
    node.id = optionId(optionItems.length);
    node.setAttribute("role", "option");
    node.setAttribute("aria-selected", "false");
    node.dataset.index = String(optionItems.length);
    optionItems.push(option);
    return node;
  }

  function textSpan(className: string, text: string): HTMLElement {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    return span;
  }

  /** A row that says nothing matches; not an option the arrows can reach. */
  function appendEmpty(text: string): void {
    const empty = document.createElement("div");
    empty.className = "entry-listbox-empty";
    empty.setAttribute("role", "option");
    empty.setAttribute("aria-disabled", "true");
    empty.setAttribute("aria-selected", "false");
    empty.textContent = text;
    listbox.appendChild(empty);
  }

  function appendSuggestions(items: EntrySuggestion[], browse: boolean): void {
    for (const suggestion of items) {
      const node = buildOption({ type: "suggestion", suggestion }, "entry-option entry-suggestion");
      node.append(
        textSpan("entry-suggestion-title", suggestion.title),
        textSpan("entry-suggestion-meta", suggestion.meta)
      );
      listbox.appendChild(node);
    }
    if (browse) {
      const node = buildOption({ type: "browse" }, "entry-option entry-suggestion-browse");
      node.textContent = t("siteGroups_browseAll") || "Browse all site groups…";
      listbox.appendChild(node);
    }
  }

  function appendSection(key: string, heading: string, items: SiteGroupIndexItem[]): void {
    if (items.length === 0) return;
    const group = document.createElement("div");
    group.className = "entry-listbox-group";
    group.setAttribute("role", "group");
    const headingEl = document.createElement("div");
    headingEl.className = "entry-listbox-heading";
    headingEl.id = `${listbox.id}-${key}`;
    headingEl.setAttribute("role", "presentation");
    headingEl.textContent = heading;
    group.setAttribute("aria-labelledby", headingEl.id);
    group.appendChild(headingEl);
    for (const item of items) {
      const option = buildOption({ type: "group", item }, "entry-option");
      option.appendChild(textSpan("entry-option-label", siteGroupOptionText(item)));
      if (item.featured !== null) {
        option.appendChild(textSpan("entry-option-secondary", `${GROUP_PREFIX}${item.name}`));
      }
      group.appendChild(option);
    }
    listbox.appendChild(group);
  }

  /** "Browse all site groups…": today's picker, Popular then All site groups. */
  function renderBrowse(): void {
    if (index === null) {
      void ensureIndex();
      return;
    }
    const { popular, all } = searchSiteGroups(index, "");
    appendSection("popular", t("siteGroups_popular") || "Popular", popular);
    appendSection("all", t("siteGroups_allGroups") || "All site groups", all);
  }

  function renderSuggestions(): void {
    const groupsAvailable = siteGroupsAvailable();
    if (groupsAvailable && index === null) void ensureIndex();
    const { items, browse } = entrySuggestions(input.value, { context, groupsAvailable, index });
    // A typed group name that matches nothing says so, as the picker did.
    if (
      items.length === 0 &&
      index !== null &&
      detectKind(input.value) === "group" &&
      groupSearchTerm(input.value) !== ""
    ) {
      const query = typedGroupName(input.value);
      appendEmpty(t("siteGroups_noMatch", [query]) || `No site groups match ${query}`);
    }
    appendSuggestions(items, browse);
  }

  /** A site group is visible: a group row, or the browse sections. */
  function showsGroups(): boolean {
    return optionItems.some(
      (option) =>
        option.type === "group" ||
        (option.type === "suggestion" && option.suggestion.kind === "group")
    );
  }

  /** Render the listbox for the input's text and show it when it has rows. */
  function render(): void {
    clearOptions();
    if (browsing) renderBrowse();
    else renderSuggestions();
    open = listbox.childElementCount > 0;
    listbox.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    // The v2fly credit belongs with the groups it names.
    if (attribution) attribution.hidden = !(open && showsGroups());
  }

  function ensureIndex(): Promise<void> {
    indexLoading ??= loadCatalogIndex().then((loaded) => {
      index = loaded;
      indexLoading = null;
      if (!open) return;
      const active = activeIndex >= 0 ? optionKey(optionItems[activeIndex]) : null;
      render();
      if (active !== null) {
        const i = optionItems.findIndex((option) => optionKey(option) === active);
        if (i >= 0) setActive(i);
      }
    });
    return indexLoading;
  }

  function close(): void {
    browsing = false;
    if (open) {
      open = false;
      listbox.hidden = true;
      clearOptions();
    }
    if (attribution) attribution.hidden = true;
    input.setAttribute("aria-expanded", "false");
    // An empty index means the load failed; try again next time.
    if (index !== null && index.length === 0) index = null;
  }

  function chooseOption(i: number): void {
    const option = optionItems[i];
    if (option === undefined) return;
    switch (option.type) {
      case "suggestion":
        void submitEntries([option.suggestion.entry], option.suggestion.kind);
        break;
      case "group": {
        const token =
          parseFilterEntry(`${option.item.name}${typedGroupAttrs(input.value)}`, "group") ??
          `${GROUP_PREFIX}${option.item.name}`;
        void submitEntries([token], "group");
        break;
      }
      case "browse":
        browsing = true;
        render();
        break;
    }
  }

  // ── Adding ──

  function setBusy(on: boolean, restore: boolean[]): void {
    const controlsToLock = [input, button];
    controlsToLock.forEach((control, i) => {
      control.disabled = on ? true : restore[i];
    });
    if (on) {
      button.dataset.label = button.textContent ?? "";
      button.textContent = t("siteGroups_downloading") || "Downloading list…";
      input.setAttribute("aria-busy", "true");
    } else {
      button.textContent = button.dataset.label ?? button.textContent;
      delete button.dataset.label;
      input.removeAttribute("aria-busy");
    }
  }

  function clearAfterAdd(): void {
    input.value = "";
    close();
  }

  async function submitEntries(entries: string[], kind: EntryInputKind): Promise<void> {
    if (busy) return;
    busy = true;
    close();
    const showBusy = kind === "link";
    const before = [input.disabled, button.disabled];
    if (showBusy) setBusy(true, before);
    let result: EntrySubmitResult;
    try {
      result = await options.onSubmit(entries, kind);
    } catch (error: unknown) {
      console.error("Failed to add the entry:", error);
      result = { ok: false, message: t("filters_notSaved") || "⚠ Change not saved" };
    } finally {
      busy = false;
      if (showBusy) setBusy(false, before);
    }
    if (!input.isConnected) return;
    if (showBusy && (document.activeElement === null || document.activeElement === document.body)) {
      input.focus();
    }
    if (result.ok) clearAfterAdd();
    else showError(result.message);
  }

  /** Add the typed text, read as auto-detection reads it. */
  function submit(): void {
    if (busy) return;
    hideError();
    const kind = detectKind(input.value) ?? "site";
    if (kind === "group" && typedGroupName(input.value) === "") {
      input.focus();
      browsing = true;
      render();
      return;
    }
    const parsed = parseEntries(input.value, kind, context);
    if (parsed.error !== null) {
      showError(parsed.error);
      // "google": the message names the fix, and the group stays in the list
      // to pick (K1).
      const offersGroups = optionItems.some(
        (option) => option.type !== "suggestion" || option.suggestion.kind === "group"
      );
      if (!(context === "filters" && kind === "site" && open && offersGroups)) close();
      return;
    }
    void submitEntries(parsed.entries, kind);
  }

  // ── Events ──

  input.addEventListener("input", () => {
    hideError();
    browsing = false;
    if (!busy) render();
  });

  input.addEventListener("focus", () => {
    if (!busy && input.value.trim() !== "") render();
  });

  input.addEventListener("blur", () => {
    close();
  });

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        if (!open && !busy) render();
        // Nothing to show: the arrows keep their usual meaning.
        if (!open) return;
        e.preventDefault();
        move(e.key === "ArrowDown" ? 1 : -1);
        break;
      case "Home":
      case "End":
        // Only while an option is active; otherwise they move the caret.
        if (open && activeIndex >= 0 && optionItems.length > 0) {
          e.preventDefault();
          setActive(e.key === "Home" ? 0 : optionItems.length - 1);
        }
        break;
      case "Enter":
        e.preventDefault();
        if (open && activeIndex >= 0) chooseOption(activeIndex);
        else submit();
        break;
      case "Escape":
        // Closing the listbox is all Escape does here; the per-site editor's
        // own Escape (close the editor) must not also run.
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
        break;
      case "Tab":
        close();
        break;
    }
  });

  // Keep focus in the input while the pointer is on the listbox.
  listbox.addEventListener("mousedown", (e: MouseEvent) => {
    e.preventDefault();
  });
  listbox.addEventListener("click", (e: MouseEvent) => {
    const option = (e.target as HTMLElement | null)?.closest<HTMLElement>(".entry-option");
    if (!option || option.dataset.index === undefined) return;
    chooseOption(Number(option.dataset.index));
  });

  button.addEventListener("click", () => {
    submit();
  });

  const control: EntryAddControl = {
    reset(): void {
      input.value = "";
      close();
      hideError();
    },
    readPending() {
      if (input.value.trim() === "") return null;
      return parseEntries(input.value, detectKind(input.value) ?? "site", context);
    },
  };
  controls.set(input, control);
  return control;
}
