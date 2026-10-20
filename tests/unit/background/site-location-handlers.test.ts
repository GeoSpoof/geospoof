/**
 * SAVE_SITE_LOCATION / REMOVE_SITE_LOCATION handlers.
 *
 * The timezone and geocoding modules are mocked so each test controls the
 * lookups (and can land a "concurrent" write mid-await). Storage is a single
 * stateful slot so the handler's post-await re-load sees what happened.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import type { LocationName, Settings, SiteLocation, Timezone } from "@/shared/types/settings";
import { DEFAULT_SETTINGS, MAX_SITE_LOCATIONS } from "@/shared/types/settings";
import type { Message, SiteLocationResponse } from "@/shared/types/messages";
import {
  DUBLIN,
  DUBLIN_NAME,
  DUBLIN_TZ,
  ENTRY_DUBLIN,
  ENTRY_MEXICO_CITY,
  MEXICO_CITY,
  MEXICO_CITY_NAME,
  MEXICO_CITY_TZ,
  TOKYO,
  TOKYO_NAME,
  TOKYO_TZ,
  makeSiteLocation,
} from "../../helpers/site-locations";

const lookups = vi.hoisted(() => ({
  timezone: vi.fn<(lat: number, lon: number, hint?: string) => Promise<Timezone>>(),
  reverseGeocode: vi.fn<(lat: number, lon: number) => Promise<LocationName>>(),
}));

vi.mock("@/background/timezone", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/background/timezone")>()),
  getTimezoneForCoordinates: lookups.timezone,
}));

vi.mock("@/background/geocoding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/background/geocoding")>()),
  reverseGeocode: lookups.reverseGeocode,
}));

/** The single persisted settings slot. */
let stored: Settings;

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    onboardingCompleted: true,
    location: TOKYO,
    timezone: TOKYO_TZ,
    locationName: TOKYO_NAME,
    accuracySetting: { mode: "fixed", meters: 25 },
    accuracySeed: 777,
    precisionSeed: 123456789,
    ...overrides,
  };
}

async function boot(s: Settings, setImpl?: (obj: { settings: Settings }) => Promise<void>) {
  vi.clearAllMocks();
  vi.resetModules();
  stored = structuredClone(s);

  browser.storage.local.get = vi.fn(() => Promise.resolve({ settings: structuredClone(stored) }));
  const setSpy = vi.fn(
    setImpl ??
      ((obj: { settings: Settings }) => {
        stored = structuredClone(obj.settings);
        return Promise.resolve();
      })
  );
  browser.storage.local.set = setSpy;
  browser.tabs.query = vi.fn().mockResolvedValue([{ id: 1, url: "https://chatgpt.com/" }]);

  const broadcasts: Array<Message<Record<string, unknown>>> = [];
  browser.tabs.sendMessage = vi
    .fn()
    .mockImplementation((_tabId: number, message: Message<Record<string, unknown>>) => {
      if (message.type === "UPDATE_SETTINGS") broadcasts.push(message);
      return Promise.resolve();
    });
  const setBadgeText = vi.fn().mockResolvedValue(undefined);
  browser.action.setBadgeText = setBadgeText;
  browser.action.setBadgeBackgroundColor = vi.fn().mockResolvedValue(undefined);

  const bg = await import("@/background");
  return { ...bg, broadcasts, setBadgeText, setSpy };
}

beforeEach(() => {
  lookups.timezone.mockReset().mockResolvedValue(DUBLIN_TZ);
  lookups.reverseGeocode.mockReset().mockResolvedValue(DUBLIN_NAME);
});

