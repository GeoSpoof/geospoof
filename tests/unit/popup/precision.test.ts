/**
 * Unit tests for the popup precision control: the pure mapping helpers, and
 * the "Pick a new point" cadence control, exercised in jsdom against the real
 * `.precision-selector` markup from assets/popup.html.
 * Feature: location-precision (Task 8.3) and its cadence (GeoSpoof/geospoof#1).
 */

import { describe, test, expect, beforeEach, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import {
  cadenceUiState,
  initPrecisionCadenceControl,
  initPrecisionControl,
  optionToLocationPrecision,
  locationPrecisionToOption,
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

describe("cadenceUiState", () => {
  test("row only for approximate outside the Pro lock; hint only when not never", () => {
    expect(cadenceUiState("exact", "hour", false)).toEqual({
      rowVisible: false,
      hintVisible: false,
    });
    expect(cadenceUiState("street", "never", false)).toEqual({
      rowVisible: true,
      hintVisible: false,
    });
    for (const cadence of ["session", "hour", "day"] as const) {
      expect(cadenceUiState("city", cadence, false)).toEqual({
        rowVisible: true,
        hintVisible: true,
      });
      expect(cadenceUiState("city", cadence, true)).toEqual({
        rowVisible: false,
        hintVisible: false,
      });
    }
  });
});

/** The real `.precision-selector` markup from the shipped popup. */
const PRECISION_MARKUP = (() => {
  const html = readFileSync("assets/popup.html", "utf8");
  const section = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector(".precision-selector");
  if (!section) throw new Error(".precision-selector not found in assets/popup.html");
  return section.outerHTML;
})();

describe("cadence control in the popup (AC23)", () => {
  const byId = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} missing`);
    return el as T;
  };
  const row = () => byId<HTMLDivElement>("precisionCadenceRow");
  const hint = () => byId<HTMLDivElement>("precisionCadenceHint");
  const precision = () => byId<HTMLSelectElement>("precisionSelect");
  const cadence = () => byId<HTMLSelectElement>("precisionCadenceSelect");
  const sendMessage = (): Mock =>
    (browser.runtime as unknown as Record<string, Mock>)["sendMessage"];

  function choose(select: HTMLSelectElement, value: string): void {
    select.value = value;
    select.dispatchEvent(new Event("change"));
  }

  beforeEach(() => {
    document.body.innerHTML = PRECISION_MARKUP;
  });

  test("a labelled native select with the options in order", () => {
    expect([...cadence().options].map((o) => o.value)).toEqual(["never", "session", "hour", "day"]);
    const label = document.querySelector('label[for="precisionCadenceSelect"]');
    expect(label).not.toBeNull();
    expect(label!.textContent).toContain("Pick a new point");
    expect(cadence().closest(".precision-selector")).not.toBeNull();
  });

  test("Exact hides the row and keeps the stored cadence", () => {
    restorePrecisionControl({ mode: "exact" });
    restorePrecisionCadenceControl("hour");

    expect(row().style.display).toBe("none");
    expect(cadence().value).toBe("hour");
  });

  test("the Pro lock hides the row and disables the select", () => {
    restorePrecisionControl({ mode: "approximate", radiusMeters: 2000 }, true);
    restorePrecisionCadenceControl("hour", true);

    expect(row().style.display).toBe("none");
    expect(cadence().disabled).toBe(true);
  });

  test("switching precision shows and hides the row synchronously", () => {
    restorePrecisionControl({ mode: "exact" });
    restorePrecisionCadenceControl("never");
    initPrecisionControl();
    initPrecisionCadenceControl();
    expect(row().style.display).toBe("none");

    choose(precision(), "street");
    expect(row().style.display).toBe("block");
    expect(cadence().disabled).toBe(false);

    choose(precision(), "exact");
    expect(row().style.display).toBe("none");
  });

  test("the hint and aria-describedby toggle with the cadence, without a reload", () => {
    restorePrecisionControl({ mode: "approximate", radiusMeters: 2000 });
    restorePrecisionCadenceControl("never");
    initPrecisionControl();
    initPrecisionCadenceControl();

    expect(hint().style.display).toBe("none");
    expect(cadence().hasAttribute("aria-describedby")).toBe(false);

    choose(cadence(), "hour");
    expect(hint().style.display).toBe("block");
    expect(cadence().getAttribute("aria-describedby")).toBe("precisionCadenceHint");

    // Leaving approximate hides the hint with the row; returning restores it.
    choose(precision(), "exact");
    expect(hint().style.display).toBe("none");
    expect(cadence().hasAttribute("aria-describedby")).toBe(false);
    choose(precision(), "city");
    expect(hint().style.display).toBe("block");
    expect(cadence().getAttribute("aria-describedby")).toBe("precisionCadenceHint");

    choose(cadence(), "never");
    expect(hint().style.display).toBe("none");
    expect(cadence().hasAttribute("aria-describedby")).toBe(false);
  });

  test("a cadence change sends SET_PRECISION_CADENCE", () => {
    restorePrecisionControl({ mode: "approximate", radiusMeters: 500 });
    restorePrecisionCadenceControl("never");
    initPrecisionCadenceControl();

    choose(cadence(), "day");

    expect(sendMessage()).toHaveBeenCalledWith({
      type: "SET_PRECISION_CADENCE",
      payload: { cadence: "day" },
    });
  });

  test("an unknown stored cadence selects never", () => {
    restorePrecisionControl({ mode: "approximate", radiusMeters: 500 });
    restorePrecisionCadenceControl("page");
    expect(cadence().value).toBe("never");
  });
});
