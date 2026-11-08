/**
 * The THIS SITE card at the top of the Filters root (design H, direction.md
 * 4.2 design B, 6.1–6.3): one site row ("twitch.tv · Off", "example.com ·
 * Paris ›"), then at most one reason, at most one button that names the exact
 * list change, and the reload hint or the error after a write.
 *
 * The card shows state. It never predicts: after a write it re-reads the
 * settings and computes again (the model is `computeThisSiteCard`). The row
 * opens the editor and changes nothing; an Off or Not set row opens nothing.
 * The button writes list membership, and after a Remove it re-adds exactly
 * the entry it removed (`card-undo.ts`). With Location Protection off it is
 * "Turn On Location Protection", which turns protection on in place; with no
 * location set it is "Set Location", which opens the Main tab's city search.
 *
 * The row is rebuilt on every render. The button, the hint and the error are
 * static markup, so focus stays on the button while its label flips.
 */

import type { Settings } from "@/shared/types/settings";
import { isOwnExtensionPage } from "./active-tab";
import { announce, spokenValue } from "./announce";
import { clearCardUndo, getCardUndo, setCardUndo } from "./card-undo";
import { filtersActionAriaLabel, filtersActionLabel, sendFiltersAction } from "./filters-action";
import { isFocusable } from "./filters-nav";
import { t } from "./i18n";
import { getReloadHintHost, setReloadHintHost } from "./reload-hint";
import { isRestrictedUrl, loadSettings } from "./settings";
import { describeEntry, popupSiteGroupLookup } from "./site-groups";
import { openSiteLocationEditor } from "./site-locations";
import { buildSiteRow } from "./site-row";
import {
  computeThisSiteCard,
  type ThisSiteCard,
  type ThisSiteReason,
  type ThisSiteSource,
  type ThisSiteValue,
} from "./this-site";
import { clearChildren } from "./ui";

type ShownCard = Extract<ThisSiteCard, { kind: "shown" }>;

/** The ids the card's accessible descriptions point at (6.1, "Accessible names"). */
const ROW_ID_PREFIX = "card";
const VALUE_ID = "card-value";
const OPENS_MAIN_ID = "card-opens-main";
const REASON_ID = "thisSiteReason";

/** The last rendered inputs, so a failed write can re-render from them. */
let last: { settings: Settings; tabUrl: string | undefined; proLocked: boolean } | null = null;
let model: ThisSiteCard = { kind: "hidden" };
/** A card write is in flight; repeat activations are ignored. */
let pending = false;

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setHidden(id: string, hidden: boolean): void {
  const node = el(id);
  if (node) node.hidden = hidden;
}

/** "Off", "Not set", or the place. */
function valueText(value: ThisSiteValue): string {
  switch (value.kind) {
    case "off":
      return t("filters_valueOff") || "Off";
    case "notSet":
      return t("filters_valueNotSet") || "Not set";
    case "place":
      return value.name;
  }
}

/** The line under the site: where the value comes from (row 2: Location Protection, N26). */
function sourceText(source: ThisSiteSource): string | null {
  if (source === "none") return null;
  if (source === "protection") return t("toggle_locationProtection") || "Location Protection";
  if (source === "main") return t("siteLocation_srcMain") || "Main location";
  if (source === "site") return t("siteLocation_srcSite") || "Per-site location";
  const entry = describeEntry(source.entry).title;
  return t("siteLocation_srcEntry", [entry]) || `Per-site location · ${entry}`;
}

/** What opening the row does, read as its description. */
function opensDescription(card: ShownCard): string | null {
  const { site } = card;
  switch (card.opens.kind) {
    case "edit":
      return t("siteLocation_changeAria", [site]) || `Change the location for ${site}`;
    case "new":
      return t("siteLocation_useHereAria", [site]) || `Use a different location on ${site}`;
    case "none":
      return null;
  }
}

type CardButton = NonNullable<ShownCard["button"]>;

/** The button's visible label. */
function buttonLabel(button: CardButton): string {
  if (button.action === "turnOn") {
    return t("filters_turnOnProtection") || "Turn On Location Protection";
  }
  if (button.action === "setLocation") return t("filters_setLocation") || "Set Location";
  return filtersActionLabel(button);
}

/** "Covered by *.ru" (the entry named the way its list row shows it), or "Covered on some pages only". */
function reasonText(reason: ThisSiteReason): string | null {
  if (reason.kind === "coveredBy") {
    const entry = describeEntry(reason.entry).title;
    return t("filters_coveredBy", [entry]) || `Covered by ${entry}`;
  }
  if (reason.kind === "somePages") {
    return t("filters_somePages") || "Covered on some pages only";
  }
  return null;
}

