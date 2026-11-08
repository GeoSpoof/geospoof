/**
 * Unit tests for Randomize location: the pure mapping and summary helpers,
 * and its Settings row, screen, Distance list and "Pick a new point" picker,
 * exercised in jsdom against the real `#settingsView` markup from
 * assets/popup.html.
 * Feature: location-precision (Task 8.3) and its cadence (GeoSpoof/geospoof#1).
 */

import { describe, test, expect, beforeEach, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import {
  __resetPrecisionForTest,
  cadenceUiState,
  initPrecisionCadenceControl,
  initPrecisionControl,
  optionToLocationPrecision,
  locationPrecisionToOption,
  randomizeSummary,
  resetRandomizeScreen,
  restorePrecisionCadenceControl,
  restorePrecisionControl,
  type PrecisionOption,
} from "@/popup/precision";
import type { LocationPrecision } from "@/shared/types/settings";

describe("optionToLocationPrecision", () => {
  test("exact maps to { mode: 'exact' }", () => {
    expect(optionToLocationPrecision("exact")).toEqual({ mode: "exact" });
  });

  test("approximate options map to their preset radii", () => {
    expect(optionToLocationPrecision("street")).toEqual({
      mode: "approximate",
      radiusMeters: 500,
    });
    expect(optionToLocationPrecision("neighborhood")).toEqual({
      mode: "approximate",
      radiusMeters: 2000,
    });
    expect(optionToLocationPrecision("city")).toEqual({
      mode: "approximate",
      radiusMeters: 10000,
    });
  });
});

describe("locationPrecisionToOption", () => {
  test("exact / missing / unknown → 'exact'", () => {
    expect(locationPrecisionToOption({ mode: "exact" })).toBe("exact");
    expect(locationPrecisionToOption(undefined)).toBe("exact");
    expect(locationPrecisionToOption(null)).toBe("exact");
  });

  test("exact preset radii map back to their option", () => {
    expect(locationPrecisionToOption({ mode: "approximate", radiusMeters: 500 })).toBe("street");
    expect(locationPrecisionToOption({ mode: "approximate", radiusMeters: 2000 })).toBe(
      "neighborhood"
    );
    expect(locationPrecisionToOption({ mode: "approximate", radiusMeters: 10000 })).toBe("city");
  });

  test("off-preset radii snap to the nearest option", () => {
    expect(locationPrecisionToOption({ mode: "approximate", radiusMeters: 700 })).toBe("street");
    expect(locationPrecisionToOption({ mode: "approximate", radiusMeters: 1500 })).toBe(
      "neighborhood"
    );
    expect(locationPrecisionToOption({ mode: "approximate", radiusMeters: 8000 })).toBe("city");
  });
});

describe("round-trip", () => {
  test("every option survives option → setting → option", () => {
    const options: PrecisionOption[] = ["exact", "street", "neighborhood", "city"];
    for (const option of options) {
      const setting: LocationPrecision = optionToLocationPrecision(option);
      expect(locationPrecisionToOption(setting)).toBe(option);
    }
  });
});

describe("randomizeSummary", () => {
  test("Off for Exact, whatever the cadence", () => {
    expect(randomizeSummary("exact", "never")).toBe("Off");
    expect(randomizeSummary("exact", "hour")).toBe("Off");
  });

  test("the distance alone under Never", () => {
    expect(randomizeSummary("street", "never")).toBe("0.5 km");
    expect(randomizeSummary("neighborhood", "never")).toBe("2 km");
    expect(randomizeSummary("city", "never")).toBe("10 km");
  });

  test("the distance and the cadence otherwise", () => {
    expect(randomizeSummary("neighborhood", "hour")).toBe("2 km · Hourly");
    expect(randomizeSummary("street", "session")).toBe("0.5 km · Each session");
    expect(randomizeSummary("city", "day")).toBe("10 km · Daily");
  });

  test("Off under the Pro lock", () => {
    expect(randomizeSummary("neighborhood", "hour", true)).toBe("Off");
  });
});

describe("cadenceUiState", () => {
  test("row only for approximate outside the Pro lock", () => {
    expect(cadenceUiState("exact", false)).toEqual({ rowVisible: false });
    expect(cadenceUiState("exact", true)).toEqual({ rowVisible: false });
    for (const option of ["street", "neighborhood", "city"] as const) {
      expect(cadenceUiState(option, false)).toEqual({ rowVisible: true });
      expect(cadenceUiState(option, true)).toEqual({ rowVisible: false });
    }
  });
});

/** The real Settings view from the shipped popup. */
const SETTINGS_MARKUP = (() => {
  const html = readFileSync("assets/popup.html", "utf8");
  const view = new DOMParser().parseFromString(html, "text/html").querySelector("#settingsView");
  if (!view) throw new Error("#settingsView not found in assets/popup.html");
  return view.outerHTML;
})();

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};
const row = () => byId("randomizeRow");
const screen = () => byId("randomizeScreen");
const newPoint = () => byId("randomizeNewPointGroup");
const cadence = () => byId<HTMLSelectElement>("precisionCadenceSelect");
const radios = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[name="randomizeDistance"]'));
const radio = (value: string) => radios().find((r) => r.value === value)!;
const checked = () => radios().find((r) => r.checked)?.value;
const value = () => byId("randomizeValue").textContent;
const sendMessage = (): Mock => (browser.runtime as unknown as Record<string, Mock>)["sendMessage"];

