/**
 * Popup Per-site locations (GeoSpoof/geospoof#177): the Main-tab line (only
 * when a site location applies), the Filters root's Per-site locations row,
 * the Per-site locations screen (site rows with their Filters marks), the
 * editor on its own screen with its in-context hints, and the Details
 * readout, exercised in jsdom against the real assets/popup.html markup.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Favorite, Settings, SiteLocation } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import {
  ENTRY_DUBLIN,
  ENTRY_MEXICO_CITY,
  makeSiteLocation,
  MEXICO_CITY,
  MEXICO_CITY_NAME,
  MEXICO_CITY_TZ,
  TOKYO,
  TOKYO_NAME,
  TOKYO_TZ,
} from "../../helpers/site-locations";

// Keep the real isRestrictedUrl; stub the reload so a successful action doesn't
// re-run the whole popup render.
vi.mock("@/popup/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/popup/settings")>();
  return { ...actual, loadSettings: vi.fn().mockResolvedValue(undefined) };
});

// Import order matters: loading site-locations first means the settings mock is
// fully built before site-locations binds to it (the real settings module
// imports site-locations back, which would otherwise hand it the original).
import {
  __resetSiteLocationsForTest,
  renderSearchResults,
  renderSiteLocationDetails,
  renderSiteLocationLine,
  renderSiteLocations,
  renderSiteLocationsSection,
} from "@/popup/site-locations";
import { loadSettings } from "@/popup/settings";
import { __resetFiltersNavForTest } from "@/popup/filters-nav";
import {
  __resetPopupSiteGroupsForTest,
  loadCatalogIndex,
  loadPopupSiteGroups,
} from "@/popup/site-groups";

const GOOGLE_TOKEN = "geosite:google";

/** Load the popup's site group data as loadSettings does, with Google stored. */
async function loadGroups(settings: Settings): Promise<void> {
  sendMessage.mockResolvedValueOnce({
    available: true,
    status: {
      release: "20261104112839",
      releasedAt: "2026-11-04T11:28:50Z",
      checkedAt: null,
      lastError: null,
      updating: false,
    },
    groups: {
      [GOOGLE_TOKEN]: {
        token: GOOGLE_TOKEN,
        kind: "group",
        name: "google",
        count: 964,
        skipped: 2,
        updatedAt: 1,
        d: "\ngoogle.com\nyoutube.com\n",
        f: "\n",
      },
    },
  });
  const settingsWithToken = {
    ...settings,
    allowlist: [...settings.allowlist, GOOGLE_TOKEN],
  };
  await loadPopupSiteGroups(settingsWithToken);
  sendMessage.mockClear();
}

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

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    location: TOKYO,
    timezone: TOKYO_TZ,
    locationName: TOKYO_NAME,
    favorites: [FAVORITE],
    siteLocations: [ENTRY_DUBLIN, ENTRY_MEXICO_CITY],
    ...overrides,
  };
}

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

function messagesOfType(type: string): unknown[] {
  return sendMessage.mock.calls
    .map(([message]) => message as unknown as { type: string; payload?: unknown })
    .filter((message) => message.type === type)
    .map((message) => message.payload);
}

/** Let queued promise continuations run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Click the favorite suggestion with this id under the Location field. */
function pickFavorite(id: string): void {
  const button = byId("siteLocationFavoritesList").querySelector<HTMLButtonElement>(
    `[data-favorite-id="${id}"]`
  );
  if (!button) throw new Error(`no favorite ${id}`);
  button.click();
}

/** The chosen place, as its token in the Location field shows it ("" for none). */
function chosenName(): string {
  return byId("siteLocationChosen").querySelector(".entry-chip-title")?.textContent ?? "";
}

/** The ✕ of the chosen place's token. */
function chosenRemoveButton(): HTMLButtonElement {
  const button = byId("siteLocationChosen").querySelector<HTMLButtonElement>(".entry-chip-remove");
  if (!button) throw new Error("no chosen place");
  return button;
}

function saveButton(): HTMLButtonElement {
  return byId<HTMLButtonElement>("siteLocationSave");
}

