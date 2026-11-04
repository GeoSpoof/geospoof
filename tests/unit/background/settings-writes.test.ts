/**
 * D5: every value derived from stored settings is computed inside the settings
 * write that stores it (`updateSettingsWith`), so overlapping changes can't
 * erase each other or act on a stale read.
 *
 * Storage is one stateful slot. `slowSet` makes writes land late, so two
 * overlapping handlers would both read the old object if their read sat
 * outside the write. The timezone, geocoding, and VPN lookups are mocked so a
 * test can hold one mid-await.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { Favorite, LocationName, Settings, Timezone } from "@/shared/types/settings";
import { DEFAULT_SETTINGS, MAX_FAVORITES } from "@/shared/types/settings";
import type { FavoriteResponse, Message, ScopeResponse } from "@/shared/types/messages";
import type { VpnSyncResponse } from "@/background/vpn-sync";
import {
  DUBLIN_NAME,
  MEXICO_CITY,
  MEXICO_CITY_TZ,
  TOKYO,
  TOKYO_NAME,
  TOKYO_TZ,
} from "../../helpers/site-locations";
import { deferred } from "../../helpers/cadence";

const lookups = vi.hoisted(() => ({
  timezone: vi.fn<(lat: number, lon: number, hint?: string) => Promise<Timezone>>(),
  reverseGeocode: vi.fn<(lat: number, lon: number) => Promise<LocationName>>(),
  syncVpnLocation: vi.fn<(force: boolean) => Promise<VpnSyncResponse>>(),
  clearIpGeoCache: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/background/timezone", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/background/timezone")>()),
  getTimezoneForCoordinates: lookups.timezone,
}));

vi.mock("@/background/geocoding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/background/geocoding")>()),
  reverseGeocode: lookups.reverseGeocode,
}));

vi.mock("@/background/vpn-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/background/vpn-sync")>()),
  syncVpnLocation: lookups.syncVpnLocation,
  clearIpGeoCache: lookups.clearIpGeoCache,
}));

const BERLIN = { latitude: 52.52, longitude: 13.405 };
const BERLIN_TZ: Timezone = { identifier: "Europe/Berlin", offset: -60, dstOffset: 60 };
const BERLIN_NAME: LocationName = {
  city: "Berlin",
  country: "Germany",
  displayName: "Berlin, Germany",
};
const BERLIN_SYNC: VpnSyncResponse = {
  ...BERLIN,
  city: "Berlin",
  country: "Germany",
  ip: "198.51.100.7",
  timezone: "Europe/Berlin",
};
const MANUAL = { latitude: MEXICO_CITY.latitude, longitude: MEXICO_CITY.longitude };

/** The single persisted settings slot. */
let stored: Settings;
/** Every settings object passed to storage.local.set, in call order. */
let writes: Settings[];
/** Writes (by latitude and vpnSyncEnabled) and clearIpGeoCache calls, in call order. */
let events: string[];

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

function storeNow(s: Settings): Promise<void> {
  stored = s;
  return Promise.resolve();
}

/** A storage write that lands `ms` later. */
function slowSet(ms = 5) {
  return (s: Settings) =>
    new Promise<void>((resolve) =>
      setTimeout(() => {
        stored = s;
        resolve();
      }, ms)
    );
}

async function boot(
  s: Settings,
  setImpl: (s: Settings) => Promise<void> = storeNow,
  beforeImport?: () => void
) {
  vi.clearAllMocks();
  vi.resetModules();
  stored = structuredClone(s);
  writes = [];
  events = [];

  browser.storage.local.get = vi.fn(() => Promise.resolve({ settings: structuredClone(stored) }));
  const setSpy = vi.fn((obj: { settings?: Settings }) => {
    if (!obj.settings) return Promise.resolve();
    const snapshot = structuredClone(obj.settings);
    writes.push(snapshot);
    events.push(`write ${snapshot.location?.latitude ?? "null"} vpn=${snapshot.vpnSyncEnabled}`);
    return setImpl(snapshot);
  });
  browser.storage.local.set = setSpy;
  browser.tabs.query = vi.fn().mockResolvedValue([{ id: 1, url: "https://example.com/" }]);

  const broadcasts: Array<Message<Record<string, unknown>>> = [];
  browser.tabs.sendMessage = vi
    .fn()
    .mockImplementation((_tabId: number, message: Message<Record<string, unknown>>) => {
      if (message.type === "UPDATE_SETTINGS") broadcasts.push(message);
      return Promise.resolve();
    });
  browser.action.setBadgeText = vi.fn().mockResolvedValue(undefined);
  browser.action.setBadgeBackgroundColor = vi.fn().mockResolvedValue(undefined);

  beforeImport?.();
  const bg = await import("@/background");
  return { ...bg, broadcasts, setSpy };
}

