/**
 * The add control shared by the Filters list and the per-site location
 * editor: a native `<select>` type menu, a text input, an Add button, an
 * inline error, and, for "Site group", an ARIA 1.2 combobox picker.
 *
 *   - Typing a marker picks the kind: `geosite:` is a site group, `list:` or an
 *     https link to a .txt/.list/.conf/.yaml/.yml file is a list from a link,
 *     `=` is an exact address, `*.` is subdomains only. Removing the marker
 *     puts an auto-picked kind back to "Site and its subdomains". A kind the
 *     user picked is never overridden.
 *   - Picking a kind rewrites the input without the markers that ask for a
 *     different one (`normalizeInputForKind`).
 *   - "Site group" turns the input into a combobox over a listbox with
 *     "Popular" and "All site groups" sections. Arrow keys, Home/End, Enter,
 *     Escape and click work; Enter with no option active adds the typed
 *     `geosite:name@tag`.
 *   - "List from a link" shows "Downloading list…" and disables the control
 *     while the add runs.
 *
 * Where site groups are unavailable (Safari, until the app supports them) the
 * exact, group and link kinds are removed from the menu and nothing is
 * auto-detected, so only typed patterns can be added.
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
    kind: string;
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
  /** Clear the input, close the picker, and return the type menu to its default. */
  reset(): void;
  /**
   * Parse what's in the input as Add would, without adding it: the canonical
   * entries, or the error message for the first bad one. Null when empty.
   */
  readPending(): { entries: string[]; error: string | null } | null;
}

const KINDS: readonly EntryInputKind[] = ["site", "exact", "subdomains", "group", "link"];
/** The kinds hidden where site groups are unavailable. */
const SITE_GROUP_KINDS: ReadonlySet<EntryInputKind> = new Set(["exact", "group", "link"]);

const controls = new WeakMap<HTMLElement, EntryAddControl>();

function isKind(value: string): value is EntryInputKind {
  return (KINDS as readonly string[]).includes(value);
}

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
      return context === "filters"
        ? t("filters_invalidDomain") || "Not a valid pattern"
        : t("siteLocation_errorPattern") ||
            "Use a site like example.com, with no path and not just *.";
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

/**
 * Wire the control for `options.ids` and return it. Wiring happens once per
 * input element; later calls for the same elements return the same control.
 * Null when the markup is missing.
 */
