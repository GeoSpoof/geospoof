/**
 * Popup Accuracy Control (Settings screen, WHAT SITES SEE)
 *
 * Renders and wires the accuracy dropdown (+ conditional Custom numeric input)
 * that lets the user choose how the spoofed `GeolocationCoordinates.accuracy`
 * value is produced. The control maps a small set of presets onto the
 * `AccuracySetting` model and persists the choice by sending `SET_ACCURACY` to
 * the background (Requirements 9.2, 9.3):
 *
 *   - "Realistic" → { mode: "auto" }
 *   - "Custom"    → { mode: "fixed", meters } (revealed numeric input)
 *
 * The older "Tight" / "Loose" range presets were retired — "Realistic" already
 * picks a device-appropriate band automatically, so the manual range options
 * mostly added noise. The `range` mode still exists in the model/Resolver for
 * backward compatibility (a value saved before removal keeps resolving), but the
 * picker no longer offers it and collapses any stored range to "Realistic".
 *
 * Selecting "Realistic" applies immediately and hides the Meters row.
 * Selecting "Custom" shows the Meters row, an always-visible input holding the
 * committed value. Its "Set" button shows only while the input differs from
 * the committed value (dirty), and the value commits ONLY on Set or Enter —
 * never on blur and never on every keystroke. On commit a finite, in-range
 * value is rounded to an integer and sent via `SET_ACCURACY` as
 * `{ mode: "fixed", meters }`. An empty, non-finite, or out-of-range entry is
 * rejected: the field is outlined, the hint becomes the Location card's
 * caption (it outranks the card's other captions), and nothing is sent —
 * out-of-range values are NOT clamped/saved.
 *
 * Selecting "Custom" from the dropdown (coming from another option) pre-fills
 * the input with the currently-resolved accuracy (the ±Nm in effect) and sends
 * nothing. Restoring a stored `fixed` setting shows the committed value with
 * Set hidden.
 *
 * No controls for distribution, per-call jitter, or fractional precision are
 * exposed (Requirement 9.4); the Custom input must be a finite value within
 * `[1, 10000]` to commit — out-of-range entries are rejected rather than
 * clamped (Requirement 9.3).
 *
 * The pure mapping/clamping helpers are exported so they can be unit-tested
 * without a DOM.
 */

import type { AccuracySetting } from "@/shared/types/settings";
import type { Message, SetAccuracyPayload } from "@/shared/types/messages";
import { isCustomValueDirty, setRowLocked, syncValueRow } from "./settings-rows";
import { setCaptionActive } from "./settings-captions";

/** Inclusive bounds for a valid custom accuracy value, in metres. */
export const MIN_ACCURACY_M = 1;
export const MAX_ACCURACY_M = 10000;

/** The dropdown options, matching the `value` attributes in popup.html. */
export type AccuracyOption = "realistic" | "custom";

/**
 * Round and clamp an arbitrary number into the valid custom accuracy range
 * `[1, 10000]`. Non-finite input falls back to the lower bound so the result
 * is always a valid integer.
 */
export function clampAccuracyMeters(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_ACCURACY_M;
  }
  const rounded = Math.round(value);
  return Math.min(MAX_ACCURACY_M, Math.max(MIN_ACCURACY_M, rounded));
}

/**
 * Whether a raw numeric value is a finite number already inside the inclusive
 * `[1, 10000]` range. Used to decide whether to flag the input as out-of-range
 * before clamping (Requirement 9.3).
 */
export function isAccuracyMetersInRange(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_ACCURACY_M && value <= MAX_ACCURACY_M;
}

/**
 * Map a selected dropdown option (plus the custom meters value when the option
 * is "custom") onto an {@link AccuracySetting}.
 *
 * For "custom" the provided meters value is clamped into `[1, 10000]`; a
 * non-finite/undefined value yields `null` so the caller can withhold a save
 * until the user enters something usable.
 */
export function optionToAccuracySetting(
  option: AccuracyOption,
  customMeters?: number
): AccuracySetting | null {
  switch (option) {
    case "custom":
      if (customMeters === undefined || !Number.isFinite(customMeters)) {
        return null;
      }
      return { mode: "fixed", meters: clampAccuracyMeters(customMeters) };
    case "realistic":
    default:
      return { mode: "auto" };
  }
}

