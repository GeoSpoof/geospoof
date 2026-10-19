/**
 * Badge Management
 * Update the toolbar icon badge to reflect the per-tab spoofing state.
 *
 * Three visually distinct states (design §5, Req 12):
 *   - `active`        — master on AND the tab's Effective_Enabled is true.
 *   - `out-of-scope`  — master on but Effective_Enabled is false (out of scope
 *                       under the active mode/lists, or a Restricted_URL).
 *   - `master-off`    — master switch off; shown on every tab.
 *
 * The orange `"!"` injection-failure badge written by the alarm path in
 * `index.ts` is orthogonal to scope state and lives there, not here.
 *
 * The per-tab title carries the site-location state (it names the place and
 * the site), so no new badge color is needed and color is never the only
 * signal.
 */

import type { Settings } from "@/shared/types/settings";
import { isRestrictedUrl } from "./tabs";
import { loadSettings } from "./settings";
import type { SiteResolution } from "@/shared/utils/site-locations";
import { resolveSiteSettings, siteLocationDisplayName } from "@/shared/utils/site-locations";
import { createLogger } from "@/shared/utils/debug-logger";

const logger = createLogger("BG");

export type BadgeState = "active" | "out-of-scope" | "master-off";

const BADGE_STYLE: Record<BadgeState, { color: string; text: string }> = {
  active: { color: "green", text: "✓" },
  "out-of-scope": { color: "#5b7083", text: "•" },
  "master-off": { color: "gray", text: "" },
};

/**
 * Apply the mapped color/text for `state` to a single tab's badge.
 *
 * Per-tab badge writes are best-effort. They reject with "No tab with id ..."
 * when the tab has closed between resolving the state and applying it, and they
 * reject (or the API is entirely absent) on mobile engines that have no toolbar
 * to host a per-tab action badge — e.g. Chromium-based Android browsers such as
 * Quetta. Those rejections must never escape as unhandled promise rejections:
 * on some Android engines a flood of "Uncaught (in promise)" rejections in the
 * background wedges the worker, leaving the popup toggles unresponsive. So we
 * feature-detect the API and swallow any rejection (logged at debug only).
 */
export function setBadgeForTab(tabId: number, state: BadgeState): void {
  const action = browser.action;
  if (!action?.setBadgeText) {
    return;
  }
  const { color, text } = BADGE_STYLE[state];
  const swallow = (error: unknown): void => {
    logger.debug(`Badge update skipped for tab ${tabId}:`, error);
  };
  void action.setBadgeBackgroundColor({ color, tabId }).catch(swallow);
  void action.setBadgeText({ text, tabId }).catch(swallow);
}

/**
 * Map the master switch and a tab's Effective_Enabled value to a BadgeState.
 *
 * `master-off` when the master switch is off (Req 12.3); otherwise `active`
 * when the tab is effectively enabled (Req 12.1), else `out-of-scope` (Req
 * 12.2). Restricted URLs are covered here too because `computeEffectiveEnabled`
 * already returns false for them, so they map to `out-of-scope` (Req 12.5).
 */
export function badgeStateFor(masterEnabled: boolean, effectiveEnabled: boolean): BadgeState {
  if (!masterEnabled) {
    return "master-off";
  }
  return effectiveEnabled ? "active" : "out-of-scope";
}

/**
 * Refresh the badge and title on every open tab to reflect its current
 * Effective_Enabled value and site location. Loads settings once, then resolves
 * the per-tab decision against each tab's top-level URL via the shared
 * `resolveSiteSettings` source of truth and applies the mapped state (Req
 * 12.1–12.6).
 */
export async function updateBadge(): Promise<void> {
  try {
    const settings = await loadSettings();
    const tabs = await browser.tabs.query({});

    for (const tab of tabs) {
      if (tab.id == null) {
        continue;
      }
      applyTabIndicator(tab.id, settings, tab.url);
    }
  } catch (error) {
    logger.error("Failed to update badge:", error);
  }
}

/** A localized message, or null when the API is absent or the key is missing (""). */
function message(key: string, substitutions?: string[]): string | null {
  try {
    const text = browser.i18n?.getMessage(key, substitutions);
    return typeof text === "string" && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * The toolbar title for a tab. Pure apart from reading the localized strings.
 *
 * With a site location applied it names the place and the site, so the state
 * is never carried by the badge color alone. Otherwise it's the plain extension
 * name. Always explicit, because engines differ on whether clearing a per-tab
 * title restores the default.
 */
export function tabTitleFor(resolution: SiteResolution, url: string | undefined): string {
  const entry = resolution.siteLocation;
  if (entry !== null) {
    let hostname = "";
    try {
      hostname = url ? new URL(url).hostname : "";
    } catch {
      hostname = "";
    }
    const place = siteLocationDisplayName(entry);
    return (
      message("badge_titleSiteLocation", [place, hostname]) ?? `GeoSpoof: ${place} on ${hostname}`
    );
  }
  return message("extensionName") ?? "GeoSpoof";
}

/**
 * Set one tab's toolbar title. Best-effort like `setBadgeForTab`: the API is
 * feature-detected (absent on mobile engines) and rejections (closed tab) are
 * swallowed so they never surface as unhandled rejections.
 */
export function setTitleForTab(tabId: number, title: string): void {
  const action = browser.action;
  if (!action?.setTitle) {
    return;
  }
  try {
    void action.setTitle({ title, tabId }).catch((error: unknown) => {
      logger.debug(`Title update skipped for tab ${tabId}:`, error);
    });
  } catch (error) {
    logger.debug(`Title update skipped for tab ${tabId}:`, error);
  }
}

/**
 * Resolve a tab once and apply both indicators: the badge (scope state, colors
 * unchanged) and the title (names a site location when one applies). Returns
 * the resolution so callers can reuse `enabled`.
 */
export function applyTabIndicator(
  tabId: number,
  settings: Settings,
  url: string | undefined
): SiteResolution {
  const r = resolveSiteSettings(settings, url, isRestrictedUrl);
  setBadgeForTab(tabId, badgeStateFor(settings.enabled, r.enabled));
  setTitleForTab(tabId, tabTitleFor(r, url));
  return r;
}