/** Type into the Sites input; what's left there is added on Save. */
function setPatterns(value: string): void {
  const input = byId<HTMLInputElement>("siteLocationPatterns");
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

/** The editor's sites, as its chips show them. */
function chipTitles(): string[] {
  return Array.from(byId("siteLocationEntries").querySelectorAll(".entry-chip-title")).map(
    (node) => node.textContent ?? ""
  );
}

/** The ✕ of the chip titled `title`. */
function chipRemoveButton(title: string): HTMLButtonElement {
  const chip = Array.from(byId("siteLocationEntries").children).find(
    (node) => node.querySelector(".entry-chip-title")?.textContent === title
  );
  const button = chip?.querySelector<HTMLButtonElement>(".entry-chip-remove");
  if (!button) throw new Error(`no chip ${title}`);
  return button;
}

/** Remove every chip, then type `value` into the Sites input. */
function replaceSites(value: string): void {
  for (const title of chipTitles()) chipRemoveButton(title).click();
  setPatterns(value);
}

/**
 * Switch to the Filters tab as index.ts's showPopupView does. Needed for focus
 * assertions: jsdom won't focus inside a `display: none` panel.
 */
function showFiltersView(): void {
  byId("mainView").style.display = "none";
  byId("filtersView").style.display = "block";
}

/** Render every surface as loadSettings does. */
function renderAll(settings: Settings, url: string | undefined, proLocked = false): void {
  renderSiteLocationLine(settings, url, proLocked);
  renderSiteLocationsSection(settings, url, proLocked);
  renderSiteLocationDetails(settings, url, proLocked);
}

/** The Per-site locations screen's site row of the entry with this id; it opens the editor. */
function siteRow(id: string): HTMLElement {
  const item = Array.from(byId("siteLocationsList").children).find(
    (node) => (node as HTMLElement).dataset.siteLocationId === id
  );
  const row = item?.querySelector<HTMLElement>(".site-row");
  if (!row) throw new Error(`no row for ${id}`);
  return row;
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

/** The editor's back row, as read: "Sites", "Per-site locations" or "Main". */
function editorBackLabel(): string {
  return text("siteLocationEditorBackLabel");
}

/** Stand in for index.ts's Main tab handler. */
function wireMainTab(): ReturnType<typeof vi.fn> {
  const toMain = vi.fn(() => {
    byId("filtersView").style.display = "none";
    byId("mainView").style.display = "block";
  });
  byId("mainTab").addEventListener("click", toMain);
  return toMain;
}

beforeEach(() => {
  document.body.innerHTML = BODY;
  __resetFiltersNavForTest();
  __resetSiteLocationsForTest();
  __resetPopupSiteGroupsForTest();
  sendMessage.mockReset();
  vi.mocked(loadSettings).mockClear();
});

describe("Main tab: nothing unless a site location applies", () => {
  const noMain = { location: null, timezone: null, locationName: null };

  test.each<[string, Partial<Settings>, string | undefined, boolean]>([
    ["a restricted page", {}, "about:blank", false],
    ["a restricted site", {}, "https://addons.mozilla.org/en-US/", false],
    ["no tab URL", {}, undefined, false],
    ["an unmatched site", {}, "https://example.com/", false],
    ["an unmatched site with no main location", noMain, "https://example.org/", false],
    [
      "a site Filters keep off (allowlist)",
      { scopeMode: "allowlist", allowlist: ["example.com"] },
      "https://chatgpt.com/c/1",
      false,
    ],
    [
      "a site Filters keep off (denylist)",
      { scopeMode: "denylist", denylist: ["twitch.tv"] },
      "https://twitch.tv/",
      false,
    ],
    ["the Safari Pro lock", {}, "https://twitch.tv/", true],
  ])("renders nothing on %s", (_name, overrides, url, proLocked) => {
    const applies = renderSiteLocationLine(makeSettings(overrides), url, proLocked);
    expect(applies).toBe(false);
    // `hidden` (display: none) takes no space: no empty container, no gap.
    expect(byId("siteLocationLine").hidden).toBe(true);
    expect(text("siteLocationLineStatus")).toBe("");
  });

  test("the old always-visible 'This site' card is gone", () => {
    // The This site card lives at the top of the Filters root now.
    expect(byId("mainView").querySelector("#thisSiteRow, #thisSiteSection")).toBeNull();
    expect(byId("thisSiteSection").closest("#filtersRoot")).not.toBeNull();
    expect(byId("mainView").textContent).not.toContain("Use a different location here");
    expect(byId("mainView").querySelector("[data-i18n='siteLocation_proNote']")).toBeNull();
  });
});

describe("Main tab: the line when a site location applies", () => {
  test("one compact line, 'On twitch.tv: Mexico City', with Edit and Use main location", () => {
    const applies = renderSiteLocationLine(
      makeSettings(),
      "https://www.twitch.tv/somechannel",
      false
    );
    expect(applies).toBe(true);
    expect(isShown("siteLocationLine")).toBe(true);
    expect(text("siteLocationLineStatus")).toBe("On twitch.tv: Mexico City");
    expect(isShown("siteLocationLineEdit")).toBe(true);
    expect(isShown("siteLocationLineUseMain")).toBe(true);
    expect(byId("siteLocationLineEdit").getAttribute("aria-label")).toBe(
      "Edit location Mexico City"
    );
    expect(isShown("siteLocationLineVpnHint")).toBe(false);
    expect(isShown("siteLocationLineReloadHint")).toBe(false);
    expect(isShown("siteLocationLineError")).toBe(false);
  });

  test("is a live line right under the location card, with no heading or card chrome", () => {
    const line = byId("siteLocationLine");
    expect(byId("currentLocation").nextElementSibling).toBe(line);
    expect(byId("siteLocationLineStatus").getAttribute("role")).toBe("status");
    expect(byId("siteLocationLineStatus").getAttribute("aria-live")).toBe("polite");
    expect(line.querySelector(".section-heading, h1, h2, h3, h4")).toBeNull();
    expect(line.tagName).toBe("DIV");
  });

  test("protection off still shows what the site would get", () => {
    renderSiteLocationLine(makeSettings({ enabled: false }), "https://twitch.tv/", false);
    expect(text("siteLocationLineStatus")).toBe("On twitch.tv: Mexico City");
  });

  test("a site location applies with no main location set", () => {
    const settings = makeSettings({ location: null, timezone: null, locationName: null });
    expect(renderSiteLocationLine(settings, "https://twitch.tv/", false)).toBe(true);
    expect(text("siteLocationLineStatus")).toBe("On twitch.tv: Mexico City");
  });

  test("VPN hint only with VPN sync on and the line showing", () => {
    renderSiteLocationLine(makeSettings({ vpnSyncEnabled: true }), "https://twitch.tv/", false);
    expect(isShown("siteLocationLineVpnHint")).toBe(true);

    renderSiteLocationLine(makeSettings({ vpnSyncEnabled: true }), "https://example.com/", false);
    expect(isShown("siteLocationLineVpnHint")).toBe(false);
    expect(byId("siteLocationLine").hidden).toBe(true);

    renderSiteLocationLine(makeSettings({ vpnSyncEnabled: false }), "https://twitch.tv/", false);
    expect(isShown("siteLocationLineVpnHint")).toBe(false);
  });

  test("'Use main location' sends REMOVE_SITE_LOCATION with the matched pattern", async () => {
    renderAll(makeSettings(), "https://openai.com/research");
    expect(text("siteLocationLineStatus")).toBe("On openai.com: Dublin");

    sendMessage.mockResolvedValue({ success: true, id: ENTRY_DUBLIN.id });
    // The reload loadSettings does: the site no longer matches.
    vi.mocked(loadSettings).mockImplementationOnce(() => {
      renderAll(
        makeSettings({ siteLocations: [ENTRY_MEXICO_CITY] }),
        "https://openai.com/research"
      );
      return Promise.resolve();
    });
    const useMain = byId("siteLocationLineUseMain");
    useMain.focus();
    useMain.click();
    await flush();

    expect(messagesOfType("REMOVE_SITE_LOCATION")).toEqual([
      { id: ENTRY_DUBLIN.id, pattern: "openai.com" },
    ]);
    expect(loadSettings).toHaveBeenCalled();

    // Only the reload hint shows, and only here (not in the Filters disclosure).
    expect(isShown("siteLocationLine")).toBe(true);
    expect(isShown("siteLocationLineMain")).toBe(false);
    expect(isShown("siteLocationLineReloadHint")).toBe(true);
    // The announcer is the one live region; the hint itself has no role, so
    // revealing it can't add a second reading.
    expect(byId("siteLocationLineReloadHint").hasAttribute("role")).toBe(false);
    expect(byId("siteLocationAnnouncer").getAttribute("role")).toBe("status");
    expect(byId("siteLocationsReloadHint").hidden).toBe(true);

    // The pressed button is gone, so focus moves to the confirmation: it's
    // read out, and Tab continues from there. Script-only, not a tab stop.
    expect(isShown("siteLocationLineUseMain")).toBe(false);
    expect(document.activeElement).toBe(byId("siteLocationLineReloadHint"));
    expect(byId("siteLocationLineReloadHint").getAttribute("tabindex")).toBe("-1");
  });

  // "Use main location" removes only the winning pattern, so it shows only
  // when that leaves exactly this site on the main location. Edit always shows.
  describe("'Use main location' shows only when it gives just this site the main location", () => {
    const rule = (id: string, patterns: string[], place = ENTRY_MEXICO_CITY): SiteLocation => ({
      ...place,
      id,
      patterns,
    });

    test.each<[string, SiteLocation[], string, boolean]>([
      ["an exact-host rule", [ENTRY_MEXICO_CITY], "https://twitch.tv/x", true],
      ["the suggested rule on www.", [ENTRY_MEXICO_CITY], "https://www.twitch.tv/x", true],
      ["one site of a multi-site entry", [ENTRY_DUBLIN], "https://openai.com/", true],
      ["a Unicode spelling of this host", [rule("a", ["münchen.de"])], "https://münchen.de/", true],
      [
        "a broader rule in another entry left matching",
        [rule("a", ["foo.example.com"], ENTRY_DUBLIN), rule("b", ["example.com"])],
        "https://foo.example.com/",
        false,
      ],
      [
        "a broader rule in the same entry left matching",
        [rule("a", ["foo.example.com", "example.com"])],
        "https://foo.example.com/",
        false,
      ],
      ["a wildcard rule like *.ru", [rule("a", ["*.ru"])], "https://yandex.ru/", false],
      ["a parent-domain rule", [rule("a", ["example.com"])], "https://a.b.example.com/", false],
      ["a subdomain wildcard", [rule("a", ["*.example.com"])], "https://www.example.com/", false],
    ])("%s", (_name, siteLocations, url, shown) => {
      renderSiteLocationLine(makeSettings({ siteLocations }), url, false);
      expect(isShown("siteLocationLineMain")).toBe(true);
      expect(isShown("siteLocationLineEdit")).toBe(true);
      expect(isShown("siteLocationLineUseMain")).toBe(shown);
    });

    test("where it's hidden, it sends nothing", async () => {
      renderSiteLocationLine(
        makeSettings({ siteLocations: [rule("a", ["*.ru"])] }),
        "https://yandex.ru/",
        false
      );
      byId("siteLocationLineUseMain").click();
      await flush();
      expect(messagesOfType("REMOVE_SITE_LOCATION")).toEqual([]);
    });

    // Removing the rule would leave the site unspoofed, not on a main location.
    test("hidden with no main location set, even for this site's own rule", async () => {
      renderSiteLocationLine(
        makeSettings({
          location: null,
          timezone: null,
          locationName: null,
          siteLocations: [ENTRY_MEXICO_CITY],
        }),
        "https://twitch.tv/x",
        false
      );
      expect(isShown("siteLocationLineMain")).toBe(true);
      expect(isShown("siteLocationLineEdit")).toBe(true);
      expect(isShown("siteLocationLineUseMain")).toBe(false);

      byId("siteLocationLineUseMain").click();
      await flush();
      expect(messagesOfType("REMOVE_SITE_LOCATION")).toEqual([]);
    });

    test("a later render shows it again where it applies", () => {
      renderSiteLocationLine(
        makeSettings({ siteLocations: [rule("a", ["*.ru"])] }),
        "https://yandex.ru/",
        false
      );
      renderSiteLocationLine(makeSettings(), "https://twitch.tv/", false);
      expect(isShown("siteLocationLineUseMain")).toBe(true);
    });
  });

  test("a failed 'Use main location' shows an alert and doesn't reload", async () => {
    renderSiteLocationLine(makeSettings(), "https://twitch.tv/", false);
    sendMessage.mockResolvedValue({ error: "STORAGE_ERROR" });
    byId("siteLocationLineUseMain").click();
    await flush();
    expect(isShown("siteLocationLineError")).toBe(true);
    expect(byId("siteLocationLineError").getAttribute("role")).toBe("alert");
    expect(text("siteLocationLineError")).toBe("⚠ Change not saved");
    expect(loadSettings).not.toHaveBeenCalled();
  });

  test("'Edit' switches to Filters and opens that entry, with '‹ Main' back to the line", () => {
    renderAll(makeSettings(), "https://chatgpt.com/c/1");
    // Stand in for index.ts's tab handlers. Focus landing in the editor below
    // also proves the tab switch happens before the editor opens.
    const onFiltersTab = vi.fn(showFiltersView);
    byId("filtersTab").addEventListener("click", onFiltersTab);
    const toMain = wireMainTab();

    byId("siteLocationLineEdit").click();

    expect(onFiltersTab).toHaveBeenCalledTimes(1);
    expect(shownScreens()).toEqual(["siteLocationEditorScreen"]);
    expect(isShown("siteLocationEditor")).toBe(true);
    expect(text("siteLocationEditorTitle")).toBe("Per-site location");
    expect(editorBackLabel()).toBe("Main");
    expect(chipTitles()).toEqual(["chatgpt.com", "openai.com"]);
    expect(byId<HTMLInputElement>("siteLocationPatterns").value).toBe("");
    expect(chosenName()).toBe("Dublin");
    // An existing entry: focus on the screen's title.
    expect(document.activeElement).toBe(byId("siteLocationEditorTitle"));

    // Cancel returns to the Main tab, with focus on Edit; Filters is back on its root.
    byId("siteLocationCancel").click();
    expect(toMain).toHaveBeenCalledTimes(1);
    expect(shownScreens()).toEqual(["filtersRoot"]);
    expect(document.activeElement).toBe(byId("siteLocationLineEdit"));
  });

  test.each<[string, () => void]>([
    [
      "Escape",
      () => {
        byId("siteLocationEditorTitle").dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
      },
    ],
    ["the back row", () => byId("siteLocationEditorBack").click()],
  ])("%s returns an editor opened from Main to Main too", (_name, back) => {
    renderAll(makeSettings(), "https://chatgpt.com/c/1");
    byId("filtersTab").addEventListener("click", showFiltersView);
    const toMain = wireMainTab();
    byId("siteLocationLineEdit").click();
    back();
    expect(toMain).toHaveBeenCalledTimes(1);
    expect(isShown("siteLocationEditor")).toBe(false);
    expect(document.activeElement).toBe(byId("siteLocationLineEdit"));
  });

  test("renderSiteLocations renders every surface for the tab it's given", () => {
    expect(renderSiteLocations(makeSettings(), false, "https://twitch.tv/x")).toBe(true);
    // loadSettings reads the tab once; this module doesn't.
    expect(browser.tabs.query).not.toHaveBeenCalled();
    expect(text("siteLocationLineStatus")).toBe("On twitch.tv: Mexico City");
    expect(text("detailSiteLocation")).toBe("Mexico City (twitch.tv) · America/Mexico_City");
    expect(text("siteLocationsRowValue")).toBe("2");
    expect(text("siteLocationsRowDesc")).toBe("2 locations");

    expect(renderSiteLocations(makeSettings(), false, "https://example.com/")).toBe(false);
    expect(byId("siteLocationLine").hidden).toBe(true);
    expect(byId("detailSiteLocationSection").hidden).toBe(true);
  });
});

describe("Filters root: the Per-site locations row", () => {
  test("shares one card with the list's row, after it, at the end of the root", () => {
    const card = byId("siteLocationsCard");
    expect(card.parentElement).toBe(byId("filtersRootRows"));
    expect(card.parentElement).toBe(byId("scopeListCard").parentElement);
    expect(byId("filtersRoot").lastElementChild).toBe(byId("filtersRootRows"));
    expect(byId("scopeListCard").compareDocumentPosition(card)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(byId("siteLocationsRow").getAttribute("role")).toBe("button");
    expect(byId("siteLocationsRow").getAttribute("tabindex")).toBe("0");
  });

  test.each<[string, SiteLocation[], string, string]>([
    ["no entries", [], "0", "None"],
    ["one entry", [ENTRY_DUBLIN], "1", "1 location"],
    ["two entries", [ENTRY_DUBLIN, ENTRY_MEXICO_CITY], "2", "2 locations"],
  ])("with %s it reads '%s', described as '%s'", (_name, siteLocations, value, words) => {
    renderSiteLocationsSection(makeSettings({ siteLocations }), undefined, false);
    expect(text("siteLocationsRow").replace(/\s+/g, " ")).toBe(`Per-site locations ${value} ›`);
    expect(text("siteLocationsRowValue")).toBe(value);
    expect(byId("siteLocationsRow").getAttribute("aria-describedby")).toBe("siteLocationsRowDesc");
    expect(text("siteLocationsRowDesc")).toBe(words);
    expect(byId("siteLocationsRowChev").getAttribute("aria-hidden")).toBe("true");
    expect(byId("siteLocationsRow").hasAttribute("aria-disabled")).toBe(false);
  });

  test("opens the Per-site locations screen with focus on its title; back returns to the row", () => {
    showFiltersView();
    renderAll(makeSettings(), "https://example.com/");
    const row = byId("siteLocationsRow");
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(shownScreens()).toEqual(["siteLocationsScreen"]);
    expect(document.activeElement).toBe(byId("siteLocationsTitle"));
    expect(text("siteLocationsTitle")).toBe("Per-site locations");

    byId("siteLocationsBack").click();
    expect(shownScreens()).toEqual(["filtersRoot"]);
    expect(document.activeElement).toBe(row);
  });

  test("locked (Safari without Pro): focusable, described by the Pro note, and inert (H-8)", () => {
    showFiltersView();
    renderAll(makeSettings(), "https://example.com/", true);
    const row = byId("siteLocationsRow");
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.getAttribute("aria-describedby")).toBe("siteLocationsRowDesc scopeProNote");
    expect(text("siteLocationsRowChev")).toBe("🔒");
    expect(text("siteLocationsRowValue")).toBe("2");

    row.click();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(shownScreens()).toEqual(["filtersRoot"]);

    // Unlocked again, it opens.
    renderAll(makeSettings(), "https://example.com/", false);
    expect(row.hasAttribute("aria-disabled")).toBe(false);
    expect(row.getAttribute("aria-describedby")).toBe("siteLocationsRowDesc");
    expect(text("siteLocationsRowChev")).toBe("›");
    row.click();
    expect(shownScreens()).toEqual(["siteLocationsScreen"]);
  });
});

describe("the Per-site locations screen", () => {
  /** Scenario S (direction.md 5.0): Allowlist, Paris on example.com, Los Angeles on twitch.tv. */
  const PARIS = makeSiteLocation({
    id: "paris",
    patterns: ["example.com"],
    locationName: { city: "Paris", country: "France", displayName: "Paris, France" },
  });
  const LOS_ANGELES = makeSiteLocation({
    id: "la",
    patterns: ["twitch.tv"],
    location: MEXICO_CITY,
    timezone: MEXICO_CITY_TZ,
    locationName: { ...MEXICO_CITY_NAME, city: "Los Angeles", displayName: "Los Angeles" },
  });
  const SCENARIO_S: Partial<Settings> = {
    scopeMode: "allowlist",
    allowlist: ["example.com", "=mail.example.com", GOOGLE_TOKEN, "*.ru"],
    siteLocations: [PARIS, LOS_ANGELES],
  };

  function rowTexts(): Array<{ host: string; value: string; sub: string | null }> {
    return Array.from(byId("siteLocationsList").querySelectorAll(".site-row")).map((row) => ({
      host: row.querySelector(".site-row-host")?.textContent ?? "",
      value: row.querySelector(".site-row-value")?.textContent ?? "",
      sub: row.querySelector(".site-row-sub")?.textContent ?? null,
    }));
  }

  function markOf(id: string): Element | null {
    return siteRow(id).querySelector(".site-row-sub");
  }

  test("a title, the caption, '＋ Set a location for …', then the list", () => {
    renderSiteLocationsSection(makeSettings(), "https://example.com/", false);
    const screen = byId("siteLocationsScreen");
    expect(screen.firstElementChild).toBe(byId("siteLocationsBack"));
    expect(text("siteLocationsBack").replace(/\s+/g, " ")).toBe("‹ Sites");
    expect(screen.querySelector(".view-caption")?.textContent?.trim()).toBe(
      "Use a different location on specific sites."
    );
    const add = byId("siteLocationsAddButton");
    expect(add.classList.contains("primary-add")).toBe(true);
    expect(add.querySelector(".primary-add-plus")?.getAttribute("aria-hidden")).toBe("true");
    expect(add.compareDocumentPosition(byId("siteLocationsList"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  test("each entry is one site row: its sites, its place and a ›; no ✕ and no badge", () => {
    renderSiteLocationsSection(makeSettings(), undefined, false);
    const items = byId("siteLocationsList").querySelectorAll('[role="listitem"]');
    expect(items).toHaveLength(2);
    expect(rowTexts()).toEqual([
      { host: "chatgpt.com, openai.com", value: "Dublin", sub: null },
      { host: "twitch.tv", value: "Mexico City", sub: null },
    ]);
    const row = siteRow(ENTRY_DUBLIN.id);
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.querySelector(".site-row-host")?.innerHTML).toBe(
      "chatgpt.<wbr>com, openai.<wbr>com"
    );
    expect(row.querySelector(".site-row-trail")?.textContent).toBe("Dublin\u00A0›");
    // Its description says what opening does.
    const descId = row.getAttribute("aria-describedby")!;
    expect(document.getElementById(descId)?.textContent).toBe(
      "Change the location for chatgpt.com, openai.com"
    );
    expect(document.getElementById(descId)?.classList.contains("visually-hidden")).toBe(true);
    expect(byId("siteLocationsList").querySelector("button, .scope-site-icon")).toBeNull();
  });

  test("a row opens its entry in the editor, '‹ Per-site locations', focus on the title", () => {
    showFiltersView();
    renderAll(makeSettings(), "https://example.com/");
    byId("siteLocationsRow").click();
    const row = siteRow(ENTRY_DUBLIN.id);
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(shownScreens()).toEqual(["siteLocationEditorScreen"]);
    expect(text("siteLocationEditorTitle")).toBe("Per-site location");
    expect(editorBackLabel()).toBe("Per-site locations");
    expect(document.activeElement).toBe(byId("siteLocationEditorTitle"));
    expect(chipTitles()).toEqual(["chatgpt.com", "openai.com"]);
    expect(isShown("siteLocationRemove")).toBe(true);

    // Cancel, Escape and the back row each return to the screen, on the row.
    byId("siteLocationCancel").click();
    expect(shownScreens()).toEqual(["siteLocationsScreen"]);
    expect(document.activeElement).toBe(row);

    row.click();
    byId("siteLocationSearch").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    expect(shownScreens()).toEqual(["siteLocationsScreen"]);
    expect(document.activeElement).toBe(row);

    row.click();
    byId("siteLocationEditorBack").click();
    expect(shownScreens()).toEqual(["siteLocationsScreen"]);
    expect(document.activeElement).toBe(row);
  });

  describe("marks: when Filters keep a location from being used (M2, M13)", () => {
    test("Scenario S: twitch.tv isn't in the Allowlist, so 'Not used · Off in Sites'", async () => {
      const settings = makeSettings(SCENARIO_S);
      await loadGroups(settings);
      renderSiteLocationsSection(settings, "https://www.twitch.tv/", false);
      expect(rowTexts()).toEqual([
        { host: "example.com", value: "Paris", sub: null },
        { host: "twitch.tv", value: "Los Angeles", sub: "⚠ Not used · Off in Sites" },
      ]);
      const mark = markOf("la")!;
      expect(mark.classList.contains("warn")).toBe(true);
      expect(mark.querySelector("[aria-hidden='true']")?.textContent).toBe("⚠ ");
    });

    test("an entry with several sites names the ones that are off", () => {
      const both = makeSiteLocation({ id: "both", patterns: ["twitch.tv", "kick.com"] });
      renderSiteLocationsSection(
        makeSettings({ scopeMode: "allowlist", allowlist: ["kick.com"], siteLocations: [both] }),
        undefined,
        false
      );
      expect(markOf("both")?.textContent).toBe("⚠ Not used on twitch.tv · Off in Sites");
    });

    test("more than two: the first two, then how many more", () => {
      const many = makeSiteLocation({
        id: "many",
        patterns: ["a.com", "b.com", "c.com", "d.com", "e.com"],
      });
      renderSiteLocationsSection(
        makeSettings({ scopeMode: "allowlist", allowlist: ["x.com"], siteLocations: [many] }),
        undefined,
        false
      );
      expect(markOf("many")?.textContent).toBe(
        "⚠ Not used on a.com, b.com and 3 more · Off in Sites"
      );
    });

    // M13: the group's sites do use the place, so the mark names twitch.tv only.
    test("a site group in the Allowlist keeps the entry in use; only twitch.tv is named", async () => {
      const mixed = makeSiteLocation({ id: "mixed", patterns: ["twitch.tv", GOOGLE_TOKEN] });
      const settings = makeSettings({
        scopeMode: "allowlist",
        allowlist: [GOOGLE_TOKEN],
        siteLocations: [mixed],
      });
      await loadGroups(settings);
      renderSiteLocationsSection(settings, undefined, false);
      expect(markOf("mixed")?.textContent).toBe("⚠ Not used on twitch.tv · Off in Sites");
    });

    test("an Allowlist entry with a path covers only some pages", () => {
      renderSiteLocationsSection(
        makeSettings({
          scopeMode: "allowlist",
          allowlist: ["example.com/app/*"],
          siteLocations: [PARIS],
        }),
        undefined,
        false
      );
      expect(markOf("paris")?.textContent).toBe("⚠ Used on some pages only");
    });

    test("Denylist: a listed site is not used, a listed path is some pages, the rest none", () => {
      renderSiteLocationsSection(
        makeSettings({
          scopeMode: "denylist",
          denylist: ["twitch.tv", "example.com/app/*"],
          siteLocations: [PARIS, LOS_ANGELES, ENTRY_DUBLIN],
        }),
        undefined,
        false
      );
      expect(markOf("la")?.textContent).toBe("⚠ Not used · Off in Sites");
      expect(markOf("paris")?.textContent).toBe("⚠ Used on some pages only");
      expect(markOf(ENTRY_DUBLIN.id)).toBeNull();
    });

    test("All sites mode marks nothing, and only the active list counts", () => {
      renderSiteLocationsSection(
        makeSettings({ scopeMode: "all", allowlist: [], siteLocations: [PARIS, LOS_ANGELES] }),
        undefined,
        false
      );
      expect(rowTexts().map((row) => row.sub)).toEqual([null, null]);

      renderSiteLocationsSection(
        makeSettings({
          scopeMode: "denylist",
          denylist: [],
          allowlist: [],
          siteLocations: [PARIS, LOS_ANGELES],
        }),
        undefined,
        false
      );
      expect(rowTexts().map((row) => row.sub)).toEqual([null, null]);
    });
  });

  describe("'＋ Set a location for <site>'", () => {
    test("names this site, without www., when it has no entry of its own", () => {
      showFiltersView();
      renderAll(makeSettings({ siteLocations: [ENTRY_DUBLIN] }), "https://www.twitch.tv/x");
      expect(text("siteLocationsAddLabel")).toBe("Set a location for twitch.tv");

      byId("siteLocationsAddButton").click();
      expect(shownScreens()).toEqual(["siteLocationEditorScreen"]);
      expect(text("siteLocationEditorTitle")).toBe("New per-site location");
      expect(editorBackLabel()).toBe("Per-site locations");
      expect(chipTitles()).toEqual(["twitch.tv"]);
      expect(isShown("siteLocationRemove")).toBe(false);
      // The site is there, so the place is what's left (S6).
      expect(document.activeElement).toBe(byId("siteLocationSearch"));
    });

    test.each<[string, Partial<Settings>, string]>([
      ["the site already has an entry", {}, "https://twitch.tv/"],
      ["a restricted page", {}, "about:blank"],
      ["the options page", {}, "moz-extension://test/popup/popup.html"],
    ])("is generic when %s, and opens with no sites", (_name, overrides, url) => {
      showFiltersView();
      renderAll(makeSettings(overrides), url);
      expect(text("siteLocationsAddLabel")).toBe("Set a location for a site");
      byId("siteLocationsAddButton").click();
      expect(chipTitles()).toEqual([]);
      expect(document.activeElement).toBe(byId("siteLocationPatterns"));
    });
  });
});

describe("Editor: Remove", () => {
  const RELOAD = "Reload affected pages to apply the change.";

  async function announced(): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return text("siteLocationAnnouncer");
  }

  function openRow(id: string, url = "https://example.com/"): void {
    showFiltersView();
    renderAll(makeSettings(), url);
    byId("siteLocationsRow").click();
    siteRow(id).click();
  }

  test("removes the entry, returns to Per-site locations, and focuses the reload hint", async () => {
    openRow(ENTRY_DUBLIN.id);
    const remove = byId("siteLocationRemove");
    expect(remove.textContent?.trim()).toBe("Remove location");
    expect(byId("siteLocationEditor").lastElementChild).toBe(remove);

    sendMessage.mockResolvedValue({ success: true, id: ENTRY_DUBLIN.id });
    vi.mocked(loadSettings).mockImplementationOnce(() => {
      renderAll(makeSettings({ siteLocations: [ENTRY_MEXICO_CITY] }), "https://example.com/");
      return Promise.resolve();
    });
    remove.focus();
    remove.click();
    await flush();

    expect(messagesOfType("REMOVE_SITE_LOCATION")).toEqual([{ id: ENTRY_DUBLIN.id }]);
    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(shownScreens()).toEqual(["siteLocationsScreen"]);
    expect(isShown("siteLocationsReloadHint")).toBe(true);
    expect(document.activeElement).toBe(byId("siteLocationsReloadHint"));
    expect(await announced()).toBe(RELOAD);
  });

  test("a failed remove keeps the editor and focus, and says the change wasn't saved", async () => {
    openRow(ENTRY_DUBLIN.id);
    const remove = byId("siteLocationRemove");
    sendMessage.mockResolvedValue({ error: "STORAGE_ERROR" });
    remove.focus();
    remove.click();
    await flush();
    expect(shownScreens()).toEqual(["siteLocationEditorScreen"]);
    expect(text("siteLocationErrorText")).toBe("⚠ Change not saved");
    expect(document.activeElement).toBe(remove);
    expect(remove.hasAttribute("aria-disabled")).toBe(false);
    expect(loadSettings).not.toHaveBeenCalled();
    expect(await announced()).toBe("");
  });

  test("while it's in flight a second press sends nothing, and Remove keeps focus", async () => {
    openRow(ENTRY_DUBLIN.id);
    const remove = byId<HTMLButtonElement>("siteLocationRemove");
    let finish: (reply: unknown) => void = () => {};
    sendMessage.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    remove.focus();
    remove.click();
    remove.click();
    expect(messagesOfType("REMOVE_SITE_LOCATION")).toHaveLength(1);
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(remove.disabled).toBe(false);
    expect(document.activeElement).toBe(remove);
    finish({ success: true, id: ENTRY_DUBLIN.id });
    await flush();
    expect(remove.hasAttribute("aria-disabled")).toBe(false);
  });

  test("from Main, it returns to Main with the line's reload hint", async () => {
    renderAll(makeSettings(), "https://twitch.tv/");
    byId("filtersTab").addEventListener("click", showFiltersView);
    const toMain = wireMainTab();
    byId("siteLocationLineEdit").click();
    sendMessage.mockResolvedValue({ success: true, id: ENTRY_MEXICO_CITY.id });
    vi.mocked(loadSettings).mockImplementationOnce(() => {
      renderAll(makeSettings({ siteLocations: [ENTRY_DUBLIN] }), "https://twitch.tv/");
      return Promise.resolve();
    });
    byId("siteLocationRemove").click();
    await flush();
    expect(toMain).toHaveBeenCalledTimes(1);
    expect(isShown("siteLocationLineReloadHint")).toBe(true);
    expect(document.activeElement).toBe(byId("siteLocationLineReloadHint"));
    expect(isShown("siteLocationsReloadHint")).toBe(false);
  });

  test("a new entry has no Remove", () => {
    showFiltersView();
    renderAll(makeSettings(), "https://example.com/");
    byId("siteLocationsAddButton").click();
    expect(isShown("siteLocationRemove")).toBe(false);
  });
});

describe("Editor: Save returns to where it was opened from", () => {
  test("from a row: back on Per-site locations, focus on the entry's new row, the reload hint", async () => {
    showFiltersView();
    renderAll(makeSettings(), "https://example.com/");
    byId("siteLocationsRow").click();
    siteRow(ENTRY_DUBLIN.id).click();
    chipRemoveButton("openai.com").click();
    sendMessage.mockResolvedValue({ success: true, id: ENTRY_DUBLIN.id });
    // The reload rebuilds the list, so the row that opened the editor is gone.
    vi.mocked(loadSettings).mockImplementationOnce(() => {
      renderAll(
        makeSettings({
          siteLocations: [{ ...ENTRY_DUBLIN, patterns: ["chatgpt.com"] }, ENTRY_MEXICO_CITY],
        }),
        "https://example.com/"
      );
      return Promise.resolve();
    });
    saveButton().click();
    await flush();
    expect(shownScreens()).toEqual(["siteLocationsScreen"]);
    expect(isShown("siteLocationsReloadHint")).toBe(true);
    expect(document.activeElement).toBe(siteRow(ENTRY_DUBLIN.id));
  });

  test("from Main: back on the Main tab, with the line's reload hint", async () => {
    renderAll(makeSettings(), "https://twitch.tv/");
    byId("filtersTab").addEventListener("click", showFiltersView);
    const toMain = wireMainTab();
    byId("siteLocationLineEdit").click();
    pickFavoriteAfterClearing();
    sendMessage.mockResolvedValue({ success: true, id: ENTRY_MEXICO_CITY.id });
    vi.mocked(loadSettings).mockImplementationOnce(() => {
      renderAll(makeSettings(), "https://twitch.tv/");
      return Promise.resolve();
    });
    saveButton().click();
    await flush();
    expect(toMain).toHaveBeenCalledTimes(1);
    expect(shownScreens()).toEqual(["filtersRoot"]);
    expect(isShown("siteLocationLineReloadHint")).toBe(true);
    expect(isShown("siteLocationsReloadHint")).toBe(false);
    // The line still applies, so focus is back on its Edit.
    expect(document.activeElement).toBe(byId("siteLocationLineEdit"));
  });

  /** Swap the existing entry's place for the favorite. */
  function pickFavoriteAfterClearing(): void {
    chosenRemoveButton().click();
    pickFavorite(FAVORITE.id);
  }
});

describe("Safari Pro lock", () => {
  test("nothing on Main or Details, and the root's row is locked", () => {
    expect(renderSiteLocations(makeSettings(), true, "https://twitch.tv/")).toBe(false);
    expect(byId("siteLocationLine").hidden).toBe(true);
    expect(byId("detailSiteLocationSection").hidden).toBe(true);
    expect(byId("siteLocationsRow").getAttribute("aria-disabled")).toBe("true");
    expect(byId<HTMLButtonElement>("siteLocationsAddButton").disabled).toBe(true);

    byId("siteLocationsAddButton").click();
    expect(isShown("siteLocationEditor")).toBe(false);
  });

  test("locking closes an open editor and leaves the Per-site locations screen", () => {
    showFiltersView();
    renderAll(makeSettings(), "https://example.com/");
    byId("siteLocationsRow").click();
    byId("siteLocationsAddButton").click();
    expect(isShown("siteLocationEditor")).toBe(true);
    renderAll(makeSettings(), "https://example.com/", true);
    expect(isShown("siteLocationEditor")).toBe(false);
    expect(shownScreens()).toEqual(["filtersRoot"]);
  });
});

describe("Editor", () => {
  function openFromAdd(url = "https://www.example.com/page", settings = makeSettings()): void {
    showFiltersView();
    renderAll(settings, url);
    byId("siteLocationsAddButton").click();
  }

  test("pre-fills the current site without www. as a chip, and is editable", () => {
    openFromAdd();
    const input = byId<HTMLInputElement>("siteLocationPatterns");
    expect(isShown("siteLocationEditor")).toBe(true);
    expect(byId("siteLocationEditorScreen").contains(byId("siteLocationEditor"))).toBe(true);
    expect(chipTitles()).toEqual(["example.com"]);
    expect(input.value).toBe("");
    expect(input.readOnly).toBe(false);
    // The site is there, so the place is what's left to pick (S6).
    expect(document.activeElement).toBe(byId("siteLocationSearch"));

    setPatterns("example.com, example.org");
    pickFavorite(FAVORITE.id);
    expect(chosenName()).toBe("Work");
    expect(text("siteLocationExplain")).toContain("example.com, example.org");
    expect(text("siteLocationExplain")).toContain("Work");
  });

  // Per-site locations work without a main location, and some embedded content
  // can't be reached, so the summary promises neither.
  test("the summary says only which place the sites will see", () => {
    openFromAdd(
      "https://www.example.com/page",
      makeSettings({ location: null, timezone: null, locationName: null })
    );
    pickFavorite(FAVORITE.id);
    const en = (
      JSON.parse(readFileSync("_locales/en/messages.json", "utf8")) as Record<
        string,
        { message: string }
      >
    ).siteLocation_explain.message;

    expect(text("siteLocationExplain")).toBe("Pages on example.com will see Work.");
    expect(en.replace("$SITES$", "example.com").replace("$PLACE$", "Work")).toBe(
      text("siteLocationExplain")
    );
    expect(text("siteLocationExplain")).not.toMatch(/main location|embedded/i);
  });

  test("the editor is a screen of its own; Cancel returns to Per-site locations and the button", () => {
    openFromAdd();
    expect(shownScreens()).toEqual(["siteLocationEditorScreen"]);
    expect(isShown("siteLocationsAddButton")).toBe(false);
    byId("siteLocationCancel").click();
    expect(isShown("siteLocationEditor")).toBe(false);
    expect(shownScreens()).toEqual(["siteLocationsScreen"]);
    expect(document.activeElement).toBe(byId("siteLocationsAddButton"));
  });

  test("Escape closes the editor too", () => {
    openFromAdd();
    byId("siteLocationPatterns").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    expect(isShown("siteLocationEditor")).toBe(false);
    expect(document.activeElement).toBe(byId("siteLocationsAddButton"));
  });

  test("an invalid pattern blocks the send", async () => {
    openFromAdd();
    pickFavorite(FAVORITE.id);
    setPatterns("example.com/app");
    byId("siteLocationSave").click();
    await flush();

    expect(messagesOfType("SAVE_SITE_LOCATION")).toEqual([]);
    expect(isShown("siteLocationError")).toBe(true);
    expect(text("siteLocationErrorText")).toContain("example.com");
    expect(byId("siteLocationPatterns").getAttribute("aria-invalid")).toBe("true");

    setPatterns("*");
    byId("siteLocationSave").click();
    await flush();
    expect(messagesOfType("SAVE_SITE_LOCATION")).toEqual([]);

    // A host with no A-label form never matches, so the background rejects it.
    setPatterns("xn--zz.com");
    byId("siteLocationSave").click();
    await flush();
    expect(messagesOfType("SAVE_SITE_LOCATION")).toEqual([]);
    expect(isShown("siteLocationError")).toBe(true);
  });

  describe("two spellings of one host count once, as the background counts them", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `site${i}.com`);

    test("ten sites plus an alias is at the cap, and sends the first spelling", async () => {
      openFromAdd();
      pickFavorite(FAVORITE.id);
      replaceSites([...nine, "münchen.de", "xn--mnchen-3ya.de"].join(", "));
      sendMessage.mockResolvedValue({ success: true, id: "new" });
      byId("siteLocationSave").click();
      await flush();

      const [payload] = messagesOfType("SAVE_SITE_LOCATION") as Array<{ patterns: string[] }>;
      expect(payload?.patterns).toEqual([...nine, "münchen.de"]);
      expect(isShown("siteLocationError")).toBe(false);
    });

    test("eleven sites plus an alias is still over the cap", async () => {
      openFromAdd();
      pickFavorite(FAVORITE.id);
      replaceSites([...nine, "other.com", "xn--mnchen-3ya.de", "münchen.de"].join(", "));
      byId("siteLocationSave").click();
      await flush();

      expect(messagesOfType("SAVE_SITE_LOCATION")).toEqual([]);
      expect(text("siteLocationErrorText")).toBe("One location can cover up to 10 sites.");
    });
  });

  test("no location chosen: Save is off and sends nothing", async () => {
    openFromAdd();
    expect(saveButton().disabled).toBe(true);
    saveButton().click();
    await flush();
    expect(messagesOfType("SAVE_SITE_LOCATION")).toEqual([]);
  });

  test("a successful save sends the payload, closes, reloads, and shows the reload hint", async () => {
    openFromAdd();
    pickFavorite(FAVORITE.id);
    sendMessage.mockResolvedValue({ success: true, id: "new" });
    byId("siteLocationSave").click();
    await flush();

    expect(messagesOfType("SAVE_SITE_LOCATION")).toEqual([
      {
        patterns: ["example.com"],
        latitude: FAVORITE.latitude,
        longitude: FAVORITE.longitude,
        locationName: { city: "Paris", country: "France", displayName: "Paris, France" },
        label: "Work",
      },
    ]);
    expect(isShown("siteLocationEditor")).toBe(false);
    expect(loadSettings).toHaveBeenCalled();
    expect(document.activeElement).toBe(byId("siteLocationsAddButton"));

    renderAll(makeSettings(), "https://www.example.com/page");
    expect(isShown("siteLocationsReloadHint")).toBe(true);
    expect(byId("siteLocationLineReloadHint").hidden).toBe(true);
  });

  test("a pattern-only edit keeps the stored place (no locationName or label sent)", async () => {
    renderSiteLocationsSection(makeSettings(), "https://example.com/", false);
    siteRow(ENTRY_DUBLIN.id).click();
    chipRemoveButton("openai.com").click();
    sendMessage.mockResolvedValue({ success: true, id: ENTRY_DUBLIN.id });
    byId("siteLocationSave").click();
    await flush();
    expect(messagesOfType("SAVE_SITE_LOCATION")).toEqual([
      {
        id: ENTRY_DUBLIN.id,
        patterns: ["chatgpt.com"],
        latitude: ENTRY_DUBLIN.location.latitude,
        longitude: ENTRY_DUBLIN.location.longitude,
      },
    ]);
  });

  test("PATTERN_IN_USE names the owner and offers 'Edit that one'", async () => {
    openFromAdd();
    pickFavorite(FAVORITE.id);
    setPatterns("example.com, twitch.tv");
    sendMessage.mockResolvedValue({
      error: "PATTERN_IN_USE",
      pattern: "twitch.tv",
      ownerId: ENTRY_MEXICO_CITY.id,
    });
    byId("siteLocationSave").click();
    await flush();

    expect(text("siteLocationErrorText")).toBe("twitch.tv already uses Mexico City.");
    expect(isShown("siteLocationEditOwner")).toBe(true);

    byId("siteLocationEditOwner").click();
    expect(chipTitles()).toEqual(["twitch.tv"]);
    expect(byId<HTMLInputElement>("siteLocationPatterns").value).toBe("");
    expect(chosenName()).toBe("Mexico City");
    expect(isShown("siteLocationError")).toBe(false);
  });

  test.each([
    ["AT_CAPACITY", "You can have up to 50 locations here. Remove one first."],
    ["TOO_MANY_PATTERNS", "One location can cover up to 10 sites."],
    [
      "TIMEZONE_UNAVAILABLE",
      "Couldn't look up this place's time zone. Check your connection and try again.",
    ],
    ["STORAGE_ERROR", "⚠ Change not saved"],
  ])("maps %s to its message", async (error, message) => {
    openFromAdd();
    pickFavorite(FAVORITE.id);
    sendMessage.mockResolvedValue({ error });
    byId("siteLocationSave").click();
    await flush();
    expect(text("siteLocationErrorText")).toBe(message);
    expect(isShown("siteLocationEditOwner")).toBe(false);
    expect(isShown("siteLocationEditor")).toBe(true);
  });

  // The payload is built when Save is pressed and the message can't be called
  // back, so nothing in the editor may look like it changes the save.
  describe("while a save is in flight", () => {
    const CONTROLS = [
      "siteLocationPatterns",
      "siteLocationAddEntry",
      "siteLocationSearch",
      "siteLocationFiltersAction",
      "siteLocationEditOwner",
      "siteLocationSave",
      "siteLocationCancel",
      "siteLocationRemove",
    ];
    const BERLIN = {
      name: "Berlin, Germany",
      latitude: 52.52,
      longitude: 13.405,
      city: "Berlin",
      country: "DE",
    };

    /** Hold SAVE_SITE_LOCATION and GEOCODE_QUERY replies until released; anything else succeeds. */
    function holdReplies(): { save: (reply: unknown) => void; geocode: (reply: unknown) => void } {
      const pending: Record<string, (reply: unknown) => void> = {};
      sendMessage.mockImplementation((message: unknown) => {
        const { type } = message as { type: string };
        if (type === "SAVE_SITE_LOCATION" || type === "GEOCODE_QUERY") {
          return new Promise((resolve) => {
            pending[type] = resolve;
          });
        }
        return Promise.resolve({ success: true, id: "other" });
      });
      return {
        save: (reply) => pending.SAVE_SITE_LOCATION?.(reply),
        geocode: (reply) => pending.GEOCODE_QUERY?.(reply),
      };
    }

    function disabledControls(): string[] {
      return CONTROLS.filter((id) => byId<HTMLInputElement>(id).disabled);
    }

    async function announced(): Promise<string> {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return text("siteLocationAnnouncer");
    }

    const RELOAD_EN = (
      JSON.parse(readFileSync("_locales/en/messages.json", "utf8")) as Record<
        string,
        { message: string }
      >
    ).siteLocation_reloadHint.message;

    test.each<[string, () => void]>([
      ["Cancel", () => byId("siteLocationCancel").click()],
      [
        "Escape",
        () =>
          byId("siteLocationPatterns").dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
          ),
      ],
    ])("%s waits for it, then the save takes its normal path", async (_name, dismiss) => {
      openFromAdd();
      pickFavorite(FAVORITE.id);
      const held = holdReplies();
      byId("siteLocationSave").click();
      await flush();
      expect(byId("siteLocationEditor").getAttribute("aria-busy")).toBe("true");

      dismiss();
      expect(isShown("siteLocationEditor")).toBe(true);

      held.save({ success: true, id: "new" });
      await flush();
      expect(isShown("siteLocationEditor")).toBe(false);
      expect(byId("siteLocationEditor").hasAttribute("aria-busy")).toBe(false);
      expect(loadSettings).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(byId("siteLocationsAddButton"));
      expect(await announced()).toBe(RELOAD_EN);
    });

    test("every control is disabled, and nothing chosen meanwhile changes the save", async () => {
      openFromAdd();
      pickFavorite(FAVORITE.id);
      const held = holdReplies();
      const search = byId<HTMLInputElement>("siteLocationSearch");
      search.value = "Berlin";
      search.dispatchEvent(new Event("input"));
      // Past the search debounce: the query is sent, its reply held.
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(messagesOfType("GEOCODE_QUERY")).toEqual([{ query: "Berlin" }]);

      byId("siteLocationSave").click();
      await flush();
      expect(disabledControls()).toEqual(CONTROLS);
      expect(chipRemoveButton("example.com").disabled).toBe(true);
      expect(chosenRemoveButton().disabled).toBe(true);

      // The search reply arrives: no result buttons appear.
      held.geocode({ results: [BERLIN] });
      await flush();
      expect(byId("siteLocationResults").querySelectorAll("button")).toHaveLength(0);
      // A result picked anyway, and Edit on another row, change nothing; with
      // a place chosen, no favorites are offered.
      renderSearchResults([BERLIN]);
      byId("siteLocationResults").querySelector("button")!.click();
      expect(byId("siteLocationFavoritesList").children).toHaveLength(0);
      chosenRemoveButton().click();
      siteRow(ENTRY_DUBLIN.id).click();
      expect(chosenName()).toBe("Work");
      expect(chipTitles()).toEqual(["example.com"]);

      held.save({ success: true, id: "new" });
      await flush();
      // Released; Save stays off in the closed editor, which has no site or
      // place until it opens again.
      expect(disabledControls()).toEqual(["siteLocationSave"]);
      expect(chosenRemoveButton().disabled).toBe(false);
      expect(messagesOfType("SAVE_SITE_LOCATION")).toHaveLength(1);
      expect(isShown("siteLocationEditor")).toBe(false);
    });

    test.each<[string, unknown, string]>([
      ["TIMEZONE_UNAVAILABLE", { error: "TIMEZONE_UNAVAILABLE" }, "siteLocationSave"],
      [
        "PATTERN_IN_USE",
        { error: "PATTERN_IN_USE", pattern: "example.com", ownerId: ENTRY_MEXICO_CITY.id },
        "siteLocationPatterns",
      ],
    ])("a %s failure releases the editor and puts focus back", async (_name, reply, focusId) => {
      openFromAdd();
      pickFavorite(FAVORITE.id);
      const held = holdReplies();
      const save = byId("siteLocationSave");
      save.focus();
      save.click();
      await flush();
      // A browser drops focus from a control that becomes disabled (jsdom
      // doesn't), leaving it on the page.
      const stand = document.body.appendChild(document.createElement("button"));
      stand.focus();
      stand.remove();
      expect(document.activeElement).toBe(document.body);

      held.save(reply);
      await flush();
      expect(disabledControls()).toEqual([]);
      expect(byId("siteLocationEditor").hasAttribute("aria-busy")).toBe(false);
      expect(isShown("siteLocationEditor")).toBe(true);
      expect(isShown("siteLocationError")).toBe(true);
      expect(document.activeElement).toBe(byId(focusId));
      expect(loadSettings).not.toHaveBeenCalled();
    });

    test("a failed send releases the editor too", async () => {
      openFromAdd();
      pickFavorite(FAVORITE.id);
      sendMessage.mockRejectedValue(new Error("disconnected"));
      byId("siteLocationSave").click();
      await flush();
      expect(disabledControls()).toEqual([]);
      expect(text("siteLocationErrorText")).toBe("⚠ Change not saved");
    });

    // A remove sent now would reach the background before the save, which
    // would then be refused as superseded.
    test("'Use main location' and the editor's Remove wait for a save of that entry", async () => {
      showFiltersView();
      renderAll(makeSettings(), "https://twitch.tv/");
      siteRow(ENTRY_MEXICO_CITY.id).click();
      const held = holdReplies();
      byId("siteLocationSave").click();
      await flush();

      const useMain = byId<HTMLButtonElement>("siteLocationLineUseMain");
      expect(isShown("siteLocationLineUseMain")).toBe(true);
      expect(useMain.disabled).toBe(true);
      expect(byId<HTMLButtonElement>("siteLocationRemove").disabled).toBe(true);

      // A re-render meanwhile keeps it off.
      renderAll(makeSettings(), "https://twitch.tv/");
      expect(useMain.disabled).toBe(true);

      // A dispatched click reaches the listener even on a disabled button.
      useMain.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      byId("siteLocationRemove").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
      expect(messagesOfType("REMOVE_SITE_LOCATION")).toEqual([]);

      held.save({ success: true, id: ENTRY_MEXICO_CITY.id });
      await flush();
      expect(useMain.disabled).toBe(false);
    });

    test("a save that lands after the Pro lock closed its editor still reloads and announces", async () => {
      showFiltersView();
      renderAll(makeSettings(), "https://example.com/");
      siteRow(ENTRY_DUBLIN.id).click();
      const held = holdReplies();
      byId("siteLocationSave").click();
      await flush();

      // The one thing left that can close the frozen editor.
      renderAll(makeSettings(), "https://example.com/", true);
      expect(isShown("siteLocationEditor")).toBe(false);

      held.save({ success: true, id: ENTRY_DUBLIN.id });
      await flush();
      expect(loadSettings).toHaveBeenCalledTimes(1);
      expect(disabledControls()).toEqual(["siteLocationSave"]);
      expect(await announced()).toBe(RELOAD_EN);
    });

    test("a save refused as superseded shows 'Change not saved' and stays open", async () => {
      openFromAdd();
      pickFavorite(FAVORITE.id);
      const held = holdReplies();
      byId("siteLocationSave").click();
      await flush();

      held.save({ error: "SUPERSEDED" });
      await flush();
      expect(isShown("siteLocationEditor")).toBe(true);
      expect(text("siteLocationErrorText")).toBe("⚠ Change not saved");
      expect(loadSettings).not.toHaveBeenCalled();
    });
  });

  test("search results are keyboard-operable buttons that set the location", () => {
    openFromAdd();
    renderSearchResults([
      {
        name: "Berlin, Germany",
        latitude: 52.52,
        longitude: 13.405,
        city: "Berlin",
        country: "DE",
      },
    ]);
    const results = byId("siteLocationResults").querySelectorAll("button");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("button");
    results[0].click();
    expect(chosenName()).toBe("Berlin, Germany");
    expect(byId("siteLocationResults").children).toHaveLength(0);
  });
});

describe("Editor: sites as chips, added through the shared add control", () => {
  const GROUP_ENTRY: SiteLocation = {
    ...ENTRY_DUBLIN,
    id: "group-entry",
    patterns: ["chatgpt.com", GOOGLE_TOKEN],
  };

  function openFromAdd(settings = makeSettings()): void {
    showFiltersView();
    renderAll(settings, "https://www.example.com/page");
    byId("siteLocationsAddButton").click();
  }

  function pressAdd(): void {
    byId("siteLocationAddEntry").click();
  }

  async function save(): Promise<string[] | undefined> {
    sendMessage.mockResolvedValue({ success: true, id: "new" });
    byId("siteLocationSave").click();
    await flush();
    const [payload] = messagesOfType("SAVE_SITE_LOCATION") as Array<{ patterns: string[] }>;
    return payload?.patterns;
  }

  test("a stored group shows as one chip with its name and size", async () => {
    const settings = makeSettings({ siteLocations: [GROUP_ENTRY] });
    await loadGroups(settings);
    renderAll(settings, "https://example.com/");
    siteRow(GROUP_ENTRY.id).click();

    expect(chipTitles()).toEqual(["chatgpt.com", "Google"]);
    const chip = chipRemoveButton("Google").closest(".entry-chip")!;
    expect(chip.getAttribute("role")).toBe("listitem");
    expect(chip.querySelector(".entry-chip-meta")?.textContent).toBe("Site group · 964 sites");
    expect(chip.getAttribute("title")).toBe(GOOGLE_TOKEN);
    expect(chipRemoveButton("Google").getAttribute("aria-label")).toBe("Remove site Google");
    expect(chipRemoveButton("Google").type).toBe("button");
    expect(byId("siteLocationEntries").getAttribute("role")).toBe("list");
    expect(byId("siteLocationEntries").getAttribute("aria-labelledby")).toBe(
      "siteLocationSitesLabel"
    );
    // The row names the group the same way.
    expect(siteRow(GROUP_ENTRY.id).querySelector(".site-row-host")?.textContent).toBe(
      "chatgpt.com, Google"
    );
  });

  test("a group without data shows 'Not available' with a warning sign, not colour alone", () => {
    const settings = makeSettings({ siteLocations: [GROUP_ENTRY] });
    renderAll(settings, "https://example.com/");
    siteRow(GROUP_ENTRY.id).click();
    const meta = chipRemoveButton("Google")
      .closest(".entry-chip")!
      .querySelector(".entry-chip-meta")!;
    expect(meta.classList.contains("warning")).toBe(true);
    expect(meta.textContent).toBe("⚠ Not available");
    expect(meta.querySelector("[aria-hidden='true']")?.textContent).toBe("⚠ ");
  });

  test("typing geosite: adds a site group, as a chip next to the typed site", async () => {
    openFromAdd();
    pickFavorite(FAVORITE.id);
    setPatterns("geosite:google");
    expect(byId("siteLocationPatterns").getAttribute("role")).toBe("combobox");
    pressAdd();
    await flush();

    expect(chipTitles()).toEqual(["example.com", "Google"]);
    expect(byId<HTMLInputElement>("siteLocationPatterns").value).toBe("");
    expect(byId("siteLocationGroupListbox").hidden).toBe(true);
    expect(text("siteLocationExplain")).toBe("Pages on example.com, Google will see Work.");
    expect(await save()).toEqual(["example.com", GOOGLE_TOKEN]);
  });

  test("a group or link added here isn't 'Not available' before Save builds its data", async () => {
    sendMessage.mockImplementation((message: unknown) =>
      Promise.resolve(
        (message as { type: string }).type === "GET_SITE_GROUP_INDEX"
          ? {
              release: "20261104112839",
              lists: [
                { name: "google", count: 964 },
                { name: "netflix", count: 30 },
              ],
            }
          : undefined
      )
    );
    await loadCatalogIndex();
    openFromAdd();
    for (const typed of [
      "geosite:netflix",
      "geosite:google@cn",
      "https://lists.example.org/rules/direct-list.txt",
    ]) {
      setPatterns(typed);
      pressAdd();
      await flush();
      await flush();
    }

    expect(chipTitles()).toEqual(["example.com", "Netflix", "Google @cn", "direct-list"]);
    const meta = (title: string) =>
      chipRemoveButton(title).closest(".entry-chip")!.querySelector(".entry-chip-meta");
    expect(meta("Netflix")?.textContent).toBe("Site group · 30 sites");
    expect(meta("Netflix")?.classList.contains("warning")).toBe(false);
    // A tag's count isn't in the index, and a link is downloaded on Save.
    expect(meta("Google @cn")).toBeNull();
    expect(meta("direct-list")).toBeNull();
  });

  test("Enter in the Sites input adds the typed sites as chips", async () => {
    openFromAdd();
    setPatterns("example.org, *.example.net, =mail.example.com");
    byId("siteLocationPatterns").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
    await flush();
    expect(chipTitles()).toEqual([
      "example.com",
      "example.org",
      "*.example.net",
      "mail.example.com",
    ]);
    expect(isShown("siteLocationEditor")).toBe(true);
  });

  test("a group counts once toward the 10-site cap", async () => {
    openFromAdd();
    pickFavorite(FAVORITE.id);
    replaceSites(Array.from({ length: 9 }, (_, i) => `site${i}.com`).join(", "));
    pressAdd();
    await flush();
    setPatterns(GOOGLE_TOKEN);
    pressAdd();
    await flush();
    expect(chipTitles()).toHaveLength(10);
    expect(isShown("siteLocationError")).toBe(false);

    // An eleventh is refused and stays in the input.
    setPatterns("one-more.com");
    pressAdd();
    await flush();
    expect(chipTitles()).toHaveLength(10);
    expect(text("siteLocationErrorText")).toBe("One location can cover up to 10 sites.");
    expect(byId<HTMLInputElement>("siteLocationPatterns").value).toBe("one-more.com");

    // Without it, the save carries the ten.
    setPatterns("");
    const sent = await save();
    expect(sent).toHaveLength(10);
    expect(sent).toContain(GOOGLE_TOKEN);
  });

  test("a site already there isn't added twice", async () => {
    openFromAdd();
    setPatterns("Example.com, xn--mnchen-3ya.de, münchen.de");
    pressAdd();
    await flush();
    expect(chipTitles()).toEqual(["example.com", "xn--mnchen-3ya.de"]);
  });

  test("removing a chip drops it from the save and moves focus to the next chip", async () => {
    const settings = makeSettings();
    showFiltersView();
    renderAll(settings, "https://example.com/");
    siteRow(ENTRY_DUBLIN.id).click();
    const remove = chipRemoveButton("chatgpt.com");
    remove.focus();
    remove.click();
    expect(chipTitles()).toEqual(["openai.com"]);
    expect(document.activeElement).toBe(chipRemoveButton("openai.com"));

    chipRemoveButton("openai.com").click();
    expect(chipTitles()).toEqual([]);
    expect(document.activeElement).toBe(byId("siteLocationPatterns"));

    // With no sites left, Save is off.
    expect(saveButton().disabled).toBe(true);
    saveButton().click();
    await flush();
    expect(messagesOfType("SAVE_SITE_LOCATION")).toEqual([]);
  });

  test("text left in the input is added on Save", async () => {
    openFromAdd();
    pickFavorite(FAVORITE.id);
    setPatterns("example.org, chatgpt.com");
    expect(await save()).toEqual(["example.com", "example.org", "chatgpt.com"]);
  });

  test("an invalid group name in the input blocks Save with the group's message", async () => {
    openFromAdd();
    pickFavorite(FAVORITE.id);
    setPatterns("geosite:not a group");
    byId("siteLocationSave").click();
    await flush();
    expect(messagesOfType("SAVE_SITE_LOCATION")).toEqual([]);
    expect(text("siteLocationErrorText")).toBe("No site group is called not a group.");
    expect(byId("siteLocationPatterns").getAttribute("aria-invalid")).toBe("true");
  });

  test.each([
    ["UNKNOWN_GROUP", "geosite:nope", "No site group is called nope."],
    ["EMPTY_GROUP", "geosite:google@zz", "Google has no sites with that tag."],
    [
      "LINK_FAILED",
      "list:https://example.com/a.txt",
      "Couldn't download that list. Check the link and try again.",
    ],
    ["STORAGE_FULL", "geosite:google", "Site groups are out of space. Remove a large list first."],
  ])("maps the save error %s to its message", async (error, pattern, message) => {
    openFromAdd();
    pickFavorite(FAVORITE.id);
    sendMessage.mockResolvedValue({ error, pattern });
    byId("siteLocationSave").click();
    await flush();
    expect(text("siteLocationErrorText")).toBe(message);
  });

  test("a suggestion picked in the Sites field becomes a chip", async () => {
    openFromAdd();
    const input = byId<HTMLInputElement>("siteLocationPatterns");
    input.focus();
    setPatterns("twitch.tv");
    const metas = Array.from(
      byId("siteLocationGroupListbox").querySelectorAll(".entry-suggestion-meta")
    ).map((node) => node.textContent);
    expect(metas).toEqual(["Site and its subdomains", "Exact address only", "Subdomains only"]);
    for (const key of ["ArrowDown", "ArrowDown", "Enter"]) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    }
    await flush();
    expect(chipTitles()).toEqual(["example.com", "twitch.tv"]);
    expect(
      chipRemoveButton("twitch.tv").closest(".entry-chip")!.querySelector(".entry-chip-meta")
        ?.textContent
    ).toBe("Exact address only");
    expect(isShown("siteLocationEditor")).toBe(true);
  });

  test("Escape with the suggestions open closes only them", () => {
    openFromAdd();
    const input = byId<HTMLInputElement>("siteLocationPatterns");
    input.focus();
    setPatterns("twitch.tv");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(isShown("siteLocationEditor")).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isShown("siteLocationEditor")).toBe(false);
  });
});