/**
 * Reverse mapping used to restore the control from a stored
 * {@link AccuracySetting}:
 *   - { mode: "fixed", meters }   → "custom" (meters populated)
 *   - { mode: "auto" }            → "realistic"
 *   - { mode: "range", … }        → "realistic"
 *
 * The Tight/Loose range presets were retired, so the control now models only
 * "realistic" and "custom". Any stored `range` — including a legacy Tight
 * (5–15) or Loose (35–100) value saved before the presets were removed — has no
 * dedicated control, so it collapses to "realistic" (the safest,
 * least-surprising default) and is normalized to `auto` the next time the user
 * changes the setting. The value still resolves correctly in the meantime (the
 * Resolver and validators retain `range` support); only the picker no longer
 * offers it. `customMeters` is only non-null for the fixed/"custom" case.
 */
export function accuracySettingToControlState(setting: AccuracySetting): {
  option: AccuracyOption;
  customMeters: number | null;
} {
  switch (setting.mode) {
    case "fixed":
      return { option: "custom", customMeters: clampAccuracyMeters(setting.meters) };
    case "range":
    case "auto":
    default:
      return { option: "realistic", customMeters: null };
  }
}

// ── DOM wiring ───────────────────────────────────────────────────────────────

/**
 * The most recently resolved accuracy value (the ±Nm currently in effect),
 * supplied by `restoreAccuracyControl`. Used to pre-fill the Custom input when
 * the user selects "Custom" so the field opens showing the value in effect.
 */
let lastResolvedAccuracy: number | null = null;

/**
 * The committed custom value (metres): the stored `fixed` setting, or the last
 * value committed this session. `null` while no custom value is committed
 * (Realistic). Drives the dirty state that shows Set.
 */
let storedMeters: number | null = null;

function getSelect(): HTMLSelectElement | null {
  return document.getElementById("accuracySelect") as HTMLSelectElement | null;
}

function getCustomInput(): HTMLInputElement | null {
  return document.getElementById("accuracyCustomInput") as HTMLInputElement | null;
}

function getCustomHint(): HTMLElement | null {
  return document.getElementById("accuracyCustomHint");
}

function getCustomConfirm(): HTMLButtonElement | null {
  return document.getElementById("accuracyCustomConfirm") as HTMLButtonElement | null;
}

function getCustomEditRow(): HTMLElement | null {
  return document.getElementById("accuracyCustomEdit");
}

/** Show Set only while the input differs from the committed value. */
function syncConfirm(): void {
  const input = getCustomInput();
  const confirm = getCustomConfirm();
  if (!input || !confirm) return;
  confirm.hidden = !isCustomValueDirty(input.value, storedMeters?.toString() ?? null);
}

/** Show or hide the Meters row. */
function setCustomRowVisible(visible: boolean): void {
  const row = getCustomEditRow();
  if (row) row.style.display = visible ? "block" : "none";
}

/**
 * Toggle the invalid indication: the field's outline and `aria-invalid`, and
 * the hint as the Location card's caption (describing the field while invalid).
 */
function setCustomInvalid(invalid: boolean): void {
  const input = getCustomInput();
  if (input) {
    input.classList.toggle("invalid", invalid);
    if (invalid) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", "accuracyCustomHint");
    } else {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    }
  }
  setCaptionActive(getCustomHint(), invalid);
}

/** Persist an AccuracySetting via the background. */
async function sendAccuracy(accuracySetting: AccuracySetting): Promise<void> {
  const message: Message<SetAccuracyPayload> = {
    type: "SET_ACCURACY",
    payload: { accuracySetting },
  };
  try {
    await browser.runtime.sendMessage(message);
  } catch (error: unknown) {
    console.error("Failed to set accuracy:", error);
  }
}

/**
 * Read, validate, and (if usable) commit the Custom numeric input.
 *
 *   - Empty/blank, non-finite, or out of range → invalid indication, send
 *     nothing. The value is NOT clamped/saved (the user must enter a value in
 *     `[1, 10000]`).
 *   - In range → round to an integer, send `SET_ACCURACY` with
 *     `{ mode: "fixed", meters }`, show the rounded value, and hide Set
 *     (Requirement 9.3). Focus moves to the field when Set had it, since Set
 *     disappears.
 */