/**
 * A status as the live region speaks it: "twitch.tv: Los Angeles.",
 * "Allowlist: Empty, Off on every site." `name` is a site or a list name.
 */
export function statusAnnouncement(name: string, value: string): string {
  const spoken = spokenValue(value);
  return t("filters_statusAnnounce", [name, spoken]) || `${name}: ${spoken}.`;
}

/** The card's status as last rendered ("twitch.tv: Off."), or null while it's hidden. */
export function cardStatusText(): string | null {
  if (model.kind !== "shown") return null;
  return statusAnnouncement(model.site, valueText(model.value));
}

/**
 * Called from loadSettings() after renderSiteLocations(), with the active
 * tab's URL. Hidden on restricted pages and in the options tab.
 */
export function renderThisSiteCard(
  settings: Settings,
  tabUrl: string | undefined,
  proLocked: boolean
): void {
  wireCardOnce();
  last = { settings, tabUrl, proLocked };
  // The undo belongs to the tab its Remove ran on.
  const undo = getCardUndo();
  if (undo !== null && undo.tabUrl !== tabUrl) clearCardUndo();
  model = computeThisSiteCard({
    settings,
    tabUrl,
    proLocked,
    isOptionsPage: tabUrl !== undefined && isOwnExtensionPage(tabUrl),
    isRestricted: isRestrictedUrl,
    siteGroups: popupSiteGroupLookup(),
    undo: getCardUndo(),
  });
  renderCard();
}

function renderCard(): void {
  const section = el("thisSiteSection");
  const rowHost = el("thisSiteRow");
  const reason = el("thisSiteReason");
  const button = el<HTMLButtonElement>("thisSiteButton");
  if (!section || !rowHost || !reason || !button) return;
  setHidden("thisSiteError", true);
  clearChildren(rowHost);

  if (model.kind === "hidden") {
    section.hidden = true;
    reason.hidden = true;
    reason.textContent = "";
    hideButton(button);
    syncActions();
    return;
  }
  section.hidden = false;
  const card = model;
  const opens = card.opens.kind !== "none";
  const reasonLine = reasonText(card.reason);
  // A plain row isn't a Tab stop, so a button after it is described by the
  // value, then the reason (rows 7, 8, 9; N22).
  const describeButton = !opens && card.button !== null;

  const { row, description } = buildSiteRow({
    host: card.site,
    value: valueText(card.value),
    sub: sourceText(card.source),
    opens,
    description: opensDescription(card),
    idPrefix: ROW_ID_PREFIX,
    valueId: describeButton ? VALUE_ID : null,
    onActivate: () => {
      activateRow(card, row);
    },
  });
  // A row that is a Tab stop carries the reason itself (rows 6, 11; N24).
  if (description && reasonLine !== null) {
    row.setAttribute("aria-describedby", `${description.id} ${REASON_ID}`);
  }
  rowHost.appendChild(row);
  if (description) rowHost.appendChild(description);

  reason.textContent = reasonLine ?? "";
  reason.hidden = reasonLine === null;

  if (card.button === null) {
    hideButton(button);
  } else {
    const label = buttonLabel(card.button);
    button.textContent = label;
    // A list change names the site, because the row may not be a Tab stop.
    // Turning protection on and setting the location aren't per site.
    if (card.button.action === "add" || card.button.action === "remove") {
      button.setAttribute("aria-label", filtersActionAriaLabel(label, card.site));
    } else {
      button.removeAttribute("aria-label");
    }
    const describedBy: string[] = [];
    if (describeButton) {
      describedBy.push(VALUE_ID);
      if (reasonLine !== null) describedBy.push(REASON_ID);
    }
    // "Set Location" says where it goes: "Opens the Main tab".
    if (card.button.action === "setLocation") {
      const opensMain = document.createElement("span");
      opensMain.className = "visually-hidden";
      opensMain.id = OPENS_MAIN_ID;
      opensMain.textContent = t("filters_openMainAria") || "Opens the Main tab";
      rowHost.appendChild(opensMain);
      describedBy.push(OPENS_MAIN_ID);
    }
    if (describedBy.length > 0) button.setAttribute("aria-describedby", describedBy.join(" "));
    else button.removeAttribute("aria-describedby");
    button.hidden = false;
  }
  // aria-disabled, never disabled: a disabled button would drop focus.
  if (pending) button.setAttribute("aria-disabled", "true");
  else button.removeAttribute("aria-disabled");

  setHidden("thisSiteReloadHint", getReloadHintHost() !== "card");
  syncActions();
}

function hideButton(button: HTMLButtonElement): void {
  button.hidden = true;
  button.removeAttribute("aria-label");
  button.removeAttribute("aria-describedby");
}

