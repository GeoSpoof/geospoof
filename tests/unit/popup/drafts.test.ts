/**
 * S7 drafts: the open Filters screen, the list's typed text and an open
 * editor survive closing the popup, in storage.session, keyed to the site the
 * popup opened on. jsdom against the real assets/popup.html markup; "closing
 * and reopening" is a fresh body and fresh module state over the same
 * storage.session mock (tests/setup.ts).
 */
import { describe, test, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Favorite, Settings } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import {
  ENTRY_DUBLIN,
  ENTRY_MEXICO_CITY,
  TOKYO,
  TOKYO_NAME,
  TOKYO_TZ,
} from "../../helpers/site-locations";
import { sessionStorageData } from "../../setup";
// Stub the reload so a successful action doesn't re-run the whole popup render.
vi.mock("@/popup/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/popup/settings")>();
  return { ...actual, loadSettings: vi.fn().mockResolvedValue(undefined) };
});
// Import order matters: the popup modules first, so the settings mock is
// built before they bind to it.
import { __resetScopeForTest, renderScope } from "@/popup/scope";
import {
  __resetSiteLocationsForTest,
  openSiteLocationEditor,
  renderSiteLocations,
} from "@/popup/site-locations";
import {
  __resetDraftsForTest,
  draftKey,
  FILTERS_DRAFT_STORAGE_KEY,
  restoreFiltersDraft,
  type FiltersDraft,
} from "@/popup/drafts";
import { __resetFiltersNavForTest } from "@/popup/filters-nav";
import { __resetPopupSiteGroupsForTest } from "@/popup/site-groups";

const BODY = (() => {
  const html = readFileSync("assets/popup.html", "utf8");
  return new DOMParser().parseFromString(html, "text/html").body.innerHTML;
})();

const FAVORITE: Favorite = {
  id: "fav-1",
  latitude: 48.8566,
  longitude: 2.3522,
  city: "Paris",
  country: "France",
  displayName: "Paris, France",
  label: "Work",
};

const TWITCH = "https://www.twitch.tv/directory";
const EXAMPLE = "https://example.com/page";
const OPTIONS_PAGE = "moz-extension://test/popup/popup.html";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    location: TOKYO,
    timezone: TOKYO_TZ,
    locationName: TOKYO_NAME,
    favorites: [FAVORITE],
    scopeMode: "allowlist",
    allowlist: ["twitch.tv"],
    siteLocations: [ENTRY_DUBLIN, ENTRY_MEXICO_CITY],
    ...overrides,
  };
}

const sendMessage = vi.mocked(browser.runtime.sendMessage);

/** The storage.session.set mock from tests/setup.ts. */
function sessionSetMock(): ReturnType<typeof vi.fn> {
  const session = browser.storage.session as unknown as Record<string, unknown>;
  return session["set"] as ReturnType<typeof vi.fn>;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
}

function stored(): FiltersDraft | undefined {
  return sessionStorageData[FILTERS_DRAFT_STORAGE_KEY] as FiltersDraft | undefined;
}

/** The Filters screens showing: root, list, Per-site locations, editor. */
function shownScreens(): string[] {
  return [
    "filtersRoot",
    "scopeListScreen",
    "siteLocationsScreen",
    "siteLocationEditorScreen",
  ].filter((id) => !byId(id).hidden);
}

function filtersViewShown(): boolean {
  return byId("filtersView").style.display === "block";
}

