/**
 * The Settings nav bar: it replaces the tab bar while Settings is open, its
 * back row names the tab Settings was opened from, and Back or the gear
 * returns there. Runs against the real popup markup.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  __resetViewsForTest,
  gearTarget,
  getSettingsOrigin,
  showPopupView,
  wireSettingsNav,
} from "@/popup/views";

const BODY = new DOMParser().parseFromString(readFileSync("assets/popup.html", "utf8"), "text/html")
  .body.innerHTML;

const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};
const tabBar = () => document.querySelector<HTMLElement>(".tab-navigation")!;
const shownView = () =>
  ["mainView", "filtersView", "detailsView", "settingsView"].filter(
    (id) => byId(id).style.display === "block"
  );

describe("gearTarget", () => {
  test("from a tab the gear opens Settings; from Settings it returns to the origin", () => {
    expect(gearTarget("main", "main")).toBe("settings");
    expect(gearTarget("details", "main")).toBe("settings");
    expect(gearTarget("settings", "filters")).toBe("filters");
  });
});

describe("Settings nav bar", () => {
  beforeEach(() => {
    document.body.innerHTML = BODY;
    __resetViewsForTest();
    // The tab buttons' own listeners live in index.ts; wire the same calls.
    byId("mainTab").addEventListener("click", () => showPopupView("main"));
    byId("filtersTab").addEventListener("click", () => showPopupView("filters"));
    byId("detailsTab").addEventListener("click", () => showPopupView("details"));
    wireSettingsNav();
  });

  test("the origin defaults to Main", () => {
    expect(getSettingsOrigin()).toBe("main");
    byId("settingsTab").click();
    expect(byId("settingsBackLabel").textContent).toBe("Main");
    byId("settingsBack").click();
    expect(shownView()).toEqual(["mainView"]);
  });

  test("opened from Sites: the back row says Sites and the tab bar hides", () => {
    byId("filtersTab").click();
    byId("settingsTab").click();
    expect(shownView()).toEqual(["settingsView"]);
    expect(byId("settingsBackLabel").textContent).toBe("Sites");
    expect(tabBar().hidden).toBe(true);
    expect(byId("settingsTab").getAttribute("aria-current")).toBe("true");
    expect(byId("filtersTab").hasAttribute("aria-current")).toBe(false);
  });

  test("Back returns to Sites, with the tab bar and its current tab", () => {
    byId("filtersTab").click();
    byId("settingsTab").click();
    byId("settingsBack").click();
    expect(shownView()).toEqual(["filtersView"]);
    expect(tabBar().hidden).toBe(false);
    expect(byId("filtersTab").getAttribute("aria-current")).toBe("true");
    expect(byId("settingsTab").hasAttribute("aria-current")).toBe(false);
  });

  test("the gear twice returns to the origin", () => {
    byId("detailsTab").click();
    byId("settingsTab").click();
    expect(byId("settingsBackLabel").textContent).toBe("Details");
    byId("settingsTab").click();
    expect(shownView()).toEqual(["detailsView"]);
    expect(byId("detailsTab").getAttribute("aria-current")).toBe("true");
  });

  test("focus moves to the title on open, and to the gear on Back", () => {
    byId("settingsTab").click();
    expect(document.activeElement).toBe(byId("settingsTitle"));
    byId("settingsBack").focus();
    byId("settingsBack").click();
    expect(document.activeElement).toBe(byId("settingsTab"));
  });

  test("leaving Settings by another route doesn't move focus that isn't inside it", () => {
    byId("settingsTab").click();
    const outside = document.body.appendChild(document.createElement("button"));
    outside.focus();
    showPopupView("main");
    expect(document.activeElement).toBe(outside);
  });
});