/** Hold the next time-zone lookup until released. */
function holdNextTimezoneLookup(tz: Timezone): () => void {
  let release!: () => void;
  lookups.timezone.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(tz);
      })
  );
  return () => release();
}

beforeEach(() => {
  lookups.timezone.mockReset().mockResolvedValue(MEXICO_CITY_TZ);
  lookups.reverseGeocode.mockReset().mockResolvedValue(DUBLIN_NAME);
  lookups.syncVpnLocation.mockReset().mockResolvedValue(BERLIN_SYNC);
  lookups.clearIpGeoCache.mockReset().mockImplementation(() => {
    events.push("clearIpGeoCache");
    return Promise.resolve();
  });
});

// --- Favorites -----------------------------------------------------------------

function favorite(i: number): Favorite {
  return {
    id: `fav-${i}`,
    // Distinct and in range for every i the tests use (0–101).
    latitude: -60 + i * 0.5,
    longitude: -60 + i * 0.5,
    city: `City ${i}`,
    country: "Country",
    displayName: `City ${i}, Country`,
    label: null,
  };
}

type Bg = Awaited<ReturnType<typeof boot>>;

function saveFavorite(bg: Bg, payload: unknown): Promise<FavoriteResponse> {
  return bg.handleMessage({ type: "SAVE_FAVORITE", payload }, {}) as Promise<FavoriteResponse>;
}

function removeFavorite(bg: Bg, id: string): Promise<FavoriteResponse> {
  return bg.handleMessage(
    { type: "REMOVE_FAVORITE", payload: { id } },
    {}
  ) as Promise<FavoriteResponse>;
}

const storedIds = () => stored.favorites.map((f) => f.id);

describe("favorites changes that overlap keep each other", () => {
  test("two saves are both stored", async () => {
    const bg = await boot(makeSettings(), slowSet());
    const results = await Promise.all([
      saveFavorite(bg, favorite(1)),
      saveFavorite(bg, favorite(2)),
    ]);
    expect(results).toEqual([{ success: true }, { success: true }]);
    expect(storedIds()).toEqual(["fav-1", "fav-2"]);
  });

  test("a save and a remove of another id both take effect", async () => {
    const bg = await boot(makeSettings({ favorites: [favorite(0)] }), slowSet());
    await Promise.all([saveFavorite(bg, favorite(1)), removeFavorite(bg, "fav-0")]);
    expect(storedIds()).toEqual(["fav-1"]);
  });

  test("two removes both apply", async () => {
    const bg = await boot(
      makeSettings({ favorites: [favorite(0), favorite(1), favorite(2)] }),
      slowSet()
    );
    await Promise.all([removeFavorite(bg, "fav-0"), removeFavorite(bg, "fav-1")]);
    expect(storedIds()).toEqual(["fav-2"]);
  });

  test("a rename and a save both apply", async () => {
    const bg = await boot(makeSettings({ favorites: [favorite(0)] }), slowSet());
    await Promise.all([
      bg.handleMessage({ type: "RENAME_FAVORITE", payload: { id: "fav-0", label: "Home" } }, {}),
      saveFavorite(bg, favorite(1)),
    ]);
    expect(stored.favorites.map((f) => [f.id, f.label])).toEqual([
      ["fav-0", "Home"],
      ["fav-1", null],
    ]);
  });

  test("two saves into the last free slot: one is stored, the other gets AT_CAPACITY", async () => {
    const almostFull = Array.from({ length: MAX_FAVORITES - 1 }, (_, i) => favorite(i));
    const bg = await boot(makeSettings({ favorites: almostFull }), slowSet());
    const results = await Promise.all([
      saveFavorite(bg, favorite(100)),
      saveFavorite(bg, favorite(101)),
    ]);
    expect(results.filter((r) => "success" in r)).toHaveLength(1);
    expect(results.filter((r) => "error" in r && r.error === "AT_CAPACITY")).toHaveLength(1);
    expect(stored.favorites).toHaveLength(MAX_FAVORITES);
  });

  test("two saves of the same coordinates store one entry", async () => {
    const bg = await boot(makeSettings(), slowSet());
    const results = await Promise.all([
      saveFavorite(bg, favorite(1)),
      saveFavorite(bg, { ...favorite(1), id: "fav-1-again" }),
    ]);
    expect(results).toEqual([{ success: true }, { success: true }]);
    expect(storedIds()).toEqual(["fav-1"]);
  });

  test("a non-string displayName returns an error and writes nothing", async () => {
    const bg = await boot(makeSettings());
    const res = await saveFavorite(bg, { ...favorite(1), displayName: 42 });
    expect(res).toEqual({ error: expect.stringContaining("displayName") as string });
    expect(bg.setSpy).not.toHaveBeenCalled();
  });

  test("a save at capacity returns AT_CAPACITY and writes nothing", async () => {
    const full = Array.from({ length: MAX_FAVORITES }, (_, i) => favorite(i));
    const bg = await boot(makeSettings({ favorites: full }));
    expect(await saveFavorite(bg, favorite(100))).toEqual({ error: "AT_CAPACITY" });
    expect(bg.setSpy).not.toHaveBeenCalled();
  });
});