function type(id: string, value: string): void {
  const input = byId<HTMLInputElement>(id);
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

function pressEnter(id: string): void {
  byId(id).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

function chipTitles(): string[] {
  return Array.from(byId("siteLocationEntries").querySelectorAll(".entry-chip-title")).map(
    (node) => node.textContent ?? ""
  );
}

function chipRemoveButton(title: string): HTMLButtonElement {
  const chip = Array.from(byId("siteLocationEntries").children).find(
    (node) => node.querySelector(".entry-chip-title")?.textContent === title
  );
  const button = chip?.querySelector<HTMLButtonElement>(".entry-chip-remove");
  if (!button) throw new Error(`no chip ${title}`);
  return button;
}

function chosenName(): string {
  return byId("siteLocationChosen").querySelector(".entry-chip-title")?.textContent ?? "";
}

function pickFavorite(id: string): void {
  const button = byId("siteLocationFavoritesList").querySelector<HTMLButtonElement>(
    `[data-favorite-id="${id}"]`
  );
  if (!button) throw new Error(`no favorite ${id}`);
  button.click();
}

function siteRow(id: string): HTMLElement {
  const item = Array.from(byId("siteLocationsList").children).find(
    (node) => (node as HTMLElement).dataset.siteLocationId === id
  );
  const row = item?.querySelector<HTMLElement>(".site-row");
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/**
 * Open the popup as index.ts does: fresh markup and module state, the
 * renders loadSettings runs, then the one restore.
 */
async function openPopup(settings: Settings, url: string | undefined, proLocked = false) {
  document.body.innerHTML = BODY;
  __resetFiltersNavForTest();
  __resetScopeForTest();
  __resetSiteLocationsForTest();
  __resetPopupSiteGroupsForTest();
  __resetDraftsForTest();
  // Stand-ins for index.ts's tab handlers.
  byId("filtersTab").addEventListener("click", () => {
    byId("mainView").style.display = "none";
    byId("filtersView").style.display = "block";
  });
  byId("mainTab").addEventListener("click", () => {
    byId("filtersView").style.display = "none";
    byId("mainView").style.display = "block";
  });
  renderScope(settings, proLocked, url);
  renderSiteLocations(settings, proLocked, url);
  await restoreFiltersDraft(settings, url, proLocked);
}

beforeEach(() => {
  sendMessage.mockReset();
});

describe("draftKey", () => {
  test.each<[string, string | undefined, string | null]>([
    ["the site, without www.", TWITCH, "twitch.tv"],
    ["an ordinary page", EXAMPLE, "example.com"],
    ["the options tab", OPTIONS_PAGE, "options"],
    ["a restricted page", "about:addons", null],
    ["a browser page", "chrome://extensions/", null],
    ["a file", "file:///Users/me/a.html", null],
    ["no tab", undefined, null],
  ])("%s", (_name, url, key) => {
    expect(draftKey(url)).toBe(key);
  });
});

describe("the list screen", () => {
  test("its typed text comes back on the same site, with the screen and focus in the field", async () => {
    await openPopup(makeSettings(), TWITCH);
    byId("filtersTab").click();
    byId("scopeListRow").click();
    type("scopeAddInput", "example.org");
    expect(stored()).toEqual({ v: 1, key: "twitch.tv", screen: "list", listField: "example.org" });

    await openPopup(makeSettings(), TWITCH);
    expect(filtersViewShown()).toBe(true);
    expect(shownScreens()).toEqual(["scopeListScreen"]);
    expect(byId<HTMLInputElement>("scopeAddInput").value).toBe("example.org");
    expect(document.activeElement).toBe(byId("scopeAddInput"));
    // Back still returns to the root, and focus to the list's row.
    byId("scopeListBack").click();
    expect(shownScreens()).toEqual(["filtersRoot"]);
    expect(document.activeElement).toBe(byId("scopeListRow"));
  });

  test("the draft never travels in a runtime message", async () => {
    await openPopup(makeSettings(), TWITCH);
    byId("filtersTab").click();
    byId("scopeListRow").click();
    type("scopeAddInput", "secret-draft.example");
    await openPopup(makeSettings(), TWITCH);
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain("secret-draft");
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain(FILTERS_DRAFT_STORAGE_KEY);
  });

  test("a successful add keeps the screen and drops the text", async () => {
    await openPopup(makeSettings(), TWITCH);
    byId("filtersTab").click();
    byId("scopeListRow").click();
    sendMessage.mockResolvedValue({ success: true });
    type("scopeAddInput", "example.org");
    pressEnter("scopeAddInput");
    await flush();
    expect(byId<HTMLInputElement>("scopeAddInput").value).toBe("");
    expect(stored()).toEqual({ v: 1, key: "twitch.tv", screen: "list" });
  });

  test("going back to the root removes the draft", async () => {
    await openPopup(makeSettings(), TWITCH);
    byId("filtersTab").click();
    byId("scopeListRow").click();
    type("scopeAddInput", "example.org");
    byId("scopeListBack").click();
    expect(stored()).toBeUndefined();

    await openPopup(makeSettings(), TWITCH);
    expect(filtersViewShown()).toBe(false);
    expect(shownScreens()).toEqual(["filtersRoot"]);
  });

  test("a list screen is dropped when the mode is now All sites", async () => {
    await openPopup(makeSettings(), TWITCH);
    byId("filtersTab").click();
    byId("scopeListRow").click();
    type("scopeAddInput", "example.org");

    await openPopup(makeSettings({ scopeMode: "all" }), TWITCH);
    expect(shownScreens()).toEqual(["filtersRoot"]);
    expect(filtersViewShown()).toBe(false);
    expect(stored()).toBeUndefined();
  });
});

describe("the editor", () => {
  test("a new entry's chips, pending text and chosen place come back, with its back label", async () => {
    await openPopup(makeSettings(), EXAMPLE);
    byId("filtersTab").click();
    byId("siteLocationsRow").click();
    byId("siteLocationsAddButton").click();
    expect(chipTitles()).toEqual(["example.com"]);
    // Added as a chip: the draft doesn't keep it as typed text too.
    type("siteLocationPatterns", "example.org");
    pressEnter("siteLocationPatterns");
    await flush();
    expect(stored()?.editor?.pending).toBe("");
    type("siteLocationPatterns", "example.net");
    pickFavorite(FAVORITE.id);
    const place = chosenName();
    expect(place).not.toBe("");
    expect(stored()).toMatchObject({
      key: "example.com",
      screen: "editor",
      editor: {
        origin: "perSite",
        entryId: null,
        entries: ["example.com", "example.org"],
        pending: "example.net",
        chosen: { latitude: FAVORITE.latitude, longitude: FAVORITE.longitude, name: place },
        search: "",
      },
    });

    await openPopup(makeSettings(), EXAMPLE);
    expect(filtersViewShown()).toBe(true);
    expect(shownScreens()).toEqual(["siteLocationEditorScreen"]);
    expect(chipTitles()).toEqual(["example.com", "example.org"]);
    expect(byId<HTMLInputElement>("siteLocationPatterns").value).toBe("example.net");
    expect(chosenName()).toBe(place);
    expect(byId("siteLocationEditorBackLabel").textContent).toBe("Per-site locations");
    expect(byId<HTMLButtonElement>("siteLocationSave").disabled).toBe(false);
    expect(byId("siteLocationRemove").hidden).toBe(true);

    // Back goes where it was opened from.
    byId("siteLocationEditorBack").click();
    expect(shownScreens()).toEqual(["siteLocationsScreen"]);
  });

  test("an existing entry comes back with its edits, its Remove, and the search text", async () => {
    await openPopup(makeSettings(), EXAMPLE);
    byId("filtersTab").click();
    byId("siteLocationsRow").click();
    siteRow(ENTRY_DUBLIN.id).click();
    chipRemoveButton("openai.com").click();
    byId("siteLocationChosen").querySelector<HTMLButtonElement>(".entry-chip-remove")?.click();
    type("siteLocationSearch", "Par");
    expect(stored()?.editor).toMatchObject({
      entryId: ENTRY_DUBLIN.id,
      entries: ["chatgpt.com"],
      chosen: null,
      search: "Par",
    });

    await openPopup(makeSettings(), EXAMPLE);
    expect(shownScreens()).toEqual(["siteLocationEditorScreen"]);
    expect(chipTitles()).toEqual(["chatgpt.com"]);
    expect(chosenName()).toBe("");
    expect(byId<HTMLInputElement>("siteLocationSearch").value).toBe("Par");
    expect(byId("siteLocationRemove").hidden).toBe(false);
  });

  test("opened from Main, it comes back with '‹ Main'", async () => {
    await openPopup(makeSettings(), "https://twitch.tv/");
    byId("siteLocationLineEdit").click();
    expect(stored()?.editor?.origin).toBe("main");

    await openPopup(makeSettings(), "https://twitch.tv/");
    expect(shownScreens()).toEqual(["siteLocationEditorScreen"]);
    expect(byId("siteLocationEditorBackLabel").textContent).toBe("Main");
  });

  test("an entry that's gone since drops the draft", async () => {
    await openPopup(makeSettings(), EXAMPLE);
    byId("filtersTab").click();
    byId("siteLocationsRow").click();
    siteRow(ENTRY_DUBLIN.id).click();
    chipRemoveButton("openai.com").click();

    await openPopup(makeSettings({ siteLocations: [ENTRY_MEXICO_CITY] }), EXAMPLE);
    expect(shownScreens()).toEqual(["filtersRoot"]);
    expect(stored()).toBeUndefined();
  });

  test("Cancel removes it (from the root, nothing is left)", async () => {
    await openPopup(makeSettings(), EXAMPLE);
    byId("filtersTab").click();
    openSiteLocationEditor({ entryId: null, opener: null, origin: "root", prefill: "example.com" });
    pickFavorite(FAVORITE.id);
    expect(stored()?.screen).toBe("editor");
    byId("siteLocationCancel").click();
    expect(stored()).toBeUndefined();
  });

  test("Save removes the editor and keeps the screen it returns to", async () => {
    await openPopup(makeSettings(), EXAMPLE);
    byId("filtersTab").click();
    byId("siteLocationsRow").click();
    byId("siteLocationsAddButton").click();
    pickFavorite(FAVORITE.id);
    expect(stored()?.screen).toBe("editor");
    sendMessage.mockResolvedValue({ success: true, id: "1700000000009" });
    byId("siteLocationSave").click();
    await flush();
    expect(shownScreens()).toEqual(["siteLocationsScreen"]);
    expect(stored()).toEqual({ v: 1, key: "example.com", screen: "perSite" });
  });

  test("Remove removes the editor too", async () => {
    await openPopup(makeSettings(), EXAMPLE);
    byId("filtersTab").click();
    byId("siteLocationsRow").click();
    siteRow(ENTRY_DUBLIN.id).click();
    sendMessage.mockResolvedValue({ success: true });
    byId("siteLocationRemove").click();
    await flush();
    expect(stored()).toEqual({ v: 1, key: "example.com", screen: "perSite" });
  });
});

describe("where no draft is kept or restored", () => {
  test("another site drops it and opens as usual", async () => {
    await openPopup(makeSettings(), TWITCH);
    byId("filtersTab").click();
    byId("scopeListRow").click();
    type("scopeAddInput", "example.org");

    await openPopup(makeSettings(), "https://chatgpt.com/");
    expect(filtersViewShown()).toBe(false);
    expect(shownScreens()).toEqual(["filtersRoot"]);
    expect(byId<HTMLInputElement>("scopeAddInput").value).toBe("");
    expect(stored()).toBeUndefined();
  });

  test("the options tab keys its draft 'options'", async () => {
    await openPopup(makeSettings(), OPTIONS_PAGE);
    byId("filtersTab").click();
    byId("siteLocationsRow").click();
    expect(stored()).toEqual({ v: 1, key: "options", screen: "perSite" });

    await openPopup(makeSettings(), OPTIONS_PAGE);
    expect(shownScreens()).toEqual(["siteLocationsScreen"]);
  });

  test("a restricted tab saves nothing", async () => {
    await openPopup(makeSettings(), "about:addons");
    byId("filtersTab").click();
    byId("scopeListRow").click();
    type("scopeAddInput", "example.org");
    expect(stored()).toBeUndefined();
    expect(sessionSetMock()).not.toHaveBeenCalled();
  });

  test("the Pro lock drops it", async () => {
    await openPopup(makeSettings(), EXAMPLE);
    byId("filtersTab").click();
    byId("siteLocationsRow").click();

    await openPopup(makeSettings(), EXAMPLE, true);
    expect(shownScreens()).toEqual(["filtersRoot"]);
    expect(stored()).toBeUndefined();
  });

  test("a draft this version didn't write is dropped", async () => {
    sessionStorageData[FILTERS_DRAFT_STORAGE_KEY] = { v: 2, key: "example.com", screen: "list" };
    await openPopup(makeSettings(), EXAMPLE);
    expect(shownScreens()).toEqual(["filtersRoot"]);
    expect(stored()).toBeUndefined();
  });

  test("without storage.session nothing throws and nothing is kept", async () => {
    const storage = browser.storage as { session?: unknown };
    const session = storage.session;
    delete storage.session;
    try {
      await openPopup(makeSettings(), TWITCH);
      byId("filtersTab").click();
      byId("scopeListRow").click();
      expect(() => {
        type("scopeAddInput", "example.org");
      }).not.toThrow();
      byId("scopeListBack").click();
      await openPopup(makeSettings(), TWITCH);
      expect(shownScreens()).toEqual(["filtersRoot"]);
    } finally {
      storage.session = session;
    }
  });

  test("a failing write is logged, not thrown", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await openPopup(makeSettings(), TWITCH);
    sessionSetMock().mockRejectedValueOnce(new Error("quota"));
    byId("filtersTab").click();
    byId("scopeListRow").click();
    await flush();
    expect(error).toHaveBeenCalledWith("Failed to keep the Filters draft:", expect.any(Error));
    error.mockRestore();
  });
});
