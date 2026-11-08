/**
 * Popup "Randomize location" (Settings screen, WHAT SITES SEE).
 *
 * The Location card has one value row, "Randomize location ›", whose value
 * sums up both settings ("Off", "2 km", "2 km · Hourly"). It opens a screen of
 * its own, inside the Settings view, with the house nav bar ("‹ Settings"):
 *
 *   - DISTANCE: a checkmark list (native radios) that maps onto the
 *     {@link LocationPrecision} model:
 *       - "Off (exact)"   → { mode: "exact" }                    (default)
 *       - "Within 0.5 km" → { mode: "approximate", radiusMeters: 500 }
 *       - "Within 2 km"   → { mode: "approximate", radiusMeters: 2000 }
 *       - "Within 10 km"  → { mode: "approximate", radiusMeters: 10000 }
 *     A choice persists via `SET_PRECISION`; the background applies the offset
 *     to every page-bound payload.
 *   - NEW POINT: the "Pick a new point" picker (Never / Each browser session /
 *     Every hour / Every day), persisted via `SET_PRECISION_CADENCE`. It shows
 *     only when Distance isn't Off; hiding it never changes the stored cadence.
 *   - one caption.
 *
 * This is distinct from Location Accuracy: precision moves the reported point
 * within a radius; accuracy sets the reported uncertainty number.
 *
 * Behind the Pro lock (Safari on iOS without Pro) the row is locked: it stays
 * a Tab stop (`aria-disabled`), shows Off with a 🔒, is described by the
 * Settings screen's one Pro note, and doesn't open. The background
 * independently forces `exact` for a non-Pro user, so this is UI clarity only.
 *
 * The screen's back row and Escape return to the Settings root with focus on
 * the row. Leaving Settings resets to the root ({@link resetRandomizeScreen}).
 *
 * The pure helpers are exported so they can be unit-tested without a DOM.
 */

import type { LocationPrecision, PrecisionCadence } from "@/shared/types/settings";
import type {
  Message,
  SetPrecisionCadencePayload,
  SetPrecisionPayload,
} from "@/shared/types/messages";
import { validatePrecisionCadence } from "@/shared/precision/cadence";
import { t } from "./i18n";
import { spokenValue } from "./announce";
import { fitNavBar, wireButtonRow } from "./filters-nav";
import { SETTINGS_PRO_NOTE_ID, syncValueRow } from "./settings-rows";

/** The Distance options, matching the radios' `value` attributes in popup.html. */
export type PrecisionOption = "exact" | "street" | "neighborhood" | "city";

/** Preset radius (meters) for each approximate option. */
const PRESET_RADIUS_M: Record<Exclude<PrecisionOption, "exact">, number> = {
  street: 500,
  neighborhood: 2000,
  city: 10000,
};

/** Map a Distance option onto a {@link LocationPrecision}. */
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

/** The short value-row words, with English fallbacks. */
const SUMMARY_WORDS: Record<string, { key: string; fallback: string }> = {
  exact: { key: "randomize_value_off", fallback: "Off" },
  street: { key: "randomize_value_street", fallback: "0.5 km" },
  neighborhood: { key: "randomize_value_neighborhood", fallback: "2 km" },
  city: { key: "randomize_value_city", fallback: "10 km" },
  session: { key: "randomize_value_session", fallback: "Each session" },
  hour: { key: "randomize_value_hour", fallback: "Hourly" },
  day: { key: "randomize_value_day", fallback: "Daily" },
};

function word(id: string): string {
  const { key, fallback } = SUMMARY_WORDS[id];
  return t(key) || fallback;
}

/**
 * The root row's value: "Off" for Exact (or under the Pro lock), else the
 * distance, then " · " and the cadence unless it's Never ("2 km · Hourly",
 * "2 km").
 */
export function randomizeSummary(
  option: PrecisionOption,
  cadence: PrecisionCadence,
  proLocked = false
): string {
  if (proLocked || option === "exact") return word("exact");
  const distance = word(option);
  return cadence === "never" ? distance : `${distance} · ${word(cadence)}`;
}

/**
 * Pure visibility rule for the NEW POINT section: it shows only for an
 * approximate option outside the Pro lock.
 */
export function cadenceUiState(
  option: PrecisionOption,
  proLocked: boolean
): { rowVisible: boolean } {
  return { rowVisible: !proLocked && option !== "exact" };
}

// ── DOM ──────────────────────────────────────────────────────────────────────

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

function distanceRadios(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="radio"][name="randomizeDistance"]')
  );
}

/** The checked Distance option ("exact" when none is checked). */
function selectedOption(): PrecisionOption {
  const checked = distanceRadios().find((radio) => radio.checked);
  return (checked?.value as PrecisionOption | undefined) ?? "exact";
}

function selectOption(option: PrecisionOption): void {
  for (const radio of distanceRadios()) radio.checked = radio.value === option;
}

function getCadenceSelect(): HTMLSelectElement | null {
  return el<HTMLSelectElement>("precisionCadenceSelect");
}

/** Pro lock, set on restore. */
let proLock = false;