export function createEntryAddControl(options: EntryAddControlOptions): EntryAddControl | null {
  const { ids, context } = options;
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const selectEl = byId<HTMLSelectElement>(ids.kind);
  const inputEl = byId<HTMLInputElement>(ids.input);
  const buttonEl = byId<HTMLButtonElement>(ids.button);
  const listboxEl = byId<HTMLElement>(ids.listbox);
  if (!selectEl || !inputEl || !buttonEl || !listboxEl) return null;
  const select: HTMLSelectElement = selectEl;
  const input: HTMLInputElement = inputEl;
  const button: HTMLButtonElement = buttonEl;
  const listbox: HTMLElement = listboxEl;
  const attribution = byId<HTMLElement>(ids.attribution);

  const existing = controls.get(input);
  if (existing && input.dataset.wired === "1") return existing;
  input.dataset.wired = "1";

  if (!siteGroupsAvailable()) {
    for (const option of Array.from(select.options)) {
      if (isKind(option.value) && SITE_GROUP_KINDS.has(option.value)) option.remove();
    }
  }
  select.value = "site";

  const sitePlaceholder = input.placeholder;
  /** The user chose the kind in the menu; typing never changes it then. */
  let userPicked = false;
  /** The kind was set by a typed marker, so removing the marker reverts it. */
  let autoSet = false;
  let busy = false;
  let open = false;
  let index: SiteGroupIndexItem[] | null = null;
  let indexLoading: Promise<void> | null = null;
  let optionItems: SiteGroupIndexItem[] = [];
  let activeIndex = -1;

  function currentKind(): EntryInputKind {
    return isKind(select.value) ? select.value : "site";
  }

  /** The kind an add would use now: the user's pick, else what the input's marker asks for. */
  function effectiveKind(): EntryInputKind {
    return userPicked ? currentKind() : (detectKind(input.value) ?? "site");
  }

  function placeholderFor(kind: EntryInputKind): string {
    switch (kind) {
      case "exact":
        return t("filters_placeholderExact") || "mail.example.com";
      case "subdomains":
        return t("filters_placeholderSubdomains") || "example.com";
      case "group":
        return t("filters_placeholderGroup") || "Search site groups, e.g. Google";
      case "link":
        return t("filters_placeholderLink") || "https://example.com/list.txt";
      default:
        return context === "filters"
          ? t("filters_addPlaceholder") || sitePlaceholder
          : sitePlaceholder;
    }
  }

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

  /** Placeholder and combobox semantics for `kind`. */
  function applyKind(kind: EntryInputKind): void {
    input.placeholder = placeholderFor(kind);
    if (kind === "group") {
      input.setAttribute("role", "combobox");
      input.setAttribute("aria-autocomplete", "list");
      input.setAttribute("aria-expanded", String(open));
      input.setAttribute("aria-controls", listbox.id);
      if (document.activeElement === input) openPicker();
    } else {
      closePicker();
      for (const attr of ["role", "aria-autocomplete", "aria-expanded", "aria-controls"]) {
        input.removeAttribute(attr);
      }
    }
  }

  function setKind(kind: EntryInputKind, auto: boolean): void {
    autoSet = auto;
    if (select.value !== kind) select.value = kind;
    applyKind(kind);
  }

  // ── The group picker ──

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
      const option = document.createElement("div");
      option.className = "entry-option";
      option.id = optionId(optionItems.length);
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.dataset.index = String(optionItems.length);
      const label = document.createElement("span");
      label.className = "entry-option-label";
      label.textContent = siteGroupOptionText(item);
      option.appendChild(label);
      if (item.featured !== null) {
        const secondary = document.createElement("span");
        secondary.className = "entry-option-secondary";
        secondary.textContent = `${GROUP_PREFIX}${item.name}`;
        option.appendChild(secondary);
      }
      optionItems.push(item);
      group.appendChild(option);
    }
    listbox.appendChild(group);
  }

  function renderPicker(): void {
    while (listbox.firstChild) listbox.removeChild(listbox.firstChild);
    optionItems = [];
    activeIndex = -1;
    input.removeAttribute("aria-activedescendant");
    if (index === null) {
      void ensureIndex();
      return;
    }
    const { popular, all } = searchSiteGroups(index, input.value);
    if (popular.length + all.length === 0) {
      const query = input.value.trim();
      const empty = document.createElement("div");
      empty.className = "entry-listbox-empty";
      empty.setAttribute("role", "option");
      empty.setAttribute("aria-disabled", "true");
      empty.setAttribute("aria-selected", "false");
      empty.textContent = t("siteGroups_noMatch", [query]) || `No site groups match ${query}`;
      listbox.appendChild(empty);
      return;
    }
    appendSection("popular", t("siteGroups_popular") || "Popular", popular);
    appendSection("all", t("siteGroups_allGroups") || "All site groups", all);
  }

  function ensureIndex(): Promise<void> {
    indexLoading ??= loadCatalogIndex().then((loaded) => {
      index = loaded;
      indexLoading = null;
      if (open) renderPicker();
    });
    return indexLoading;
  }

  function openPicker(): void {
    if (currentKind() !== "group" || busy) return;
    if (!open) {
      open = true;
      listbox.hidden = false;
      if (attribution) attribution.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }
    renderPicker();
  }

  function closePicker(): void {
    if (open) {
      open = false;
      listbox.hidden = true;
      if (attribution) attribution.hidden = true;
      while (listbox.firstChild) listbox.removeChild(listbox.firstChild);
      optionItems = [];
      activeIndex = -1;
      input.removeAttribute("aria-activedescendant");
    }
    if (input.getAttribute("role") === "combobox") input.setAttribute("aria-expanded", "false");
    // An empty index means the load failed; try again next time.
    if (index !== null && index.length === 0) index = null;
  }

  function chooseOption(i: number): void {
    const item = optionItems[i];
    if (item === undefined) return;
    const token =
      parseFilterEntry(`${item.name}${typedGroupAttrs(input.value)}`, "group") ??
      `${GROUP_PREFIX}${item.name}`;
    void submitEntries([token], "group");
  }

  // ── Adding ──

  function setBusy(on: boolean, restore: boolean[]): void {
    const controlsToLock = [select, input, button];
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
    closePicker();
    if (!userPicked) setKind("site", false);
  }

  async function submitEntries(entries: string[], kind: EntryInputKind): Promise<void> {
    if (busy) return;
    busy = true;
    closePicker();
    const showBusy = kind === "link";
    const before = [select.disabled, input.disabled, button.disabled];
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

  function submit(): void {
    if (busy) return;
    hideError();
    const kind = effectiveKind();
    if (!userPicked) setKind(kind, kind !== "site");
    if (kind === "group" && typedGroupName(input.value) === "") {
      input.focus();
      openPicker();
      return;
    }
    const parsed = parseEntries(input.value, kind, context);
    if (parsed.error !== null) {
      showError(parsed.error);
      return;
    }
    void submitEntries(parsed.entries, kind);
  }

  // ── Events ──

  select.addEventListener("change", () => {
    const kind = currentKind();
    userPicked = true;
    autoSet = false;
    const normalized = normalizeInputForKind(input.value, kind);
    if (normalized !== input.value) input.value = normalized;
    hideError();
    applyKind(kind);
  });

  input.addEventListener("input", () => {
    hideError();
    if (!userPicked) {
      const detected = detectKind(input.value);
      if (detected !== null) {
        if (detected !== currentKind() || !autoSet) setKind(detected, true);
      } else if (autoSet) {
        setKind("site", false);
      }
    }
    if (currentKind() === "group") openPicker();
  });

  input.addEventListener("focus", () => {
    if (currentKind() === "group") openPicker();
  });

  input.addEventListener("blur", () => {
    closePicker();
  });

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (currentKind() !== "group") {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        if (!open) openPicker();
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
        // Closing the picker is all Escape does here; the per-site editor's
        // own Escape (close the editor) must not also run.
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          closePicker();
        }
        break;
      case "Tab":
        closePicker();
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
      userPicked = false;
      select.value = "site";
      setKind("site", false);
      hideError();
    },
    readPending() {
      if (input.value.trim() === "") return null;
      return parseEntries(input.value, effectiveKind(), context);
    },
  };
  applyKind("site");
  controls.set(input, control);
  return control;
}
