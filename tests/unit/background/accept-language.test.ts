/**
 * Accept-Language header alignment.
 * Feature: locale-spoofing (Task 13.5) — Requirements 5.1, 5.4, 10.1, 10.5, 10.6, 15.4
 *
 * The invariant under test is the one that makes this feature safe rather than
 * harmful: the header value and the JS-reported locale must be two projections
 * of ONE decision. A browser claiming `fr-FR` from `navigator.language` while
 * sending `Accept-Language: en-US` is visibly tampered with — a stronger
 * fingerprinting signal than not spoofing at all — so "header agrees with
 * payload" is the property that matters most here.
 */

import { describe, test, expect } from "vitest";
import type { Settings } from "@/shared/types/settings";
import { MAX_SITE_LOCATIONS } from "@/shared/types/settings";
import {
  ACCEPT_LANGUAGE_RULE_IDS,
  planAcceptLanguageRules,
  resolveAcceptLanguageFor,
  usesPerTabRules,
} from "@/background/accept-language";
import { resolveLocale, resolvePageLocale } from "@/shared/locale/resolver";
import { ENTRY_DUBLIN, ENTRY_MEXICO_CITY } from "../../helpers/site-locations";

function makeSettings(overrides?: Partial<Settings>): Settings {
  return {
    enabled: true,
    location: { latitude: 48.8566, longitude: 2.3522, accuracy: 42 },
    timezone: { identifier: "Europe/Paris", offset: -60, dstOffset: 60 },
    locationName: { city: "Paris", country: "France", displayName: "Paris, France" },
    webrtcProtection: false,
    preserveGeolocationPrompt: false,
    onboardingCompleted: true,
    version: "1.2",
    lastUpdated: Date.now(),
    vpnSyncEnabled: false,
    debuggerModeEnabled: false,
    autoSyncBlocked: false,
    proFeaturesBlocked: false,
    debugLogging: false,
    verbosityLevel: "INFO",
    theme: "system",
    uiLanguage: "",
    favorites: [],
    scopeMode: "all",
    allowlist: [],
    denylist: [],
    accuracySetting: { mode: "auto" },
    accuracySeed: 777,
    locationPrecision: { mode: "exact" },
    precisionSeed: 123456789,
    precisionCadence: "never" as const,
    localeSpoofing: { mode: "off" as const },
    siteLocations: [],
    ...overrides,
  };
}

const PAGE = "https://example.com/page";

describe("header agrees with the page payload (Req 5.1)", () => {
  test("the header leads with the same tag the page world is told to report", () => {
    for (const setting of [
      { mode: "custom" as const, locale: "fr-FR" },
      { mode: "custom" as const, locale: "ja" },
      { mode: "match" as const },
    ]) {
      const s = makeSettings({ localeSpoofing: setting });

      const header = resolveAcceptLanguageFor(s, PAGE);
      const payload = resolvePageLocale(
        s.localeSpoofing,
        s.timezone?.identifier ?? null,
        s.proFeaturesBlocked
      );

      expect(header).not.toBeNull();
      expect(payload).not.toBeNull();
      // The header must begin with exactly the tag navigator.language reports.
      expect(header!.startsWith(payload!.tag)).toBe(true);
      // And advertise the same list, in the same order.
      const headerTags = header!.split(",").map((p) => p.split(";")[0]);
      expect(headerTags).toEqual(payload!.languages);
    }
  });

  test("both are null together, so neither can spoof without the other", () => {
    const cases: Partial<Settings>[] = [
      { localeSpoofing: { mode: "off" } },
      { localeSpoofing: { mode: "match" }, timezone: null },
      { localeSpoofing: { mode: "custom", locale: "xx-ZZ" } },
    ];
    for (const overrides of cases) {
      const s = makeSettings(overrides);
      expect(resolveAcceptLanguageFor(s, PAGE)).toBeNull();
      expect(
        resolvePageLocale(s.localeSpoofing, s.timezone?.identifier ?? null, s.proFeaturesBlocked)
      ).toBeNull();
    }
  });

  test("the real language never appears in the header", () => {
    const s = makeSettings({ localeSpoofing: { mode: "custom", locale: "fr-FR" } });
    expect(resolveAcceptLanguageFor(s, PAGE)).not.toMatch(/en/i);
  });
});

