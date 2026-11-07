/**
 * Filters tab navigation (design H): a root and three screens, one shown at a
 * time; focus to the title on open and back to the opener on the way back;
 * back rows that name where they return; Escape; locked rows that stay
 * focusable but inert. jsdom against the real assets/popup.html markup.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  __resetFiltersNavForTest,
  backFromFiltersScreen,
  getFiltersScreen,
  onFiltersScreenChange,
  openFiltersScreen,
  setFiltersScreenBackHandler,
  setFiltersScreenFallback,
  wireButtonRow,
  wireFiltersNavOnce,
  type FiltersScreen,
} from "@/popup/filters-nav";

const BODY = (() => {
  const html = readFileSync("assets/popup.html", "utf8");
  return new DOMParser().parseFromString(html, "text/html").body.innerHTML;
})();

const SCREENS: Record<FiltersScreen, string> = {
  root: "filtersRoot",
  list: "scopeListScreen",
  perSite: "siteLocationsScreen",
  editor: "siteLocationEditorScreen",
};

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
}

/** The ids of the screens showing. */
function shown(): string[] {
  return Object.values(SCREENS).filter((id) => !byId(id).hidden);
}

function escapeOn(node: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  node.dispatchEvent(event);
  return event;
}

function backLabel(): string {
  return byId("siteLocationEditorBackLabel").textContent ?? "";
}

beforeEach(() => {
  document.body.innerHTML = BODY;
  // Shown as index.ts's tab switch shows it, so focus can land inside.
  byId("mainView").style.display = "none";
  byId("filtersView").style.display = "block";
  // The list's row shows in a list mode.
  byId("scopeListCard").hidden = false;
  __resetFiltersNavForTest();
  // Every test registers what it needs.
  setFiltersScreenBackHandler("editor", () => backFromFiltersScreen());
  for (const screen of ["list", "perSite", "editor"] as const) {
    setFiltersScreenFallback(screen, () => null);
  }
  wireFiltersNavOnce();
});

describe("screens", () => {
  test("the markup starts on the root, with the other screens hidden", () => {
    expect(getFiltersScreen()).toBe("root");
    expect(shown()).toEqual(["filtersRoot"]);
  });

  test.each<[FiltersScreen, string]>([
    ["list", "scopeListTitle"],
    ["perSite", "siteLocationsTitle"],
    ["editor", "siteLocationEditorTitle"],
  ])("opening %s hides the others and focuses its title", (screen, titleId) => {
    openFiltersScreen(screen, { opener: byId("scopeListRow") });
    expect(getFiltersScreen()).toBe(screen);
    expect(shown()).toEqual([SCREENS[screen]]);
    expect(document.activeElement).toBe(byId(titleId));
  });

  test("the caller can name where focus goes instead", () => {
    openFiltersScreen("editor", { opener: null, focus: byId("siteLocationSearch") });
    expect(document.activeElement).toBe(byId("siteLocationSearch"));
  });

  test("the back row and Escape return to the root, with focus on the opener", () => {
    const row = byId("scopeListRow");
    openFiltersScreen("list", { opener: row });
    byId("scopeListBack").click();
    expect(shown()).toEqual(["filtersRoot"]);
    expect(document.activeElement).toBe(row);

    const perSiteRow = byId("siteLocationsRow");
    openFiltersScreen("perSite", { opener: perSiteRow });
    escapeOn(byId("siteLocationsTitle"));
    expect(shown()).toEqual(["filtersRoot"]);
    expect(document.activeElement).toBe(perSiteRow);
  });

  test("an opener that's gone hands focus to the screen's fallback", () => {
    const opener = document.createElement("button");
    byId("filtersRoot").appendChild(opener);
    openFiltersScreen("list", { opener });
    opener.remove();
    setFiltersScreenFallback("list", () => byId("scopeListRow"));
    escapeOn(byId("scopeListTitle"));
    expect(document.activeElement).toBe(byId("scopeListRow"));
  });

  test("going back without restoring focus leaves focus alone", () => {
    openFiltersScreen("list", { opener: byId("scopeListRow") });
    backFromFiltersScreen({ restoreFocus: false });
    expect(shown()).toEqual(["filtersRoot"]);
    expect(document.activeElement).not.toBe(byId("scopeListRow"));
  });

  test("Escape does nothing on the root, or when something inside already handled it", () => {
    expect(escapeOn(byId("scopeModeAll")).defaultPrevented).toBe(false);
    expect(shown()).toEqual(["filtersRoot"]);

    openFiltersScreen("list", { opener: byId("scopeListRow") });
    const input = byId("scopeAddInput");
    input.addEventListener("keydown", (e) => {
      e.preventDefault();
    });
    escapeOn(input);
    expect(shown()).toEqual(["scopeListScreen"]);
  });

  test("a screen's own back handler runs instead of the plain way back", () => {
    const handler = vi.fn();
    setFiltersScreenBackHandler("editor", handler);
    openFiltersScreen("editor", { opener: null, editorOrigin: "perSite" });
    escapeOn(byId("siteLocationEditorTitle"));
    byId("siteLocationEditorBack").click();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(shown()).toEqual(["siteLocationEditorScreen"]);
  });

  test("listeners hear every change, with the editor's origin", () => {
    const heard: unknown[] = [];
    const stop = onFiltersScreenChange((change) => heard.push(change));
    openFiltersScreen("perSite", { opener: byId("siteLocationsRow") });
    openFiltersScreen("editor", { opener: null, editorOrigin: "perSite" });
    backFromFiltersScreen();
    stop();
    backFromFiltersScreen();
    expect(heard).toEqual([
      { screen: "perSite", editorOrigin: null },
      { screen: "editor", editorOrigin: "perSite" },
      { screen: "perSite", editorOrigin: null },
    ]);
  });
});

