/**
 * Popup Location Precision control (Advanced accordion, Details tab).
 *
 * A single dropdown that maps onto the {@link LocationPrecision} model:
 *
 *   - "Exact"        → { mode: "exact" }                    (default; pre-feature behavior)
 *   - "Street"       → { mode: "approximate", radiusMeters: 500 }
 *   - "Neighborhood" → { mode: "approximate", radiusMeters: 2000 }
 *   - "City"         → { mode: "approximate", radiusMeters: 10000 }
 *
 * This is distinct from the Accuracy control: precision moves the reported
 * point within a radius; accuracy sets the reported uncertainty number. The two
 * are independent. Selecting an option persists it via `SET_PRECISION`; the
 * background applies the offset to every page-bound payload.
 *
 * Under it sits the "Pick a new point" cadence control (Never / Each browser
 * session / Every hour / Every day), persisted via `SET_PRECISION_CADENCE`. It's
 * shown only for an approximate option, and hidden and disabled behind the Pro
 * lock; hiding it never changes the stored cadence. The row updates
 * synchronously on a change of the precision select.
 *
 * The pure mapping helpers are exported so they can be unit-tested without a DOM.
 */

import type { LocationPrecision, PrecisionCadence } from "@/shared/types/settings";
import type {
  Message,
  SetPrecisionCadencePayload,
  SetPrecisionPayload,
} from "@/shared/types/messages";
import { validatePrecisionCadence } from "@/shared/precision/cadence";

/** The dropdown options, matching the `value` attributes in popup.html. */
export type PrecisionOption = "exact" | "street" | "neighborhood" | "city";

/** Preset radius (meters) for each approximate option. */
const PRESET_RADIUS_M: Record<Exclude<PrecisionOption, "exact">, number> = {
  street: 500,
  neighborhood: 2000,
  city: 10000,
};

/** Map a selected dropdown option onto a {@link LocationPrecision}. */
export function optionToLocationPrecision(option: PrecisionOption): LocationPrecision {
  if (option === "exact") {
    return { mode: "exact" };
  }
  return { mode: "approximate", radiusMeters: PRESET_RADIUS_M[option] };
}

/**
 * Reverse mapping used to restore the control from a stored
 * {@link LocationPrecision}: `exact` (or anything unrecognized) → "exact"; an
 * approximate setting maps to the option whose preset radius is nearest the
 * stored `radiusMeters`, so a hand-edited or migrated value still selects a
 * sensible option.
 */
export function locationPrecisionToOption(
  setting: LocationPrecision | undefined | null
): PrecisionOption {
  if (!setting || setting.mode !== "approximate") {
    return "exact";
  }

  const radius = setting.radiusMeters;
  let nearest: Exclude<PrecisionOption, "exact"> = "street";
  let nearestDelta = Infinity;
  for (const key of ["street", "neighborhood", "city"] as const) {
    const delta = Math.abs(PRESET_RADIUS_M[key] - radius);
    if (delta < nearestDelta) {
      nearestDelta = delta;
      nearest = key;
    }
  }
  return nearest;
}

// ── DOM wiring ───────────────────────────────────────────────────────────────

function getSelect(): HTMLSelectElement | null {
  return document.getElementById("precisionSelect") as HTMLSelectElement | null;
}

/**
 * Enable/disable the precision control for the Pro gate. The disabled dropdown
 * can't be changed and the Pro note explains why; toggling it off restores
 * normal interaction. Approximate location is Pro-only on iOS Safari; the
 * background independently forces `exact` for a non-Pro user, so this is UI
 * clarity only.
 */
function applyPrecisionLock(locked: boolean): void {
  const select = getSelect();
  if (select) select.disabled = locked;
  const note = document.getElementById("precisionProNote");
  if (note) note.style.display = locked ? "block" : "none";
}

/** Persist a LocationPrecision via the background. */
async function sendPrecision(precision: LocationPrecision): Promise<void> {
  const message: Message<SetPrecisionPayload> = {
    type: "SET_PRECISION",
    payload: { precision },
  };
  try {
    await browser.runtime.sendMessage(message);
  } catch (error: unknown) {
    console.error("Failed to set location precision:", error);
  }
}