describe("off by default (Req 10.5)", () => {
  test("default settings leave the header alone", () => {
    expect(resolveAcceptLanguageFor(makeSettings(), PAGE)).toBeNull();
  });

  test("master spoofing disabled leaves the header alone", () => {
    const s = makeSettings({
      enabled: false,
      localeSpoofing: { mode: "custom", locale: "fr-FR" },
    });
    expect(resolveAcceptLanguageFor(s, PAGE)).toBeNull();
  });
});

describe("site scoping (Req 10.6)", () => {
  test("allowlist mode: only in-scope sites get a rewritten header", () => {
    const s = makeSettings({
      localeSpoofing: { mode: "custom", locale: "fr-FR" },
      scopeMode: "allowlist",
      allowlist: ["example.com"],
    });
    expect(resolveAcceptLanguageFor(s, "https://example.com/page")).not.toBeNull();
    expect(resolveAcceptLanguageFor(s, "https://other.test/page")).toBeNull();
  });

  test("denylist mode: excluded sites keep their real header", () => {
    const s = makeSettings({
      localeSpoofing: { mode: "custom", locale: "fr-FR" },
      scopeMode: "denylist",
      denylist: ["blocked.test"],
    });
    expect(resolveAcceptLanguageFor(s, "https://example.com/page")).not.toBeNull();
    expect(resolveAcceptLanguageFor(s, "https://blocked.test/page")).toBeNull();
  });

  test("an undeterminable or restricted URL is never rewritten", () => {
    const s = makeSettings({ localeSpoofing: { mode: "custom", locale: "fr-FR" } });
    expect(resolveAcceptLanguageFor(s, undefined)).toBeNull();
    expect(resolveAcceptLanguageFor(s, "about:blank")).toBeNull();
  });
});

describe("Pro gate (Req 15.4)", () => {
  test("a gated user's header is never rewritten", () => {
    const s = makeSettings({
      localeSpoofing: { mode: "custom", locale: "fr-FR" },
      proFeaturesBlocked: true,
    });
    // __SAFARI__ is false in the test build, so the gate compiles to a
    // passthrough here; on Safari it forces `off`. Assert the two stay in step
    // rather than hardcoding one engine's outcome.
    const header = resolveAcceptLanguageFor(s, PAGE);
    const payload = resolvePageLocale(
      s.localeSpoofing,
      s.timezone?.identifier ?? null,
      s.proFeaturesBlocked
    );
    if (__SAFARI__) {
      expect(header).toBeNull();
      expect(payload).toBeNull();
    } else {
      expect(header).not.toBeNull();
      expect(payload).not.toBeNull();
    }
  });
});

describe("header format", () => {
  test("a region-qualified tag advertises the bare language as fallback", () => {
    const s = makeSettings({ localeSpoofing: { mode: "custom", locale: "fr-FR" } });
    const header = resolveAcceptLanguageFor(s, PAGE)!;
    expect(header.split(",")[0]).toBe("fr-FR");
    expect(header).toContain("fr;q=");
  });

  test("the leading entry carries no explicit q", () => {
    const s = makeSettings({ localeSpoofing: { mode: "custom", locale: "fr-FR" } });
    expect(resolveAcceptLanguageFor(s, PAGE)!.split(",")[0]).not.toContain("q=");
  });

  test("a language-only tag advertises a single entry", () => {
    const s = makeSettings({ localeSpoofing: { mode: "custom", locale: "ja" } });
    expect(resolveAcceptLanguageFor(s, PAGE)).toBe("ja");
  });
});