describe("SAVE_SITE_LOCATION", () => {
  test("a new save persists a validated entry, broadcasts, and badges", async () => {
    const bg = await boot(makeSettings());
    const res = (await bg.handleMessage(
      {
        type: "SAVE_SITE_LOCATION",
        payload: {
          patterns: [" ChatGPT.com ", "openai.com", "chatgpt.com"],
          latitude: DUBLIN.latitude,
          longitude: DUBLIN.longitude,
          locationName: DUBLIN_NAME,
          label: "  EU  ",
        },
      },
      {}
    )) as SiteLocationResponse;

    expect(res).toEqual({ success: true, id: expect.any(String) as string });
    expect(stored.siteLocations).toHaveLength(1);
    const [entry] = stored.siteLocations;
    expect(entry).toEqual({
      id: (res as { id: string }).id,
      kind: "location",
      patterns: ["chatgpt.com", "openai.com"],
      location: { latitude: DUBLIN.latitude, longitude: DUBLIN.longitude, accuracy: 25 },
      timezone: DUBLIN_TZ,
      locationName: DUBLIN_NAME,
      label: "EU",
      updatedAt: expect.any(Number) as number,
    });
    // The stored entry survives the load-time validator unchanged.
    const { validateSiteLocations } = await import("@/background/settings");
    expect(validateSiteLocations(stored.siteLocations)).toEqual(stored.siteLocations);

    expect(bg.broadcasts.length).toBeGreaterThan(0);
    expect(bg.broadcasts.at(-1)!.payload!.timezone).toEqual(DUBLIN_TZ);
    expect(bg.broadcasts.at(-1)!.payload).not.toHaveProperty("siteLocations");
    expect(bg.setBadgeText).toHaveBeenCalled();
    // The main location is untouched.
    expect(stored.location).toEqual(TOKYO);
  });

  test("an edit keeps the id and replaces the entry in place", async () => {
    const bg = await boot(makeSettings({ siteLocations: [ENTRY_DUBLIN, ENTRY_MEXICO_CITY] }));
    lookups.timezone.mockResolvedValue(MEXICO_CITY_TZ);
    const res = await bg.handleSaveSiteLocation({
      id: ENTRY_DUBLIN.id,
      patterns: ["chatgpt.com"],
      latitude: MEXICO_CITY.latitude,
      longitude: MEXICO_CITY.longitude,
      locationName: MEXICO_CITY_NAME,
    });
    expect(res).toEqual({ success: true, id: ENTRY_DUBLIN.id });
    expect(stored.siteLocations.map((e) => e.id)).toEqual([ENTRY_DUBLIN.id, ENTRY_MEXICO_CITY.id]);
    expect(stored.siteLocations[0].patterns).toEqual(["chatgpt.com"]);
    expect(stored.siteLocations[0].timezone).toEqual(MEXICO_CITY_TZ);
  });

  test("unchanged coordinates skip the timezone and name lookups", async () => {
    const entry = makeSiteLocation({ id: "e1", patterns: ["chatgpt.com"], label: "Keep" });
    const bg = await boot(makeSettings({ siteLocations: [entry] }));
    const res = await bg.handleSaveSiteLocation({
      id: "e1",
      patterns: ["chatgpt.com", "openai.com"],
      latitude: entry.location.latitude,
      longitude: entry.location.longitude,
    });
    expect(res).toEqual({ success: true, id: "e1" });
    expect(lookups.timezone).not.toHaveBeenCalled();
    expect(lookups.reverseGeocode).not.toHaveBeenCalled();
    expect(stored.siteLocations[0]).toMatchObject({
      patterns: ["chatgpt.com", "openai.com"],
      timezone: entry.timezone,
      locationName: entry.locationName,
      // An omitted label keeps the existing one.
      label: "Keep",
    });
  });

  test("an unknown id is saved as a new entry with a fresh id", async () => {
    const bg = await boot(makeSettings({ siteLocations: [ENTRY_DUBLIN] }));
    const res = await bg.handleSaveSiteLocation({
      id: "does-not-exist",
      patterns: ["twitch.tv"],
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
    });
    expect("success" in res && res.id).not.toBe("does-not-exist");
    expect(stored.siteLocations).toHaveLength(2);
  });

  test("a fallback timezone gives TIMEZONE_UNAVAILABLE with nothing persisted", async () => {
    const bg = await boot(makeSettings());
    lookups.timezone.mockResolvedValue({
      identifier: "Etc/GMT+1",
      offset: 60,
      dstOffset: 0,
      fallback: true,
    });
    const res = await bg.handleSaveSiteLocation({
      patterns: ["chatgpt.com"],
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
    });
    expect(res).toEqual({ error: "TIMEZONE_UNAVAILABLE" });
    expect(bg.setSpy).not.toHaveBeenCalled();
    expect(stored.siteLocations).toEqual([]);
  });

  test("a failing timezone lookup gives TIMEZONE_UNAVAILABLE", async () => {
    const bg = await boot(makeSettings());
    lookups.timezone.mockRejectedValue(new Error("offline"));
    const res = await bg.handleSaveSiteLocation({
      patterns: ["chatgpt.com"],
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
    });
    expect(res).toEqual({ error: "TIMEZONE_UNAVAILABLE" });
    expect(stored.siteLocations).toEqual([]);
  });

  test.each(["twitch.tv/videos", "*", "", "not a site"])(
    "INVALID_PATTERN for %j, naming it",
    async (pattern) => {
      const bg = await boot(makeSettings());
      const res = await bg.handleSaveSiteLocation({
        patterns: ["chatgpt.com", pattern],
        latitude: DUBLIN.latitude,
        longitude: DUBLIN.longitude,
      });
      expect(res).toEqual({ error: "INVALID_PATTERN", pattern });
      expect(bg.setSpy).not.toHaveBeenCalled();
    }
  );

  test("INVALID_PATTERN for no patterns", async () => {
    const bg = await boot(makeSettings());
    const res = await bg.handleSaveSiteLocation({
      patterns: [],
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
    });
    expect(res).toEqual({ error: "INVALID_PATTERN" });
  });

  test.each([
    [91, 0],
    [0, 181],
    [NaN, 0],
    [0, Infinity],
  ])("INVALID_LOCATION for (%s, %s)", async (latitude, longitude) => {
    const bg = await boot(makeSettings());
    const res = await bg.handleSaveSiteLocation({ patterns: ["chatgpt.com"], latitude, longitude });
    expect(res).toEqual({ error: "INVALID_LOCATION" });
  });

  test("PATTERN_IN_USE carries the owner's id", async () => {
    const bg = await boot(makeSettings({ siteLocations: [ENTRY_DUBLIN] }));
    const res = await bg.handleSaveSiteLocation({
      patterns: ["twitch.tv", "OpenAI.com"],
      latitude: MEXICO_CITY.latitude,
      longitude: MEXICO_CITY.longitude,
    });
    expect(res).toEqual({
      error: "PATTERN_IN_USE",
      pattern: "openai.com",
      ownerId: ENTRY_DUBLIN.id,
    });
    expect(lookups.timezone).not.toHaveBeenCalled();
    expect(stored.siteLocations).toEqual([ENTRY_DUBLIN]);
  });

  test("an entry may keep its own patterns on edit", async () => {
    const bg = await boot(makeSettings({ siteLocations: [ENTRY_DUBLIN] }));
    const res = await bg.handleSaveSiteLocation({
      id: ENTRY_DUBLIN.id,
      patterns: ENTRY_DUBLIN.patterns,
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
    });
    expect(res).toEqual({ success: true, id: ENTRY_DUBLIN.id });
  });

  test(`AT_CAPACITY at ${MAX_SITE_LOCATIONS}`, async () => {
    const full = Array.from({ length: MAX_SITE_LOCATIONS }, (_, i) =>
      makeSiteLocation({ id: `id${i}`, patterns: [`site${i}.com`] })
    );
    const bg = await boot(makeSettings({ siteLocations: full }));
    const res = await bg.handleSaveSiteLocation({
      patterns: ["chatgpt.com"],
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
    });
    expect(res).toEqual({ error: "AT_CAPACITY" });
    // Editing an existing entry is still allowed at capacity.
    const edit = await bg.handleSaveSiteLocation({
      id: "id0",
      patterns: ["site0.com", "chatgpt.com"],
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
    });
    expect(edit).toEqual({ success: true, id: "id0" });
  });

  test("TOO_MANY_PATTERNS at 11", async () => {
    const bg = await boot(makeSettings());
    const res = await bg.handleSaveSiteLocation({
      patterns: Array.from({ length: 11 }, (_, i) => `site${i}.com`),
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
    });
    expect(res).toEqual({ error: "TOO_MANY_PATTERNS" });
  });

  test("STORAGE_ERROR when storage.local.set rejects", async () => {
    const bg = await boot(makeSettings(), () => Promise.reject(new Error("disk full")));
    const res = await bg.handleSaveSiteLocation({
      patterns: ["chatgpt.com"],
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
    });
    expect(res).toEqual({ error: "STORAGE_ERROR" });
    expect(bg.broadcasts).toHaveLength(0);
  });

  test("reverse geocodes only when no name is supplied", async () => {
    const bg = await boot(makeSettings());
    await bg.handleSaveSiteLocation({
      patterns: ["chatgpt.com"],
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
      locationName: { city: "Custom", country: "IE", displayName: "Custom, IE" },
    });
    expect(lookups.reverseGeocode).not.toHaveBeenCalled();
    expect(stored.siteLocations[0].locationName?.city).toBe("Custom");

    await bg.handleSaveSiteLocation({
      patterns: ["openai.com"],
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
    });
    expect(lookups.reverseGeocode).toHaveBeenCalledTimes(1);
    expect(stored.siteLocations[1].locationName).toEqual(DUBLIN_NAME);
  });

  test("a failing reverse geocode saves a null name", async () => {
    const bg = await boot(makeSettings());
    lookups.reverseGeocode.mockRejectedValue(new Error("offline"));
    const res = await bg.handleSaveSiteLocation({
      patterns: ["chatgpt.com"],
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
    });
    expect("success" in res).toBe(true);
    expect(stored.siteLocations[0].locationName).toBeNull();
  });

  test("the post-await re-check catches a concurrent conflicting save", async () => {
    const bg = await boot(makeSettings());
    const rival = makeSiteLocation({ id: "rival", patterns: ["chatgpt.com"] });
    // While this save waits on the timezone lookup, another save claims the pattern.
    lookups.timezone.mockImplementation(() => {
      stored = { ...stored, siteLocations: [rival] };
      return Promise.resolve(DUBLIN_TZ);
    });
    const res = await bg.handleSaveSiteLocation({
      patterns: ["chatgpt.com"],
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
    });
    expect(res).toEqual({ error: "PATTERN_IN_USE", pattern: "chatgpt.com", ownerId: "rival" });
    expect(stored.siteLocations).toEqual([rival]);
  });

  test("the post-await re-check catches a concurrent fill to capacity", async () => {
    const bg = await boot(makeSettings());
    const full = Array.from({ length: MAX_SITE_LOCATIONS }, (_, i) =>
      makeSiteLocation({ id: `id${i}`, patterns: [`site${i}.com`] })
    );
    lookups.timezone.mockImplementation(() => {
      stored = { ...stored, siteLocations: full };
      return Promise.resolve(DUBLIN_TZ);
    });
    const res = await bg.handleSaveSiteLocation({
      patterns: ["chatgpt.com"],
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
    });
    expect(res).toEqual({ error: "AT_CAPACITY" });
    expect(stored.siteLocations).toHaveLength(MAX_SITE_LOCATIONS);
  });

  test("a concurrent save of another entry is kept, not overwritten", async () => {
    const bg = await boot(makeSettings());
    lookups.timezone.mockImplementation(() => {
      stored = { ...stored, siteLocations: [ENTRY_MEXICO_CITY] };
      return Promise.resolve(DUBLIN_TZ);
    });
    await bg.handleSaveSiteLocation({
      patterns: ["chatgpt.com"],
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
    });
    expect(stored.siteLocations.map((e) => e.patterns)).toEqual([["twitch.tv"], ["chatgpt.com"]]);
  });
});

