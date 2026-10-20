/**
 * Popup Site locations (GeoSpoof/geospoof#177): the Main-tab line (only when a
 * site location applies), the Filters-tab "Site locations (optional)"
 * disclosure, the shared editor and its in-context hints, and the Details
 * readout, exercised in jsdom against the real assets/popup.html markup.
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

function disclosure(): HTMLDetailsElement {
  return byId<HTMLDetailsElement>("siteLocationsDisclosure");
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

function pickFavorite(id: string): void {
  const select = byId<HTMLSelectElement>("siteLocationFavorite");
  select.value = id;
  select.dispatchEvent(new Event("change"));
}

function setPatterns(value: string): void {
  const input = byId<HTMLInputElement>("siteLocationPatterns");
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

/**
 * Switch to the Filters tab as index.ts's showPopupView does. Needed for focus
 * assertions: jsdom won't focus inside a `display: none` panel.
 */
function showFiltersView(): void {
  byId("mainView").style.display = "none";
  byId("filtersView").style.display = "block";
}

/** Render both surfaces as loadSettings does. */
function renderAll(settings: Settings, url: string | undefined, proLocked = false): void {
  renderSiteLocationLine(settings, url, proLocked);
  renderSiteLocationsSection(settings, url, proLocked);
  renderSiteLocationDetails(settings, url, proLocked);
}

/** The Filters-row Edit button of the entry with this id. */
function rowEditButton(id: string): HTMLButtonElement {
  const row = Array.from(byId("siteLocationsList").children).find(
    (node) => (node as HTMLElement).dataset.siteLocationId === id
  );
  const button = row?.querySelector<HTMLButtonElement>(".site-location-edit");
  if (!button) throw new Error(`no Edit button for ${id}`);
  return button;
}