describe("site locations", () => {
  const acceptFor = (zone: string): string =>
    resolveLocale({ mode: "match" }, zone)!.acceptLanguage;
  const withSites = (overrides?: Partial<Settings>): Settings =>
    makeSettings({
      localeSpoofing: { mode: "match" },
      siteLocations: [ENTRY_DUBLIN, ENTRY_MEXICO_CITY],
      ...overrides,
    });
  const TABS = [
    { id: 1, url: "https://chatgpt.com/" }, // Dublin
    { id: 2, url: "https://www.twitch.tv/x" }, // Mexico City
    { id: 3, url: "https://example.com/" }, // main (Paris)
    { id: 4, url: "https://openai.com/c" }, // Dublin
    { id: 5, url: "about:blank" }, // restricted: no rule
    { url: "https://example.com/no-id" }, // no id: skipped
  ];

  test("a matched URL gets the site location's value", () => {
    const s = withSites();
    expect(resolveAcceptLanguageFor(s, "https://chatgpt.com/")).toBe(acceptFor("Europe/Dublin"));
    expect(resolveAcceptLanguageFor(s, "https://example.com/")).toBe(acceptFor("Europe/Paris"));
  });

  test("the rule ids cover one global rule plus one per site location", () => {
    expect(ACCEPT_LANGUAGE_RULE_IDS).toHaveLength(MAX_SITE_LOCATIONS + 1);
    expect(ACCEPT_LANGUAGE_RULE_IDS[0]).toBe(8801);
    expect(ACCEPT_LANGUAGE_RULE_IDS.at(-1)).toBe(8801 + MAX_SITE_LOCATIONS);
  });

  test("with no site locations, 'all' mode keeps the single global rule", () => {
    const s = makeSettings({ localeSpoofing: { mode: "match" } });
    expect(usesPerTabRules(s)).toBe(false);
    expect(planAcceptLanguageRules(s, TABS)).toEqual([
      { id: 8801, value: acceptFor("Europe/Paris"), condition: { urlFilter: "*" } },
    ]);
  });

  test("Match mode with site locations groups tabs by value, sorted, with sequential ids", () => {
    const s = withSites();
    expect(usesPerTabRules(s)).toBe(true);
    const groups = [
      { value: acceptFor("Europe/Dublin"), tabIds: [1, 4] },
      { value: acceptFor("America/Mexico_City"), tabIds: [2] },
      { value: acceptFor("Europe/Paris"), tabIds: [3] },
    ].sort((a, b) => (a.value < b.value ? -1 : 1));
    expect(planAcceptLanguageRules(s, TABS)).toEqual(
      groups.map((g, i) => ({ id: 8801 + i, value: g.value, condition: { tabIds: g.tabIds } }))
    );
  });

  test("custom mode stays global: the locale doesn't follow the zone", () => {
    const s = withSites({ localeSpoofing: { mode: "custom", locale: "fr-FR" } });
    expect(usesPerTabRules(s)).toBe(false);
    const plan = planAcceptLanguageRules(s, TABS);
    expect(plan).toHaveLength(1);
    expect(plan[0].condition).toEqual({ urlFilter: "*" });
  });

  test("Filters still decide: an out-of-scope tab gets no rule", () => {
    const s = withSites({ scopeMode: "allowlist", allowlist: ["twitch.tv"] });
    expect(planAcceptLanguageRules(s, TABS)).toEqual([
      { id: 8801, value: acceptFor("America/Mexico_City"), condition: { tabIds: [2] } },
    ]);
  });

  test("master off plans no rules", () => {
    expect(planAcceptLanguageRules(withSites({ enabled: false }), TABS)).toEqual([]);
    expect(
      planAcceptLanguageRules(
        makeSettings({ enabled: false, localeSpoofing: { mode: "match" } }),
        TABS
      )
    ).toEqual([]);
  });

  test("no locale at all plans no rules", () => {
    expect(planAcceptLanguageRules(makeSettings(), TABS)).toEqual([]);
  });
});
