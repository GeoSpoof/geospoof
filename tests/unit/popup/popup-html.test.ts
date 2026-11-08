/**
 * Unit tests for popup HTML structure
 * Validates: Requirements 4.1, 5.1
 */

import fs from "fs";
import path from "path";

describe("Popup HTML Structure", () => {
  let document: Document;

  beforeEach(() => {
    // Load popup.html
    const html = fs.readFileSync(path.join(__dirname, "../../../assets/popup.html"), "utf8");
    document = new DOMParser().parseFromString(html, "text/html");
  });

  test("should have header with title and status badge", () => {
    const header = document.querySelector(".header");
    expect(header).toBeTruthy();

    const title = document.querySelector(".header h1");
    expect(title).toBeTruthy();
    expect(title!.textContent).toBe("GeoSpoof");

    const statusBadge = document.getElementById("statusBadge");
    expect(statusBadge).toBeTruthy();

    const statusText = document.getElementById("statusText");
    expect(statusText).toBeTruthy();
  });

  test("should have protection toggle element", () => {
    const protectionToggle = document.querySelector<HTMLInputElement>("#protectionToggle");
    expect(protectionToggle).toBeTruthy();
    expect(protectionToggle!.type).toBe("checkbox");
  });

  test("should have current location display section", () => {
    const currentLocation = document.getElementById("currentLocation");
    expect(currentLocation).toBeTruthy();

    const locationIcon = document.querySelector(".location-icon");
    expect(locationIcon).toBeTruthy();

    const locationName = document.getElementById("locationName");
    expect(locationName).toBeTruthy();

    const locationCoords = document.getElementById("locationCoords");
    expect(locationCoords).toBeTruthy();
  });

  test("should have location picker input field", () => {
    const locationSearch = document.querySelector<HTMLInputElement>("#locationSearch");
    expect(locationSearch).toBeTruthy();
    expect(locationSearch!.type).toBe("text");
    expect(locationSearch!.placeholder).toContain("Search");

    const searchResults = document.getElementById("searchResults");
    expect(searchResults).toBeTruthy();
  });

  test("should have manual coordinate inputs", () => {
    const latitudeInput = document.querySelector<HTMLInputElement>("#latitudeInput");
    expect(latitudeInput).toBeTruthy();
    expect(latitudeInput!.type).toBe("number");
    expect(latitudeInput!.min).toBe("-90");
    expect(latitudeInput!.max).toBe("90");

    const longitudeInput = document.querySelector<HTMLInputElement>("#longitudeInput");
    expect(longitudeInput).toBeTruthy();
    expect(longitudeInput!.type).toBe("number");
    expect(longitudeInput!.min).toBe("-180");
    expect(longitudeInput!.max).toBe("180");

    const setButton = document.getElementById("setManualCoords");
    expect(setButton).toBeTruthy();
    expect(setButton!.tagName).toBe("BUTTON");
  });

  test("should have WebRTC protection toggle", () => {
    const webrtcToggle = document.querySelector<HTMLInputElement>("#webrtcToggle");
    expect(webrtcToggle).toBeTruthy();
    expect(webrtcToggle!.type).toBe("checkbox");
  });

  test("should have warning message element", () => {
    const warningMessage = document.getElementById("warningMessage");
    expect(warningMessage).toBeTruthy();
    expect(warningMessage!.style.display).toBe("none");
  });

  test("the Filters tab is a root and three screens, only the root shown", () => {
    const screens = Array.from(document.querySelectorAll("#filtersView > .filters-screen"));
    expect(screens.map((screen) => screen.id)).toEqual([
      "filtersRoot",
      "scopeListScreen",
      "siteLocationsScreen",
      "siteLocationEditorScreen",
    ]);
    expect(screens.filter((screen) => !screen.hasAttribute("hidden")).map((s) => s.id)).toEqual([
      "filtersRoot",
    ]);
    // Each screen below the root has a back row and a script-focusable title.
    for (const screen of screens.slice(1)) {
      expect(screen.firstElementChild?.matches("button.back-row"), screen.id).toBe(true);
      const title = screen.querySelector(".view-title");
      expect(title?.getAttribute("tabindex"), screen.id).toBe("-1");
      expect(screen.querySelector(".back-row [aria-hidden='true']")?.textContent).toBe("‹ ");
    }
    expect(
      document.getElementById("siteLocationEditor")?.closest("#siteLocationEditorScreen")
    ).not.toBeNull();
  });

  test("the root: SITE RULES and one card with two rows; the Filters screen holds the mode", () => {
    const tabs = document.getElementById("scopeModeTabs")!;
    expect(tabs.getAttribute("role")).toBe("radiogroup");
    expect(tabs.getAttribute("aria-labelledby")).toBe("scopeModeHeading");
    expect(tabs.getAttribute("aria-describedby")).toBe("scopeModeDesc");
    expect(tabs.hasAttribute("aria-label")).toBe(false);
    expect(document.getElementById("scopeModeHeading")?.textContent?.trim()).toBe("Filter mode");
    const card = document.getElementById("filtersRootRows")!;
    expect(card.classList.contains("site-card")).toBe(true);
    // SITE RULES heads the card as a real heading; the mode lives on the Filters screen.
    const rules = document.getElementById("siteRulesHeading")!;
    expect(rules.tagName).toBe("H2");
    expect(rules.classList).toContain("section-heading");
    expect(rules.textContent?.trim()).toBe("Site rules");
    expect(rules.nextElementSibling).toBe(card);
    const root = document.getElementById("filtersRoot")!;
    const screen = document.getElementById("scopeListScreen")!;
    for (const id of ["scopeModeHeading", "scopeModeTabs", "scopeModeDesc", "scopeProNote"]) {
      expect(root.contains(document.getElementById(id)), id).toBe(false);
      expect(screen.contains(document.getElementById(id)), id).toBe(true);
    }
    expect(document.getElementById("scopeListRowTitle")?.textContent?.trim()).toBe("Filters");
    for (const id of ["scopeListRow", "siteLocationsRow"]) {
      const row = document.getElementById(id)!;
      // The This site card's row component: label, then the count and a ›.
      expect(row.classList.contains("site-row")).toBe(true);
      expect(row.closest("#filtersRootRows")).toBe(card);
      expect(row.querySelector(".site-row-line .site-row-host")).not.toBeNull();
      expect(
        row.querySelector(".site-row-trail .site-row-value.count")?.getAttribute("aria-hidden")
      ).toBe("true");
      expect(row.querySelector(".site-row-trail .site-row-chev")?.getAttribute("aria-hidden")).toBe(
        "true"
      );
      expect(row.getAttribute("role")).toBe("button");
      expect(row.getAttribute("tabindex")).toBe("0");
      expect(row.getAttribute("aria-describedby")).toBe(`${id}Desc`);
      expect(document.getElementById(`${id}Desc`)?.classList).toContain("visually-hidden");
    }
    expect(document.querySelector(".drill-row, .drill-card")).toBeNull();
  });

  test("the root starts with the This site card, whose button, hint and error are static", () => {
    const root = document.getElementById("filtersRoot")!;
    const section = document.getElementById("thisSiteSection")!;
    expect(section.parentElement).toBe(root);
    expect(section.previousElementSibling?.id).toBe("scopeLoadError");
    expect(section.hasAttribute("hidden")).toBe(true);
    expect(section.querySelector(".section-heading")?.getAttribute("data-i18n")).toBe(
      "filters_thisSite"
    );
    const actions = document.getElementById("thisSiteActions")!;
    expect(actions.closest("#thisSiteCard.site-card")).not.toBeNull();
    expect(Array.from(actions.children).map((child) => child.id)).toEqual([
      "thisSiteReason",
      "thisSiteButton",
      "thisSiteReloadHint",
      "thisSiteError",
    ]);
    expect(document.querySelector<HTMLButtonElement>("#thisSiteButton")!.type).toBe("button");
    expect(document.getElementById("thisSiteReloadHint")!.getAttribute("tabindex")).toBe("-1");
    expect(document.getElementById("thisSiteError")!.getAttribute("role")).toBe("alert");
    expect(document.getElementById("siteLocationAddToAllowlist")).toBeNull();
    expect(document.getElementById("siteLocationFiltersAction")?.tagName).toBe("BUTTON");
  });

  test("one Pro note, localized, for Filters and per-site locations together", () => {
    const notes = document.querySelectorAll(".pro-lock-note[data-i18n='siteLocation_proNote']");
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe("scopeProNote");
    expect(document.getElementById("siteLocationsProNote")).toBeNull();
  });

  test("no menus and none of the old list chrome in the Filters tab", () => {
    const filters = document.getElementById("filtersView")!;
    expect(filters.querySelector("select")).toBeNull();
    for (const id of [
      "scopeListManager",
      "scopeListHeader",
      "scopeListCount",
      "scopeAddCurrentButton",
      "scopeCurrentMsg",
      "siteLocationsDisclosure",
      "siteLocationsAddRow",
    ]) {
      expect(document.getElementById(id), id).toBeNull();
    }
    expect(filters.querySelector("hr, details.site-locations-disclosure")).toBeNull();
  });

  test("should link popup.css and popup.js", () => {
    const cssLink = document.querySelector('link[href="popup.css"]');
    expect(cssLink).toBeTruthy();

    const jsScript = document.querySelector('script[src="popup.js"]');
    expect(jsScript).toBeTruthy();
  });
});
