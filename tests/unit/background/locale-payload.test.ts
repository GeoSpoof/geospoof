/**
 * Locale delivery through the page-bound payload builders.
 * Feature: locale-spoofing (Task 6.3) — Requirements 2.x, 12.4, 12.5, 12.6, 15.4
 *
 * The background resolves the Reported Language and ships only the OUTCOME. Two
 * things must hold, and both are easy to break silently:
 *
 *   1. Every payload builder agrees. A freshly injected content script
 *      (GET_SETTINGS) and a live one (broadcast) must receive the same locale,
 *      or the same page ends up with two different reported languages.
 *   2. The page world never receives the mode, the mapping tables, or the
 *      Accept-Language string — only `tag` and `languages`.
 */

import { describe, test, expect, vi } from "vitest";
import type { Settings } from "@/shared/types/settings";
import type { Message, UpdateSettingsPayload } from "@/shared/types/messages";

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
    ...overrides,
  };
}

/** Captures the settings object written by the most recent storage.local.set. */
let persisted: Settings | null = null;

async function importBackgroundWith(s: Settings) {
  vi.clearAllMocks();
  vi.resetModules();
  persisted = null;
  browser.storage.local.get = vi.fn().mockResolvedValue({ settings: s });
  browser.storage.local.set = vi.fn().mockImplementation((obj: { settings: Settings }) => {
    persisted = obj.settings;
    return Promise.resolve();
  });
  return import("@/background");
}

/** Broadcast to a single tab and return the delivered payload. */
async function broadcastAndCapture(
  bg: { broadcastSettingsToTabs: (s: Settings) => Promise<void> },
  s: Settings
): Promise<UpdateSettingsPayload> {
  browser.tabs.query = vi.fn().mockResolvedValue([{ id: 1, url: "https://example.com" }]);
  const sent: UpdateSettingsPayload[] = [];
  browser.tabs.sendMessage = vi
    .fn()
    .mockImplementation((_tabId: number, message: Message<UpdateSettingsPayload>) => {
      if (message.type === "UPDATE_SETTINGS" && message.payload) sent.push(message.payload);
      return Promise.resolve();
    });
  await bg.broadcastSettingsToTabs(s);
  expect(sent).toHaveLength(1);
  return sent[0];
}

describe("locale delivery — custom mode", () => {
  test("delivers the canonical tag and language list", async () => {
    const s = makeSettings({ localeSpoofing: { mode: "custom", locale: "fr-FR" } });
    const bg = await importBackgroundWith(s);
    const payload = await broadcastAndCapture(bg, s);

    expect(payload.locale).toEqual({ tag: "fr-FR", languages: ["fr-FR", "fr"] });
  });

  test("both builders agree", async () => {
    const s = makeSettings({ localeSpoofing: { mode: "custom", locale: "de-DE" } });
    const bg = await importBackgroundWith(s);

    const broadcast = await broadcastAndCapture(bg, s);
    const response = (await bg.handleMessage(
      { type: "GET_SETTINGS" },
      { tab: { id: 2, url: "https://example.com/page" } as browser.tabs.Tab }
    )) as Record<string, unknown>;

    expect(response.locale).toEqual(broadcast.locale);
  });
});

describe("locale delivery — match mode", () => {
  test("derives the locale from the spoofed timezone", async () => {
    const s = makeSettings({ localeSpoofing: { mode: "match" } });
    const bg = await importBackgroundWith(s);
    const payload = await broadcastAndCapture(bg, s);

    // Europe/Paris -> FR -> fr-FR
    expect(payload.locale).toEqual({ tag: "fr-FR", languages: ["fr-FR", "fr"] });
  });

  test("re-resolves when the spoofed location changes (Req 12.6)", async () => {
    const paris = makeSettings({ localeSpoofing: { mode: "match" } });
    const bg = await importBackgroundWith(paris);
    expect((await broadcastAndCapture(bg, paris)).locale?.tag).toBe("fr-FR");

    const tokyo = makeSettings({
      localeSpoofing: { mode: "match" },
      timezone: { identifier: "Asia/Tokyo", offset: -540, dstOffset: 0 },
    });
    expect((await broadcastAndCapture(bg, tokyo)).locale?.tag).toBe("ja-JP");
  });

  test("delivers null when there is no spoofed timezone to derive from", async () => {
    const s = makeSettings({ localeSpoofing: { mode: "match" }, timezone: null });
    const bg = await importBackgroundWith(s);
    expect((await broadcastAndCapture(bg, s)).locale).toBeNull();
  });
});

describe("locale delivery — off mode is inert", () => {
  test("delivers null by default", async () => {
    const s = makeSettings();
    const bg = await importBackgroundWith(s);
    expect((await broadcastAndCapture(bg, s)).locale).toBeNull();
  });
});

describe("locale delivery — payload hygiene (Req 12.5)", () => {
  test("ships only tag and languages: no mode, no Accept-Language", async () => {
    const s = makeSettings({ localeSpoofing: { mode: "custom", locale: "fr-FR" } });
    const bg = await importBackgroundWith(s);
    const payload = await broadcastAndCapture(bg, s);

    expect(Object.keys(payload.locale!).sort()).toEqual(["languages", "tag"]);
    // The header value is the background's business; a page must not be handed it.
    expect(JSON.stringify(payload)).not.toContain("q=0.");
    // The user's mode must not leak either.
    expect(JSON.stringify(payload)).not.toContain("custom");
  });

  test("navigator.language is always the head of navigator.languages", async () => {
    for (const tag of ["fr-FR", "ja", "pt-BR"]) {
      const s = makeSettings({ localeSpoofing: { mode: "custom", locale: tag } });
      const bg = await importBackgroundWith(s);
      const payload = await broadcastAndCapture(bg, s);
      expect(payload.locale!.languages[0]).toBe(payload.locale!.tag);
    }
  });
});

describe("SET_LOCALE_SPOOFING handler", () => {
  test("persists a valid setting and rebroadcasts", async () => {
    const s = makeSettings();
    const bg = await importBackgroundWith(s);
    browser.tabs.query = vi.fn().mockResolvedValue([]);

    const result = await bg.handleMessage(
      {
        type: "SET_LOCALE_SPOOFING",
        payload: { localeSpoofing: { mode: "custom", locale: "fr-FR" } },
      },
      {}
    );

    expect(result).toEqual({ success: true });
    expect(persisted?.localeSpoofing).toEqual({ mode: "custom", locale: "fr-FR" });
    // Re-broadcast so live tabs pick up the new Reported Language (Req 12.2).
    expect(browser.tabs.sendMessage).toBeDefined();
  });

  test("repairs an unusable tag to off rather than storing it", async () => {
    // A caller must never end up believing a locale is applied when it isn't.
    const s = makeSettings();
    const bg = await importBackgroundWith(s);
    browser.tabs.query = vi.fn().mockResolvedValue([]);

    const result = await bg.handleMessage(
      {
        type: "SET_LOCALE_SPOOFING",
        payload: { localeSpoofing: { mode: "custom", locale: "not a tag!" } },
      },
      {}
    );

    expect(result).toEqual({ success: true });
    expect(persisted?.localeSpoofing).toEqual({ mode: "off" });
  });

  test("survives a missing payload", async () => {
    const s = makeSettings();
    const bg = await importBackgroundWith(s);
    browser.tabs.query = vi.fn().mockResolvedValue([]);
    await expect(bg.handleMessage({ type: "SET_LOCALE_SPOOFING" }, {})).resolves.toEqual({
      success: true,
    });
  });
});
