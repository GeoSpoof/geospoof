/**
 * Unit tests for the popup Reported Language control's pure helpers.
 * Feature: locale-spoofing (Task 15.4) — Requirements 3.2, 3.3, 3.4, 13.5, 13.9
 * The last block drives the control in jsdom against the real markup.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  initLocaleControl,
  restoreLocaleControl,
  optionToLocaleSpoofing,
  localeSpoofingToControlState,
  isUsableLocaleTag,
  describeTag,
  type LocaleOption,
} from "@/popup/locale";
import { LOCALE_SUGGESTIONS, endonymForTag, labelForTag } from "@/popup/locale-suggestions";
import { initSettingsRows } from "@/popup/settings-rows";
import type { LocaleSpoofing } from "@/shared/types/settings";
import { canonicalizeTag, engineSupportsLocale } from "@/shared/locale/resolver";

describe("optionToLocaleSpoofing", () => {
  test("off and match map to their bare modes", () => {
    expect(optionToLocaleSpoofing("off")).toEqual({ mode: "off" });
    expect(optionToLocaleSpoofing("match")).toEqual({ mode: "match" });
  });

  test("custom canonicalizes the typed tag", () => {
    // Casing and surrounding whitespace are user typos, not distinct locales.
    expect(optionToLocaleSpoofing("custom", "fr-FR")).toEqual({ mode: "custom", locale: "fr-FR" });
    expect(optionToLocaleSpoofing("custom", "fr-fr")).toEqual({ mode: "custom", locale: "fr-FR" });
    expect(optionToLocaleSpoofing("custom", "  ja  ")).toEqual({ mode: "custom", locale: "ja" });
  });

  test("custom returns null for an unusable tag so nothing is persisted", () => {
    // Returning null is what lets the control show its hint instead of saving a
    // value that would never take effect.
    for (const bad of ["", "   ", "!!!", "en_US", "toolongsubtagvalue", "xx-ZZ"]) {
      expect(optionToLocaleSpoofing("custom", bad), bad).toBeNull();
    }
    expect(optionToLocaleSpoofing("custom", undefined)).toBeNull();
  });

  test("an unknown option falls back to off", () => {
    expect(optionToLocaleSpoofing("bogus" as LocaleOption)).toEqual({ mode: "off" });
  });
});

describe("localeSpoofingToControlState", () => {
  test("restores each mode to its option", () => {
    expect(localeSpoofingToControlState({ mode: "off" })).toEqual({
      option: "off",
      customTag: null,
    });
    expect(localeSpoofingToControlState({ mode: "match" })).toEqual({
      option: "match",
      customTag: null,
    });
    expect(localeSpoofingToControlState({ mode: "custom", locale: "fr-FR" })).toEqual({
      option: "custom",
      customTag: "fr-FR",
    });
  });

  test("absent or unrecognized settings fall back to off", () => {
    expect(localeSpoofingToControlState(undefined)).toEqual({ option: "off", customTag: null });
    expect(localeSpoofingToControlState(null)).toEqual({ option: "off", customTag: null });
    expect(localeSpoofingToControlState({ mode: "wobble" } as unknown as LocaleSpoofing)).toEqual({
      option: "off",
      customTag: null,
    });
  });

  test("round-trips a committed custom tag", () => {
    const setting = optionToLocaleSpoofing("custom", "de-DE")!;
    const { option, customTag } = localeSpoofingToControlState(setting);
    expect(option).toBe("custom");
    expect(customTag).toBe("de-DE");
    expect(optionToLocaleSpoofing("custom", customTag!)).toEqual(setting);
  });
});

describe("isUsableLocaleTag", () => {
  test("accepts well-formed tags this engine supports", () => {
    for (const good of ["fr-FR", "ja", "pt-BR", "en-GB"]) {
      expect(isUsableLocaleTag(good), good).toBe(true);
    }
  });

  test("rejects malformed tags", () => {
    for (const bad of ["", "   ", "!!!", "en_US"]) {
      expect(isUsableLocaleTag(bad), bad).toBe(false);
    }
  });

  test("rejects a well-formed tag the engine has no data for", () => {
    // Structurally valid but unsupported. Accepting it would let ICU silently
    // fall back, leaving navigator.language contradicting actual formatting.
    expect(canonicalizeTag("xx-ZZ")).not.toBeNull();
    expect(engineSupportsLocale("xx-ZZ")).toBe(false);
    expect(isUsableLocaleTag("xx-ZZ")).toBe(false);
  });

  test("agrees with what optionToLocaleSpoofing will accept", () => {
    // The control uses isUsableLocaleTag to decide whether to show the hint and
    // optionToLocaleSpoofing to build the value; if they disagreed the UI could
    // reject a tag it then saved, or vice versa.
    for (const tag of ["fr-FR", "ja", "xx-ZZ", "!!!", "en_US", "de-DE"]) {
      expect(isUsableLocaleTag(tag), tag).toBe(optionToLocaleSpoofing("custom", tag) !== null);
    }
  });
});

describe("describeTag / labelForTag", () => {
  test("a suggested tag gets a human label", () => {
    expect(describeTag("fr-FR")).toContain("fr-FR");
    expect(describeTag("fr-FR")).toContain("French (France)");
    expect(describeTag("fr-FR")).toContain("Français (France)");
  });

  test("an English locale is not shown twice", () => {
    // english === endonym for these, so the label must not read
    // "English (United States) — English (United States)".
    expect(labelForTag("en-US")).toBe("English (United States)");
  });

  test("a freely typed tag falls back to the bare tag rather than a guess", () => {
    expect(labelForTag("gl-ES")).not.toBeNull(); // in the list
    expect(labelForTag("fr-BE")).toBeNull(); // valid, but not suggested
    expect(describeTag("fr-BE")).toBe("fr-BE");
  });

  test("label lookup is case-insensitive", () => {
    expect(labelForTag("FR-fr")).toBe(labelForTag("fr-FR"));
  });
});

describe("suggestion list integrity", () => {
  test("every suggested tag is canonical and supported by this engine", () => {
    // A suggestion the engine can't honor would be a trap: the user picks it
    // from the dropdown and the control then rejects it.
    for (const s of LOCALE_SUGGESTIONS) {
      expect(canonicalizeTag(s.tag), s.tag).toBe(s.tag);
      expect(engineSupportsLocale(s.tag), s.tag).toBe(true);
      expect(isUsableLocaleTag(s.tag), s.tag).toBe(true);
    }
  });

  test("no duplicate tags", () => {
    const tags = LOCALE_SUGGESTIONS.map((s) => s.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  test("every suggestion carries both names", () => {
    for (const s of LOCALE_SUGGESTIONS) {
      expect(s.english.length, s.tag).toBeGreaterThan(0);
      expect(s.endonym.length, s.tag).toBeGreaterThan(0);
    }
  });

  test("suggestions are region-qualified except where a bare language is intended", () => {
    // Region-qualified tags make the number/date formats a site sees
    // unambiguous rather than leaving ICU to guess a likely region.
    for (const s of LOCALE_SUGGESTIONS) {
      expect(s.tag, s.tag).toMatch(/^[a-z]{2,3}-[A-Z]{2}$/);
    }
  });
});

describe("localization wiring", () => {
  // A typo'd data-i18n key doesn't throw — the element just keeps its hardcoded
  // English fallback, so the bug is invisible in the default locale and only
  // shows up as untranslated text for everyone else. This pins the control's
  // keys to the catalog so that can't happen silently.
  test("every data-i18n key on the Reported Language control exists in en/messages.json", async () => {
    const fs = await import("node:fs");
    const html = fs.readFileSync("assets/popup.html", "utf8");
    const messages = JSON.parse(fs.readFileSync("_locales/en/messages.json", "utf8")) as Record<
      string,
      { message: string; description?: string }
    >;

    const keys = [...html.matchAll(/data-i18n(?:-aria-label)?="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((k) => k.startsWith("advanced_locale"));

    // Guard against the regex silently matching nothing if the markup changes.
    expect(keys.length).toBeGreaterThanOrEqual(9);

    for (const key of keys) {
      expect(messages[key], `missing message key: ${key}`).toBeDefined();
      expect(messages[key].message.length, key).toBeGreaterThan(0);
      // The repo's convention is that every entry carries a translator note.
      expect(messages[key].description, `missing description: ${key}`).toBeTruthy();
    }
  });

  test("the control's markup ids match the ones locale.ts queries", async () => {
    const fs = await import("node:fs");
    const html = fs.readFileSync("assets/popup.html", "utf8");
    for (const id of [
      "localeSelect",
      "localeCustomEdit",
      "localeCustomInput",
      "localeSuggestions",
      "localeCustomConfirm",
      "localeCustomHint",
      "localeWarning",
    ]) {
      expect(html, `missing element id: ${id}`).toContain(`id="${id}"`);
    }
  });

  test("the input is wired to the datalist so typeahead actually works", async () => {
    const fs = await import("node:fs");
    const html = fs.readFileSync("assets/popup.html", "utf8");
    expect(html).toContain('list="localeSuggestions"');
  });
});

describe("endonymForTag", () => {
  test("a suggested tag's own name, case-insensitively", () => {
    expect(endonymForTag("FR-fr")).toBe("Français (France)");
  });
  test("null for a tag that isn't a suggestion", () => {
    expect(endonymForTag("fr-BE")).toBeNull();
  });
});

describe("Reported Language control in the popup (jsdom)", () => {
  const markup = (() => {
    const html = readFileSync("assets/popup.html", "utf8");
    const section = new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector("#settingsSitesSee");
    if (!section) throw new Error("#settingsSitesSee not found");
    return section.outerHTML;
  })();
  const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const select = () => byId<HTMLSelectElement>("localeSelect");
  const input = () => byId<HTMLInputElement>("localeCustomInput");
  const confirm = () => byId<HTMLButtonElement>("localeCustomConfirm");
  const valueText = () => select().closest(".value-row")!.querySelector(".value-row-text")!;
  const shown = () =>
    Array.from(byId("settingsLanguageCaptions").children)
      .filter((el) => !(el as HTMLElement).hidden)
      .map((el) => el.id);
  const send = () => browser.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
  function choose(value: string): void {
    select().value = value;
    select().dispatchEvent(new Event("change", { bubbles: true }));
  }
  function type(value: string): void {
    input().value = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  }
  function enter(): void {
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }

  beforeEach(() => {
    document.body.innerHTML = `<div id="advancedContent">${markup}</div>`;
    initSettingsRows();
    initLocaleControl();
  });

  test("Off shows the standing hint; Match sends match and shows the warning instead", () => {
    restoreLocaleControl({ mode: "off" });
    expect(shown()).toEqual(["localeHint"]);
    choose("match");
    expect(send()).toHaveBeenCalledWith({
      type: "SET_LOCALE_SPOOFING",
      payload: { localeSpoofing: { mode: "match" } },
    });
    expect(shown()).toEqual(["localeWarning"]);
  });

  test("committing fr-FR sends it, hides Set, and shows the language's own name", () => {
    restoreLocaleControl({ mode: "off" });
    choose("custom");
    expect(byId("localeCustomEdit").style.display).toBe("block");
    expect(send()).not.toHaveBeenCalled();
    expect(valueText().textContent).toBe("Choose language…");
    type("fr-FR");
    expect(confirm().hidden).toBe(false);
    confirm().click();
    expect(send()).toHaveBeenCalledWith({
      type: "SET_LOCALE_SPOOFING",
      payload: { localeSpoofing: { mode: "custom", locale: "fr-FR" } },
    });
    expect(confirm().hidden).toBe(true);
    expect(valueText().textContent).toBe("Français (France)");
    expect(shown()).toEqual(["localeWarning"]);
  });

  test("a tag that isn't a suggestion shows as the bare tag", () => {
    restoreLocaleControl({ mode: "custom", locale: "fr-BE" });
    expect(input().value).toBe("fr-BE");
    expect(confirm().hidden).toBe(true);
    expect(valueText().textContent).toBe("fr-BE");
  });

  test("an unusable tag sends nothing, and its error outranks the warning", () => {
    restoreLocaleControl({ mode: "custom", locale: "fr-FR" });
    expect(shown()).toEqual(["localeWarning"]);
    type("not a tag!");
    enter();
    expect(send()).not.toHaveBeenCalled();
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(input().classList.contains("invalid")).toBe(true);
    expect(shown()).toEqual(["localeCustomHint"]);
    type("ja");
    expect(shown()).toEqual(["localeWarning"]);
  });

  test("locked: Off, aria-disabled, and a change is reverted without sending", () => {
    restoreLocaleControl({ mode: "match" }, true);
    expect(select().value).toBe("off");
    expect(select().getAttribute("aria-disabled")).toBe("true");
    expect(select().disabled).toBe(false);
    choose("match");
    expect(select().value).toBe("off");
    expect(send()).not.toHaveBeenCalled();
    expect(valueText().textContent).toBe("Off (use real)");
  });
});