/** Write the summary into the root row, and its spoken form into the row's description. */
function renderRow(): void {
  const cadence = validatePrecisionCadence(getCadenceSelect()?.value);
  const text = randomizeSummary(selectedOption(), cadence, proLock);
  const value = el("randomizeValue");
  if (value) value.textContent = text;
  const desc = el("randomizeRowDesc");
  if (desc) desc.textContent = spokenValue(text);

  const row = el("randomizeRow");
  if (!row) return;
  if (proLock) {
    row.setAttribute("aria-disabled", "true");
    row.setAttribute("aria-describedby", `randomizeRowDesc ${SETTINGS_PRO_NOTE_ID}`);
    row.classList.add("is-locked");
  } else {
    row.removeAttribute("aria-disabled");
    row.setAttribute("aria-describedby", "randomizeRowDesc");
    row.classList.remove("is-locked");
  }
}

/**
 * Apply {@link cadenceUiState} to the DOM from the checked Distance option and
 * the Pro lock, and refresh the root row.
 */
export function syncPrecisionCadenceUi(): void {
  const select = getCadenceSelect();
  const group = el("randomizeNewPointGroup");
  if (select && group) {
    group.hidden = !cadenceUiState(selectedOption(), proLock).rowVisible;
    select.disabled = proLock;
  }
  renderRow();
}

// ── The Randomize location screen ────────────────────────────────────────────

function isScreenOpen(): boolean {
  const screen = el("randomizeScreen");
  return !!screen && !screen.hidden;
}

function showScreen(open: boolean): void {
  const screen = el("randomizeScreen");
  const navBar = el("settingsNavBar");
  const content = el("advancedContent");
  if (!screen || !navBar || !content) return;
  screen.hidden = !open;
  navBar.hidden = open;
  content.hidden = open;
}

/** Open the screen, scrolled to the top, with focus on its title. */
export function openRandomizeScreen(): void {
  if (proLock) return;
  showScreen(true);
  const container = document.querySelector<HTMLElement>(".popup-container");
  if (container) container.scrollTop = 0;
  const bar = el("randomizeScreen")?.querySelector<HTMLElement>(".nav-bar");
  if (bar) fitNavBar(bar);
  el("randomizeTitle")?.focus();
}

/** Back to the Settings root, with focus on the row that opened the screen. */
export function closeRandomizeScreen(): void {
  if (!isScreenOpen()) return;
  showScreen(false);
  el("randomizeRow")?.focus();
}

/** Show the Settings root without moving focus (leaving Settings). */
export function resetRandomizeScreen(): void {
  if (isScreenOpen()) showScreen(false);
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

function handleDistanceChange(): void {
  // Show or hide NEW POINT before the round-trip, so it tracks the choice
  // synchronously.
  syncPrecisionCadenceUi();
  void sendPrecision(optionToLocationPrecision(selectedOption()));
}

/**
 * Wire the root row, the screen's back row and Escape, and the Distance
 * radios. Idempotent: guarded by a data flag so repeated calls (the markup is
 * static) don't stack listeners.
 */
export function initPrecisionControl(): void {
  const row = el("randomizeRow");
  if (!row || row.dataset.wired === "1") return;
  row.dataset.wired = "1";

  // Inert while aria-disabled (the Pro lock).
  wireButtonRow(row, openRandomizeScreen);

  el("randomizeBack")?.addEventListener("click", closeRandomizeScreen);
  el("randomizeScreen")?.addEventListener("keydown", (e: KeyboardEvent) => {
    // A select's own Escape (closing its menu) never reaches the page.
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    closeRandomizeScreen();
  });

  for (const radio of distanceRadios()) {
    radio.addEventListener("change", handleDistanceChange);
  }
}

/**
 * Restore the Distance choice from a stored {@link LocationPrecision}. Called
 * from `loadSettings` each time settings are (re)loaded; only sets the
 * value/lock state, never persists.
 *
 * `proLocked` (iOS Safari non-Pro) checks Off, matching what the background
 * enforces, locks the root row, and closes the screen if it's open.
 */
export function restorePrecisionControl(
  setting: LocationPrecision | undefined | null,
  proLocked = false
): void {
  proLock = proLocked;
  selectOption(proLocked ? "exact" : locationPrecisionToOption(setting));
  if (proLocked && isScreenOpen()) closeRandomizeScreen();
  syncPrecisionCadenceUi();
}

// ── Cadence ("Pick a new point") ─────────────────────────────────────────────

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
  syncValueRow(select);
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
 * {@link restorePrecisionControl}, since NEW POINT's visibility and the root
 * row's value depend on the Distance choice. Only sets value/visibility/lock
 * state, never persists.
 */
export function restorePrecisionCadenceControl(cadence: unknown, proLocked = false): void {
  const select = getCadenceSelect();
  if (!select) return;
  proLock = proLocked;
  select.value = validatePrecisionCadence(cadence);
  syncValueRow(select);
  syncPrecisionCadenceUi();
}

/** Test hook: forget the Pro lock. */
export function __resetPrecisionForTest(): void {
  proLock = false;
}
