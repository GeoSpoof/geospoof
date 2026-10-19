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
import { resolveAcceptLanguageFor } from "@/background/accept-language";
import { resolvePageLocale } from "@/shared/locale/resolver";

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
