/**
 * Settings rows: the mirrored value of a value row, the custom-value dirty
 * rule, and locked-row semantics (aria-disabled, never disabled; changes
 * suppressed before the control's own handler runs).
 */
import { describe, test, expect, beforeEach, vi } from "vitest";
import {
  initSettingsRows,
  isCustomValueDirty,
  setRowLocked,
  syncValueRow,
  applySettingsProNote,
  revealSettingsGroup,
} from "@/popup/settings-rows";

function mount(): void {
  document.body.innerHTML = `
    <div id="advancedContent">
      <section id="group" hidden></section>
      <section>
        <p id="settingsProNote" hidden>🔒 Pro</p>
        <div class="toggle-group">
          <label class="value-row" for="pick">
            <span class="value-row-label" id="pickLabel">Pick</span>
            <span class="value-row-value" aria-hidden="true"><span class="value-row-text"></span></span>
            <select id="pick" aria-labelledby="pickLabel">
              <option value="a">Alpha</option>
              <option value="b">Beta</option>
            </select>
          </label>
          <div class="toggle-section">
            <label class="toggle-label" for="sw">
              <span class="label-with-info"><span>Switch</span>
                <button type="button" class="info-icon" id="swInfo">ⓘ</button></span>
              <span class="toggle-wrapper"><input type="checkbox" id="sw" /></span>
            </label>
          </div>
        </div>
      </section>
    </div>`;
  initSettingsRows();
}

const pick = () => document.getElementById("pick") as HTMLSelectElement;
const sw = () => document.getElementById("sw") as HTMLInputElement;
const text = () => document.querySelector(".value-row-text")!.textContent;

describe("isCustomValueDirty", () => {
  test("equal to the committed value is clean", () => {
    expect(isCustomValueDirty("25", "25")).toBe(false);
  });
  test("surrounding whitespace doesn't count", () => {
    expect(isCustomValueDirty("  25 ", "25")).toBe(false);
  });
  test("a different value is dirty", () => {
    expect(isCustomValueDirty("30", "25")).toBe(true);
  });
  test("with nothing committed, any text is dirty and empty is clean", () => {
    expect(isCustomValueDirty("fr-FR", null)).toBe(true);
    expect(isCustomValueDirty("", null)).toBe(false);
  });
});

describe("syncValueRow", () => {
  beforeEach(mount);

  test("mirrors the selected option's text", () => {
    pick().value = "b";
    syncValueRow(pick());
    expect(text()).toBe("Beta");
  });

  test("dataset.valueLabel wins over the option text", () => {
    pick().dataset.valueLabel = "Français (France)";
    syncValueRow(pick());
    expect(text()).toBe("Français (France)");
  });

  test("a change re-syncs the row without the control's own handler", () => {
    pick().value = "b";
    pick().dispatchEvent(new Event("change", { bubbles: true }));
    expect(text()).toBe("Beta");
  });
});

describe("locked rows", () => {
  beforeEach(mount);

  test("a locked select is aria-disabled, described by the Pro note, and still focusable", () => {
    setRowLocked(pick(), true, "a");
    expect(pick().getAttribute("aria-disabled")).toBe("true");
    expect(pick().getAttribute("aria-describedby")).toBe("settingsProNote");
    expect(pick().disabled).toBe(false);
    expect(pick().closest(".value-row")!.classList.contains("is-locked")).toBe(true);
    pick().focus();
    expect(document.activeElement).toBe(pick());
  });

  test("a change on a locked select is reverted and never reaches its listener", () => {
    const spy = vi.fn();
    pick().addEventListener("change", spy);
    setRowLocked(pick(), true, "a");
    pick().value = "b";
    pick().dispatchEvent(new Event("change", { bubbles: true }));
    expect(spy).not.toHaveBeenCalled();
    expect(pick().value).toBe("a");
    expect(text()).toBe("Alpha");
  });

  test("keys other than Tab are cancelled on a locked control", () => {
    setRowLocked(pick(), true, "a");
    const arrow = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    pick().dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(true);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    pick().dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });

  test("a locked switch doesn't toggle on click, on its label or itself", () => {
    const spy = vi.fn();
    sw().addEventListener("change", spy);
    setRowLocked(sw(), true);
    sw().click();
    expect(sw().checked).toBe(false);
    (document.querySelector('label[for="sw"]') as HTMLLabelElement).click();
    expect(sw().checked).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  test("the ⓘ in a locked row still works", () => {
    setRowLocked(sw(), true);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.getElementById("swInfo")!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  test("unlocking restores normal interaction", () => {
    setRowLocked(sw(), true);
    setRowLocked(sw(), false);
    expect(sw().hasAttribute("aria-disabled")).toBe(false);
    expect(sw().hasAttribute("aria-describedby")).toBe(false);
    expect(sw().closest(".toggle-section")!.classList.contains("is-locked")).toBe(false);
    sw().click();
    expect(sw().checked).toBe(true);
  });

  test("the Pro note and a hidden group can be shown", () => {
    applySettingsProNote(true);
    expect(document.getElementById("settingsProNote")!.hidden).toBe(false);
    applySettingsProNote(false);
    expect(document.getElementById("settingsProNote")!.hidden).toBe(true);
    revealSettingsGroup("group");
    expect(document.getElementById("group")!.hidden).toBe(false);
  });
});