/** The action area isn't rendered when it would be empty. */
function syncActions(): void {
  const actions = el("thisSiteActions");
  if (!actions) return;
  actions.hidden = Array.from(actions.children).every((child) => (child as HTMLElement).hidden);
}

/** The row: the editor on the entry that applies, or a new entry for the site. */
function activateRow(card: ShownCard, row: HTMLElement): void {
  switch (card.opens.kind) {
    case "edit":
      openSiteLocationEditor({ entryId: card.opens.entryId, opener: row, origin: "root" });
      return;
    case "new":
      openSiteLocationEditor({ entryId: null, opener: row, origin: "root", prefill: card.site });
      return;
    case "none":
      return;
  }
}

/** "Set Location": the Main tab, focus on its city search. Writes nothing. */
function openMainSearch(): void {
  // index.ts's own tab handler switches the view.
  const tab = el("mainTab");
  tab?.click();
  // The search is hidden while VPN sync or coordinates entry shows; focus the tab then.
  const search = el("locationSearch");
  search?.focus();
  if (document.activeElement !== search && isFocusable(tab)) tab.focus();
}

/** Turn Location Protection on, with the message the Main tab's toggle sends. True when it saved. */
async function sendTurnOn(): Promise<boolean> {
  try {
    const result = (await browser.runtime.sendMessage({
      type: "SET_PROTECTION_STATUS",
      payload: { enabled: true },
    })) as { success?: boolean } | undefined;
    if (result?.success === true) return true;
    console.error("Failed to set protection status:", result);
  } catch (error: unknown) {
    console.error("Failed to set protection status:", error);
  }
  return false;
}

function wireCardOnce(): void {
  const button = el("thisSiteButton");
  if (!button || button.dataset.wired === "1") return;
  button.dataset.wired = "1";
  button.addEventListener("click", () => {
    void handleButton();
  });
}

/**
 * The card's button. "Set Location" opens the Main tab's city search. The
 * others write: one ADD_SCOPE_SITE or REMOVE_SCOPE_SITE with the model's
 * exact pattern, or SET_PROTECTION_STATUS on. On success the card recomputes
 * from the saved settings, focus stays on the button (or moves to the row,
 * then the reload hint, when the new state has none), and the live region
 * speaks the site's new status, and after a list change the reload hint. A
 * failure keeps focus, the undo record and the card, and shows "⚠ Change not
 * saved".
 */
async function handleButton(): Promise<void> {
  if (pending || model.kind !== "shown" || model.button === null) return;
  const card = model;
  const action = model.button;
  if (action.action === "setLocation") {
    openMainSearch();
    return;
  }
  // Safari without Pro: the lists are locked.
  if (last?.proLocked && action.action !== "turnOn") return;
  const button = el("thisSiteButton");
  pending = true;
  button?.setAttribute("aria-disabled", "true");
  setHidden("thisSiteError", true);
  syncActions();

  const saved = action.action === "turnOn" ? await sendTurnOn() : await sendFiltersAction(action);
  if (!saved) {
    pending = false;
    button?.removeAttribute("aria-disabled");
    if (last) renderThisSiteCard(last.settings, last.tabUrl, last.proLocked);
    setHidden("thisSiteError", false);
    syncActions();
    return;
  }

  if (action.action === "remove") {
    setCardUndo({ tabUrl: card.tabUrl, list: action.list, entry: action.pattern });
  } else {
    clearCardUndo();
  }
  const listChange = action.action !== "turnOn";
  // Turning protection on reaches open pages as the Main toggle's does, with no hint.
  if (listChange) setReloadHintHost("card");
  try {
    await loadSettings();
  } finally {
    pending = false;
    button?.removeAttribute("aria-disabled");
  }

  const active = document.activeElement;
  if (active === button || active === null || active === document.body) {
    const hint = el("thisSiteReloadHint");
    const row = document.querySelector<HTMLElement>("#thisSiteRow .site-row");
    if (isFocusable(button)) button.focus();
    else if (!listChange && row?.tabIndex === 0 && isFocusable(row)) row.focus();
    else if (isFocusable(hint)) hint.focus();
  }
  const status = cardStatusText();
  if (!listChange) {
    if (status !== null) announce(status);
    return;
  }
  const reload = t("siteLocation_reloadHint") || "Reload affected pages to apply the change.";
  announce(status === null ? reload : `${status} ${reload}`);
}

/** Test hook: forget popup-session state between cases. */
export function __resetThisSiteCardForTest(): void {
  last = null;
  model = { kind: "hidden" };
  pending = false;
  clearCardUndo();
}