describe("the editor returns to where it was opened from", () => {
  test.each<["root" | "perSite" | "main", string]>([
    ["root", "Filters"],
    ["perSite", "Per-site locations"],
    ["main", "Main"],
  ])("from %s its back row reads '‹ %s'", (origin, label) => {
    openFiltersScreen("editor", { opener: null, editorOrigin: origin });
    expect(backLabel()).toBe(label);
    expect(byId("siteLocationEditorBack").textContent?.replace(/\s+/g, " ").trim()).toBe(
      `‹ ${label}`
    );
    expect(byId("siteLocationEditorBack").querySelector("[aria-hidden='true']")?.textContent).toBe(
      "‹ "
    );
  });

  test("from the root, back is the root", () => {
    openFiltersScreen("editor", { opener: byId("siteLocationsRow"), editorOrigin: "root" });
    byId("siteLocationEditorBack").click();
    expect(shown()).toEqual(["filtersRoot"]);
    expect(document.activeElement).toBe(byId("siteLocationsRow"));
  });

  test("from Per-site locations, back is that screen, and back again is the root", () => {
    const row = byId("siteLocationsRow");
    openFiltersScreen("perSite", { opener: row });
    const add = byId("siteLocationsAddButton");
    openFiltersScreen("editor", { opener: add, editorOrigin: "perSite" });
    escapeOn(byId("siteLocationPatterns"));
    expect(shown()).toEqual(["siteLocationsScreen"]);
    expect(document.activeElement).toBe(add);
    escapeOn(add);
    expect(shown()).toEqual(["filtersRoot"]);
    expect(document.activeElement).toBe(row);
  });

  test("from Main, back shows the root underneath and lands on the Main tab's Edit", () => {
    const toMain = vi.fn(() => {
      byId("filtersView").style.display = "none";
      byId("mainView").style.display = "block";
    });
    byId("mainTab").addEventListener("click", toMain);
    byId("siteLocationLine").hidden = false;
    const edit = byId("siteLocationLineEdit");

    openFiltersScreen("editor", { opener: edit, editorOrigin: "main" });
    escapeOn(byId("siteLocationEditorTitle"));
    expect(toMain).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual(["filtersRoot"]);
    expect(document.activeElement).toBe(edit);

    // The next editor starts from its own origin.
    openFiltersScreen("editor", { opener: null });
    expect(backLabel()).toBe("Filters");
  });
});

describe("rows that open a screen", () => {
  test("Enter, Space and click activate; Space doesn't scroll", () => {
    const row = byId("scopeListRow");
    const onActivate = vi.fn();
    wireButtonRow(row, onActivate);
    row.click();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    row.dispatchEvent(space);
    expect(onActivate).toHaveBeenCalledTimes(3);
    expect(space.defaultPrevented).toBe(true);
    // Other keys pass through.
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  test("a locked row stays a Tab stop but ignores Enter, Space and click", () => {
    const row = byId("siteLocationsRow");
    const onActivate = vi.fn();
    wireButtonRow(row, onActivate);
    row.setAttribute("aria-disabled", "true");
    row.click();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(onActivate).not.toHaveBeenCalled();
    expect(row.getAttribute("tabindex")).toBe("0");
  });
});
