/**
 * Popup Reported Language control (Settings screen, WHAT SITES SEE).
 *
 * Lets the user choose what language websites see. Maps a three-option dropdown
 * onto the {@link LocaleSpoofing} model and persists via `SET_LOCALE_SPOOFING`:
 *
 *   - "Off"               → { mode: "off" }    (default; report the real locale)
 *   - "Match my location" → { mode: "match" }  (derive from the spoofed location)
 *   - "Choose language…"  → { mode: "custom", locale } (revealed text input)
 *
 * NOT the same thing as the "Language" row under General, which
 * is `Settings.uiLanguage` and controls GeoSpoof's OWN popup language. This one
 * changes what sites see. The label is "Reported Language" specifically so the
 * two can't be confused.
 *
 * The Custom control works like the accuracy control's, because it solves the
 * same problem (a preset dropdown revealing a validated free-form value) in the
 * same 350px width: an always-visible "Language tag" field holding the
 * committed tag, with "Set" shown only while the field differs from it. It
 * commits ONLY on Set or Enter, never on blur or keystroke. A tag that is
 * malformed or that this engine has no data for is REJECTED: the field keeps
 * the text, it's outlined, the hint becomes the card's caption, and nothing is
 * sent. While a tag is committed, the row's value shows the language's own
 * name (or the bare tag when it isn't one of the suggestions).
 *
 * Why validation is strict rather than best-effort: silently accepting a tag the
 * engine can't honor would leave the user believing a language is applied while
 * ICU quietly formats with a fallback — and `navigator.language` would then
 * contradict the actual formatting behavior, which is the exact inconsistency
 * this feature exists to avoid. Rejecting loudly is the safer failure.
 *
 * The pure mapping helpers are exported so they can be unit-tested without a DOM.
 */

import type { LocaleSpoofing } from "@/shared/types/settings";
import type { Message, SetLocaleSpoofingPayload } from "@/shared/types/messages";
import { canonicalizeTag, engineSupportsLocale } from "@/shared/locale/resolver";
import { LOCALE_SUGGESTIONS, endonymForTag, labelForTag } from "./locale-suggestions";
import { isCustomValueDirty, setRowLocked, syncValueRow } from "./settings-rows";
import { setCaptionActive } from "./settings-captions";

/** The dropdown options, matching the `value` attributes in popup.html. */
export type LocaleOption = "off" | "match" | "custom";

// ── Pure mapping helpers ─────────────────────────────────────────────────────

/**
 * Map a selected option (plus the typed tag when the option is "custom") onto a
 * {@link LocaleSpoofing}.
 *
 * Returns `null` for "custom" with an unusable tag so the caller can withhold
 * the save and surface the hint instead of persisting something that wouldn't
 * take effect.
 */
export function optionToLocaleSpoofing(
  option: LocaleOption,
  customTag?: string
): LocaleSpoofing | null {
  switch (option) {
    case "match":
      return { mode: "match" };
    case "custom": {
      if (!customTag) return null;
      const canonical = canonicalizeTag(customTag.trim());
      if (!canonical || !engineSupportsLocale(canonical)) return null;
      return { mode: "custom", locale: canonical };
    }
    case "off":
    default:
      return { mode: "off" };
  }
}

/**
 * Reverse mapping used to restore the control from a stored
 * {@link LocaleSpoofing}. Anything unrecognized falls back to "off", which is
 * both the default and the safe direction.
 */
export function localeSpoofingToControlState(setting: LocaleSpoofing | undefined | null): {
  option: LocaleOption;
  customTag: string | null;
} {
  if (!setting) return { option: "off", customTag: null };
  switch (setting.mode) {
    case "match":
      return { option: "match", customTag: null };
    case "custom":
      return { option: "custom", customTag: setting.locale };
    case "off":
    default:
      return { option: "off", customTag: null };
  }
}

/**
 * Whether a raw typed tag is usable: well-formed BCP47 AND supported by this
 * engine's locale data.
 */
export function isUsableLocaleTag(raw: string): boolean {
  const canonical = canonicalizeTag(raw.trim());
  return canonical !== null && engineSupportsLocale(canonical);
}

