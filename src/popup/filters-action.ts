/**
 * The one list change the This site card offers (direction.md 6.1), shared
 * with the per-site editor's Filters hint, which shows the card's button
 * (M13): its label, its accessible name, and the message that makes it.
 */

import type { ScopeResponse, ScopeSitePayload } from "@/shared/types/messages";
import { t } from "./i18n";
import type { ThisSiteListAction } from "./this-site";

export type FiltersAction = ThisSiteListAction;

/** A verb and the list's name: "Add to Allowlist", "Remove from Denylist". */
export function filtersActionLabel(action: FiltersAction): string {
  if (action.list === "allowlist") {
    return action.action === "add"
      ? t("siteLocation_addToAllowlist") || "Add to Allowlist"
      : t("filters_removeFromAllowlist") || "Remove from Allowlist";
  }
  return action.action === "add"
    ? t("filters_addToDenylist") || "Add to Denylist"
    : t("filters_removeFromDenylist") || "Remove from Denylist";
}

/**
 * "Add to Allowlist: twitch.tv". The visible label comes first (WCAG 2.5.3);
 * the site follows, because the row above may not be a Tab stop.
 */
export function filtersActionAriaLabel(label: string, site: string): string {
  return t("filters_actionAria", [label, site]) || `${label}: ${site}`;
}

/** Send the list change, the pattern exactly as the card's model gives it. True when it saved. */
export async function sendFiltersAction(action: FiltersAction): Promise<boolean> {
  const payload: ScopeSitePayload = { list: action.list, pattern: action.pattern };
  try {
    const result = (await browser.runtime.sendMessage({
      type: action.action === "add" ? "ADD_SCOPE_SITE" : "REMOVE_SCOPE_SITE",
      payload,
    })) as ScopeResponse | undefined;
    if (result && "success" in result && result.success) return true;
    console.error("Failed to change the Filters list:", result);
  } catch (error: unknown) {
    console.error("Failed to change the Filters list:", error);
  }
  return false;
}
