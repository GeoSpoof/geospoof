/**
 * jsdom tests for the popup accuracy control, against the real WHAT SITES SEE
 * markup from assets/popup.html.
 *
 * Selecting "Custom" shows the always-visible Meters field, pre-filled with the
 * resolved accuracy, and sends nothing. "Set" shows only while the field
 * differs from the committed value; the value commits ONLY on Set or Enter.
 * An unusable value is rejected: nothing is sent, the field is marked invalid,
 * and the hint becomes the Location card's caption, outranking its others.
 * Presets apply immediately and hide the Meters row.
 *
 * Validates: Requirements 9.2, 9.3
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { initAccuracyControl, restoreAccuracyControl } from "@/popup/accuracy";
import { initSettingsRows } from "@/popup/settings-rows";
import { wireInfoButtons } from "@/popup/settings-captions";

const SITES_SEE_MARKUP = (() => {
  const html = readFileSync("assets/popup.html", "utf8");
  const section = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector("#settingsSitesSee");
  if (!section) throw new Error("#settingsSitesSee not found in assets/popup.html");
  return section.outerHTML;
})();

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};
const select = () => byId<HTMLSelectElement>("accuracySelect");
const input = () => byId<HTMLInputElement>("accuracyCustomInput");
const confirm = () => byId<HTMLButtonElement>("accuracyCustomConfirm");
const editRow = () => byId("accuracyCustomEdit");
const hint = () => byId("accuracyCustomHint");
const valueText = () => select().closest(".value-row")!.querySelector(".value-row-text")!;

/** Select an option and fire the `change` event the control listens for. */
function selectOption(value: string): void {
  select().value = value;
  select().dispatchEvent(new Event("change", { bubbles: true }));
}

