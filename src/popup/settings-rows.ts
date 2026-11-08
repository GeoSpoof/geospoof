/**
 * Settings screen rows: value rows over a native `<select>`, custom-value
 * dirty state, and the Pro lock.
 *
 * A value row is a `<label class="value-row">` holding the row's label, a
 * mirrored value with its chevron (`aria-hidden`), and the real `<select>`
 * laid over the whole row with `opacity: 0`, so a click anywhere on the row
 * opens the native menu (HIG Pop-up buttons). The mirrored text has to follow
 * the select, which is what {@link syncValueRow} does.
 *
 * A locked row (Safari on iOS without Pro) uses `aria-disabled`, not
 * `disabled`, so it stays a Tab stop and its value can still be read, and it
 * points `aria-describedby` at the section's one Pro note. Changes to it are
 * suppressed by capture-phase listeners on the Settings content, so the
 * control's own handler never runs and nothing is sent.
 */

/** The id of the one Pro note under the WHAT SITES SEE heading. */
export const SETTINGS_PRO_NOTE_ID = "settingsProNote";

/** Write a select's shown value into its row's mirrored value slot. */
export function syncValueRow(select: HTMLSelectElement): void {
  const row = select.closest(".value-row");
  const slot = row?.querySelector<HTMLElement>(".value-row-text");
  if (!slot) return;
  const label = select.dataset.valueLabel || select.selectedOptions[0]?.textContent?.trim() || "";
  slot.textContent = label;
}

/** Sync every value row under `root`. */
export function syncAllValueRows(root: ParentNode = document): void {
  root
    .querySelectorAll<HTMLSelectElement>(".value-row > select")
    .forEach((select) => syncValueRow(select));
}

/**
 * Whether a custom value's input differs from what's committed, which is when
 * its Set button shows. Surrounding whitespace doesn't count.
 */
export function isCustomValueDirty(inputValue: string, committed: string | null): boolean {
  return inputValue.trim() !== (committed ?? "");
}

function isLocked(el: Element | null): el is HTMLInputElement | HTMLSelectElement {
  return !!el && el.getAttribute("aria-disabled") === "true";
}

/**
 * Lock or unlock a control for the Pro gate. Locked: `aria-disabled`, the Pro
 * note as its description, the enforced value remembered (so a change can be
 * reverted), and `is-locked` on its row. Never sets `.disabled`.
 */
export function setRowLocked(
  control: HTMLSelectElement | HTMLInputElement,
  locked: boolean,
  enforcedValue?: string
): void {
  const row = control.closest(".value-row, .toggle-section");
  if (locked) {
    control.setAttribute("aria-disabled", "true");
    control.setAttribute("aria-describedby", SETTINGS_PRO_NOTE_ID);
    const isCheckbox = control instanceof HTMLInputElement && control.type === "checkbox";
    control.dataset.lockedValue =
      enforcedValue ?? (isCheckbox ? String(control.checked) : control.value);
    row?.classList.add("is-locked");
  } else {
    control.removeAttribute("aria-disabled");
    if (control.getAttribute("aria-describedby") === SETTINGS_PRO_NOTE_ID) {
      control.removeAttribute("aria-describedby");
    }
    delete control.dataset.lockedValue;
    row?.classList.remove("is-locked");
  }
}

/** Show or hide the one Pro note. */
export function applySettingsProNote(locked: boolean): void {
  const note = document.getElementById(SETTINGS_PRO_NOTE_ID);
  if (note) note.hidden = !locked;
}

/** Show a group (heading, card and captions) that starts hidden. */
export function revealSettingsGroup(id: string): void {
  const group = document.getElementById(id);
  if (group) group.hidden = false;
}

/** The locked control an event is aimed at, if any. An ⓘ is never suppressed. */
function lockedTarget(e: Event): HTMLInputElement | HTMLSelectElement | null {
  const target = e.target as Element | null;
  if (!target || typeof target.closest !== "function") return null;
  if (target.closest(".info-icon")) return null;
  if (isLocked(target)) return target;
  const row = target.closest(".is-locked");
  if (!row) return null;
  const control = row.querySelector("select, input");
  return isLocked(control) ? control : null;
}

function restoreLocked(control: HTMLInputElement | HTMLSelectElement): void {
  const value = control.dataset.lockedValue;
  if (value === undefined) return;
  if (control instanceof HTMLInputElement && control.type === "checkbox") {
    control.checked = value === "true";
  } else {
    control.value = value;
  }
  if (control instanceof HTMLSelectElement) syncValueRow(control);
}

/**
 * Wire the row behaviors on the Settings content. Idempotent.
 *
 * Capture phase, so a locked control's own listeners never see the event:
 * pointer presses and clicks are cancelled (a select's menu stays shut, a
 * switch stays put), every key but Tab is cancelled, and a `change` that gets
 * through anyway is reverted and stopped. A bubble-phase `change` keeps each
 * value row's mirrored text current, which covers the selects whose handlers
 * don't know about value rows (Theme, Language, Verbosity).
 */
export function initSettingsRows(): void {
  const root = document.getElementById("advancedContent");
  if (!root || root.dataset.rowsWired === "1") return;
  root.dataset.rowsWired = "1";

  const cancel = (e: Event): void => {
    if (lockedTarget(e)) e.preventDefault();
  };
  root.addEventListener("mousedown", cancel, true);
  root.addEventListener("click", cancel, true);
  root.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key === "Tab") return;
      if (lockedTarget(e)) e.preventDefault();
    },
    true
  );
  root.addEventListener(
    "change",
    (e: Event) => {
      const control = lockedTarget(e);
      if (!control) return;
      restoreLocked(control);
      e.stopPropagation();
    },
    true
  );
  root.addEventListener("change", (e: Event) => {
    const target = e.target as Element | null;
    if (target instanceof HTMLSelectElement && target.parentElement?.matches(".value-row")) {
      syncValueRow(target);
    }
  });
}