// --- Filters lists ---------------------------------------------------------------

function scope(
  bg: Bg,
  type: "ADD_SCOPE_SITE" | "REMOVE_SCOPE_SITE",
  pattern: string,
  list = "allowlist"
): Promise<ScopeResponse> {
  return bg.handleMessage({ type, payload: { list, pattern } }, {}) as Promise<ScopeResponse>;
}

describe("Filters list changes that overlap keep each other", () => {
  test("two adds to one list are both stored", async () => {
    const bg = await boot(makeSettings({ scopeMode: "allowlist" }), slowSet());
    const results = await Promise.all([
      scope(bg, "ADD_SCOPE_SITE", "a.com"),
      scope(bg, "ADD_SCOPE_SITE", "b.com"),
    ]);
    expect(results).toEqual([{ success: true }, { success: true }]);
    expect(stored.allowlist).toEqual(["a.com", "b.com"]);
  });

  test("an add and a remove of another pattern both apply", async () => {
    const bg = await boot(
      makeSettings({ scopeMode: "allowlist", allowlist: ["keep.com", "old.com"] }),
      slowSet()
    );
    await Promise.all([
      scope(bg, "ADD_SCOPE_SITE", "new.com"),
      scope(bg, "REMOVE_SCOPE_SITE", "old.com"),
    ]);
    expect(stored.allowlist).toEqual(["keep.com", "new.com"]);
  });

  test("the same pattern added twice is stored once", async () => {
    const bg = await boot(makeSettings({ scopeMode: "allowlist" }), slowSet());
    const results = await Promise.all([
      scope(bg, "ADD_SCOPE_SITE", "a.com"),
      scope(bg, "ADD_SCOPE_SITE", "A.COM"),
    ]);
    expect(results).toEqual([{ success: true }, { success: true }]);
    expect(stored.allowlist).toEqual(["a.com"]);
    // The duplicate wrote nothing.
    expect(writes).toHaveLength(1);
  });

  test.each(["ADD_SCOPE_SITE", "REMOVE_SCOPE_SITE"] as const)(
    "%s with an unknown list returns INVALID_PATTERN and writes nothing",
    async (type) => {
      const bg = await boot(makeSettings({ allowlist: ["a.com"] }));
      expect(await scope(bg, type, "a.com", "bogus")).toEqual({ error: "INVALID_PATTERN" });
      expect(bg.setSpy).not.toHaveBeenCalled();
    }
  );
});

// --- VPN sync and manual locations -----------------------------------------------