function handleSelectChange(): void {
  const select = getSelect();
  if (!select) return;
  // Show or hide the cadence row before the round-trip, so it tracks the
  // precision select synchronously.
  syncPrecisionCadenceUi();
  void sendPrecision(optionToLocationPrecision(select.value as PrecisionOption));
}

/**
 * Wire the precision control's change listener. Idempotent: guarded by a data
 * flag so repeated calls (the markup is static) don't stack listeners.
 */
export function initPrecisionControl(): void {
  const select = getSelect();
  if (!select || select.dataset.wired === "1") return;
  select.dataset.wired = "1";
  select.addEventListener("change", handleSelectChange);
}

/**
 * Restore the control's selection from a stored {@link LocationPrecision}.
 * Called from `loadSettings` each time settings are (re)loaded; only sets the
 * value/lock state, never persists.
 *
 * `proLocked` (iOS Safari non-Pro) disables the control and forces "Exact" —
 * matching what the background enforces — while the Pro note explains that
 * approximate location is a Pro feature.
 */
export function restorePrecisionControl(
  setting: LocationPrecision | undefined | null,
  proLocked = false
): void {
  const select = getSelect();
  if (!select) return;

  applyPrecisionLock(proLocked);

  if (proLocked) {
    select.value = "exact";
    return;
  }

  select.value = locationPrecisionToOption(setting);
}

// ── Cadence ("Pick a new point") ─────────────────────────────────────────────

/** Pro lock for the cadence row, set on restore. */
let cadenceProLocked = false;

/**
 * Pure visibility rule for the cadence row: it shows only for an approximate
 * option outside the Pro lock.
 */
export function cadenceUiState(
  option: PrecisionOption,
  proLocked: boolean
): { rowVisible: boolean } {
  return { rowVisible: !proLocked && option !== "exact" };
}

function getCadenceSelect(): HTMLSelectElement | null {
  return document.getElementById("precisionCadenceSelect") as HTMLSelectElement | null;
}

/**
 * Apply {@link cadenceUiState} to the DOM from the current value of the
 * precision select and the Pro lock.
 */
export function syncPrecisionCadenceUi(): void {
  const precision = getSelect();
  const select = getCadenceSelect();
  const row = document.getElementById("precisionCadenceRow");
  if (!precision || !select || !row) return;

  const { rowVisible } = cadenceUiState(precision.value as PrecisionOption, cadenceProLocked);
  row.style.display = rowVisible ? "block" : "none";
  select.disabled = cadenceProLocked;
}

/** Persist a cadence via the background. */
async function sendPrecisionCadence(cadence: PrecisionCadence): Promise<void> {
  const message: Message<SetPrecisionCadencePayload> = {
    type: "SET_PRECISION_CADENCE",
    payload: { cadence },
  };
  try {
    await browser.runtime.sendMessage(message);
  } catch (error: unknown) {
    console.error("Failed to set location precision cadence:", error);
  }
}

function handleCadenceChange(): void {
  const select = getCadenceSelect();
  if (!select) return;
  syncPrecisionCadenceUi();
  void sendPrecisionCadence(validatePrecisionCadence(select.value));
}

/**
 * Wire the cadence control's change listener. Idempotent, like
 * {@link initPrecisionControl}.
 */
export function initPrecisionCadenceControl(): void {
  const select = getCadenceSelect();
  if (!select || select.dataset.wired === "1") return;
  select.dataset.wired = "1";
  select.addEventListener("change", handleCadenceChange);
}

/**
 * Restore the cadence control from the stored value. Call after
 * {@link restorePrecisionControl}, since the row's visibility depends on the
 * precision select. Only sets value/visibility/lock state, never persists.
 */
export function restorePrecisionCadenceControl(cadence: unknown, proLocked = false): void {
  const select = getCadenceSelect();
  if (!select) return;
  cadenceProLocked = proLocked;
  select.value = validatePrecisionCadence(cadence);
  syncPrecisionCadenceUi();
}