describe("REMOVE_SITE_LOCATION", () => {
  const MULTI: SiteLocation = makeSiteLocation({ id: "multi", patterns: ["a.com", "b.com"] });

  test("by id removes the entry, broadcasts, and badges", async () => {
    const bg = await boot(makeSettings({ siteLocations: [ENTRY_DUBLIN, ENTRY_MEXICO_CITY] }));
    const res = (await bg.handleMessage(
      { type: "REMOVE_SITE_LOCATION", payload: { id: ENTRY_DUBLIN.id } },
      {}
    )) as SiteLocationResponse;
    expect(res).toEqual({ success: true, id: ENTRY_DUBLIN.id });
    expect(stored.siteLocations).toEqual([ENTRY_MEXICO_CITY]);
    expect(bg.broadcasts.length).toBeGreaterThan(0);
    expect(bg.setBadgeText).toHaveBeenCalled();
  });

  test("by pattern shrinks the entry", async () => {
    const bg = await boot(makeSettings({ siteLocations: [MULTI] }));
    const res = await bg.handleRemoveSiteLocation({ id: "multi", pattern: "A.com" });
    expect(res).toEqual({ success: true, id: "multi" });
    expect(stored.siteLocations).toEqual([{ ...MULTI, patterns: ["b.com"] }]);
  });

  test("by its last pattern removes the entry", async () => {
    const bg = await boot(makeSettings({ siteLocations: [ENTRY_MEXICO_CITY] }));
    await bg.handleRemoveSiteLocation({ id: ENTRY_MEXICO_CITY.id, pattern: "twitch.tv" });
    expect(stored.siteLocations).toEqual([]);
  });

  test("an absent id or pattern is a no-op success", async () => {
    const bg = await boot(makeSettings({ siteLocations: [MULTI] }));
    expect(await bg.handleRemoveSiteLocation({ id: "nope" })).toEqual({
      success: true,
      id: "nope",
    });
    expect(await bg.handleRemoveSiteLocation({ id: "multi", pattern: "c.com" })).toEqual({
      success: true,
      id: "multi",
    });
    expect(bg.setSpy).not.toHaveBeenCalled();
    expect(stored.siteLocations).toEqual([MULTI]);
  });

  test("STORAGE_ERROR when storage.local.set rejects", async () => {
    const bg = await boot(makeSettings({ siteLocations: [MULTI] }), () =>
      Promise.reject(new Error("disk full"))
    );
    expect(await bg.handleRemoveSiteLocation({ id: "multi" })).toEqual({ error: "STORAGE_ERROR" });
    expect(bg.broadcasts).toHaveLength(0);
  });
});

describe("VPN resync leaves site locations pinned", () => {
  test("handleSetLocation(fromVpnSync) changes only the main location", async () => {
    const bg = await boot(
      makeSettings({ vpnSyncEnabled: true, siteLocations: [ENTRY_DUBLIN, ENTRY_MEXICO_CITY] })
    );
    const before = JSON.stringify(stored.siteLocations);
    lookups.timezone.mockResolvedValue({
      identifier: "Europe/Berlin",
      offset: -60,
      dstOffset: 60,
    });
    await bg.handleSetLocation(
      { latitude: 52.52, longitude: 13.405 },
      {
        fromVpnSync: true,
        locationName: { city: "Berlin", country: "Germany", displayName: "Berlin, Germany" },
      }
    );
    expect(stored.location?.latitude).toBe(52.52);
    expect(stored.timezone?.identifier).toBe("Europe/Berlin");
    expect(JSON.stringify(stored.siteLocations)).toBe(before);
  });
});
