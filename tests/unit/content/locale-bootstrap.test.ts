/**
 * Instant locale protection via the Firefox document_start bootstrap.
 * Feature: locale-spoofing — Requirements 6.1, 5.2
 *
 * The timezone surfaces get "instant protection" on Firefox: the background
 * registers a MAIN-world userScript that inlines the last-saved settings, and the
 * injected script consumes that global synchronously, so a page reading
 * `Intl...timeZone` in its very first `<script>` already sees the spoofed zone.
 *
 * The locale surfaces have to ride the SAME mechanism, or they lag the timezone
 * surfaces by a settings round-trip — and a page reading early would catch a
 * spoofed timezone sitting next to the user's REAL language. That is both a leak
 * and a glaring internal inconsistency, so it's worse than either surface being
 * unspoofed.
 *
 * Note `src/content/injected/bootstrap.ts` cannot be imported here: its
 * dependency `state.ts` captures `navigator.geolocation.getCurrentPosition` at
 * import time, which jsdom doesn't provide. That's why the existing content tests
 * replicate logic. So this file tests the two ends that ARE reachable — the real
 * validator, and the real background payload — plus structural guards on the
 * page-side wiring in between.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { validateLocaleData } from "@/content/injected/locale-helpers";

describe("validateLocaleData (the real validator the bootstrap uses)", () => {
  test("accepts a well-formed payload", () => {
    expect(validateLocaleData({ tag: "fr-FR", languages: ["fr-FR", "fr"] })).toBe(true);
    expect(validateLocaleData({ tag: "ja", languages: ["ja"] })).toBe(true);
  });

  test("rejects a payload whose language list contradicts the tag", () => {
    // This is the invariant that matters most: every consumer assumes
    // languages[0] === tag, so navigator.language and navigator.languages can
    // never disagree. A payload violating it must be dropped, not applied.
    expect(validateLocaleData({ tag: "fr-FR", languages: ["en-US", "en"] })).toBe(false);
    expect(validateLocaleData({ tag: "fr-FR", languages: ["fr"] })).toBe(false);
  });

  test("rejects malformed or truncated payloads", () => {
    for (const bad of [
      undefined,
      null,
      {},
      "fr-FR",
      { tag: "fr-FR" },
      { languages: ["fr-FR"] },
      { tag: "", languages: [""] },
      { tag: "fr-FR", languages: [] },
      { tag: "fr-FR", languages: "fr-FR" },
      { tag: 42, languages: ["fr-FR"] },
      { tag: "fr-FR", languages: ["fr-FR", 7] },
    ]) {
      expect(validateLocaleData(bad), JSON.stringify(bad) ?? "undefined").toBe(false);
    }
  });
});

describe("the background inlines the resolved locale into the bootstrap payload", () => {
  /** Captured `userScripts.register` calls. */
  let registered: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.resetModules();
    registered = [];
    // Minimal MV3 userScripts stand-in. The real API is Firefox-only and absent
    // in jsdom, and the module feature-detects it, so without this the
    // registration silently no-ops and the test would vacuously pass.
    (browser as unknown as { userScripts?: unknown }).userScripts = {
      register: (scripts: Array<Record<string, unknown>>) => {
        registered.push(...scripts);
        return Promise.resolve();
      },
      unregister: () => Promise.resolve(),
      getScripts: () => Promise.resolve([]),
    };
  });

  /** Pull the inlined JSON payload back out of the generated bootstrap code. */
  function inlinedPayload(): Record<string, unknown> {
    expect(registered.length, "no bootstrap script was registered").toBeGreaterThan(0);
    const js = registered[0].js as Array<{ code: string }>;
    const code = js[0].code;
    const match = /\{value:(\{.*?\}),configurable:true/s.exec(code);
    expect(match, `could not extract payload from: ${code.slice(0, 200)}`).not.toBeNull();
    return JSON.parse(match![1]) as Record<string, unknown>;
  }

  const BASE = {
    enabled: true,
    location: { latitude: 48.8566, longitude: 2.3522, accuracy: 42 },
    timezone: { identifier: "Europe/Paris", offset: -60, dstOffset: 60 },
    locationName: null,
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
    theme: "system" as const,
    uiLanguage: "",
    favorites: [],
    scopeMode: "all" as const,
    allowlist: [],
    denylist: [],
    accuracySetting: { mode: "auto" as const },
    accuracySeed: 777,
    locationPrecision: { mode: "exact" as const },
    precisionSeed: 123456789,
    precisionCadence: "never" as const,
  };

  test("a custom locale is inlined so it applies before the page's first script", async () => {
    const { updateBootstrapRegistration } = await import("@/background/bootstrap-register");
    await updateBootstrapRegistration({
      ...BASE,
      localeSpoofing: { mode: "custom", locale: "fr-FR" },
    });

    expect(inlinedPayload().locale).toEqual({ tag: "fr-FR", languages: ["fr-FR", "fr"] });
  });

  test("match mode inlines the locale derived from the spoofed timezone", async () => {
    const { updateBootstrapRegistration } = await import("@/background/bootstrap-register");
    await updateBootstrapRegistration({ ...BASE, localeSpoofing: { mode: "match" } });

    // Europe/Paris -> FR -> fr-FR
    expect(inlinedPayload().locale).toEqual({ tag: "fr-FR", languages: ["fr-FR", "fr"] });
  });

  test("off mode inlines null, so nothing is seeded", async () => {
    const { updateBootstrapRegistration } = await import("@/background/bootstrap-register");
    await updateBootstrapRegistration({ ...BASE, localeSpoofing: { mode: "off" } });

    expect(inlinedPayload().locale).toBeNull();
  });

  test("the inlined locale matches what the async path delivers", async () => {
    // The whole premise of the bootstrap is that it's a *preview* of the
    // authoritative value. If the two could differ, an early read would show one
    // locale and a later read another — a visible flip mid-page-load.
    const settings = { ...BASE, localeSpoofing: { mode: "match" as const } };
    const { updateBootstrapRegistration } = await import("@/background/bootstrap-register");
    await updateBootstrapRegistration(settings);

    const { resolvePageLocale } = await import("@/shared/locale/resolver");
    const asyncValue = resolvePageLocale(
      settings.localeSpoofing,
      settings.timezone.identifier,
      settings.proFeaturesBlocked
    );

    expect(inlinedPayload().locale).toEqual(asyncValue);
  });
});

