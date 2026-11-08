/**
 * Settings tab extraction + the Language & Locale entry in "Key Overrides".
 *
 * The controls that used to sit behind the "Advanced" accordion inside the
 * Details tab now live in their own Settings tab — Details had grown too long to
 * scan. These tests pin the wiring that a type-checker can't see: the markup ids
 * the view-switcher toggles, the fact that every control survived the move, and
 * that the accordion is genuinely gone rather than left orphaned.
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildApiGroups } from "@/popup/ui";
import { __resetViewsForTest, wireSettingsNav } from "@/popup/views";

const html = readFileSync("assets/popup.html", "utf8");
const indexTs = readFileSync("src/popup/index.ts", "utf8");
const viewsTs = readFileSync("src/popup/views.ts", "utf8");
const css = readFileSync("assets/popup.css", "utf8");
const messages = JSON.parse(readFileSync("_locales/en/messages.json", "utf8")) as Record<
  string,
  { message: string; description?: string }
>;

describe("Settings view + header gear trigger", () => {
  test("the trigger and its view both exist", () => {
    expect(html).toContain('id="settingsTab"');
    expect(html).toContain('id="settingsView"');
    // Must be a real tab-content pane so the shared show/hide logic applies.
    expect(html).toMatch(/<div class="tab-content" id="settingsView"/);
  });

  test("the view switcher knows about all four views", () => {
    for (const id of ["mainTab", "filtersTab", "detailsTab", "settingsTab"]) {
      expect(viewsTs, id).toContain(id);
    }
    for (const id of ["mainView", "filtersView", "detailsView", "settingsView"]) {
      expect(viewsTs, id).toContain(id);
    }
    // Iteration is over POPUP_VIEWS (asserted as the single source of truth in
    // its own test below), so there's no separate tuple to keep in step.
  });

  test("the gear opens Settings", () => {
    document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
    __resetViewsForTest();
    wireSettingsNav();
    document.getElementById("settingsTab")!.click();
    expect(document.getElementById("settingsView")!.style.display).toBe("block");
    expect(document.getElementById("mainView")!.style.display).toBe("none");
    expect(document.getElementById("settingsTab")!.getAttribute("aria-current")).toBe("true");
    expect(indexTs).toContain("wireSettingsNav()");
  });

  test("Settings is NOT in the tab bar - the bar stays at three labels", () => {
    // The point of the gear: Main/Filters/Details are views onto the current
    // spoofing state, Settings is app config, and four labels crowded the 350px bar.
    const navStart = html.indexOf('class="tab-navigation"');
    const navMarkup = html.slice(navStart, html.indexOf("<!-- Main View -->", navStart));
    expect(navMarkup).toContain('id="mainTab"');
    expect(navMarkup).toContain('id="filtersTab"');
    expect(navMarkup).toContain('id="detailsTab"');
    expect(navMarkup).not.toContain('id="settingsTab"');
    expect((navMarkup.match(/class="nav-tab/g) ?? []).length).toBe(3);
  });

  test("the gear lives in the header's grouped right side", () => {
    // Grouping matters: a third direct child of the space-between header would
    // have centred the status badge instead of leaving it right-aligned.
    expect(html).toContain('class="header-actions"');
    const group = html.slice(
      html.indexOf('class="header-actions"'),
      html.indexOf("<!-- Tab Navigation -->")
    );
    expect(group).toContain('id="statusBadge"');
    expect(group).toContain('id="settingsTab"');
  });

  test("all four triggers share one state mechanism: aria-current", () => {
    // While Settings is open no tab is current, so the gear must carry its own
    // indicator. aria-current (not aria-pressed) because this is one-of-N view
    // selection, not a binary toggle — and one attribute drives both the visual
    // state and what assistive tech announces, so they can't drift apart.
    expect(html).toMatch(/id="mainTab"[\s\S]{0,80}aria-current="true"/);
    expect(viewsTs).toContain('setAttribute("aria-current", "true")');
    expect(viewsTs).toContain('removeAttribute("aria-current")');
    expect(css).toContain(".nav-tab[aria-current]");
    expect(css).toContain(".header-gear[aria-current]");
    // aria-pressed would be the wrong semantic here; make sure no element
    // actually carries it. Matched as an attribute rather than a bare word, since
    // the word legitimately appears in comments explaining the choice.
    expect(html).not.toMatch(/aria-pressed\s*=/);
    expect(indexTs).not.toMatch(/"aria-pressed"/);
    expect(viewsTs).not.toMatch(/"aria-pressed"/);
  });

  test("no separate .active class shadowing the aria state", () => {
    // Two mechanisms for one piece of state is how they get out of sync.
    expect(css).not.toContain(".nav-tab.active");
    expect(indexTs).not.toMatch(/classList\.toggle\("active"/);
  });

  test("the view list is a single source of truth", () => {
    // It used to live in three parallel lists (trigger map, panel map, iteration
    // tuple); missing one failed silently — the view rendered but never hid its
    // siblings.
    expect(viewsTs).toContain("const POPUP_VIEWS");
    expect(viewsTs).toContain("Object.entries(POPUP_VIEWS)");
    expect(indexTs).not.toContain("const POPUP_VIEWS");
    for (const v of ["main", "filters", "details", "settings"]) {
      expect(viewsTs, v).toContain(`${v}: { trigger:`);
    }
  });

  test("keyboard focus is visible on every trigger", () => {
    expect(css).toContain(".nav-tab:focus-visible");
    expect(css).toContain(".header-gear:focus-visible");
  });

  test("the gear's current-state fill meets non-text contrast (WCAG 1.4.11)", () => {
    // white on --brand is 2.78:1 (fails the 3:1 minimum); white on --brand-hover
    // is 3.29:1 (passes). Pin the passing token so a well-meaning "use the brand
    // colour" tidy-up can't silently reintroduce the failure.
    const i = css.indexOf(".header-gear[aria-current] {");
    const rule = css.slice(i, css.indexOf("}", i));
    expect(rule).toContain("var(--brand-hover)");
    expect(rule).not.toMatch(/background:\s*var\(--brand\)/);
  });

  test("motion respects prefers-reduced-motion (WCAG 2.3.3)", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("transitions are enumerated, not `all`", () => {
    // `transition: all` animates every property added later, including layout
    // ones — a perf trap and a source of surprising motion.
    const i = css.indexOf(".nav-tab {");
    const rule = css.slice(i, css.indexOf("}", i));
    expect(rule).not.toContain("transition: all");
  });

  test("the gear is accessible without a visible label", () => {
    const idAt = html.indexOf('id="settingsTab"');
    // Slice from the opening <button so attributes declared before the id
    // (type, class) are included.
    const gear = html.slice(html.lastIndexOf("<button", idAt), html.indexOf("</button>", idAt));
    // Tooltip for sighted users, action-phrased label for screen readers, both
    // localized; decorative glyph hidden from the a11y tree.
    expect(gear).toContain('data-i18n-title="tab_settings"');
    expect(gear).toContain('data-i18n-aria-label="tab_settings_ariaLabel"');
    expect(gear).toContain('aria-hidden="true"');
    expect(gear).toContain('focusable="false"');
    // A native <button> keeps it keyboard-operable and in the tab order for free.
    expect(gear).toContain('type="button"');
  });

  test("the Advanced accordion is fully removed, not orphaned", () => {
    // Both the button and its handler must go together - a leftover handler
    // referencing a removed element is dead code that silently does nothing.
    expect(html).not.toContain("advanced-toggle");
    expect(html).not.toContain('id="advancedToggle"');
    expect(indexTs).not.toContain("advancedToggle");
  });

  test("both gear strings are localized with translator notes", () => {
    for (const key of ["tab_settings", "tab_settings_ariaLabel"]) {
      expect(messages[key], key).toBeDefined();
      expect(messages[key].message.length, key).toBeGreaterThan(0);
      expect(messages[key].description, key).toBeTruthy();
    }
  });

  test("the tab bar keeps its roomy three-tab proportions", () => {
    // Reverted from the cramped 4-tab values (6px / 13px) now that Settings has
    // moved out. The nowrap/ellipsis translation insurance stays.
    const i = css.indexOf(".nav-tab {");
    const navTab = css.slice(i, css.indexOf("}", i));
    expect(navTab).toContain("padding: 10px 16px");
    expect(navTab).toContain("font-size: 14px");
    expect(navTab).toContain("text-overflow: ellipsis");
  });
});

describe("every Advanced control survived the move into Settings", () => {
  // A silent drop during the block move would be easy to miss by eye, since the
  // Settings tab would still look plausible with a control missing.
  const CONTROL_IDS = [
    // Toggles
    "preserveGeoPromptToggle",
    "earlyTzToggle",
    "debuggerModeToggle",
    "debugLoggingToggle",
    // Selects
    "accuracySelect",
    "localeSelect",
    "themeSelect",
    "languageSelect",
    "verbosityLevel",
    // Randomize location: its row, its screen, Distance and Pick a new point
    "randomizeRow",
    "randomizeScreen",
    "randomizeDistanceCard",
    "precisionCadenceSelect",
    // Reported Language sub-controls
    "localeCustomEdit",
    "localeCustomInput",
    "localeSuggestions",
    "localeCustomConfirm",
    "localeCustomHint",
    "localeWarning",
    // Accuracy sub-controls
    "accuracyCustomInput",
    "accuracyCustomConfirm",
    "accuracyCustomHint",
    // The one Pro note, the nav bar, the Advanced group, and the footer
    "settingsProNote",
    "settingsBack",
    "settingsTitle",
    "settingsAdvancedGroup",
    "versionLabel",
  ];

  test.each(CONTROL_IDS)("%s is present", (id) => {
    expect(html).toContain(`id="${id}"`);
  });

  test("the settings controls sit inside settingsView, not detailsView", () => {
    const settingsStart = html.indexOf('id="settingsView"');
    const detailsStart = html.indexOf('id="detailsView"');
    expect(settingsStart).toBeGreaterThan(-1);
    expect(detailsStart).toBeGreaterThan(-1);
    // Details comes first, and the controls must land after the Settings marker.
    expect(detailsStart).toBeLessThan(settingsStart);
    for (const id of [
      "localeSelect",
      "accuracySelect",
      "randomizeRow",
      "randomizeScreen",
      "precisionCadenceSelect",
      "themeSelect",
    ]) {
      expect(html.indexOf(`id="${id}"`), id).toBeGreaterThan(settingsStart);
    }
  });

  test("Details keeps its read-only rows", () => {
    // The move must not have taken the actual details with it.
    const settingsStart = html.indexOf('id="settingsView"');
    for (const id of ["detailLocation", "detailTimezone", "detailWebRTC", "detailAPIs"]) {
      const at = html.indexOf(`id="${id}"`);
      expect(at, id).toBeGreaterThan(-1);
      expect(at, `${id} should still be in the Details tab`).toBeLessThan(settingsStart);
    }
  });
});

describe("Language & Locale group in Key Overrides", () => {
  const ids = (hasLocale: boolean): string[] =>
    buildApiGroups(true, true, true, hasLocale).map((g) => g.id);

  test("appears only when a locale is actually active", () => {
    // `off` is the default and overrides nothing, so listing the group would
    // misrepresent what's in effect.
    expect(ids(false)).not.toContain("locale");
    expect(ids(true)).toContain("locale");
  });

  test("lists the surfaces the feature actually overrides", () => {
    const group = buildApiGroups(true, true, true, true).find((g) => g.id === "locale");
    expect(group).toBeDefined();
    for (const api of [
      "navigator.language",
      "navigator.languages",
      "Accept-Language (request header)",
      "Intl.NumberFormat()",
      "Intl.Collator()",
      "String.prototype.localeCompare()",
    ]) {
      expect(group!.apis, api).toContain(api);
    }
  });

  test("does not claim surfaces the feature deliberately leaves native", () => {
    // supportedLocalesOf / getCanonicalLocales report engine capability, not user
    // preference, and are passed through unchanged — claiming them would be a
    // false advertisement in the UI.
    const group = buildApiGroups(true, true, true, true).find((g) => g.id === "locale");
    const joined = group!.apis.join(" ");
    expect(joined).not.toContain("supportedLocalesOf");
    expect(joined).not.toContain("getCanonicalLocales");
  });

  test("its heading is localized", () => {
    expect(messages.details_section_locale).toBeDefined();
    expect(messages.details_section_locale.description).toBeTruthy();
  });

  test("the other groups are unaffected by the new parameter", () => {
    // buildApiGroups gained a trailing arg; existing callers must behave as before.
    expect(buildApiGroups(true, true, true)).toEqual(buildApiGroups(true, true, true, false));
  });
});
