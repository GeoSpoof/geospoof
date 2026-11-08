/**
 * The THIS SITE card on the Filters root (design H, direction.md 4.2 design
 * B, 5 H-1…H-8 and H-2b, 6.1–6.3), rendered in jsdom against the real
 * assets/popup.html: the site row, the reason, the one list button and its
 * exact undo, the accessible names and descriptions (N22, N24), the live
 * region after a card write and after a mode change (6.2, N25), and the
 * editor opened from the card.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Favorite, Settings, SiteLocation } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import { TOKYO, TOKYO_NAME, TOKYO_TZ, makeSiteLocation } from "../../helpers/site-locations";

// Stub the reload so each test decides what a successful write re-renders.
// The card, scope.ts and site-locations.ts must all bind to this mock, so the
// factory doesn't load the real settings module (whose imports would bind
// them to the original first). isRestrictedUrl is the background's copy,
// which the popup's mirrors host for host.
vi.mock("@/popup/settings", async () => {
  const restricted = await import("@/background/restricted-url");
  return {
    loadSettings: vi.fn().mockResolvedValue(undefined),
    isRestrictedUrl: (url: string | undefined) => !url || restricted.isRestrictedUrl(url),
  };
});

import {
  __resetThisSiteCardForTest,
  cardStatusText,
  renderThisSiteCard,
} from "@/popup/this-site-card";
import { __resetScopeForTest, renderScope } from "@/popup/scope";
import { __resetSiteLocationsForTest, renderSiteLocations } from "@/popup/site-locations";
import { loadSettings } from "@/popup/settings";
import { __resetFiltersNavForTest } from "@/popup/filters-nav";
import { __resetPopupSiteGroupsForTest } from "@/popup/site-groups";
import { getCardUndo } from "@/popup/card-undo";

const BODY = (() => {
  const html = readFileSync("assets/popup.html", "utf8");
  return new DOMParser().parseFromString(html, "text/html").body.innerHTML;
})();

const RELOAD = "Reload affected pages to apply the change.";

const PARIS: SiteLocation = makeSiteLocation({
  id: "paris",
  patterns: ["example.com"],
  location: { latitude: 48.8566, longitude: 2.3522, accuracy: 45 },
  locationName: { city: "Paris", country: "France", displayName: "Paris, France" },
});
const LOS_ANGELES: SiteLocation = makeSiteLocation({
  id: "los-angeles",
  patterns: ["twitch.tv"],
  location: { latitude: 34.0522, longitude: -118.2437, accuracy: 45 },
  locationName: {
    city: "Los Angeles",
    country: "United States",
    displayName: "Los Angeles, United States",
  },
});
const FAVORITE: Favorite = {
  id: "fav-paris",
  latitude: 48.8566,
  longitude: 2.3522,
  city: "Paris",
  country: "France",
  displayName: "Paris, France",
  label: null,
};

const S_ALLOWLIST = ["example.com", "=mail.example.com", "geosite:google", "*.ru"];

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    location: TOKYO,
    timezone: TOKYO_TZ,
    locationName: TOKYO_NAME,
    favorites: [FAVORITE],
    ...overrides,
  };
}

/** Scenario S (direction.md 5.0): the Allowlist, Paris for example.com, Los Angeles for twitch.tv. */
const S = settings({
  scopeMode: "allowlist",
  allowlist: S_ALLOWLIST,
  denylist: [],
  siteLocations: [PARIS, LOS_ANGELES],
});
/** Scenario S0: All sites, empty lists, no per-site locations. */
const S0 = settings({ scopeMode: "all", allowlist: [], denylist: [], siteLocations: [] });
/** Scenario D: the Denylist `twitch.tv`, `*.ru`; the rest as in S. */
const D = settings({
  scopeMode: "denylist",
  allowlist: S_ALLOWLIST,
  denylist: ["twitch.tv", "*.ru"],
  siteLocations: [PARIS, LOS_ANGELES],
});

const sendMessage = vi.mocked(browser.runtime.sendMessage);

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
}

function text(id: string): string {
  return (byId(id).textContent ?? "").trim();
}

/** Visible = neither the element nor an ancestor is `hidden`. */
function isShown(id: string): boolean {
  return byId(id).closest("[hidden]") === null;
}

function messages(): Array<{ type: string; payload?: unknown }> {
  return sendMessage.mock.calls.map(
    ([message]) => message as unknown as { type: string; payload?: unknown }
  );
}

