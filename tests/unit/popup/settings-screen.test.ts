/**
 * The Settings screen's structure, against the real popup markup: groups and
 * cards in order, one Pro note, ⓘ buttons that say what they control, the
 * footer order, the Advanced group's visibility rule, and the Preserve toggle's
 * lock and payload.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { reflectEarlyProtectionState } from "@/popup/early-protection";
import { applySettingsProNote, initSettingsRows, setRowLocked } from "@/popup/settings-rows";

const HTML = readFileSync("assets/popup.html", "utf8");
const BODY = new DOMParser().parseFromString(HTML, "text/html").body.innerHTML;
const EN = JSON.parse(readFileSync("_locales/en/messages.json", "utf8")) as Record<
  string,
  { message: string }
>;

const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};

beforeEach(() => {
  document.body.innerHTML = BODY;
});

describe("Settings screen structure", () => {
  test("the nav bar, then three groups, then the footer", () => {
    const view = byId("settingsView");
    expect(view.firstElementChild!.classList.contains("nav-bar")).toBe(true);
    const content = byId("advancedContent");
    expect(Array.from(content.children).map((el) => el.id || el.className)).toEqual([
      "settingsSitesSee",
      "settingsAdvancedGroup",
      "settingsGeneralGroup",
      "settings-footer",
    ]);
  });

  test("WHAT SITES SEE: the Location card, then the Reported Language card", () => {
    const cards = Array.from(byId("settingsSitesSee").querySelectorAll(":scope > .toggle-group"));
    expect(cards.map((c) => c.id)).toEqual(["settingsLocationCard", "settingsLanguageCard"]);
    const location = byId("settingsLocationCard");
    const order = [
      "accuracySelect",
      "accuracyCustomInput",
      "precisionSelect",
      "precisionCadenceSelect",
      "preserveGeoPromptToggle",
    ];
    const positions = order.map((id) =>
      Array.from(location.querySelectorAll("select, input")).indexOf(byId(id) as HTMLInputElement)
    );
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    expect(byId("precisionCadenceRow").classList.contains("dependent-row")).toBe(true);
    expect(byId("accuracyCustomEdit").classList.contains("dependent-row")).toBe(true);
    expect(byId("localeCustomEdit").classList.contains("dependent-row")).toBe(true);
    expect(byId("verbositySelector").classList.contains("dependent-row")).toBe(true);
  });

  test("the Advanced group starts hidden and holds both browser rows", () => {
    expect(byId("settingsAdvancedGroup").hidden).toBe(true);
    const card = byId("settingsAdvancedCard");
    expect(card.contains(byId("earlyTzRow"))).toBe(true);
    expect(card.contains(byId("debuggerModeRow"))).toBe(true);
  });

  test("every value row is a label over a select named by its label span", () => {
    const rows = byId("settingsView").querySelectorAll<HTMLLabelElement>(".value-row");
    expect(rows.length).toBe(7);
    rows.forEach((row) => {
      const select = row.querySelector(":scope > select")!;
      expect(row.htmlFor).toBe(select.id);
      const labelId = select.getAttribute("aria-labelledby")!;
      expect(row.querySelector(`#${labelId}`)).not.toBeNull();
      expect(row.querySelector(".value-row-value")!.getAttribute("aria-hidden")).toBe("true");
    });
  });

  test("the custom-value inputs are named by visible labels and Set starts hidden", () => {
    expect(
      document.querySelector('label[for="accuracyCustomInput"]')!.getAttribute("data-i18n")
    ).toBe("advanced_accuracy_meters");
    expect(
      document.querySelector('label[for="localeCustomInput"]')!.getAttribute("data-i18n")
    ).toBe("advanced_locale_customTag");
    expect(byId("accuracyCustomInput").hasAttribute("aria-label")).toBe(false);
    expect((byId("accuracyCustomConfirm") as HTMLButtonElement).hidden).toBe(true);
    expect((byId("localeCustomConfirm") as HTMLButtonElement).hidden).toBe(true);
  });

  test("every ⓘ says what it controls, and no caption is a tooltip", () => {
    const infos = byId("settingsView").querySelectorAll(".info-icon");
    expect(infos.length).toBe(3);
    infos.forEach((info) => {
      expect(info.getAttribute("aria-expanded")).toBe("false");
      const target = document.getElementById(info.getAttribute("aria-controls")!);
      expect(target?.getAttribute("data-caption")).toBe("info");
    });
    expect(byId("settingsView").querySelector('[role="tooltip"]')).toBeNull();
  });

  test("errors are alerts; each card has one caption group", () => {
    for (const id of ["accuracyCustomHint", "localeCustomHint"]) {
      expect(byId(id).getAttribute("role")).toBe("alert");
      expect(byId(id).getAttribute("data-caption")).toBe("error");
    }
    expect(byId("settingsView").querySelectorAll("[data-caption-group]").length).toBe(3);
  });

  test("one Pro note in the screen, localized", () => {
    const notes = byId("settingsView").querySelectorAll(".pro-lock-note");
    expect(notes.length).toBe(1);
    expect(notes[0].id).toBe("settingsProNote");
    expect(notes[0].getAttribute("data-i18n")).toBe("settings_proNote");
  });

  test("the footer reads version, then the coffee link", () => {
    const footer = byId("advancedContent").querySelector(".settings-footer")!;
    expect(Array.from(footer.children).map((el) => el.id)).toEqual(["versionLabel", "coffeeRow"]);
  });

  test("every data-i18n key in Settings exists in en", () => {
    const keys = new Set<string>();
    byId("settingsView")
      .querySelectorAll("*")
      .forEach((el) => {
        for (const attr of el.getAttributeNames()) {
          if (attr.startsWith("data-i18n")) keys.add(el.getAttribute(attr)!);
        }
      });
    expect(keys.size).toBeGreaterThan(30);
    for (const key of keys) expect(EN[key]?.message, key).toBeTruthy();
  });

  test("no row label or option text changed", () => {
    const text = (id: string) => byId(id).textContent.replace(/\s+/g, " ").trim();
    expect(text("accuracyLabel")).toBe("Location Accuracy");
    expect(text("precisionLabel")).toBe("Location Precision");
    expect(text("precisionCadenceLabel")).toBe("Pick a new point");
    expect(text("localeLabel")).toBe("Reported Language");
    expect(text("themeLabel")).toBe("Theme");
    expect(text("languageLabel")).toBe("Language");
    expect(text("verbosityLabel")).toBe("Verbosity Level");
    const options = (id: string) =>
      Array.from((byId(id) as HTMLSelectElement).options).map((o) => o.textContent.trim());
    expect(options("accuracySelect")).toEqual(["Realistic", "Custom"]);
    expect(options("localeSelect")).toEqual([
      "Off (use real)",
      "Match my location",
      "Choose language…",
    ]);
  });
});

describe("the Advanced group on Firefox", () => {
  const original = (browser as unknown as { permissions?: unknown }).permissions;
  afterEach(() => {
    (browser as unknown as { permissions?: unknown }).permissions = original;
  });

  test("stays hidden without the permissions API", async () => {
    (browser as unknown as { permissions?: unknown }).permissions = undefined;
    await reflectEarlyProtectionState();
    expect(byId("settingsAdvancedGroup").hidden).toBe(true);
    expect(byId("earlyTzRow").style.display).toBe("none");
  });

  test("shows with it, along with the row", async () => {
    (browser as unknown as { permissions?: unknown }).permissions = {
      contains: vi.fn().mockResolvedValue(true),
      request: vi.fn(),
      remove: vi.fn(),
    };
    await reflectEarlyProtectionState();
    expect(byId("settingsAdvancedGroup").hidden).toBe(false);
    expect(byId("earlyTzRow").style.display).toBe("");
    expect((byId("earlyTzToggle") as HTMLInputElement).checked).toBe(true);
  });
});

describe("Preserve location prompts", () => {
  test("locked: aria-disabled, the Pro note shown, and a click changes nothing", () => {
    initSettingsRows();
    const toggle = byId("preserveGeoPromptToggle") as HTMLInputElement;
    const spy = vi.fn();
    toggle.addEventListener("change", spy);
    setRowLocked(toggle, true);
    applySettingsProNote(true);
    expect(byId("settingsProNote").hidden).toBe(false);
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.getAttribute("aria-describedby")).toBe("settingsProNote");
    expect(toggle.disabled).toBe(false);
    toggle.click();
    expect(toggle.checked).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  test("its handler still sends SET_PRESERVE_GEO_PROMPT { enabled }", () => {
    const indexTs = readFileSync("src/popup/index.ts", "utf8");
    expect(indexTs).toMatch(
      /getElementById\("preserveGeoPromptToggle"\)[\s\S]{0,300}type: "SET_PRESERVE_GEO_PROMPT",\s*payload: \{ enabled \}/
    );
  });
});