function choose(select: HTMLSelectElement, v: string): void {
  select.value = v;
  select.dispatchEvent(new Event("change"));
}
function pick(v: string): void {
  radio(v).click();
}
function key(target: HTMLElement, k: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}
function restore(precision: LocationPrecision, cadenceValue: unknown, locked = false): void {
  restorePrecisionControl(precision, locked);
  restorePrecisionCadenceControl(cadenceValue, locked);
}

beforeEach(() => {
  document.body.innerHTML = SETTINGS_MARKUP;
  byId("settingsView").style.display = "block";
  __resetPrecisionForTest();
  initPrecisionControl();
  initPrecisionCadenceControl();
});

describe("the Randomize location screen's markup", () => {
  test("Distance is a labelled radiogroup with the four options in order", () => {
    const group = byId("randomizeDistanceCard");
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-labelledby")).toBe("randomizeHeadingDistance");
    expect(radios().map((r) => r.value)).toEqual(["exact", "street", "neighborhood", "city"]);
    expect(
      radios().map((r) => r.closest("label")!.textContent.replace(/\s+/g, " ").trim())
    ).toEqual(["Off (exact)", "Within 0.5 km", "Within 2 km", "Within 10 km"]);
  });

  test("New point holds the labelled Pick a new point picker, options unchanged", () => {
    expect(newPoint().contains(cadence())).toBe(true);
    expect([...cadence().options].map((o) => o.value)).toEqual(["never", "session", "hour", "day"]);
    expect([...cadence().options].map((o) => o.textContent.trim())).toEqual([
      "Never",
      "Each browser session",
      "Every hour",
      "Every day",
    ]);
    const label = document.querySelector('label[for="precisionCadenceSelect"]');
    expect(label!.textContent).toContain("Pick a new point");
  });

  test("one caption, after both sections; a nav bar back to Settings", () => {
    const children = Array.from(screen().children);
    expect(children.map((c) => c.id || c.className)).toEqual([
      "nav-bar",
      "randomizeDistanceGroup",
      "randomizeNewPointGroup",
      "randomizeCaption",
    ]);
    expect(screen().querySelectorAll(".settings-caption").length).toBe(1);
    expect(byId("randomizeBack").textContent).toContain("Settings");
    expect(byId("randomizeTitle").textContent.trim()).toBe("Randomize location");
  });

  test("the root row is a named button described by its value", () => {
    expect(row().getAttribute("role")).toBe("button");
    expect(row().tabIndex).toBe(0);
    expect(row().getAttribute("aria-labelledby")).toBe("randomizeLabel");
    expect(row().getAttribute("aria-describedby")).toBe("randomizeRowDesc");
    expect(byId("randomizeLabel").textContent.trim()).toBe("Randomize location");
  });
});

describe("restoring", () => {
  test("Exact checks Off, hides New point, keeps the stored cadence; the row reads Off", () => {
    restore({ mode: "exact" }, "hour");
    expect(checked()).toBe("exact");
    expect(newPoint().hidden).toBe(true);
    expect(cadence().value).toBe("hour");
    expect(value()).toBe("Off");
  });

  test("an approximate setting checks its distance; the row sums up both", () => {
    restore({ mode: "approximate", radiusMeters: 2000 }, "hour");
    expect(checked()).toBe("neighborhood");
    expect(newPoint().hidden).toBe(false);
    expect(value()).toBe("2 km · Hourly");
    expect(byId("randomizeRowDesc").textContent).toBe("2 km, Hourly");
  });

  test("an unknown stored cadence selects never", () => {
    restore({ mode: "approximate", radiusMeters: 500 }, "page");
    expect(cadence().value).toBe("never");
    expect(value()).toBe("0.5 km");
  });
});