/** Display text for a committed tag: the tag, plus a human label when known. */
export function describeTag(tag: string): string {
  const label = labelForTag(tag);
  return label ? `${tag} — ${label}` : tag;
}

// ── DOM wiring ───────────────────────────────────────────────────────────────

/**
 * The custom tag the background holds (restored, or committed this session),
 * or `null` when the mode isn't custom. Drives the dirty state that shows Set
 * and the language name in the row's value slot.
 */
let storedTag: string | null = null;
/** The last custom tag seen this popup session, for pre-filling the field. */
let lastTag: string | null = null;

function getSelect(): HTMLSelectElement | null {
  return document.getElementById("localeSelect") as HTMLSelectElement | null;
}
function getInput(): HTMLInputElement | null {
  return document.getElementById("localeCustomInput") as HTMLInputElement | null;
}
function getConfirm(): HTMLButtonElement | null {
  return document.getElementById("localeCustomConfirm") as HTMLButtonElement | null;
}
function getEditRow(): HTMLElement | null {
  return document.getElementById("localeCustomEdit");
}
function getHint(): HTMLElement | null {
  return document.getElementById("localeCustomHint");
}
function getWarning(): HTMLElement | null {
  return document.getElementById("localeWarning");
}

/**
 * Toggle the invalid indication: the field's outline and `aria-invalid`, and
 * the hint as the Reported Language card's caption.
 */
function setInvalid(invalid: boolean): void {
  const input = getInput();
  if (input) {
    input.classList.toggle("invalid", invalid);
    if (invalid) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", "localeCustomHint");
    } else {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    }
  }
  setCaptionActive(getHint(), invalid);
}

/** Show Set only while the field differs from the committed tag. */
function syncConfirm(): void {
  const input = getInput();
  const confirm = getConfirm();
  if (!input || !confirm) return;
  confirm.hidden = !isCustomValueDirty(input.value, storedTag);
}

/** Show or hide the Language tag row. */
function setEditRowVisible(visible: boolean): void {
  const row = getEditRow();
  if (row) row.style.display = visible ? "block" : "none";
}

/**
 * The row's value: while a custom tag is committed, the language's own name
 * (or the bare tag when it isn't a suggestion); otherwise the selected option.
 */
function syncValueLabel(): void {
  const select = getSelect();
  if (!select) return;
  if (select.value === "custom" && storedTag) {
    select.dataset.valueLabel = endonymForTag(storedTag) ?? storedTag;
  } else {
    delete select.dataset.valueLabel;
  }
  syncValueRow(select);
}

/**
 * Show the consequence warning only while a language is actually being reported.
 * There is nothing to warn about in Off mode, and an always-visible warning
 * would be noise the user learns to ignore. It replaces the card's hint.
 */
function setWarningVisible(visible: boolean): void {
  setCaptionActive(getWarning(), visible);
}

/**
 * Populate the `<datalist>` from the shared suggestion list. Idempotent.
 *
 * Both the English name and the endonym go into the option text so a datalist
 * substring match finds an entry from either — someone typing "French" and
 * someone typing "Français" both land on `fr-FR`.
 */
function populateSuggestions(): void {
  const list = document.getElementById("localeSuggestions");
  if (!list || list.dataset.populated === "true") return;
  for (const suggestion of LOCALE_SUGGESTIONS) {
    const option = document.createElement("option");
    option.value = suggestion.tag;
    option.textContent =
      suggestion.english === suggestion.endonym
        ? suggestion.english
        : `${suggestion.english} — ${suggestion.endonym}`;
    list.appendChild(option);
  }
  list.dataset.populated = "true";
}

/** Persist a LocaleSpoofing via the background. */
async function sendLocaleSpoofing(setting: LocaleSpoofing): Promise<void> {
  const message: Message<SetLocaleSpoofingPayload> = {
    type: "SET_LOCALE_SPOOFING",
    payload: { localeSpoofing: setting },
  };
  try {
    await browser.runtime.sendMessage(message);
  } catch (error: unknown) {
    console.error("Failed to set reported language:", error);
  }
}