describe("page-side wiring guards", () => {
  // The behavioural half can't run here (see the file header), so these pin the
  // wiring that makes the inlined value actually take effect. Without the first
  // two, the background would inline the locale and the page would drop it on the
  // floor — which is exactly the bug this change fixed.
  test("bootstrap.ts consumes the inlined locale", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/content/injected/bootstrap.ts", "utf8");
    expect(src).toContain("validateLocaleData");
    expect(src).toContain("setLocaleData");
    // It must read the field off the payload, not just import the helpers.
    expect(src).toMatch(/locale\?:\s*unknown/);
  });

  test("the locale overrides seed from the bootstrap on their hot path", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/content/injected/locale-overrides.ts", "utf8");
    expect(src).toContain("seedFromBootstrap");
    // Both accessors must seed: navigator.languages is read as early as
    // navigator.language, so it must not lag behind it.
    expect(src).toMatch(/function activeTag\(\)[\s\S]{0,120}seedFromBootstrap\(\)/);
    expect(src).toMatch(/function activeLanguages\(\)[\s\S]{0,200}seedFromBootstrap\(\)/);
  });

  test("validateLocaleData lives in a neutral module to avoid an import cycle", async () => {
    // bootstrap.ts needs the validator and locale-overrides.ts needs the seed.
    // If the validator lived in locale-overrides.ts those two would import each
    // other. Mirrors why validateTimezoneData sits in timezone-helpers.ts.
    const fs = await import("node:fs");
    const helpers = fs.readFileSync("src/content/injected/locale-helpers.ts", "utf8");
    expect(helpers).toContain("export function validateLocaleData");
    // The helper module must not import the override module back.
    expect(helpers).not.toContain("./locale-overrides");
    expect(helpers).not.toContain("./bootstrap");
  });
});
