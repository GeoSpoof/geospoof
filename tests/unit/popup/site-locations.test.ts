/**
 * Popup Site locations (GeoSpoof/geospoof#177): the Main-tab "This site" row,
 * the Filters-tab section, the shared editor, and the Details readout,
 * exercised in jsdom against the real assets/popup.html markup.
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
  renderSiteLocations,
  renderSiteLocationsSection,
  renderThisSiteRow,
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

beforeEach(() => {
  document.body.innerHTML = BODY;
  __resetSiteLocationsForTest();
  sendMessage.mockReset();
  vi.mocked(loadSettings).mockClear();
});

describe("This site row: states", () => {
  test("hidden on restricted pages and without a URL", () => {
    renderThisSiteRow(makeSettings(), "about:blank", false);
    expect(byId("thisSiteRow").hidden).toBe(true);

    renderThisSiteRow(makeSettings(), "https://addons.mozilla.org/en-US/", false);
    expect(byId("thisSiteRow").hidden).toBe(true);

    renderThisSiteRow(makeSettings(), undefined, false);
    expect(byId("thisSiteRow").hidden).toBe(true);
  });

  test("main location: host · Main location with 'Use a different location here'", () => {
    renderThisSiteRow(makeSettings(), "https://www.example.com/page", false);
    expect(byId("thisSiteRow").hidden).toBe(false);
    expect(text("thisSiteStatus")).toBe("www.example.com · Main location");
    expect(isShown("thisSiteUseDifferent")).toBe(true);
    expect(isShown("thisSiteChange")).toBe(false);
    expect(isShown("thisSiteUseMain")).toBe(false);
    expect(isShown("thisSiteFiltersHint")).toBe(false);
    expect(isShown("thisSiteProNote")).toBe(false);
  });

  test("no main location: an unmatched site says it isn't spoofed", () => {
    const settings = makeSettings({ location: null, timezone: null, locationName: null });
    renderThisSiteRow(settings, "https://example.org/", false);
    expect(text("thisSiteStatus")).toBe("example.org · Not spoofed (no main location set)");
    expect(isShown("thisSiteUseDifferent")).toBe(true);

    // A matched site still names its site location.
    renderThisSiteRow(settings, "https://twitch.tv/", false);
    expect(text("thisSiteStatus")).toBe("twitch.tv · Mexico City (site location)");
  });

  test("applied: host · Place (site location) with Change and Use main location", () => {
    renderThisSiteRow(makeSettings(), "https://www.twitch.tv/somechannel", false);
    expect(text("thisSiteStatus")).toBe("www.twitch.tv · Mexico City (site location)");
    expect(isShown("thisSiteUseDifferent")).toBe(false);
    expect(isShown("thisSiteChange")).toBe(true);
    expect(isShown("thisSiteUseMain")).toBe(true);
  });

  test("protection off still shows what the site would get", () => {
    renderThisSiteRow(makeSettings({ enabled: false }), "https://twitch.tv/", false);
    expect(text("thisSiteStatus")).toBe("twitch.tv · Mexico City (site location)");
  });

  test("allowlist, not listed: Filters status, hint, and a one-tap ADD_SCOPE_SITE", async () => {
    const settings = makeSettings({ scopeMode: "allowlist", allowlist: ["example.com"] });
    renderThisSiteRow(settings, "https://chatgpt.com/c/1", false);

    expect(text("thisSiteStatus")).toBe("GeoSpoof is off on this site (Filters)");
    expect(isShown("thisSiteFiltersHint")).toBe(true);
    expect(text("thisSiteFiltersHintText")).toContain("allowlist");
    expect(isShown("thisSiteAddToAllowlist")).toBe(true);
    expect(isShown("thisSiteUseDifferent")).toBe(false);

    sendMessage.mockResolvedValue({ success: true });
    byId("thisSiteAddToAllowlist").click();
    await flush();

    // The matching site location's pattern is what gets allowlisted.
    expect(messagesOfType("ADD_SCOPE_SITE")).toEqual([
      { list: "allowlist", pattern: "chatgpt.com" },
    ]);
    expect(loadSettings).toHaveBeenCalled();
  });

  test("allowlist one-tap falls back to the www-stripped suggestion", async () => {
    const settings = makeSettings({ scopeMode: "allowlist", allowlist: ["example.com"] });
    renderThisSiteRow(settings, "https://www.news.org/today", false);
    sendMessage.mockResolvedValue({ success: true });
    byId("thisSiteAddToAllowlist").click();
    await flush();
    expect(messagesOfType("ADD_SCOPE_SITE")).toEqual([{ list: "allowlist", pattern: "news.org" }]);
  });

  test("a failed one-tap shows an alert and doesn't reload", async () => {
    const settings = makeSettings({ scopeMode: "allowlist", allowlist: ["example.com"] });
    renderThisSiteRow(settings, "https://chatgpt.com/", false);
    sendMessage.mockResolvedValue({ error: "STORAGE_ERROR" });
    byId("thisSiteAddToAllowlist").click();
    await flush();
    expect(isShown("thisSiteError")).toBe(true);
    expect(byId("thisSiteError").getAttribute("role")).toBe("alert");
    expect(loadSettings).not.toHaveBeenCalled();
  });

  test("denylist: the hint only, no one-tap", () => {
    const settings = makeSettings({ scopeMode: "denylist", denylist: ["twitch.tv"] });
    renderThisSiteRow(settings, "https://twitch.tv/", false);
    expect(text("thisSiteStatus")).toBe("GeoSpoof is off on this site (Filters)");
    expect(isShown("thisSiteFiltersHint")).toBe(true);
    expect(text("thisSiteFiltersHintText")).toContain("denylist");
    expect(isShown("thisSiteAddToAllowlist")).toBe(false);
  });

  test("VPN hint: with VPN sync and an applied site location, or while editing", () => {
    renderThisSiteRow(makeSettings({ vpnSyncEnabled: true }), "https://twitch.tv/", false);
    expect(isShown("thisSiteVpnHint")).toBe(true);

    renderThisSiteRow(makeSettings({ vpnSyncEnabled: true }), "https://example.com/", false);
    expect(isShown("thisSiteVpnHint")).toBe(false);
    byId("thisSiteUseDifferent").click();
    expect(isShown("thisSiteVpnHint")).toBe(true);

    renderThisSiteRow(makeSettings({ vpnSyncEnabled: false }), "https://twitch.tv/", false);
    expect(isShown("thisSiteVpnHint")).toBe(false);
  });

  test("Pro lock: main location status, disabled actions, Pro note", () => {
    renderThisSiteRow(makeSettings(), "https://twitch.tv/", true);
    expect(text("thisSiteStatus")).toBe("twitch.tv · Main location");
    expect(byId<HTMLButtonElement>("thisSiteUseDifferent").disabled).toBe(true);
    expect(isShown("thisSiteProNote")).toBe(true);

    byId("thisSiteUseDifferent").click();
    expect(isShown("siteLocationEditor")).toBe(false);

    renderSiteLocationsSection(makeSettings(), "https://twitch.tv/", true);
    expect(byId<HTMLButtonElement>("siteLocationsAddButton").disabled).toBe(true);
    expect(isShown("siteLocationsProNote")).toBe(true);
  });

  test("renderSiteLocations reads the active tab", async () => {
    vi.mocked(browser.tabs.query).mockResolvedValueOnce([
      { url: "https://twitch.tv/x" } as browser.tabs.Tab,
    ]);
    await renderSiteLocations(makeSettings(), false);
    expect(browser.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(text("thisSiteStatus")).toBe("twitch.tv · Mexico City (site location)");
    expect(text("detailSiteLocation")).toBe("Mexico City (twitch.tv) · America/Mexico_City");
  });
});

describe("This site row: actions", () => {
  test("'Use main location' sends REMOVE_SITE_LOCATION with the matched pattern", async () => {
    renderThisSiteRow(makeSettings(), "https://openai.com/research", false);
    expect(text("thisSiteStatus")).toBe("openai.com · Dublin (site location)");

    sendMessage.mockResolvedValue({ success: true, id: ENTRY_DUBLIN.id });
    byId("thisSiteUseMain").click();
    await flush();

    expect(messagesOfType("REMOVE_SITE_LOCATION")).toEqual([
      { id: ENTRY_DUBLIN.id, pattern: "openai.com" },
    ]);
    expect(loadSettings).toHaveBeenCalled();

    // The reload hint survives the re-render that follows.
    renderThisSiteRow(makeSettings(), "https://openai.com/research", false);
    expect(isShown("thisSiteReloadHint")).toBe(true);
  });

  test("'Change' opens the editor on the applied entry", () => {
    renderThisSiteRow(makeSettings(), "https://chatgpt.com/", false);
    byId("thisSiteChange").click();
    expect(isShown("siteLocationEditor")).toBe(true);
    expect(byId("thisSiteEditorHost").contains(byId("siteLocationEditor"))).toBe(true);
    expect(byId<HTMLInputElement>("siteLocationPatterns").value).toBe("chatgpt.com, openai.com");
    expect(text("siteLocationChosen")).toBe("Dublin");
  });
});

describe("Editor", () => {
  function openFromRow(url = "https://www.example.com/page"): void {
    renderThisSiteRow(makeSettings(), url, false);
    renderSiteLocationsSection(makeSettings(), url, false);
    byId("thisSiteUseDifferent").click();
  }

  test("the suggestion strips www. and is editable", () => {
    openFromRow();
    const input = byId<HTMLInputElement>("siteLocationPatterns");
    expect(isShown("siteLocationEditor")).toBe(true);
    expect(input.value).toBe("example.com");
    expect(input.readOnly).toBe(false);
    expect(document.activeElement).toBe(input);

    setPatterns("example.com, example.org");
    pickFavorite(FAVORITE.id);
    expect(text("siteLocationChosen")).toBe("Work");
    expect(text("siteLocationExplain")).toContain("example.com, example.org");
    expect(text("siteLocationExplain")).toContain("Work");
  });

  test("an invalid pattern blocks the send", async () => {
    openFromRow();
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
    openFromRow();
    byId("siteLocationSave").click();
    await flush();
    expect(messagesOfType("SAVE_SITE_LOCATION")).toEqual([]);
    expect(text("siteLocationErrorText")).toBe("Choose a location first.");
  });

  test("a successful save sends the payload, closes, reloads, and shows the reload hint", async () => {
    openFromRow();
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
    renderThisSiteRow(makeSettings(), "https://www.example.com/page", false);
    expect(isShown("thisSiteReloadHint")).toBe(true);
  });

  test("a pattern-only edit keeps the stored place (no locationName or label sent)", async () => {
    renderSiteLocationsSection(makeSettings(), "https://example.com/", false);
    const editBtn =
      byId("siteLocationsList").querySelector<HTMLButtonElement>(".site-location-edit");
    editBtn!.click();
    expect(byId("siteLocationsEditorHost").contains(byId("siteLocationEditor"))).toBe(true);
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
    openFromRow();
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
    openFromRow();
    pickFavorite(FAVORITE.id);
    sendMessage.mockResolvedValue({ error });
    byId("siteLocationSave").click();
    await flush();
    expect(text("siteLocationErrorText")).toBe(message);
    expect(isShown("siteLocationEditOwner")).toBe(false);
    expect(isShown("siteLocationEditor")).toBe(true);
  });

  test("search results are keyboard-operable buttons that set the location", () => {
    openFromRow();
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

  test("Cancel closes the editor and returns focus to the opener", () => {
    openFromRow();
    byId("siteLocationCancel").click();
    expect(isShown("siteLocationEditor")).toBe(false);
    expect(document.activeElement).toBe(byId("thisSiteUseDifferent"));
  });

  test("Filters 'Add site location' opens the editor in the Filters section", () => {
    renderThisSiteRow(makeSettings(), "https://www.example.com/", false);
    renderSiteLocationsSection(makeSettings(), "https://www.example.com/", false);
    byId("siteLocationsAddButton").click();
    expect(byId("siteLocationsEditorHost").contains(byId("siteLocationEditor"))).toBe(true);
    expect(byId<HTMLInputElement>("siteLocationPatterns").value).toBe("example.com");
  });
});

describe("Filters section", () => {
  test("lists entries with names, sites, count, and labelled actions", () => {
    renderSiteLocationsSection(makeSettings(), undefined, false);
    const rows = byId("siteLocationsList").querySelectorAll('[role="listitem"]');
    expect(rows).toHaveLength(2);
    expect(text("siteLocationsCount")).toBe("2");
    expect(isShown("siteLocationsEmpty")).toBe(false);
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

  test("an empty list shows the empty state", () => {
    renderSiteLocationsSection(makeSettings({ siteLocations: [] }), undefined, false);
    expect(text("siteLocationsCount")).toBe("0");
    expect(isShown("siteLocationsEmpty")).toBe(true);
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

  test("a successful remove reloads", async () => {
    renderSiteLocationsSection(makeSettings(), undefined, false);
    sendMessage.mockResolvedValue({ success: true, id: ENTRY_DUBLIN.id });
    byId("siteLocationsList").querySelector<HTMLButtonElement>(".scope-site-remove")!.click();
    await flush();
    expect(loadSettings).toHaveBeenCalled();
    expect(isShown("siteLocationsError")).toBe(false);
  });

  test("doesn't change Filters' 'Add current site' control", () => {
    renderSiteLocationsSection(makeSettings(), undefined, false);
    expect(byId("scopeAddCurrentButton").closest("#scopeListManager")).not.toBeNull();
  });
});

describe("Details readout", () => {
  test("applied: Place (host) · Zone", () => {
    renderSiteLocationDetails(makeSettings(), "https://chatgpt.com/");
    expect(text("detailSiteLocation")).toBe("Dublin (chatgpt.com) · Europe/Dublin");
  });

  test("none: uses the main location", () => {
    renderSiteLocationDetails(makeSettings(), "https://example.com/");
    expect(text("detailSiteLocation")).toBe("None. This site uses your main location.");
    renderSiteLocationDetails(makeSettings(), "about:blank");
    expect(text("detailSiteLocation")).toBe("None. This site uses your main location.");
  });
});

describe("Accessibility", () => {
  test("live status, alerts, and a labelled list", () => {
    expect(byId("thisSiteStatus").getAttribute("role")).toBe("status");
    expect(byId("thisSiteStatus").getAttribute("aria-live")).toBe("polite");
    expect(byId("thisSiteRow").getAttribute("aria-labelledby")).toBe("thisSiteHeading");
    expect(byId("siteLocationError").getAttribute("role")).toBe("alert");
    expect(byId("thisSiteError").getAttribute("role")).toBe("alert");
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

  test("every new button is a real button with text or an aria-label", () => {
    renderSiteLocationsSection(makeSettings(), undefined, false);
    const scopes = ["thisSiteRow", "siteLocationsSection"];
    for (const scope of scopes) {
      byId(scope)
        .querySelectorAll("button")
        .forEach((button) => {
          expect(button.type).toBe("button");
          const name = button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "";
          expect(name.length).toBeGreaterThan(0);
        });
    }
  });
});