describe("the screen", () => {
  test("a click on the row opens it, hides the Settings root and focuses the title", () => {
    restore({ mode: "exact" }, "never");
    row().click();
    expect(screen().hidden).toBe(false);
    expect(byId("advancedContent").hidden).toBe(true);
    expect(byId("settingsNavBar").hidden).toBe(true);
    expect(document.activeElement?.id).toBe("randomizeTitle");
  });

  test.each(["Enter", " "])("%j on the row opens it", (k) => {
    restore({ mode: "exact" }, "never");
    row().focus();
    key(row(), k);
    expect(screen().hidden).toBe(false);
  });

  test("Back returns to the root with focus on the row", () => {
    restore({ mode: "exact" }, "never");
    row().click();
    byId("randomizeBack").click();
    expect(screen().hidden).toBe(true);
    expect(byId("advancedContent").hidden).toBe(false);
    expect(byId("settingsNavBar").hidden).toBe(false);
    expect(document.activeElement?.id).toBe("randomizeRow");
  });

  test("Escape returns too", () => {
    restore({ mode: "exact" }, "never");
    row().click();
    key(radio("exact"), "Escape");
    expect(screen().hidden).toBe(true);
    expect(document.activeElement?.id).toBe("randomizeRow");
  });

  test("resetRandomizeScreen shows the root without moving focus", () => {
    restore({ mode: "exact" }, "never");
    row().click();
    resetRandomizeScreen();
    expect(screen().hidden).toBe(true);
    expect(byId("advancedContent").hidden).toBe(false);
    expect(document.activeElement?.id).toBe("randomizeTitle");
  });
});

describe("choosing", () => {
  test("each distance sends SET_PRECISION and updates New point and the row at once", () => {
    restore({ mode: "exact" }, "never");
    row().click();
    const cases: Array<[string, LocationPrecision, string]> = [
      ["street", { mode: "approximate", radiusMeters: 500 }, "0.5 km"],
      ["neighborhood", { mode: "approximate", radiusMeters: 2000 }, "2 km"],
      ["city", { mode: "approximate", radiusMeters: 10000 }, "10 km"],
      ["exact", { mode: "exact" }, "Off"],
    ];
    for (const [option, precision, shown] of cases) {
      sendMessage().mockClear();
      pick(option);
      expect(sendMessage()).toHaveBeenCalledWith({ type: "SET_PRECISION", payload: { precision } });
      expect(newPoint().hidden).toBe(option === "exact");
      expect(value()).toBe(shown);
    }
  });

  test("a cadence change sends SET_PRECISION_CADENCE and updates the row", () => {
    restore({ mode: "approximate", radiusMeters: 500 }, "never");
    choose(cadence(), "day");
    expect(sendMessage()).toHaveBeenCalledWith({
      type: "SET_PRECISION_CADENCE",
      payload: { cadence: "day" },
    });
    expect(value()).toBe("0.5 km · Daily");
    expect(cadence().hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("the Pro lock", () => {
  test("the row is aria-disabled, reads Off, is described by the Pro note and doesn't open", () => {
    restore({ mode: "approximate", radiusMeters: 2000 }, "hour", true);
    expect(row().getAttribute("aria-disabled")).toBe("true");
    expect(row().classList.contains("is-locked")).toBe(true);
    expect(row().getAttribute("aria-describedby")).toBe("randomizeRowDesc settingsProNote");
    expect(row().tabIndex).toBe(0);
    expect(value()).toBe("Off");
    expect(checked()).toBe("exact");
    expect(newPoint().hidden).toBe(true);
    expect(cadence().disabled).toBe(true);

    row().click();
    key(row(), "Enter");
    expect(screen().hidden).toBe(true);
    expect(sendMessage()).not.toHaveBeenCalled();
  });

  test("a lock that arrives while the screen is open closes it", () => {
    restore({ mode: "approximate", radiusMeters: 2000 }, "hour");
    row().click();
    restore({ mode: "approximate", radiusMeters: 2000 }, "hour", true);
    expect(screen().hidden).toBe(true);
  });

  test("unlocking restores the row", () => {
    restore({ mode: "exact" }, "never", true);
    restore({ mode: "approximate", radiusMeters: 10000 }, "session");
    expect(row().hasAttribute("aria-disabled")).toBe(false);
    expect(row().classList.contains("is-locked")).toBe(false);
    expect(row().getAttribute("aria-describedby")).toBe("randomizeRowDesc");
    expect(value()).toBe("10 km · Each session");
  });
});