function messagesOfType(type: string): unknown[] {
  return messages()
    .filter((message) => message.type === type)
    .map((message) => message.payload);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Wait out the announcer's clear-then-set delay, then read it. */
async function announced(): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return text("siteLocationAnnouncer");
}

/** jsdom won't focus inside a `display: none` panel. */
function showFiltersView(): void {
  byId("mainView").style.display = "none";
  byId("filtersView").style.display = "block";
}

/** Render the Filters surfaces as loadSettings does. */
function renderAll(s: Settings, url: string | undefined, proLocked = false): void {
  renderScope(s, proLocked, url);
  renderSiteLocations(s, proLocked, url);
  renderThisSiteCard(s, url, proLocked);
}

/** The next loadSettings re-renders with `s` on `url`, as the saved settings would. */
function reloadWith(s: Settings, url: string): void {
  vi.mocked(loadSettings).mockImplementationOnce(() => {
    renderAll(s, url);
    return Promise.resolve();
  });
}

/** The card's site row. */
function row(): HTMLElement {
  const node = byId("thisSiteRow").querySelector<HTMLElement>(".site-row");
  if (!node) throw new Error("no card row");
  return node;
}

/** The card as read: host, value, whether it opens something, and the line under the site. */
function card(): { host: string; value: string; chev: boolean; sub: string | null } {
  const r = row();
  return {
    host: r.querySelector(".site-row-host")?.textContent ?? "",
    value: r.querySelector(".site-row-value")?.textContent ?? "",
    chev: r.querySelector(".site-row-chev") !== null,
    sub: r.querySelector(".site-row-sub")?.textContent ?? null,
  };
}

/** The text an element's aria-describedby resolves to, joined by spaces as AT reads it. */
function description(node: HTMLElement): string {
  return (node.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => text(id))
    .join(" ");
}

/** The card's button as read: label, name, and description; null when hidden. */
function button(): { label: string; name: string | null; description: string } | null {
  if (!isShown("thisSiteButton")) return null;
  const node = byId("thisSiteButton");
  return {
    label: text("thisSiteButton"),
    name: node.getAttribute("aria-label"),
    description: description(node),
  };
}

function reason(): string | null {
  return isShown("thisSiteReason") ? text("thisSiteReason") : null;
}

beforeEach(() => {
  document.body.innerHTML = BODY;
  __resetFiltersNavForTest();
  __resetSiteLocationsForTest();
  __resetScopeForTest();
  __resetThisSiteCardForTest();
  __resetPopupSiteGroupsForTest();
  sendMessage.mockReset();
  vi.mocked(loadSettings).mockReset();
  vi.mocked(loadSettings).mockResolvedValue(undefined);
});