describe("Editor: the place (S6)", () => {
  const LOS_ANGELES: Favorite = {
    id: "fav-2",
    latitude: 34.0522,
    longitude: -118.2437,
    city: "Los Angeles",
    country: "United States",
    displayName: "Los Angeles, United States",
    label: null,
  };

  function openFromAdd(url = "https://www.example.com/page"): void {
    showFiltersView();
    renderAll(makeSettings({ favorites: [FAVORITE, LOS_ANGELES] }), url);
    byId("siteLocationsAddButton").click();
  }

  function favoriteRows(): string[] {
    return Array.from(
      byId("siteLocationFavoritesList").querySelectorAll<HTMLElement>(".favorite-suggestion")
    ).map(
      (button) =>
        `${button.querySelector(".favorite-suggestion-name")?.textContent} · ${
          button.querySelector(".favorite-suggestion-sub")?.textContent
        }`
    );
  }

  function search(value: string): void {
    const input = byId<HTMLInputElement>("siteLocationSearch");
    input.value = value;
    input.dispatchEvent(new Event("input"));
  }

  test("no favorites menu: the favorites are suggestions under the Location field", () => {
    expect(document.querySelector("#siteLocationEditor select")).toBeNull();
    openFromAdd();
    expect(isShown("siteLocationFavorites")).toBe(true);
    expect(text("siteLocationFavoritesHeading")).toBe("Favorites");
    expect(byId("siteLocationFavoritesList").getAttribute("role")).toBe("group");
    expect(byId("siteLocationFavoritesList").getAttribute("aria-labelledby")).toBe(
      "siteLocationFavoritesHeading"
    );
    expect(favoriteRows()).toEqual(["Work · France", "Los Angeles · United States"]);
    expect(
      Array.from(byId("siteLocationFavoritesList").querySelectorAll("button")).every(
        (button) => button.type === "button"
      )
    ).toBe(true);
    // Nothing chosen yet: no token, and no "No location chosen yet" text.
    expect(chosenName()).toBe("");
    expect(text("siteLocationChosen")).toBe("");
  });

  test("the Location field's text filters them by name, city or country", () => {
    openFromAdd();
    search("los");
    expect(favoriteRows()).toEqual(["Los Angeles · United States"]);
    search("PARIS");
    expect(favoriteRows()).toEqual(["Work · France"]);
    search("states");
    expect(favoriteRows()).toEqual(["Los Angeles · United States"]);
    search("zzz");
    expect(isShown("siteLocationFavorites")).toBe(false);
    search("");
    expect(favoriteRows()).toHaveLength(2);
  });

  test("with no favorites, the section stays hidden", () => {
    showFiltersView();
    renderAll(makeSettings({ favorites: [] }), "https://www.example.com/page");
    byId("siteLocationsAddButton").click();
    expect(isShown("siteLocationFavorites")).toBe(false);
  });

  test("picking one shows it as a token in the field; its ✕ brings the field back", () => {
    openFromAdd();
    search("los");
    pickFavorite(LOS_ANGELES.id);

    expect(chosenName()).toBe("Los Angeles");
    expect(byId("siteLocationChosen").getAttribute("aria-live")).toBe("polite");
    expect(byId("siteLocationChosen").querySelector(".token-field .entry-chip")).not.toBeNull();
    for (const id of ["siteLocationSearch", "siteLocationResults", "siteLocationFavorites"]) {
      expect(isShown(id), `#${id}`).toBe(false);
    }
    const remove = chosenRemoveButton();
    expect(remove.type).toBe("button");
    expect(remove.getAttribute("aria-label")).toBe("Remove location Los Angeles");
    // The picker went away with the choice; focus moves on to Save.
    expect(document.activeElement).toBe(saveButton());

    remove.click();
    expect(chosenName()).toBe("");
    expect(isShown("siteLocationSearch")).toBe(true);
    expect(document.activeElement).toBe(byId("siteLocationSearch"));
    // The token took the typed text's place, so all favorites are back.
    expect(byId<HTMLInputElement>("siteLocationSearch").value).toBe("");
    expect(favoriteRows()).toHaveLength(2);
    expect(saveButton().disabled).toBe(true);
  });

  test("a search result becomes the token too", () => {
    openFromAdd();
    renderSearchResults([
      {
        name: "Berlin, Germany",
        latitude: 52.52,
        longitude: 13.405,
        city: "Berlin",
        country: "DE",
      },
    ]);
    byId("siteLocationResults").querySelector("button")!.click();
    expect(chosenName()).toBe("Berlin, Germany");
    expect(isShown("siteLocationSearch")).toBe(false);
    expect(document.activeElement).toBe(saveButton());
  });

  test("Save works only with a site and a place", () => {
    openFromAdd();
    expect(chipTitles()).toEqual(["example.com"]);
    expect(saveButton().disabled).toBe(true);

    pickFavorite(FAVORITE.id);
    expect(saveButton().disabled).toBe(false);

    chipRemoveButton("example.com").click();
    expect(saveButton().disabled).toBe(true);
    // Text in the Sites input counts as a site once it parses.
    setPatterns("example.org");
    expect(saveButton().disabled).toBe(false);
    setPatterns("example.org/app");
    expect(saveButton().disabled).toBe(true);
    setPatterns("example.org");

    chosenRemoveButton().click();
    expect(saveButton().disabled).toBe(true);
  });

  test("a site whose typed text doesn't parse still lets Save say why", async () => {
    openFromAdd();
    pickFavorite(FAVORITE.id);
    setPatterns("example.org/app");
    expect(saveButton().disabled).toBe(false);
    saveButton().click();
    await flush();
    expect(messagesOfType("SAVE_SITE_LOCATION")).toEqual([]);
    expect(text("siteLocationErrorText")).toBe(
      "Use a site like example.com, with no path and not just *."
    );
  });

  test("Save is faint while it's off (H-7)", () => {
    const css = readFileSync("assets/popup.css", "utf8");
    expect(css).toMatch(
      /\.site-location-editor \.site-location-save:disabled\s*\{\s*opacity:\s*0\.4;/
    );
  });

  test("with no site filled in, focus starts in Sites", () => {
    openFromAdd("about:blank");
    expect(chipTitles()).toEqual([]);
    expect(document.activeElement).toBe(byId("siteLocationPatterns"));
  });

  test("an existing entry opens with its place as the token", () => {
    showFiltersView();
    renderAll(makeSettings(), "https://example.com/");
    siteRow(ENTRY_DUBLIN.id).click();
    expect(chosenName()).toBe("Dublin");
    expect(isShown("siteLocationSearch")).toBe(false);
    expect(saveButton().disabled).toBe(false);
  });
});

describe("Hints only in context", () => {
  const allowlist: Partial<Settings> = { scopeMode: "allowlist", allowlist: ["example.com"] };
  // chatgpt.com has no entry of its own, so "＋ Set a location for chatgpt.com" fills it in.
  const allowlistNoChatgpt: Partial<Settings> = {
    ...allowlist,
    siteLocations: [ENTRY_MEXICO_CITY],
  };

  function openFromAddAt(url: string, settings: Settings): void {
    showFiltersView();
    renderAll(settings, url);
    byId("siteLocationsAddButton").click();
  }

  test("no standing hints: with the editor closed, none show anywhere", () => {
    renderAll(makeSettings({ ...allowlist, vpnSyncEnabled: true }), "https://chatgpt.com/c/1");
    for (const id of [
      "siteLocationFiltersHint",
      "siteLocationVpnHint",
      "siteLocationsReloadHint",
      "siteLocationEditorReloadHint",
      "siteLocationLineVpnHint",
      "siteLocationLineReloadHint",
    ]) {
      expect(isShown(id), `#${id}`).toBe(false);
    }
    expect(byId("siteLocationLine").hidden).toBe(true);
  });

  /** The Filters hint's button, as read: its label and its accessible name. */
  function filtersAction(): { label: string; name: string | null } | null {
    if (!isShown("siteLocationFiltersAction")) return null;
    const button = byId("siteLocationFiltersAction");
    return { label: text("siteLocationFiltersAction"), name: button.getAttribute("aria-label") };
  }

  test("allowlist conflict: the hint and the card's button show in the editor for a covered site", async () => {
    openFromAddAt("https://chatgpt.com/c/1", makeSettings(allowlistNoChatgpt));
    expect(chipTitles()).toEqual(["chatgpt.com"]);
    expect(isShown("siteLocationFiltersHint")).toBe(true);
    // One site: the plain mark, without the ⚠ the Per-site rows draw (M13).
    expect(text("siteLocationFiltersHintText")).toBe("Not used · Off in Sites");
    expect(filtersAction()).toEqual({
      label: "Add to Allowlist",
      name: "Add to Allowlist: chatgpt.com",
    });

    sendMessage.mockResolvedValue({ success: true });
    // The reload loadSettings does, with the site now on the allowlist.
    vi.mocked(loadSettings).mockImplementationOnce(() => {
      renderAll(
        makeSettings({
          ...allowlistNoChatgpt,
          allowlist: ["example.com", "chatgpt.com"],
        }),
        "https://chatgpt.com/c/1"
      );
      return Promise.resolve();
    });
    const oneTap = byId("siteLocationFiltersAction");
    oneTap.focus();
    oneTap.click();
    await flush();
    expect(messagesOfType("ADD_SCOPE_SITE")).toEqual([
      { list: "allowlist", pattern: "chatgpt.com" },
    ]);
    expect(loadSettings).toHaveBeenCalled();

    // The re-render keeps the editor open, drops the now-resolved hint, and
    // says to reload, in the editor (open pages on the site keep Filters' old
    // answer).
    expect(isShown("siteLocationEditor")).toBe(true);
    expect(isShown("siteLocationFiltersHint")).toBe(false);
    expect(isShown("siteLocationEditorReloadHint")).toBe(true);

    // The button hid itself, so focus moves to the confirmation; the next Tab
    // lands in the still-open editor.
    expect(isShown("siteLocationFiltersAction")).toBe(false);
    expect(document.activeElement).toBe(byId("siteLocationEditorReloadHint"));
    expect(byId("siteLocationEditorReloadHint").getAttribute("tabindex")).toBe("-1");

    // Leaving the editor, the hint goes with it to the screen it returns to.
    byId("siteLocationCancel").click();
    expect(isShown("siteLocationsReloadHint")).toBe(true);
    expect(byId("siteLocationEditorReloadHint").hidden).toBe(true);
  });

  test("the hint follows the Sites field", () => {
    renderAll(makeSettings(allowlist), "https://chatgpt.com/c/1");
    byId("siteLocationsAddButton").click();
    replaceSites("example.org");
    expect(isShown("siteLocationFiltersHint")).toBe(false);
    setPatterns("example.org, chatgpt.com");
    expect(isShown("siteLocationFiltersHint")).toBe(true);
  });

  test("a site group covering this tab counts as a conflict", async () => {
    await loadGroups(makeSettings(allowlist));
    renderAll(makeSettings(allowlist), "https://www.google.com/");
    byId("siteLocationsAddButton").click();
    replaceSites("");
    expect(isShown("siteLocationFiltersHint")).toBe(false);
    setPatterns("geosite:google");
    expect(isShown("siteLocationFiltersHint")).toBe(true);
  });

  test("several sites: the hint names the tab's site, and the button names it too", () => {
    const shared = makeSiteLocation({
      id: "twitch-kick",
      patterns: ["twitch.tv", "kick.com"],
      location: MEXICO_CITY,
      timezone: MEXICO_CITY_TZ,
      locationName: MEXICO_CITY_NAME,
    });
    renderAll(
      makeSettings({ ...allowlist, siteLocations: [shared] }),
      "https://www.twitch.tv/videos/1"
    );
    siteRow(shared.id).click();
    expect(chipTitles()).toEqual(["twitch.tv", "kick.com"]);
    expect(text("siteLocationFiltersHintText")).toBe("Not used on twitch.tv · Off in Sites");
    expect(filtersAction()).toEqual({
      label: "Add to Allowlist",
      name: "Add to Allowlist: twitch.tv",
    });
    // Down to one site, the hint is the plain mark again.
    chipRemoveButton("kick.com").click();
    expect(text("siteLocationFiltersHintText")).toBe("Not used · Off in Sites");
  });

  test("a failed Filters hint action shows the editor error", async () => {
    renderAll(makeSettings(allowlistNoChatgpt), "https://chatgpt.com/");
    byId("siteLocationsAddButton").click();
    sendMessage.mockResolvedValue({ error: "STORAGE_ERROR" });
    byId("siteLocationFiltersAction").click();
    await flush();
    expect(isShown("siteLocationError")).toBe(true);
    expect(text("siteLocationErrorText")).toBe("⚠ Change not saved");
    expect(loadSettings).not.toHaveBeenCalled();
  });

  test("denylist, the site's own entry: Remove from Denylist, by the card's rule", async () => {
    renderAll(
      makeSettings({ scopeMode: "denylist", denylist: ["twitch.tv"] }),
      "https://twitch.tv/"
    );
    siteRow(ENTRY_MEXICO_CITY.id).click();
    expect(isShown("siteLocationFiltersHint")).toBe(true);
    expect(text("siteLocationFiltersHintText")).toBe("Not used · Off in Sites");
    expect(filtersAction()).toEqual({
      label: "Remove from Denylist",
      name: "Remove from Denylist: twitch.tv",
    });

    sendMessage.mockResolvedValue({ success: true });
    byId("siteLocationFiltersAction").click();
    await flush();
    expect(messagesOfType("REMOVE_SCOPE_SITE")).toEqual([
      { list: "denylist", pattern: "twitch.tv" },
    ]);
    expect(messagesOfType("ADD_SCOPE_SITE")).toEqual([]);
  });

  test("a broader entry keeps the site off: the hint shows with no button", () => {
    const ru = makeSiteLocation({ id: "ru", patterns: ["example.ru"] });
    renderAll(
      makeSettings({ scopeMode: "denylist", denylist: ["*.ru"], siteLocations: [ru] }),
      "https://example.ru/"
    );
    siteRow(ru.id).click();
    expect(isShown("siteLocationFiltersHint")).toBe(true);
    expect(text("siteLocationFiltersHintText")).toBe("Not used · Off in Sites");
    expect(filtersAction()).toBeNull();
  });

  test("scope 'all': no Filters hint", () => {
    openFromAddAt("https://chatgpt.com/", makeSettings());
    expect(isShown("siteLocationFiltersHint")).toBe(false);
  });

  test("VPN hint: in the editor with VPN sync on, gone when it closes", () => {
    openFromAddAt("https://example.com/", makeSettings({ vpnSyncEnabled: true }));
    expect(isShown("siteLocationVpnHint")).toBe(true);
    byId("siteLocationCancel").click();
    expect(isShown("siteLocationVpnHint")).toBe(false);

    openFromAddAt("https://example.com/", makeSettings({ vpnSyncEnabled: false }));
    expect(isShown("siteLocationVpnHint")).toBe(false);
  });
});

describe("Details readout", () => {
  test("applied: shows Place (host) · Zone", () => {
    renderSiteLocationDetails(makeSettings(), "https://chatgpt.com/");
    expect(byId("detailSiteLocationSection").hidden).toBe(false);
    expect(text("detailSiteLocation")).toBe("Dublin (chatgpt.com) · Europe/Dublin");
  });

  test.each<[string, Partial<Settings>, string, boolean]>([
    ["an unmatched site", {}, "https://example.com/", false],
    ["a restricted page", {}, "about:blank", false],
    ["protection off", { enabled: false }, "https://chatgpt.com/", false],
    ["the Safari Pro lock", {}, "https://chatgpt.com/", true],
  ])("renders nothing on %s", (_name, overrides, url, proLocked) => {
    renderSiteLocationDetails(makeSettings(), "https://chatgpt.com/");
    renderSiteLocationDetails(makeSettings(overrides), url, proLocked);
    expect(byId("detailSiteLocationSection").hidden).toBe(true);
    expect(text("detailSiteLocation")).toBe("");
  });

  test("starts hidden in the markup", () => {
    expect(byId("detailSiteLocationSection").hidden).toBe(true);
  });
});

describe("Accessibility", () => {
  test("live status, alerts, and a labelled list", () => {
    expect(byId("siteLocationLineStatus").getAttribute("role")).toBe("status");
    expect(byId("siteLocationLineStatus").getAttribute("aria-live")).toBe("polite");
    expect(byId("siteLocationError").getAttribute("role")).toBe("alert");
    expect(byId("siteLocationLineError").getAttribute("role")).toBe("alert");
    expect(byId("siteLocationsError").getAttribute("role")).toBe("alert");
    expect(byId("siteLocationChosen").getAttribute("aria-live")).toBe("polite");
    expect(byId("siteLocationsList").getAttribute("role")).toBe("list");
    expect(byId("siteLocationsList").getAttribute("aria-label")).toBeTruthy();
  });

  test("every editor input is labelled, and there are no menus", () => {
    expect(byId("siteLocationEditor").querySelector("select")).toBeNull();
    const controls = byId("siteLocationEditor").querySelectorAll("input");
    expect(controls.length).toBeGreaterThanOrEqual(2);
    controls.forEach((control) => {
      const labelled =
        document.querySelector(`label[for="${control.id}"]`) !== null ||
        control.hasAttribute("aria-label");
      expect(labelled, `#${control.id} has no label`).toBe(true);
    });
  });

  test("every button is a real button with text or an aria-label", () => {
    renderAll(makeSettings(), "https://twitch.tv/");
    for (const scope of [
      "siteLocationLine",
      "siteLocationsCard",
      "siteLocationsScreen",
      "siteLocationEditorScreen",
    ]) {
      byId(scope)
        .querySelectorAll("button, [role='button']")
        .forEach((button) => {
          if (button instanceof HTMLButtonElement) expect(button.type).toBe("button");
          const name = button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "";
          expect(name.length).toBeGreaterThan(0);
        });
    }
  });

  test("the line's Edit name starts with its visible text", () => {
    renderSiteLocationLine(makeSettings(), "https://twitch.tv/", false);
    const edit = byId("siteLocationLineEdit");
    expect(edit.getAttribute("aria-label")?.startsWith(text("siteLocationLineEdit"))).toBe(true);
  });

  test("one polite announcer, outside every view, starts empty and never shown", () => {
    const announcer = byId("siteLocationAnnouncer");
    expect(announcer.getAttribute("role")).toBe("status");
    expect(announcer.getAttribute("aria-live")).toBe("polite");
    expect(announcer.getAttribute("aria-atomic")).toBe("true");
    expect(announcer.closest("[hidden]")).toBeNull();
    expect(announcer.closest(".tab-content")).toBeNull();
    expect(announcer.closest("details")).toBeNull();
    expect(announcer.classList.contains("visually-hidden")).toBe(true);
    expect(text("siteLocationAnnouncer")).toBe("");
    // The reload hints are no longer live regions of their own.
    expect(byId("siteLocationLineReloadHint").hasAttribute("role")).toBe(false);
    expect(byId("siteLocationsReloadHint").hasAttribute("role")).toBe(false);
  });

  test("the visually-hidden utility clips rather than hides", () => {
    const css = readFileSync("assets/popup.css", "utf8");
    const rule = /\.visually-hidden\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("position: absolute");
    expect(rule).toContain("clip-path: inset(50%)");
    expect(rule).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });

  describe("confirmations are announced", () => {
    const RELOAD = "Reload affected pages to apply the change.";

    /** Wait out the announcer's clear-then-set delay, then read it. */
    async function announced(): Promise<string> {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return text("siteLocationAnnouncer");
    }

    function openEditorAt(url: string, settings: Settings): void {
      showFiltersView();
      renderAll(settings, url);
      byId("siteLocationsAddButton").click();
    }

    // One hint for every change, and a change can reach sites other than the
    // one in the tab (up to ten in one save), so it names no site.
    test("the fallback is the en catalog's wording", () => {
      const en = JSON.parse(readFileSync("_locales/en/messages.json", "utf8")) as Record<
        string,
        { message: string }
      >;
      expect(en.siteLocation_reloadHint.message).toBe(RELOAD);
      expect(text("siteLocationsReloadHint")).toBe(RELOAD);
      expect(text("siteLocationLineReloadHint")).toBe(RELOAD);
    });

    test("Save", async () => {
      openEditorAt("https://www.example.com/page", makeSettings());
      pickFavorite(FAVORITE.id);
      sendMessage.mockResolvedValue({ success: true, id: "new" });
      byId("siteLocationSave").click();
      await flush();
      expect(await announced()).toBe(RELOAD);
    });

    test("a failed Save announces nothing (the alert speaks)", async () => {
      openEditorAt("https://www.example.com/page", makeSettings());
      pickFavorite(FAVORITE.id);
      sendMessage.mockResolvedValue({ error: "STORAGE_ERROR" });
      byId("siteLocationSave").click();
      await flush();
      expect(await announced()).toBe("");
    });

    test("Remove", async () => {
      renderAll(makeSettings(), "https://example.com/");
      siteRow(ENTRY_DUBLIN.id).click();
      sendMessage.mockResolvedValue({ success: true, id: ENTRY_DUBLIN.id });
      byId("siteLocationRemove").click();
      await flush();
      expect(await announced()).toBe(RELOAD);
    });

    test("a failed Remove announces nothing", async () => {
      renderAll(makeSettings(), "https://example.com/");
      siteRow(ENTRY_DUBLIN.id).click();
      sendMessage.mockResolvedValue({ error: "STORAGE_ERROR" });
      byId("siteLocationRemove").click();
      await flush();
      expect(await announced()).toBe("");
    });

    test("Use main location", async () => {
      renderAll(makeSettings(), "https://twitch.tv/");
      sendMessage.mockResolvedValue({ success: true, id: ENTRY_MEXICO_CITY.id });
      byId("siteLocationLineUseMain").click();
      await flush();
      expect(await announced()).toBe(RELOAD);
    });

    test("a failed Use main location announces nothing", async () => {
      renderAll(makeSettings(), "https://twitch.tv/");
      sendMessage.mockResolvedValue({ error: "STORAGE_ERROR" });
      byId("siteLocationLineUseMain").click();
      await flush();
      expect(await announced()).toBe("");
    });

    test("the Filters hint's Add to Allowlist", async () => {
      openEditorAt(
        "https://chatgpt.com/c/1",
        makeSettings({
          scopeMode: "allowlist",
          allowlist: ["example.com"],
          siteLocations: [ENTRY_MEXICO_CITY],
        })
      );
      sendMessage.mockResolvedValue({ success: true });
      byId("siteLocationFiltersAction").click();
      await flush();
      expect(await announced()).toBe(RELOAD);
    });

    test("a failed Filters hint action announces nothing", async () => {
      openEditorAt(
        "https://chatgpt.com/c/1",
        makeSettings({
          scopeMode: "allowlist",
          allowlist: ["example.com"],
          siteLocations: [ENTRY_MEXICO_CITY],
        })
      );
      sendMessage.mockResolvedValue({ error: "STORAGE_ERROR" });
      byId("siteLocationFiltersAction").click();
      await flush();
      expect(await announced()).toBe("");
    });

    test("the same confirmation twice is spoken again: cleared, then set", async () => {
      renderAll(makeSettings(), "https://example.com/");
      sendMessage.mockResolvedValue({ success: true, id: ENTRY_DUBLIN.id });
      siteRow(ENTRY_DUBLIN.id).click();
      byId("siteLocationRemove").click();
      await flush();
      expect(await announced()).toBe(RELOAD);

      siteRow(ENTRY_DUBLIN.id).click();
      byId("siteLocationRemove").click();
      await flush();
      // Cleared at once, so the repeat registers as a change...
      expect(text("siteLocationAnnouncer")).toBe("");
      // ...then set again.
      expect(await announced()).toBe(RELOAD);
    });
  });
});
