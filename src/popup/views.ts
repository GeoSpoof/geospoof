/**
 * The popup's views (Main, Sites, Details, Settings) and the Settings nav bar.
 *
 * Settings is a screen you visit and leave, so while it's open a nav bar
 * ("‹ <origin tab>" and a "Settings" title) replaces the tab bar, as the Sites
 * tab's sub-screens do. Back, or the gear again, returns to the tab Settings
 * was opened from. The trade-off: reaching a different tab from Settings now
 * takes two taps (Back, then the tab), because the tab bar isn't on screen.
 */
import { t } from "./i18n";
import { fitNavBar, wireNavBarsOnce } from "./filters-nav";
import { resetRandomizeScreen } from "./precision";

/**
 * The popup's switchable views, mapped to the element that selects each one and
 * the panel it reveals.
 *
 * Single source of truth on purpose: this previously lived in three parallel
 * lists (a trigger map, a panel map, and a literal tuple to iterate), so adding a
 * view meant editing all three and forgetting one failed silently — the view
 * would render but never hide its siblings.
 *
 * `settings` is triggered by a gear in the header rather than a tab in the bar;
 * only the trigger element differs, so it participates here like any other view.
 */
export const POPUP_VIEWS = {
  main: { trigger: "mainTab", panel: "mainView" },
  filters: { trigger: "filtersTab", panel: "filtersView" },
  details: { trigger: "detailsTab", panel: "detailsView" },
  settings: { trigger: "settingsTab", panel: "settingsView" },
} as const;

export type PopupView = keyof typeof POPUP_VIEWS;
/** A view the tab bar selects: every view but Settings. */
export type TabView = Exclude<PopupView, "settings">;

/** The back label's text per origin tab, with English fallbacks. */
const BACK_LABELS: Record<TabView, { key: string; fallback: string }> = {
  main: { key: "tab_main", fallback: "Main" },
  filters: { key: "tab_filters", fallback: "Sites" },
  details: { key: "tab_details", fallback: "Details" },
};

let current: PopupView = "main";
/** The tab Settings was opened from. Main when the popup opens on Settings. */
let settingsOrigin: TabView = "main";

/** Where the gear goes: into Settings, or from Settings back to its origin. */
export function gearTarget(view: PopupView, origin: TabView): PopupView {
  return view === "settings" ? origin : "settings";
}

export function getSettingsOrigin(): TabView {
  return settingsOrigin;
}

/** Write the origin tab's name into the back row. It has no data-i18n on purpose. */
export function renderSettingsBackLabel(): void {
  const label = document.getElementById("settingsBackLabel");
  if (!label) return;
  const { key, fallback } = BACK_LABELS[settingsOrigin];
  label.textContent = t(key) || fallback;
  const bar = label.closest<HTMLElement>(".nav-bar");
  if (bar) fitNavBar(bar);
}

/**
 * Show one view and hide the rest, keeping each trigger's `aria-current` in sync.
 *
 * `aria-current` is the state mechanism for all four triggers, and it drives both
 * the visual styling and what assistive tech announces — there is no separate
 * `.active` class to keep in step. It's the right attribute here rather than
 * `aria-pressed`: these are one-of-N view selections, not independent toggles
 * that stay depressed. It also matters most for the Settings gear, which sits
 * outside the tab bar and so has no underline to inherit; without it, opening
 * Settings would leave every tab unstyled and read as "nothing selected".
 */
export function showPopupView(view: PopupView): void {
  const entering = view === "settings" && current !== "settings";
  const leaving = view !== "settings" && current === "settings";
  if (entering) settingsOrigin = current as TabView;

  for (const [key, { trigger, panel }] of Object.entries(POPUP_VIEWS)) {
    const isCurrent = key === view;

    const triggerEl = document.getElementById(trigger);
    if (triggerEl) {
      // Set-or-remove rather than writing "false": an absent attribute keeps the
      // CSS selectors simple (`[aria-current]` means current) and matches how
      // assistive tech expects a non-current item to look.
      if (isCurrent) triggerEl.setAttribute("aria-current", "true");
      else triggerEl.removeAttribute("aria-current");
    }

    const panelEl = document.getElementById(panel);
    if (panelEl) panelEl.style.display = isCurrent ? "block" : "none";
  }

  const tabBar = document.querySelector<HTMLElement>(".tab-navigation");
  if (tabBar) tabBar.hidden = view === "settings";

  if (entering) {
    renderSettingsBackLabel();
    const container = document.querySelector<HTMLElement>(".popup-container");
    if (container) container.scrollTop = 0;
    document.getElementById("settingsTitle")?.focus();
  } else if (leaving) {
    const settingsView = document.getElementById("settingsView");
    const focusInside =
      !!settingsView && !!document.activeElement && settingsView.contains(document.activeElement);
    // Settings opens on its root next time, not on Randomize location.
    resetRandomizeScreen();
    if (focusInside) document.getElementById("settingsTab")?.focus();
  }

  current = view;
}

/** Wire the gear and the Settings back row. Idempotent. */
export function wireSettingsNav(): void {
  const gear = document.getElementById("settingsTab");
  if (gear && gear.dataset.navWired !== "1") {
    gear.dataset.navWired = "1";
    gear.addEventListener("click", () => {
      showPopupView(gearTarget(current, settingsOrigin));
    });
  }
  const back = document.getElementById("settingsBack");
  if (back && back.dataset.navWired !== "1") {
    back.dataset.navWired = "1";
    back.addEventListener("click", () => {
      showPopupView(settingsOrigin);
    });
  }
  wireNavBarsOnce();
}

/** Test hook: back to Main, with Main as the origin. */
export function __resetViewsForTest(): void {
  current = "main";
  settingsOrigin = "main";
}