describe("the frames of design H", () => {
  test("H-1: All sites on chatgpt.com, the main location, a row that opens the editor", () => {
    renderAll(S0, "https://chatgpt.com/");
    expect(isShown("thisSiteSection")).toBe(true);
    expect(text("thisSiteSection").startsWith("This site")).toBe(true);
    expect(card()).toEqual({
      host: "chatgpt.com",
      value: "Tokyo",
      chev: true,
      sub: "Main location",
    });
    expect(row().getAttribute("role")).toBe("button");
    expect(row().getAttribute("tabindex")).toBe("0");
    expect(row().getAttribute("aria-describedby")).toBe("card-desc");
    expect(description(row())).toBe("Use a different location on chatgpt.com");
    // Nothing about Filters needs saying in All sites mode.
    expect(byId("thisSiteActions").hidden).toBe(true);
    expect(cardStatusText()).toBe("chatgpt.com: Tokyo.");
  });

  test("H-2: www.twitch.tv in the Allowlist reads twitch.tv, Off, and one button", () => {
    renderAll(S, "https://www.twitch.tv/");
    expect(card()).toEqual({ host: "twitch.tv", value: "Off", chev: false, sub: null });
    // A plain row: no role, not a Tab stop, no description.
    expect(row().hasAttribute("role")).toBe(false);
    expect(row().hasAttribute("tabindex")).toBe(false);
    expect(row().hasAttribute("aria-describedby")).toBe(false);
    expect(button()).toEqual({
      label: "Add to Allowlist",
      name: "Add to Allowlist: twitch.tv",
      description: "Off",
    });
    expect(byId("thisSiteButton").getAttribute("aria-describedby")).toBe("card-value");
    expect(reason()).toBeNull();
    expect(isShown("thisSiteReloadHint")).toBe(false);
    expect(isShown("thisSiteError")).toBe(false);
  });

  test("H-2b: Add to Allowlist flips the button in place, keeps focus, and speaks the new value", async () => {
    showFiltersView();
    renderAll(S, "https://www.twitch.tv/");
    sendMessage.mockResolvedValue({ success: true });
    reloadWith({ ...S, allowlist: [...S_ALLOWLIST, "twitch.tv"] }, "https://www.twitch.tv/");
    const btn = byId("thisSiteButton");
    btn.focus();
    btn.click();
    await flush();

    expect(messagesOfType("ADD_SCOPE_SITE")).toEqual([{ list: "allowlist", pattern: "twitch.tv" }]);
    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(card()).toEqual({
      host: "twitch.tv",
      value: "Los Angeles",
      chev: true,
      sub: "Per-site location",
    });
    expect(description(row())).toBe("Change the location for twitch.tv");
    // The row is a Tab stop now, so the button has no description.
    expect(button()).toEqual({
      label: "Remove from Allowlist",
      name: "Remove from Allowlist: twitch.tv",
      description: "",
    });
    expect(document.activeElement).toBe(btn);
    expect(btn.hasAttribute("disabled")).toBe(false);
    expect(btn.hasAttribute("aria-disabled")).toBe(false);
    expect(isShown("thisSiteReloadHint")).toBe(true);
    expect(text("thisSiteReloadHint")).toBe(RELOAD);
    expect(await announced()).toBe(`twitch.tv: Los Angeles. ${RELOAD}`);
    // An add leaves nothing to undo.
    expect(getCardUndo()).toBeNull();
  });

  test("H-3: example.com with its own location, and the button that removes its own entry", () => {
    renderAll(S, "https://example.com/");
    expect(card()).toEqual({
      host: "example.com",
      value: "Paris",
      chev: true,
      sub: "Per-site location",
    });
    expect(description(row())).toBe("Change the location for example.com");
    expect(button()).toEqual({
      label: "Remove from Allowlist",
      name: "Remove from Allowlist: example.com",
      description: "",
    });
    expect(reason()).toBeNull();
  });

  test("H-4: Denylist on chatgpt.com, one click from off", () => {
    renderAll(D, "https://chatgpt.com/");
    expect(card()).toEqual({
      host: "chatgpt.com",
      value: "Tokyo",
      chev: true,
      sub: "Main location",
    });
    expect(button()).toEqual({
      label: "Add to Denylist",
      name: "Add to Denylist: chatgpt.com",
      description: "",
    });
    expect(reason()).toBeNull();
  });

  test("H-8: under the Safari Pro lock the row is plain and the card has no actions", () => {
    renderAll(S, "https://example.com/", true);
    expect(card()).toEqual({
      host: "example.com",
      value: "Tokyo",
      chev: false,
      sub: "Main location",
    });
    expect(row().hasAttribute("role")).toBe(false);
    expect(row().hasAttribute("tabindex")).toBe(false);
    expect(byId("thisSiteActions").hidden).toBe(true);
  });
});