/** Type into the field, firing `input` as a keystroke would. */
function type(value: string): void {
  input().value = value;
  input().dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEnter(): void {
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

/** Spy on the mocked `browser.runtime.sendMessage`. */
function sendSpy() {
  return browser.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
}

/** The caption the Location card shows now. */
function shownCaptions(): string[] {
  return Array.from(byId("settingsLocationCaptions").children)
    .filter((el) => !(el as HTMLElement).hidden)
    .map((el) => el.id);
}

describe("accuracy control: Meters field, Set and validation (jsdom)", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="advancedContent">${SITES_SEE_MARKUP}</div>`;
    initSettingsRows();
    wireInfoButtons(document.getElementById("advancedContent"));
    initAccuracyControl();
  });

  it("Custom pre-fills the resolved value, shows Set and sends nothing", () => {
    restoreAccuracyControl({ mode: "auto" }, 72);
    expect(editRow().style.display).toBe("none");
    selectOption("custom");
    expect(input().value).toBe("72");
    expect(editRow().style.display).toBe("block");
    expect(confirm().hidden).toBe(false);
    expect(valueText().textContent).toBe("Custom");
    expect(sendSpy()).not.toHaveBeenCalled();
  });

  it("Set commits with the SET_ACCURACY payload, then hides; the field keeps the value", () => {
    restoreAccuracyControl({ mode: "auto" }, 50);
    selectOption("custom");
    type("250");
    confirm().focus();
    confirm().click();
    expect(sendSpy()).toHaveBeenCalledTimes(1);
    expect(sendSpy()).toHaveBeenCalledWith({
      type: "SET_ACCURACY",
      payload: { accuracySetting: { mode: "fixed", meters: 250 } },
    });
    expect(confirm().hidden).toBe(true);
    expect(input().value).toBe("250");
    // Set disappeared, so focus moves to the field rather than the body.
    expect(document.activeElement).toBe(input());
  });

  it("Enter commits and rounds a fractional value", () => {
    restoreAccuracyControl({ mode: "auto" }, 50);
    selectOption("custom");
    type("12.6");
    pressEnter();
    expect(sendSpy()).toHaveBeenCalledWith({
      type: "SET_ACCURACY",
      payload: { accuracySetting: { mode: "fixed", meters: 13 } },
    });
    expect(input().value).toBe("13");
    expect(confirm().hidden).toBe(true);
  });

  it("editing back to the committed value hides Set again", () => {
    restoreAccuracyControl({ mode: "fixed", meters: 25 }, 25);
    type("30");
    expect(confirm().hidden).toBe(false);
    type("25");
    expect(confirm().hidden).toBe(true);
  });

  it("restoring a fixed setting shows the field with the value and Set hidden", () => {
    restoreAccuracyControl({ mode: "fixed", meters: 25 }, 25);
    expect(select().value).toBe("custom");
    expect(editRow().style.display).toBe("block");
    expect(input().value).toBe("25");
    expect(confirm().hidden).toBe(true);
    expect(valueText().textContent).toBe("Custom");
  });

  it.each(["0", "10001", "", "abc"])(
    "rejects %j: nothing sent, field invalid, error caption",
    (raw) => {
      restoreAccuracyControl({ mode: "auto" }, 50);
      selectOption("custom");
      sendSpy().mockClear();
      input().value = raw;
      pressEnter();
      expect(sendSpy()).not.toHaveBeenCalled();
      expect(input().classList.contains("invalid")).toBe(true);
      expect(input().getAttribute("aria-invalid")).toBe("true");
      expect(input().getAttribute("aria-describedby")).toBe("accuracyCustomHint");
      expect(hint().getAttribute("role")).toBe("alert");
      // The error outranks the precision hint: it's the one caption shown.
      expect(shownCaptions()).toEqual(["accuracyCustomHint"]);
      // Typing clears it, and the standing caption comes back.
      type("5");
      expect(input().classList.contains("invalid")).toBe(false);
      expect(input().hasAttribute("aria-invalid")).toBe(false);
      expect(shownCaptions()).toEqual(["precisionHint"]);
    }
  );

  it("an error closes an open ⓘ and owns the caption", () => {
    restoreAccuracyControl({ mode: "auto" }, 50);
    selectOption("custom");
    const info = byId<HTMLButtonElement>("preserveGeoPromptInfo");
    info.click();
    expect(shownCaptions()).toEqual(["preserveGeoPromptTooltip"]);
    input().value = "0";
    pressEnter();
    expect(shownCaptions()).toEqual(["accuracyCustomHint"]);
    expect(info.getAttribute("aria-expanded")).toBe("false");
  });

  it("Realistic hides the row and sends { mode: 'auto' }", () => {
    restoreAccuracyControl({ mode: "fixed", meters: 25 }, 25);
    selectOption("realistic");
    expect(editRow().style.display).toBe("none");
    expect(sendSpy()).toHaveBeenCalledWith({
      type: "SET_ACCURACY",
      payload: { accuracySetting: { mode: "auto" } },
    });
    expect(valueText().textContent).toBe("Realistic");
  });

  it("locked: Realistic, aria-disabled (not disabled), and a change sends nothing", () => {
    restoreAccuracyControl({ mode: "fixed", meters: 25 }, 25, true);
    expect(select().value).toBe("realistic");
    expect(select().getAttribute("aria-disabled")).toBe("true");
    expect(select().getAttribute("aria-describedby")).toBe("settingsProNote");
    expect(select().disabled).toBe(false);
    expect(select().closest(".value-row")!.classList.contains("is-locked")).toBe(true);
    expect(editRow().style.display).toBe("none");
    selectOption("custom");
    expect(select().value).toBe("realistic");
    expect(editRow().style.display).toBe("none");
    expect(sendSpy()).not.toHaveBeenCalled();
    // Unlocking restores normal interaction.
    restoreAccuracyControl({ mode: "auto" }, 25, false);
    expect(select().hasAttribute("aria-disabled")).toBe(false);
    expect(select().closest(".value-row")!.classList.contains("is-locked")).toBe(false);
  });
});