beforeEach(() => {
  document.body.innerHTML = BODY;
  __resetSiteLocationsForTest();
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
    expect(document.getElementById("thisSiteRow")).toBeNull();
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
      "Edit site location Mexico City"
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
    expect(byId("siteLocationLineReloadHint").getAttribute("role")).toBe("status");
    expect(byId("siteLocationsReloadHint").hidden).toBe(true);

    // The pressed button is gone, so focus moves to the confirmation: it's
    // read out, and Tab continues from there. Script-only, not a tab stop.
    expect(isShown("siteLocationLineUseMain")).toBe(false);
    expect(document.activeElement).toBe(byId("siteLocationLineReloadHint"));
    expect(byId("siteLocationLineReloadHint").getAttribute("tabindex")).toBe("-1");
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

  test("'Edit' switches to Filters, expands the disclosure, and opens that entry", () => {
    renderAll(makeSettings(), "https://chatgpt.com/c/1");
    disclosure().open = false;
    // Stand in for index.ts's tab handler. Focus landing in the editor below
    // also proves the tab switch happens before the editor opens.
    const onFiltersTab = vi.fn(showFiltersView);
    byId("filtersTab").addEventListener("click", onFiltersTab);

    byId("siteLocationLineEdit").click();

    expect(onFiltersTab).toHaveBeenCalledTimes(1);
    expect(disclosure().open).toBe(true);
    expect(isShown("siteLocationEditor")).toBe(true);
    expect(byId<HTMLInputElement>("siteLocationPatterns").value).toBe("chatgpt.com, openai.com");
    expect(text("siteLocationChosen")).toBe("Dublin");
    expect(document.activeElement).toBe(byId("siteLocationPatterns"));

    // Cancel returns focus to that entry's Edit button in the list.
    byId("siteLocationCancel").click();
    expect(document.activeElement).toBe(rowEditButton(ENTRY_DUBLIN.id));
  });

  test("renderSiteLocations reads the active tab and reports whether one applies", async () => {
    vi.mocked(browser.tabs.query).mockResolvedValueOnce([
      { url: "https://twitch.tv/x" } as browser.tabs.Tab,
    ]);
    await expect(renderSiteLocations(makeSettings(), false)).resolves.toBe(true);
    expect(browser.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(text("siteLocationLineStatus")).toBe("On twitch.tv: Mexico City");
    expect(text("detailSiteLocation")).toBe("Mexico City (twitch.tv) · America/Mexico_City");

    vi.mocked(browser.tabs.query).mockResolvedValueOnce([
      { url: "https://example.com/" } as browser.tabs.Tab,
    ]);
    await expect(renderSiteLocations(makeSettings(), false)).resolves.toBe(false);
    expect(byId("siteLocationLine").hidden).toBe(true);
    expect(byId("detailSiteLocationSection").hidden).toBe(true);
  });
});

describe("Filters tab: the Site locations disclosure", () => {
  test("is a native <details> at the bottom of the Filters tab, after the filter list", () => {
    const details = disclosure();
    expect(details.tagName).toBe("DETAILS");
    expect(details.firstElementChild?.tagName).toBe("SUMMARY");
    expect(byId("filtersView").lastElementChild).toBe(details);
    expect(byId("scopeListManager").compareDocumentPosition(details)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    // A plain divider ends the Filters group, so in list modes the bar can't
    // read as another Filters bar like "What patterns can I use?".
    expect(details.previousElementSibling?.matches("hr.section-divider")).toBe(true);
  });

  test("with no entries: collapsed, no count chip, no empty box, a quiet label", () => {
    renderSiteLocationsSection(makeSettings({ siteLocations: [] }), undefined, false);
    const details = disclosure();
    expect(details.open).toBe(false);
    expect(byId("siteLocationsCount").hidden).toBe(true);
    expect(document.getElementById("siteLocationsEmpty")).toBeNull();
    expect(details.querySelector(".scope-empty, .scope-list-title, .section-heading")).toBeNull();

    const summary = details.querySelector("summary")!;
    expect(summary.textContent).toContain("Site locations (optional)");
    expect(summary.textContent).toContain("Use a different location on specific sites.");
    expect(summary.querySelector("[aria-hidden='true']")?.textContent).toBe("▶");
  });

  test("with entries: starts expanded with the count", () => {
    renderSiteLocationsSection(makeSettings(), undefined, false);
    expect(disclosure().open).toBe(true);
    expect(byId("siteLocationsCount").hidden).toBe(false);
    expect(text("siteLocationsCount")).toBe("2");
  });

  test("the summary toggles it, and later renders leave the user's choice alone", () => {
    renderSiteLocationsSection(makeSettings(), undefined, false);
    const summary = disclosure().querySelector("summary")!;
    summary.click();
    expect(disclosure().open).toBe(false);
    renderSiteLocationsSection(makeSettings(), undefined, false);
    expect(disclosure().open).toBe(false);

    summary.click();
    expect(disclosure().open).toBe(true);
    renderSiteLocationsSection(makeSettings({ siteLocations: [] }), undefined, false);
    expect(disclosure().open).toBe(true);
  });

  test("expanded: the list, then 'Set a location for a site' (not a full-width filter action)", () => {
    renderSiteLocationsSection(makeSettings(), "https://example.com/", false);
    const add = byId("siteLocationsAddButton");
    expect(text("siteLocationsAddButton")).toBe("Set a location for a site");
    expect(add.classList.contains("scope-add-current")).toBe(false);
    expect(byId("siteLocationsList").compareDocumentPosition(add)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(isShown("siteLocationsAddRow")).toBe(true);
    expect(isShown("siteLocationsProNote")).toBe(false);
  });

  test("lists entries with names, sites, a monogram, and labelled actions", () => {
    renderSiteLocationsSection(makeSettings(), undefined, false);
    const rows = byId("siteLocationsList").querySelectorAll('[role="listitem"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".site-location-name")?.textContent).toBe("Dublin");
    expect(rows[0].querySelector(".site-location-patterns")?.textContent).toBe(
      "chatgpt.com, openai.com"
    );
    expect(rows[0].querySelector(".scope-site-icon")).not.toBeNull();
    expect(rows[0].querySelector(".site-location-edit")?.getAttribute("aria-label")).toBe(
      "Edit site location Dublin"
    );
    expect(rows[1].querySelector(".scope-site-remove")?.getAttribute("aria-label")).toBe(
      "Remove site location Mexico City"
    );
  });

  test("remove is optimistic and reverts on failure", async () => {
    renderSiteLocationsSection(makeSettings(), undefined, false);
    sendMessage.mockResolvedValue({ error: "STORAGE_ERROR" });
    const remove = byId("siteLocationsList").querySelector<HTMLButtonElement>(".scope-site-remove");
    remove!.click();
    expect(byId("siteLocationsList").children).toHaveLength(1);
    expect(text("siteLocationsCount")).toBe("1");
    await flush();

    expect(messagesOfType("REMOVE_SITE_LOCATION")).toEqual([{ id: ENTRY_DUBLIN.id }]);
    expect(byId("siteLocationsList").children).toHaveLength(2);
    expect(byId("siteLocationsList").firstElementChild?.textContent).toContain("Dublin");
    expect(text("siteLocationsCount")).toBe("2");
    expect(isShown("siteLocationsError")).toBe(true);
    expect(loadSettings).not.toHaveBeenCalled();
  });

  test("removing the last entry hides the count chip", () => {
    renderSiteLocationsSection(makeSettings({ siteLocations: [ENTRY_DUBLIN] }), undefined, false);
    sendMessage.mockReturnValue(new Promise(() => {}));
    byId("siteLocationsList").querySelector<HTMLButtonElement>(".scope-site-remove")!.click();
    expect(byId("siteLocationsCount").hidden).toBe(true);
  });

  test("a successful remove reloads, then shows the reload hint in the disclosure", async () => {
    renderAll(makeSettings(), "https://example.com/");
    sendMessage.mockResolvedValue({ success: true, id: ENTRY_DUBLIN.id });
    byId("siteLocationsList").querySelector<HTMLButtonElement>(".scope-site-remove")!.click();
    await flush();
    expect(loadSettings).toHaveBeenCalled();
    expect(isShown("siteLocationsError")).toBe(false);

    renderAll(makeSettings({ siteLocations: [ENTRY_MEXICO_CITY] }), "https://example.com/");
    expect(isShown("siteLocationsReloadHint")).toBe(true);
    expect(byId("siteLocationLine").hidden).toBe(true);
  });

  test("doesn't change Filters' 'Add current site' control", () => {
    renderSiteLocationsSection(makeSettings(), undefined, false);
    expect(byId("scopeAddCurrentButton").closest("#scopeListManager")).not.toBeNull();
    expect(byId("scopeAddCurrentButton").closest("#siteLocationsDisclosure")).toBeNull();
  });
});

describe("Safari Pro lock", () => {
  test("only the collapsed disclosure; the Pro note lives inside it", async () => {
    vi.mocked(browser.tabs.query).mockResolvedValueOnce([
      { url: "https://twitch.tv/" } as browser.tabs.Tab,
    ]);
    await expect(renderSiteLocations(makeSettings(), true)).resolves.toBe(false);

    // Nothing on Main or Details.
    expect(byId("siteLocationLine").hidden).toBe(true);
    expect(byId("detailSiteLocationSection").hidden).toBe(true);

    // Collapsed, even with entries; the note is inside it.
    expect(disclosure().open).toBe(false);
    expect(disclosure().contains(byId("siteLocationsProNote"))).toBe(true);
    expect(byId("siteLocationsProNote").hidden).toBe(false);

    // Expanded: the note shows, and every control is disabled.
    disclosure().open = true;
    expect(isShown("siteLocationsProNote")).toBe(true);
    expect(byId<HTMLButtonElement>("siteLocationsAddButton").disabled).toBe(true);
    byId("siteLocationsList")
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((button) => expect(button.disabled).toBe(true));

    byId("siteLocationsAddButton").click();
    expect(isShown("siteLocationEditor")).toBe(false);
  });

  test("locking closes an open editor", () => {
    renderAll(makeSettings(), "https://example.com/");
    byId("siteLocationsAddButton").click();
    expect(isShown("siteLocationEditor")).toBe(true);
    renderAll(makeSettings(), "https://example.com/", true);
    expect(isShown("siteLocationEditor")).toBe(false);
  });
});

describe("Editor", () => {
  function openFromAdd(url = "https://www.example.com/page", settings = makeSettings()): void {
    showFiltersView();
    renderAll(settings, url);
    byId("siteLocationsAddButton").click();
  }

  test("pre-fills the current site without www. and is editable", () => {
    openFromAdd();
    const input = byId<HTMLInputElement>("siteLocationPatterns");
    expect(isShown("siteLocationEditor")).toBe(true);
    expect(disclosure().contains(byId("siteLocationEditor"))).toBe(true);
    expect(input.value).toBe("example.com");
    expect(input.readOnly).toBe(false);
    expect(document.activeElement).toBe(input);

    setPatterns("example.com, example.org");
    pickFavorite(FAVORITE.id);
    expect(text("siteLocationChosen")).toBe("Work");
    expect(text("siteLocationExplain")).toContain("example.com, example.org");
    expect(text("siteLocationExplain")).toContain("Work");
  });

  test("the add row hides while the editor is open, and Cancel brings it and focus back", () => {
    openFromAdd();
    expect(isShown("siteLocationsAddRow")).toBe(false);
    byId("siteLocationCancel").click();
    expect(isShown("siteLocationEditor")).toBe(false);
    expect(isShown("siteLocationsAddRow")).toBe(true);
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
  });

  test("no location chosen blocks the send", async () => {
    openFromAdd();
    byId("siteLocationSave").click();
    await flush();
    expect(messagesOfType("SAVE_SITE_LOCATION")).toEqual([]);
    expect(text("siteLocationErrorText")).toBe("Choose a location first.");
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
    rowEditButton(ENTRY_DUBLIN.id).click();
    expect(isShown("siteLocationsAddRow")).toBe(false);
    setPatterns("chatgpt.com");
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

    expect(text("siteLocationErrorText")).toBe(
      "twitch.tv already has a site location (Mexico City)."
    );
    expect(isShown("siteLocationEditOwner")).toBe(true);

    byId("siteLocationEditOwner").click();
    expect(byId<HTMLInputElement>("siteLocationPatterns").value).toBe("twitch.tv");
    expect(text("siteLocationChosen")).toBe("Mexico City");
    expect(isShown("siteLocationError")).toBe(false);
  });

  test.each([
    ["AT_CAPACITY", "You can have up to 50 site locations. Remove one first."],
    ["TOO_MANY_PATTERNS", "One site location can cover up to 10 sites."],
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
    expect(text("siteLocationChosen")).toBe("Berlin, Germany");
    expect(byId("siteLocationResults").children).toHaveLength(0);
  });
});

describe("Hints only in context", () => {
  const allowlist: Partial<Settings> = { scopeMode: "allowlist", allowlist: ["example.com"] };

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
      "siteLocationLineVpnHint",
      "siteLocationLineReloadHint",
    ]) {
      expect(isShown(id), `#${id}`).toBe(false);
    }
    expect(byId("siteLocationLine").hidden).toBe(true);
  });

  test("allowlist conflict: the hint and one-tap show in the editor for a covered site", async () => {
    openFromAddAt("https://chatgpt.com/c/1", makeSettings(allowlist));
    expect(byId<HTMLInputElement>("siteLocationPatterns").value).toBe("chatgpt.com");
    expect(isShown("siteLocationFiltersHint")).toBe(true);
    expect(text("siteLocationFiltersHintText")).toBe(
      "Filters don't spoof this site. Add it to the allowlist?"
    );
    expect(isShown("siteLocationAddToAllowlist")).toBe(true);

    sendMessage.mockResolvedValue({ success: true });
    // The reload loadSettings does, with the site now on the allowlist.
    vi.mocked(loadSettings).mockImplementationOnce(() => {
      renderAll(
        makeSettings({ scopeMode: "allowlist", allowlist: ["example.com", "chatgpt.com"] }),
        "https://chatgpt.com/c/1"
      );
      return Promise.resolve();
    });
    const oneTap = byId("siteLocationAddToAllowlist");
    oneTap.focus();
    oneTap.click();
    await flush();
    expect(messagesOfType("ADD_SCOPE_SITE")).toEqual([
      { list: "allowlist", pattern: "chatgpt.com" },
    ]);
    expect(loadSettings).toHaveBeenCalled();

    // The re-render keeps the editor open, drops the now-resolved hint, and
    // says to reload (open pages on the site keep Filters' old answer).
    expect(isShown("siteLocationEditor")).toBe(true);
    expect(isShown("siteLocationFiltersHint")).toBe(false);
    expect(isShown("siteLocationsReloadHint")).toBe(true);

    // The one-tap hid itself, so focus moves to the confirmation; the next Tab
    // lands in the still-open editor (the add row is hidden while it's open).
    expect(isShown("siteLocationAddToAllowlist")).toBe(false);
    expect(document.activeElement).toBe(byId("siteLocationsReloadHint"));
    expect(byId("siteLocationsReloadHint").getAttribute("tabindex")).toBe("-1");
    expect(isShown("siteLocationsAddRow")).toBe(false);
  });

  test("the hint follows the Sites field", () => {
    renderAll(makeSettings(allowlist), "https://chatgpt.com/c/1");
    byId("siteLocationsAddButton").click();
    setPatterns("example.org");
    expect(isShown("siteLocationFiltersHint")).toBe(false);
    setPatterns("example.org, chatgpt.com");
    expect(isShown("siteLocationFiltersHint")).toBe(true);
  });

  test("a failed one-tap shows the editor error", async () => {
    renderAll(makeSettings(allowlist), "https://chatgpt.com/");
    byId("siteLocationsAddButton").click();
    sendMessage.mockResolvedValue({ error: "STORAGE_ERROR" });
    byId("siteLocationAddToAllowlist").click();
    await flush();
    expect(isShown("siteLocationError")).toBe(true);
    expect(text("siteLocationErrorText")).toBe("⚠ Change not saved");
    expect(loadSettings).not.toHaveBeenCalled();
  });

  test("denylist conflict: the hint only, no one-tap", () => {
    renderAll(
      makeSettings({ scopeMode: "denylist", denylist: ["twitch.tv"] }),
      "https://twitch.tv/"
    );
    rowEditButton(ENTRY_MEXICO_CITY.id).click();
    expect(isShown("siteLocationFiltersHint")).toBe(true);
    expect(text("siteLocationFiltersHintText")).toBe(
      "Filters don't spoof this site because it's on your denylist."
    );
    expect(isShown("siteLocationAddToAllowlist")).toBe(false);
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

  test("every editor input and select is labelled", () => {
    const controls = byId("siteLocationEditor").querySelectorAll("input, select");
    expect(controls.length).toBeGreaterThanOrEqual(3);
    controls.forEach((control) => {
      const labelled =
        document.querySelector(`label[for="${control.id}"]`) !== null ||
        control.hasAttribute("aria-label");
      expect(labelled, `#${control.id} has no label`).toBe(true);
    });
  });

  test("every button is a real button with text or an aria-label", () => {
    renderAll(makeSettings(), "https://twitch.tv/");
    for (const scope of ["siteLocationLine", "siteLocationsDisclosure"]) {
      byId(scope)
        .querySelectorAll("button")
        .forEach((button) => {
          expect(button.type).toBe("button");
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
});