function commitCustom(): void {
  const input = getCustomInput();
  if (!input) return;

  const raw = input.value.trim();
  const parsed = Number(raw);
  if (raw === "" || !Number.isFinite(parsed) || !isAccuracyMetersInRange(parsed)) {
    setCustomInvalid(true);
    return;
  }

  const meters = clampAccuracyMeters(parsed);
  void sendAccuracy({ mode: "fixed", meters });
  storedMeters = meters;
  input.value = String(meters);
  setCustomInvalid(false);
  const confirmHadFocus = document.activeElement === getCustomConfirm();
  syncConfirm();
  if (confirmHadFocus) input.focus();
}

/** Handle a change of the dropdown selection. */
function handleSelectChange(): void {
  const select = getSelect();
  if (!select) return;
  syncValueRow(select);

  const option = select.value as AccuracyOption;

  if (option === "custom") {
    // Switching TO custom: pre-fill with the resolved accuracy (the ±Nm in
    // effect), focus and select it, and send nothing — the value commits only
    // via Set or Enter.
    setCustomInvalid(false);
    setCustomRowVisible(true);
    const input = getCustomInput();
    if (input) {
      if (lastResolvedAccuracy != null) input.value = String(lastResolvedAccuracy);
      syncConfirm();
      input.focus();
      input.select?.();
    }
    return;
  }

  // Presets apply immediately and hide the Meters row.
  storedMeters = null;
  setCustomRowVisible(false);
  setCustomInvalid(false);
  const setting = optionToAccuracySetting(option);
  if (setting) void sendAccuracy(setting);
}

/**
 * Wire the accuracy control's listeners. Idempotent: guarded by a data flag so
 * repeated calls (the control's markup is static) don't stack listeners.
 */
export function initAccuracyControl(): void {
  const select = getSelect();
  if (!select || select.dataset.wired === "1") return;
  select.dataset.wired = "1";

  select.addEventListener("change", handleSelectChange);

  const input = getCustomInput();
  if (input) {
    // Clear the invalid indication while typing and track the dirty state; do
    // NOT commit here.
    input.addEventListener("input", () => {
      setCustomInvalid(false);
      syncConfirm();
    });
    // Commit on Enter (in addition to the Set button below).
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitCustom();
      }
    });
  }

  getCustomConfirm()?.addEventListener("click", () => commitCustom());
}

/**
 * Restore the control's state from a stored {@link AccuracySetting}. Called
 * from `loadSettings` each time settings are (re)loaded; only sets values and
 * visibility, never persists.
 *
 * `resolvedAccuracy` is the ±Nm value currently in effect (as computed by the
 * shared Resolver); it is stored so selecting "Custom" can pre-fill the input
 * with the value the user currently sees.
 */
export function restoreAccuracyControl(
  setting: AccuracySetting | undefined | null,
  resolvedAccuracy?: number,
  proLocked = false
): void {
  const select = getSelect();
  if (!select) return;

  if (typeof resolvedAccuracy === "number" && Number.isFinite(resolvedAccuracy)) {
    lastResolvedAccuracy = clampAccuracyMeters(resolvedAccuracy);
  }

  setCustomInvalid(false);

  // Locked free iOS users always reflect "Realistic" (what the background
  // enforces); the locked row + Pro note explain custom accuracy is Pro.
  if (proLocked) {
    select.value = "realistic";
    storedMeters = null;
    setCustomRowVisible(false);
    applyAccuracyLock(true);
    syncValueRow(select);
    return;
  }
  applyAccuracyLock(false);

  const { option, customMeters } = accuracySettingToControlState(setting ?? { mode: "auto" });
  select.value = option;
  syncValueRow(select);

  if (option === "custom" && customMeters !== null) {
    // Stored fixed setting — already committed: show it, with Set hidden.
    storedMeters = customMeters;
    const input = getCustomInput();
    if (input) input.value = String(customMeters);
    setCustomRowVisible(true);
    syncConfirm();
  } else {
    storedMeters = null;
    setCustomRowVisible(false);
  }
}

/**
 * Lock or unlock the accuracy control for the Pro gate: the row stays a Tab
 * stop (`aria-disabled`) on Realistic, and the Settings screen's one Pro note
 * explains why.
 */
function applyAccuracyLock(locked: boolean): void {
  const select = getSelect();
  if (select) setRowLocked(select, locked, "realistic");
}
