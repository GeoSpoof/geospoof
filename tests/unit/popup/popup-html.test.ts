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

  test("the root: the heading names the mode group, and the two drill rows", () => {
    const tabs = document.getElementById("scopeModeTabs")!;
    expect(tabs.getAttribute("role")).toBe("radiogroup");
    expect(tabs.getAttribute("aria-labelledby")).toBe("scopeModeHeading");
    expect(tabs.getAttribute("aria-describedby")).toBe("scopeModeDesc");
    expect(tabs.hasAttribute("aria-label")).toBe(false);
    expect(document.getElementById("scopeModeHeading")?.textContent?.trim()).toBe(
      "Where GeoSpoof works"
    );
    for (const id of ["scopeListRow", "siteLocationsRow"]) {
      const row = document.getElementById(id)!;
      expect(row.classList.contains("drill-row")).toBe(true);
      expect(row.getAttribute("role")).toBe("button");
      expect(row.getAttribute("tabindex")).toBe("0");
    }
    expect(document.getElementById("siteLocationsCard")?.classList).toContain(
      "drill-card-separate"
    );
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