describe("VPN sync and a manual location that overlap", () => {
  test("a manual location still on its reverse geocode when SYNC_VPN completes turns sync off", async () => {
    const bg = await boot(makeSettings({ vpnSyncEnabled: false }));
    const geocode = deferred<LocationName>();
    lookups.reverseGeocode.mockReturnValueOnce(geocode.promise);

    const manual = bg.handleMessage({ type: "SET_LOCATION", payload: MANUAL }, {});
    await vi.waitFor(() => expect(lookups.reverseGeocode).toHaveBeenCalledTimes(1));
    expect(await bg.handleMessage({ type: "SYNC_VPN" }, {})).toEqual(BERLIN_SYNC);
    expect(stored.vpnSyncEnabled).toBe(true);

    geocode.resolve(DUBLIN_NAME);
    expect(await manual).toEqual({ success: true });

    expect(stored.location?.latitude).toBe(MANUAL.latitude);
    expect(stored.vpnSyncEnabled).toBe(false);
    expect(lookups.clearIpGeoCache).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      `write ${BERLIN.latitude} vpn=true`,
      `write ${MANUAL.latitude} vpn=false`,
      "clearIpGeoCache",
    ]);
  });

  test("a manual location queued behind SYNC_VPN's write turns sync off, and SYNC_VPN writes once", async () => {
    const firstWrite = deferred<void>();
    let held = false;
    const bg = await boot(makeSettings({ vpnSyncEnabled: false }), async (s) => {
      if (!held) {
        held = true;
        await firstWrite.promise;
      }
      stored = s;
    });
    lookups.timezone.mockImplementation((lat) =>
      Promise.resolve(lat === BERLIN.latitude ? BERLIN_TZ : MEXICO_CITY_TZ)
    );

    const sync = bg.handleMessage({ type: "SYNC_VPN" }, {});
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const manual = bg.handleMessage({ type: "SET_LOCATION", payload: MANUAL }, {});
    await vi.waitFor(() => expect(lookups.reverseGeocode).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 5));

    firstWrite.resolve();
    expect(await sync).toEqual(BERLIN_SYNC);
    expect(await manual).toEqual({ success: true });

    expect(stored.location?.latitude).toBe(MANUAL.latitude);
    expect(stored.vpnSyncEnabled).toBe(false);
    const syncWrites = writes.filter((w) => w.location?.latitude === BERLIN.latitude);
    expect(syncWrites).toHaveLength(1);
    expect(syncWrites[0].vpnSyncEnabled).toBe(true);
    expect(syncWrites[0].timezone).toEqual(BERLIN_TZ);
    expect(writes).toHaveLength(2);
  });
});

describe("an automatic sync writes only while VPN sync is on", () => {
  const autoSync = (bg: Bg) =>
    bg.handleSetLocation(BERLIN, {
      fromVpnSync: true,
      onlyWhileVpnSync: true,
      locationName: BERLIN_NAME,
    });

  test("a manual location set during its lookup is kept", async () => {
    const bg = await boot(makeSettings({ vpnSyncEnabled: true }));
    const release = holdNextTimezoneLookup(BERLIN_TZ);
    const sync = autoSync(bg);
    await vi.waitFor(() => expect(lookups.timezone).toHaveBeenCalledTimes(1));

    expect(await bg.handleMessage({ type: "SET_LOCATION", payload: MANUAL }, {})).toEqual({
      success: true,
    });
    const broadcastsBefore = bg.broadcasts.length;
    release();

    expect(await sync).toBe(false);
    expect(stored.location?.latitude).toBe(MANUAL.latitude);
    expect(stored.vpnSyncEnabled).toBe(false);
    expect(bg.broadcasts).toHaveLength(broadcastsBefore);
  });

  test("a Disable during its lookup is kept", async () => {
    const bg = await boot(makeSettings({ vpnSyncEnabled: true }));
    const release = holdNextTimezoneLookup(BERLIN_TZ);
    const sync = autoSync(bg);
    await vi.waitFor(() => expect(lookups.timezone).toHaveBeenCalledTimes(1));

    expect(await bg.handleMessage({ type: "DISABLE_VPN_SYNC" }, {})).toEqual({ success: true });
    const broadcastsBefore = bg.broadcasts.length;
    release();

    expect(await sync).toBe(false);
    expect(stored.location).toBeNull();
    expect(stored.vpnSyncEnabled).toBe(false);
    expect(bg.broadcasts).toHaveLength(broadcastsBefore);
  });

  test("with VPN sync still on it writes and returns true", async () => {
    const bg = await boot(makeSettings({ vpnSyncEnabled: true }));
    lookups.timezone.mockResolvedValue(BERLIN_TZ);

    expect(await autoSync(bg)).toBe(true);
    expect(stored.location?.latitude).toBe(BERLIN.latitude);
    expect(stored.timezone).toEqual(BERLIN_TZ);
    expect(stored.vpnSyncEnabled).toBe(true);
    expect(bg.broadcasts.length).toBeGreaterThan(0);
  });
});