describe("the rows of 6.1", () => {
  test("row 2: Location Protection off reads Off, names its source, and the row opens nothing", () => {
    showFiltersView();
    renderAll({ ...S, enabled: false }, "https://example.com/");
    expect(card()).toEqual({
      host: "example.com",
      value: "Off",
      chev: false,
      sub: "Location Protection",
    });
    expect(row().hasAttribute("role")).toBe(false);
    expect(row().hasAttribute("tabindex")).toBe(false);
    expect(row().hasAttribute("aria-describedby")).toBe(false);
    // The button turns protection on; it isn't per site, so its name is its label.
    expect(button()).toEqual({
      label: "Turn On Location Protection",
      name: null,
      description: "Off",
    });

    // A click on the row doesn't leave Filters or write anything.
    const toMain = vi.fn();
    byId("mainTab").addEventListener("click", toMain);
    row().click();
    expect(toMain).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("row 2: Turn On Location Protection turns it on in place and speaks the new value", async () => {
    showFiltersView();
    renderAll({ ...S0, enabled: false }, "https://chatgpt.com/");
    sendMessage.mockResolvedValue({ success: true });
    reloadWith(S0, "https://chatgpt.com/");
    const toMain = vi.fn();
    byId("mainTab").addEventListener("click", toMain);
    const btn = byId("thisSiteButton");
    btn.focus();
    btn.click();
    await flush();

    expect(messages()).toEqual([{ type: "SET_PROTECTION_STATUS", payload: { enabled: true } }]);
    expect(toMain).not.toHaveBeenCalled();
    expect(card()).toEqual({
      host: "chatgpt.com",
      value: "Tokyo",
      chev: true,
      sub: "Main location",
    });
    // The new state has no button, so focus moves to the row.
    expect(button()).toBeNull();
    expect(document.activeElement).toBe(row());
    expect(isShown("thisSiteReloadHint")).toBe(false);
    expect(await announced()).toBe("chatgpt.com: Tokyo.");
  });

  test("row 2: a failed Turn On keeps the card and focus, and says the change wasn't saved", async () => {
    showFiltersView();
    renderAll({ ...S, enabled: false }, "https://example.com/");
    sendMessage.mockResolvedValue({ error: "boom" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const btn = byId("thisSiteButton");
    btn.focus();
    btn.click();
    await flush();

    expect(loadSettings).not.toHaveBeenCalled();
    expect(button()?.label).toBe("Turn On Location Protection");
    expect(isShown("thisSiteError")).toBe(true);
    expect(document.activeElement).toBe(btn);
    expect(btn.hasAttribute("aria-disabled")).toBe(false);
  });

  test("Not set: the row opens nothing, and Set Location opens the Main tab's city search", () => {
    showFiltersView();
    renderAll({ ...S0, location: null, locationName: null }, "https://chatgpt.com/");
    expect(card()).toEqual({
      host: "chatgpt.com",
      value: "Not set",
      chev: false,
      sub: "Main location",
    });
    expect(row().hasAttribute("tabindex")).toBe(false);
    expect(button()).toEqual({
      label: "Set Location",
      name: null,
      description: "Not set Opens the Main tab",
    });

    // index.ts's tab handler, as the popup wires it.
    byId("mainTab").addEventListener("click", () => {
      byId("filtersView").style.display = "none";
      byId("mainView").style.display = "block";
    });
    row().click();
    expect(byId("mainView").style.display).toBe("none");

    byId("thisSiteButton").click();
    expect(byId("mainView").style.display).toBe("block");
    expect(document.activeElement).toBe(byId("locationSearch"));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("H-8 with Not set: Safari without Pro offers Set Location", () => {
    renderAll({ ...S, location: null, locationName: null }, "https://chatgpt.com/", true);
    expect(card()).toEqual({
      host: "chatgpt.com",
      value: "Not set",
      chev: false,
      sub: "Main location",
    });
    expect(button()?.label).toBe("Set Location");
  });

  test("row 6: a broader entry covers the page; the row is described by its description, then the reason (N24)", () => {
    renderAll(S, "https://example.ru/");
    expect(card()).toEqual({
      host: "example.ru",
      value: "Tokyo",
      chev: true,
      sub: "Main location",
    });
    expect(reason()).toBe("Covered by *.ru");
    expect(row().getAttribute("aria-describedby")).toBe("card-desc thisSiteReason");
    expect(description(row())).toBe("Use a different location on example.ru Covered by *.ru");
    expect(button()).toBeNull();
  });

  test("row 6 names the entry that keeps the site on, not its own entry (M12)", () => {
    renderAll({ ...S, allowlist: ["twitch.tv", "*.tv"] }, "https://twitch.tv/");
    expect(card().value).toBe("Los Angeles");
    expect(reason()).toBe("Covered by *.tv");
    expect(button()).toBeNull();
  });

  test("row 7: some pages covered; the button is described by the value, then the reason (N22)", () => {
    renderAll({ ...S, allowlist: ["twitch.tv/videos/*"] }, "https://www.twitch.tv/");
    expect(card()).toEqual({ host: "twitch.tv", value: "Off", chev: false, sub: null });
    expect(reason()).toBe("Covered on some pages only");
    expect(byId("thisSiteButton").getAttribute("aria-describedby")).toBe(
      "card-value thisSiteReason"
    );
    expect(button()).toEqual({
      label: "Add to Allowlist",
      name: "Add to Allowlist: twitch.tv",
      description: "Off Covered on some pages only",
    });
  });

  test("row 9: Denylist, the site's own entry: Remove from Denylist, described by Off", () => {
    renderAll(D, "https://twitch.tv/");
    expect(card()).toEqual({ host: "twitch.tv", value: "Off", chev: false, sub: null });
    expect(button()).toEqual({
      label: "Remove from Denylist",
      name: "Remove from Denylist: twitch.tv",
      description: "Off",
    });
  });

  test("row 10: Denylist, a broader entry keeps the site off; nothing on the card is focusable", () => {
    renderAll(D, "https://example.ru/");
    expect(card()).toEqual({ host: "example.ru", value: "Off", chev: false, sub: null });
    expect(reason()).toBe("Covered by *.ru");
    expect(button()).toBeNull();
    const focusable = Array.from(
      byId("thisSiteCard").querySelectorAll<HTMLElement>("[tabindex], button")
    ).filter((node) => node.closest("[hidden]") === null && node.tabIndex >= 0);
    expect(focusable).toEqual([]);
  });

  test("row 11: Denylist, some pages listed; the row carries the reason, the button no description", () => {
    renderAll({ ...D, denylist: ["twitch.tv/videos/*"] }, "https://twitch.tv/");
    expect(card().value).toBe("Los Angeles");
    expect(reason()).toBe("Covered on some pages only");
    expect(description(row())).toBe("Change the location for twitch.tv Covered on some pages only");
    expect(button()).toEqual({
      label: "Add to Denylist",
      name: "Add to Denylist: twitch.tv",
      description: "",
    });
  });

  test.each([
    ["no tab", undefined],
    ["a restricted page", "about:blank"],
    ["a browser page", "chrome://extensions/"],
    ["the options tab", "moz-extension://test/popup/popup.html"],
    ["a host with no site", "http://intranet/"],
  ])("hidden on %s", (_name, url) => {
    renderAll(S, url);
    expect(byId("thisSiteSection").hidden).toBe(true);
    expect(cardStatusText()).toBeNull();
  });
});

describe("the button's writes", () => {
  const MAIL = "https://mail.example.com/";
  const MAIL_LIST = settings({ ...S, allowlist: ["=mail.example.com", "*.ru"] });

  test("Remove then Add puts back the exact entry, =mail.example.com", async () => {
    showFiltersView();
    renderAll(MAIL_LIST, MAIL);
    expect(button()?.label).toBe("Remove from Allowlist");
    sendMessage.mockResolvedValue({ success: true });

    reloadWith({ ...MAIL_LIST, allowlist: ["*.ru"] }, MAIL);
    byId("thisSiteButton").focus();
    byId("thisSiteButton").click();
    await flush();
    expect(messagesOfType("REMOVE_SCOPE_SITE")).toEqual([
      { list: "allowlist", pattern: "=mail.example.com" },
    ]);
    // Its label names the list change, not the entry.
    expect(button()).toEqual({
      label: "Add to Allowlist",
      name: "Add to Allowlist: mail.example.com",
      description: "Off",
    });
    expect(document.activeElement).toBe(byId("thisSiteButton"));
    expect(getCardUndo()).toEqual({ tabUrl: MAIL, list: "allowlist", entry: "=mail.example.com" });

    reloadWith(MAIL_LIST, MAIL);
    byId("thisSiteButton").click();
    await flush();
    expect(messagesOfType("ADD_SCOPE_SITE")).toEqual([
      { list: "allowlist", pattern: "=mail.example.com" },
    ]);
    expect(getCardUndo()).toBeNull();
    expect(button()?.label).toBe("Remove from Allowlist");
  });

  test("any other write in between clears the undo, so the card adds the site itself", async () => {
    renderAll(MAIL_LIST, MAIL);
    sendMessage.mockResolvedValue({ success: true });
    reloadWith({ ...MAIL_LIST, allowlist: ["*.ru"] }, MAIL);
    byId("thisSiteButton").click();
    await flush();
    expect(getCardUndo()).not.toBeNull();

    // An entry added on the list screen.
    reloadWith({ ...MAIL_LIST, allowlist: ["*.ru", "kick.com"] }, MAIL);
    const input = byId<HTMLInputElement>("scopeAddInput");
    input.value = "kick.com";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(messagesOfType("ADD_SCOPE_SITE")).toEqual([{ list: "allowlist", pattern: "kick.com" }]);
    expect(getCardUndo()).toBeNull();

    sendMessage.mockClear();
    byId("thisSiteButton").click();
    await flush();
    expect(messagesOfType("ADD_SCOPE_SITE")).toEqual([
      { list: "allowlist", pattern: "mail.example.com" },
    ]);
  });

  test("a different tab drops the undo", async () => {
    renderAll(MAIL_LIST, MAIL);
    sendMessage.mockResolvedValue({ success: true });
    reloadWith({ ...MAIL_LIST, allowlist: ["*.ru"] }, MAIL);
    byId("thisSiteButton").click();
    await flush();
    expect(getCardUndo()).not.toBeNull();
    renderAll({ ...MAIL_LIST, allowlist: ["*.ru"] }, "https://www.twitch.tv/");
    expect(getCardUndo()).toBeNull();
  });

  test("a double click sends one message; the button stays focusable while it's in flight", async () => {
    showFiltersView();
    renderAll(S, "https://www.twitch.tv/");
    let reply: (value: unknown) => void = () => undefined;
    sendMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        })
    );
    const btn = byId("thisSiteButton");
    btn.focus();
    btn.click();
    btn.click();
    await flush();
    expect(messagesOfType("ADD_SCOPE_SITE")).toHaveLength(1);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(btn);

    reloadWith({ ...S, allowlist: [...S_ALLOWLIST, "twitch.tv"] }, "https://www.twitch.tv/");
    reply({ success: true });
    await flush();
    expect(btn.hasAttribute("aria-disabled")).toBe(false);
    expect(messagesOfType("ADD_SCOPE_SITE")).toHaveLength(1);
  });

  test("a failure keeps the card, focus and the undo, and says the change wasn't saved", async () => {
    showFiltersView();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderAll(MAIL_LIST, MAIL);
    sendMessage.mockResolvedValue({ success: true });
    reloadWith({ ...MAIL_LIST, allowlist: ["*.ru"] }, MAIL);
    byId("thisSiteButton").click();
    await flush();
    expect(await announced()).toBe(`mail.example.com: Off. ${RELOAD}`);
    byId("siteLocationAnnouncer").textContent = "";
    vi.mocked(loadSettings).mockClear();

    sendMessage.mockResolvedValue({ error: "STORAGE_ERROR" });
    const btn = byId("thisSiteButton");
    btn.focus();
    btn.click();
    await flush();
    expect(isShown("thisSiteError")).toBe(true);
    expect(byId("thisSiteError").getAttribute("role")).toBe("alert");
    expect(text("thisSiteError")).toBe("⚠ Change not saved");
    expect(document.activeElement).toBe(btn);
    expect(btn.hasAttribute("aria-disabled")).toBe(false);
    expect(button()?.label).toBe("Add to Allowlist");
    expect(loadSettings).not.toHaveBeenCalled();
    expect(getCardUndo()).toEqual({ tabUrl: MAIL, list: "allowlist", entry: "=mail.example.com" });
    expect(errors).toHaveBeenCalled();
    expect(await announced()).toBe("");

    // A thrown send is a failure too; the retry still re-adds the exact entry.
    sendMessage.mockRejectedValue(new Error("port closed"));
    btn.click();
    await flush();
    expect(isShown("thisSiteError")).toBe(true);
    expect(messagesOfType("ADD_SCOPE_SITE")).toEqual([
      { list: "allowlist", pattern: "=mail.example.com" },
      { list: "allowlist", pattern: "=mail.example.com" },
    ]);
    errors.mockRestore();
  });

  test("when the saved settings leave no button, focus moves to the reload hint", async () => {
    showFiltersView();
    // The card recomputes from what was saved. Here *.ru arrived meanwhile
    // (another window), so the new state has no button to keep focus on.
    const RU = settings({ ...S, allowlist: ["example.ru"] });
    renderAll(RU, "https://example.ru/");
    expect(button()?.label).toBe("Remove from Allowlist");
    sendMessage.mockResolvedValue({ success: true });
    reloadWith({ ...RU, allowlist: ["example.ru", "*.ru"] }, "https://example.ru/");
    byId("thisSiteButton").focus();
    byId("thisSiteButton").click();
    await flush();
    expect(button()).toBeNull();
    expect(reason()).toBe("Covered by *.ru");
    expect(document.activeElement).toBe(byId("thisSiteReloadHint"));
    expect(await announced()).toBe(`example.ru: Tokyo. ${RELOAD}`);
  });
});

describe("a mode change is announced (6.2, N25)", () => {
  test("the sentence, the empty-Allowlist warning spoken with a comma, and the card's new value", async () => {
    const all = settings({ scopeMode: "all", allowlist: [], denylist: [], siteLocations: [] });
    renderAll(all, "https://www.twitch.tv/");
    expect(cardStatusText()).toBe("twitch.tv: Tokyo.");
    sendMessage.mockResolvedValue({ success: true });
    reloadWith({ ...all, scopeMode: "allowlist" }, "https://www.twitch.tv/");
    byId("scopeModeAllowlist").click();
    await flush();
    expect(messagesOfType("SET_SCOPE_MODE")).toEqual([{ scopeMode: "allowlist" }]);
    expect(await announced()).toBe(
      "GeoSpoof works only on sites in the Allowlist. Allowlist: Empty, Off on every site. twitch.tv: Off."
    );
  });

  test("an unchanged card value isn't repeated", async () => {
    renderAll(D, "https://chatgpt.com/");
    sendMessage.mockResolvedValue({ success: true });
    reloadWith({ ...D, scopeMode: "all" }, "https://chatgpt.com/");
    byId("scopeModeAll").click();
    await flush();
    expect(await announced()).toBe("GeoSpoof works on every site.");
  });

  test("a mode change clears the card's undo", async () => {
    const mailList = settings({ ...S, allowlist: ["=mail.example.com"] });
    renderAll(mailList, "https://mail.example.com/");
    sendMessage.mockResolvedValue({ success: true });
    reloadWith({ ...mailList, allowlist: [] }, "https://mail.example.com/");
    byId("thisSiteButton").click();
    await flush();
    expect(getCardUndo()).not.toBeNull();
    reloadWith({ ...mailList, allowlist: [], scopeMode: "denylist" }, "https://mail.example.com/");
    byId("scopeModeDenylist").click();
    await flush();
    expect(getCardUndo()).toBeNull();
  });

  test("a failed mode change announces nothing and leaves the card", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderAll(S0, "https://www.twitch.tv/");
    sendMessage.mockResolvedValue({ error: "STORAGE_ERROR" });
    byId("scopeModeAllowlist").click();
    await flush();
    expect(isShown("scopeModeError")).toBe(true);
    expect(card().value).toBe("Tokyo");
    expect(loadSettings).not.toHaveBeenCalled();
    expect(await announced()).toBe("");
  });
});

describe("the editor opened from the card", () => {
  test("the row opens a new entry for the site; Cancel returns focus to the row", () => {
    showFiltersView();
    renderAll(S0, "https://chatgpt.com/");
    const opener = row();
    opener.focus();
    opener.click();
    expect(isShown("siteLocationEditorScreen")).toBe(true);
    expect(text("siteLocationEditorBackLabel")).toBe("Filters");
    expect(text("siteLocationEditorTitle")).toBe("New per-site location");
    expect(
      Array.from(byId("siteLocationEntries").querySelectorAll(".entry-chip-title")).map(
        (node) => node.textContent
      )
    ).toEqual(["chatgpt.com"]);
    byId("siteLocationCancel").click();
    expect(isShown("filtersRoot")).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  test("the row opens the entry that applies (Enter works too)", () => {
    showFiltersView();
    renderAll(S, "https://example.com/");
    row().focus();
    row().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(isShown("siteLocationEditorScreen")).toBe(true);
    expect(text("siteLocationEditorTitle")).toBe("Per-site location");
    expect(text("siteLocationEditorBackLabel")).toBe("Filters");
  });

  test("Save returns to the root, with the reload hint on the card and focus on its row", async () => {
    showFiltersView();
    renderAll(S0, "https://chatgpt.com/");
    row().click();
    byId("siteLocationFavoritesList")
      .querySelector<HTMLButtonElement>(`[data-favorite-id="${FAVORITE.id}"]`)
      ?.click();
    sendMessage.mockResolvedValue({ success: true, id: "new" });
    const saved = makeSiteLocation({
      id: "new",
      patterns: ["chatgpt.com"],
      location: PARIS.location,
      locationName: PARIS.locationName,
    });
    reloadWith({ ...S0, siteLocations: [saved] }, "https://chatgpt.com/");
    byId("siteLocationSave").click();
    await flush();
    expect(messagesOfType("SAVE_SITE_LOCATION")).toHaveLength(1);
    expect(isShown("filtersRoot")).toBe(true);
    expect(card()).toEqual({
      host: "chatgpt.com",
      value: "Paris",
      chev: true,
      sub: "Per-site location",
    });
    expect(isShown("thisSiteReloadHint")).toBe(true);
    expect(document.activeElement).toBe(row());
  });

  test("the editor's Filters hint offers the card's button for the tab's site (M13)", () => {
    showFiltersView();
    renderAll(S, "https://www.twitch.tv/");
    // The card's row is plain here (Off), so open Los Angeles from the
    // Per-site locations screen.
    byId("siteLocationsRow").click();
    const entryRow = byId("siteLocationsList").querySelector<HTMLElement>(
      `[data-site-location-id="${LOS_ANGELES.id}"] .site-row`
    );
    entryRow?.click();
    expect(text("siteLocationFiltersHintText")).toBe("Not used · Off in Filters");
    expect(text("siteLocationFiltersAction")).toBe("Add to Allowlist");
    expect(byId("siteLocationFiltersAction").getAttribute("aria-label")).toBe(
      byId("thisSiteButton").getAttribute("aria-label")
    );
    expect(byId("siteLocationFiltersAction").getAttribute("aria-label")).toBe(
      "Add to Allowlist: twitch.tv"
    );
  });
});

describe("the empty add field offers this site", () => {
  /** The listbox's options as text, under `listboxId`. */
  function optionTexts(listboxId: string): string[] {
    return Array.from(byId(listboxId).querySelectorAll<HTMLElement>("[role='option']")).map(
      (o) => o.textContent ?? ""
    );
  }

  test("a list screen offers Add <site> only while the site isn't listed", () => {
    showFiltersView();
    renderAll(S, "https://www.twitch.tv/");
    byId("scopeListRow").click();
    byId("scopeAddInput").focus();
    expect(byId("scopeAddInput").getAttribute("aria-expanded")).toBe("true");
    expect(optionTexts("scopeGroupListbox")).toEqual([
      "Add twitch.tvSite and its subdomains",
      "Browse all site groups…",
    ]);
    byId("scopeAddInput").blur();

    // example.com is listed: only Browse.
    renderAll(S, "https://example.com/");
    byId("scopeAddInput").focus();
    expect(optionTexts("scopeGroupListbox")).toEqual(["Browse all site groups…"]);
  });

  test("typing in the editor's Sites field lists the same readings as a list screen", () => {
    showFiltersView();
    const typeInto = (id: string, value: string): void => {
      const field = byId<HTMLInputElement>(id);
      field.focus();
      field.value = value;
      field.dispatchEvent(new Event("input"));
    };
    renderAll(S, "https://www.twitch.tv/");
    byId("scopeListRow").click();
    typeInto("scopeAddInput", "twitch.tv");
    const onList = optionTexts("scopeGroupListbox");
    byId("scopeAddInput").blur();
    byId("scopeListBack").click();

    // Paris's entry (example.com), from the Per-site locations screen.
    byId("siteLocationsRow").click();
    byId("siteLocationsList").querySelector<HTMLElement>(".site-row")?.click();
    expect(isShown("siteLocationEditorScreen")).toBe(true);
    typeInto("siteLocationPatterns", "twitch.tv");
    expect(byId("siteLocationPatterns").getAttribute("aria-expanded")).toBe("true");
    expect(optionTexts("siteLocationGroupListbox")).toEqual(onList);
    expect(onList[0]).toBe("twitch.tvSite and its subdomains");
    // By design, a comma list in the editor is added as typed, with no suggestions.
    typeInto("siteLocationPatterns", "twitch.tv, chatgpt.com");
    expect(byId("siteLocationGroupListbox").hidden).toBe(true);
  });

  test("the editor's Sites field offers Add <site> only when the entry lacks it", () => {
    showFiltersView();
    // A new entry for chatgpt.com starts with it as a chip: only Browse.
    renderAll(S0, "https://chatgpt.com/");
    row().click();
    byId("siteLocationPatterns").focus();
    expect(optionTexts("siteLocationGroupListbox")).toEqual(["Browse all site groups…"]);
    byId("siteLocationPatterns").blur();
    byId("siteLocationCancel").click();

    // example.com's own entry (Paris), opened on twitch.tv's tab: twitch.tv is offered.
    renderAll(S, "https://www.twitch.tv/");
    byId("siteLocationsRow").click();
    byId("siteLocationsList").querySelector<HTMLElement>(".site-row")?.click();
    expect(isShown("siteLocationEditorScreen")).toBe(true);
    byId("siteLocationPatterns").focus();
    expect(optionTexts("siteLocationGroupListbox")).toEqual([
      "Add twitch.tvSite and its subdomains",
      "Browse all site groups…",
    ]);
  });
});