/**
 * Read, validate, and (if usable) commit the typed tag.
 *
 * Rejects rather than coerces: an empty, malformed, or engine-unsupported tag
 * keeps the text, shows the hint as the card's caption, and sends nothing.
 */
function commitCustom(): void {
  const input = getInput();
  if (!input) return;
  const raw = input.value.trim();
  const setting = raw === "" ? null : optionToLocaleSpoofing("custom", raw);
  if (!setting || setting.mode !== "custom") {
    setInvalid(true);
    return;
  }
  void sendLocaleSpoofing(setting);
  storedTag = setting.locale;
  lastTag = setting.locale;
  input.value = setting.locale;
  setInvalid(false);
  const confirmHadFocus = document.activeElement === getConfirm();
  syncConfirm();
  if (confirmHadFocus) input.focus();
  syncValueLabel();
  setWarningVisible(true);
}

/** Handle a change of the dropdown selection. */
function handleSelectChange(): void {
  const select = getSelect();
  if (!select) return;
  const option = select.value as LocaleOption;
  if (option === "custom") {
    // Switching TO custom: pre-fill with the last tag seen this session (if
    // any) and send nothing — the value commits only via Set or Enter. The
    // warning stays hidden until a tag is committed, since nothing is being
    // reported yet.
    storedTag = null;
    setInvalid(false);
    setEditRowVisible(true);
    const input = getInput();
    if (input) {
      input.value = lastTag ?? "";
      syncConfirm();
      input.focus();
      input.select?.();
    }
    syncValueLabel();
    setWarningVisible(false);
    return;
  }
  storedTag = null;
  setEditRowVisible(false);
  setInvalid(false);
  syncValueLabel();
  const setting = optionToLocaleSpoofing(option);
  if (setting) void sendLocaleSpoofing(setting);
  setWarningVisible(option === "match");
}

/**
 * Wire the control's listeners. Idempotent: guarded by a data flag so repeated
 * calls (the markup is static) don't stack listeners.
 */
export function initLocaleControl(): void {
  populateSuggestions();
  const select = getSelect();
  if (!select || select.dataset.wired === "1") return;
  select.dataset.wired = "1";
  select.addEventListener("change", handleSelectChange);
  const input = getInput();
  if (input) {
    // Clear the invalid indication while typing and track the dirty state;
    // never commit here.
    input.addEventListener("input", () => {
      setInvalid(false);
      syncConfirm();
    });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitCustom();
      }
    });
  }
  getConfirm()?.addEventListener("click", () => commitCustom());
}

/**
 * Lock or unlock the control for the Pro gate: the row stays a Tab stop
 * (`aria-disabled`) on Off. The background independently forces `off` for a
 * non-entitled user, so this is UI clarity only.
 */
function applyLocaleLock(locked: boolean): void {
  const select = getSelect();
  if (select) setRowLocked(select, locked, "off");
}

/**
 * Restore the control from stored settings. Called from `loadSettings` on every
 * settings (re)load; only sets values and visibility, never persists.
 *
 * `proLocked` (a non-entitled Safari user) locks the control on "Off",
 * matching what the background enforces.
 */
export function restoreLocaleControl(
  setting: LocaleSpoofing | undefined | null,
  proLocked = false
): void {
  const select = getSelect();
  if (!select) return;
  populateSuggestions();
  setInvalid(false);
  if (proLocked) {
    select.value = "off";
    storedTag = null;
    setEditRowVisible(false);
    applyLocaleLock(true);
    syncValueLabel();
    setWarningVisible(false);
    return;
  }
  applyLocaleLock(false);
  const { option, customTag } = localeSpoofingToControlState(setting);
  select.value = option;
  if (option === "custom" && customTag) {
    // Already committed: show the tag in the field, with Set hidden.
    storedTag = customTag;
    lastTag = customTag;
    const input = getInput();
    if (input) input.value = customTag;
    setEditRowVisible(true);
    syncConfirm();
  } else {
    storedTag = null;
    setEditRowVisible(false);
  }
  syncValueLabel();
  setWarningVisible(option !== "off");
}