describe("the app's VPN snapshot (bridge step 2, app coordinates)", () => {
  const snapshot = (coords: { latitude: number; longitude: number }) => ({
    updatedAt: Date.now() / 1000 + 60,
    vpnSync: true,
    ...coords,
    displayName: "Somewhere",
    timezone: "Europe/Berlin",
  });

  test("a changed location is stored with vpnSyncEnabled: true in one write", async () => {
    await boot(makeSettings({ vpnSyncEnabled: false }));
    const { adoptPendingSnapshot } = await import("@/background/app-bridge");
    lookups.timezone.mockResolvedValue(BERLIN_TZ);

    await adoptPendingSnapshot(snapshot(BERLIN));

    expect(writes).toHaveLength(1);
    expect(writes[0].location?.latitude).toBe(BERLIN.latitude);
    expect(writes[0].vpnSyncEnabled).toBe(true);
  });

  test("an unchanged location with sync already on still writes vpnSyncEnabled: true", async () => {
    await boot(makeSettings({ vpnSyncEnabled: true }));
    const { adoptPendingSnapshot } = await import("@/background/app-bridge");

    await adoptPendingSnapshot(snapshot({ latitude: TOKYO.latitude, longitude: TOKYO.longitude }));

    expect(lookups.timezone).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(writes[0].location).toEqual(TOKYO);
    expect(writes[0].vpnSyncEnabled).toBe(true);
  });
});

// --- Precision cadence -----------------------------------------------------------

describe("two overlapping switches to a time cadence", () => {
  afterEach(() => {
    vi.doUnmock("@/background/precision-cadence");
  });

  test("persist one seed and adopt the clock bucket once, with that seed", async () => {
    const bg = await boot(
      makeSettings({ precisionCadence: "never", precisionSeed: 0 }),
      slowSet(),
      () => {
        vi.doMock("@/background/precision-cadence", async (importOriginal) => {
          const actual = await importOriginal<typeof import("@/background/precision-cadence")>();
          return { ...actual, adoptClockBucket: vi.fn(actual.adoptClockBucket) };
        });
      }
    );
    const { adoptClockBucket } = await import("@/background/precision-cadence");

    const results = await Promise.all([
      bg.handleMessage({ type: "SET_PRECISION_CADENCE", payload: { cadence: "hour" } }, {}),
      bg.handleMessage({ type: "SET_PRECISION_CADENCE", payload: { cadence: "hour" } }, {}),
    ]);

    expect(results).toEqual([{ success: true }, { success: true }]);
    expect(stored.precisionCadence).toBe("hour");
    expect(stored.precisionSeed).not.toBe(0);
    expect(new Set(writes.map((w) => w.precisionSeed))).toEqual(new Set([stored.precisionSeed]));
    expect(vi.mocked(adoptClockBucket)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(adoptClockBucket)).toHaveBeenCalledWith("hour", stored.precisionSeed);
  });
});

// --- updateSettingsWith ----------------------------------------------------------

describe("updateSettingsWith", () => {
  test("null writes nothing and resolves null, and the next write still runs", async () => {
    await boot(makeSettings({ theme: "system" }));
    const { updateSettingsWith } = await import("@/background/settings");

    const skipped = updateSettingsWith(() => null);
    const next = updateSettingsWith(() => ({ theme: "dark" }));

    expect(await skipped).toBeNull();
    expect((await next)?.theme).toBe("dark");
    expect(writes).toHaveLength(1);
    expect(stored.theme).toBe("dark");
  });

  test("a throwing derive writes nothing and rejects, and the next write still runs", async () => {
    await boot(makeSettings({ theme: "system" }));
    const { updateSettings, updateSettingsWith } = await import("@/background/settings");

    const failed = updateSettingsWith(() => {
      throw new Error("derive failed");
    });
    const next = updateSettings({ theme: "dark" });

    await expect(failed).rejects.toThrow("derive failed");
    expect((await next).theme).toBe("dark");
    expect(writes).toHaveLength(1);
    expect(stored.theme).toBe("dark");
  });
});
