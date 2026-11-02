/**
 * Unit Tests for SYNC_VPN message handler and startup auto-sync
 * Feature: vpn-region-sync
 * Validates: Requirements 4.3, 6.1, 6.2, 6.3
 */

import { storageData, sessionStorageData } from "../../setup";
import { importBackground } from "../../helpers/import-background";
import { deferred } from "../../helpers/cadence";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";

// Mock browser-geo-tz so timezone lookups don't make real CDN requests
vi.mock("browser-geo-tz", () => ({
  init: vi.fn(() => ({
    find: vi.fn().mockResolvedValue(["America/New_York"]),
  })),
}));

/** Matches any of the public-IP (exit-IP) echo endpoints detectPublicIp() may hit. */
const IP_ECHO_HOST_RE =
  /checkip\.amazonaws\.com|cloudflare\.com\/cdn-cgi|whatismyip\.akamai\.com|api\.ipify\.org/;

/**
 * Mock fetch for VPN sync flow:
 * 1. IP detection via ipify
 * 2. Geolocation via geojs.io (primary) — returns lat/lng as strings
 * 3. Geolocation via freeipapi (fallback #1)
 * 4. Geolocation via reallyfreegeoip (fallback #2)
 * All three geo services run in parallel; first success wins.
 */
function mockFetchForVpnSync(ip: string, lat: number, lon: number, city: string, country: string) {
  vi.mocked(fetch)
    .mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(`${ip}\n`),
    } as Response)
    // geojs.io — lat/lng are strings
    .mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ip,
          city,
          country,
          latitude: String(lat),
          longitude: String(lon),
        }),
    } as Response)
    // freeipapi
    .mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ipAddress: ip,
          cityName: city,
          countryName: country,
          latitude: lat,
          longitude: lon,
        }),
    } as Response)
    // reallyfreegeoip
    .mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ip,
          city,
          country_name: country,
          latitude: lat,
          longitude: lon,
        }),
    } as Response);
}

describe("SYNC_VPN message handler", () => {
  /**
   * Test SYNC_VPN message routing — success path
   * Validates: Requirements 6.1, 6.2
   */
  test("should handle SYNC_VPN message and return success response", async () => {
    const { handleMessage, clearIpGeoCache, resetRateLimiter } = await importBackground();
    await clearIpGeoCache();
    await resetRateLimiter();

    mockFetchForVpnSync("203.0.113.42", 40.7128, -74.006, "New York", "United States");

    const result = await handleMessage({ type: "SYNC_VPN", payload: { forceRefresh: false } }, {});

    const response = result as Record<string, unknown>;
    expect(response.latitude).toBe(40.7128);
    expect(response.longitude).toBe(-74.006);
    expect(response.city).toBe("New York");
    expect(response.country).toBe("United States");
    expect(response.ip).toBe("203.0.113.42");
  });

  /**
   * Test SYNC_VPN persists vpnSyncEnabled on success
   * Validates: Requirements 6.1
   */
  test("should persist vpnSyncEnabled on success", async () => {
    const { handleMessage, clearIpGeoCache, resetRateLimiter, loadSettings } =
      await importBackground();
    await clearIpGeoCache();
    await resetRateLimiter();

    mockFetchForVpnSync("198.51.100.1", 51.5074, -0.1278, "London", "United Kingdom");

    await handleMessage({ type: "SYNC_VPN", payload: { forceRefresh: true } }, {});

    const settings = await loadSettings();
    expect(settings.vpnSyncEnabled).toBe(true);
  });

  /**
   * Test SYNC_VPN calls handleSetLocation with correct coordinates
   * Validates: Requirements 6.1
   */
  test("should call handleSetLocation with coordinates from VPN sync", async () => {
    const { handleMessage, clearIpGeoCache, resetRateLimiter, loadSettings } =
      await importBackground();
    await clearIpGeoCache();
    await resetRateLimiter();

    mockFetchForVpnSync("203.0.113.42", 35.6762, 139.6503, "Tokyo", "Japan");

    await handleMessage({ type: "SYNC_VPN", payload: { forceRefresh: false } }, {});

    const settings = await loadSettings();
    expect(settings.location).not.toBeNull();
    expect(settings.location!.latitude).toBe(35.6762);
    expect(settings.location!.longitude).toBe(139.6503);
  });

  /**
   * Test SYNC_VPN returns error response on IP detection failure
   * Validates: Requirements 6.3
   */
  test("should return error response when IP detection fails", async () => {
    const { handleMessage, clearIpGeoCache, resetRateLimiter } = await importBackground();
    await clearIpGeoCache();
    await resetRateLimiter();

    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));

    const result = await handleMessage({ type: "SYNC_VPN", payload: { forceRefresh: false } }, {});

    const response = result as Record<string, unknown>;
    expect(response.error).toBe("IP_DETECTION_FAILED");
    expect(typeof response.message).toBe("string");
    expect((response.message as string).length).toBeGreaterThan(0);
  });

  /**
   * Test SYNC_VPN returns error response on geolocation failure
   * Validates: Requirements 6.3
   */
  test("should return error response when geolocation fails", async () => {
    const { handleMessage, clearIpGeoCache, resetRateLimiter } = await importBackground();
    await clearIpGeoCache();
    await resetRateLimiter();

    // Mock: IP detection succeeds, then all four geo services fail (geojs, freeipapi, reallyfreegeoip, ipinfo)
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("203.0.113.42\n"),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      } as Response);

    const result = await handleMessage({ type: "SYNC_VPN", payload: { forceRefresh: false } }, {});

    const response = result as Record<string, unknown>;
    expect(response.error).toBe("GEOLOCATION_FAILED");
    expect(typeof response.message).toBe("string");
  });

  /**
   * Test SYNC_VPN does not persist settings on failure
   * Validates: Requirements 6.3
   */
  test("should not persist vpnSyncEnabled on failure", async () => {
    const { handleMessage, clearIpGeoCache, resetRateLimiter, loadSettings } =
      await importBackground();
    await clearIpGeoCache();
    await resetRateLimiter();

    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));

    await handleMessage({ type: "SYNC_VPN", payload: { forceRefresh: false } }, {});

    const settings = await loadSettings();
    expect(settings.vpnSyncEnabled).toBe(false);
  });

  /**
   * Test SYNC_VPN defaults forceRefresh to false when payload is missing
   * Validates: Requirements 6.1
   */
  test("should default forceRefresh to false when no payload provided", async () => {
    const { handleMessage, clearIpGeoCache, resetRateLimiter } = await importBackground();
    await clearIpGeoCache();
    await resetRateLimiter();

    mockFetchForVpnSync("203.0.113.42", 48.8566, 2.3522, "Paris", "France");

    const result = await handleMessage({ type: "SYNC_VPN" }, {});

    const response = result as Record<string, unknown>;
    expect(response.latitude).toBe(48.8566);
    expect(response.longitude).toBe(2.3522);
  });
});

describe("DISABLE_VPN_SYNC message handler", () => {
  /**
   * Test DISABLE_VPN_SYNC sets vpnSyncEnabled to false in storage
   * Validates: Requirements 9.3, 3.5
   */
  test("should set vpnSyncEnabled to false in storage", async () => {
    const { handleMessage, clearIpGeoCache, resetRateLimiter, loadSettings, updateSettings } =
      await importBackground();
    await clearIpGeoCache();
    await resetRateLimiter();

    // First enable VPN sync
    await updateSettings({ vpnSyncEnabled: true });
    let settings = await loadSettings();
    expect(settings.vpnSyncEnabled).toBe(true);

    // Send DISABLE_VPN_SYNC
    const result = await handleMessage({ type: "DISABLE_VPN_SYNC" }, {});

    expect(result).toEqual({ success: true });

    settings = await loadSettings();
    expect(settings.vpnSyncEnabled).toBe(false);
  });

  /**
   * Test DISABLE_VPN_SYNC clears the in-memory IP geolocation cache
   * Validates: Requirements 9.3
   */
  test("should clear the IP geolocation cache", async () => {
    const { handleMessage, resetRateLimiter } = await importBackground();
    await resetRateLimiter();

    // Populate session storage cache with a fake entry (using the "cache:" prefix from session-cache)
    sessionStorageData["cache:ipGeo:203.0.113.42"] = {
      latitude: 40.7128,
      longitude: -74.006,
      city: "New York",
      country: "United States",
      ip: "203.0.113.42",
    };
    expect(
      Object.keys(sessionStorageData).filter((k) => k.startsWith("cache:ipGeo:"))
    ).toHaveLength(1);

    // Send DISABLE_VPN_SYNC
    await handleMessage({ type: "DISABLE_VPN_SYNC" }, {});

    expect(
      Object.keys(sessionStorageData).filter((k) => k.startsWith("cache:ipGeo:"))
    ).toHaveLength(0);
  });

  /**
   * Test DISABLE_VPN_SYNC prevents auto-sync on next startup
   * Validates: Requirements 9.3, 3.5
   */
  test("should prevent auto-sync on next startup after disabling", async () => {
    const { handleMessage, clearIpGeoCache, resetRateLimiter, updateSettings } =
      await importBackground();
    await clearIpGeoCache();
    await resetRateLimiter();

    // Enable VPN sync, then disable it
    await updateSettings({ vpnSyncEnabled: true });
    await handleMessage({ type: "DISABLE_VPN_SYNC" }, {});

    // Simulate a fresh startup by re-importing
    vi.mocked(fetch).mockClear();

    storageData.settings = await (async () => {
      const { loadSettings } = await importBackground();
      return await loadSettings();
    })();

    const { initialize } = await importBackground();
    await initialize();

    // No VPN-related fetch calls should have been made
    const fetchCalls = vi.mocked(fetch).mock.calls;
    const vpnIpCalls = fetchCalls.filter(
      (call) => typeof call[0] === "string" && IP_ECHO_HOST_RE.test(call[0])
    );
    expect(vpnIpCalls).toHaveLength(0);
  });
});

describe("Startup auto-sync", () => {
  /**
   * Test auto-sync triggers when vpnSyncEnabled is true
   * Validates: Requirements 4.3
   */
  test("should auto-sync VPN location on startup when vpnSyncEnabled is true", async () => {
    // Pre-populate storage with vpnSyncEnabled: true
    storageData.settings = {
      ...DEFAULT_SETTINGS,
      vpnSyncEnabled: true,
      enabled: true,
    };

    // Mock fetch for the auto-sync flow: IP detection + 3 parallel geo services
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("203.0.113.42\n"),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ip: "203.0.113.42",
            city: "San Francisco",
            country: "United States",
            latitude: "37.7749",
            longitude: "-122.4194",
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ipAddress: "203.0.113.42",
            cityName: "San Francisco",
            countryName: "United States",
            latitude: 37.7749,
            longitude: -122.4194,
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ip: "203.0.113.42",
            city: "San Francisco",
            country_name: "United States",
            latitude: 37.7749,
            longitude: -122.4194,
          }),
      } as Response);

    const { initialize, loadSettings } = await importBackground();
    await initialize();

    const settings = await loadSettings();
    expect(settings.location).not.toBeNull();
    expect(settings.location!.latitude).toBe(37.7749);
    expect(settings.location!.longitude).toBe(-122.4194);
  });

  /**
   * A manual location set while the startup sync is on its network calls is
   * kept: the sync's write re-checks vpnSyncEnabled (onlyWhileVpnSync).
   */
  test("keeps a manual location set while the startup sync is on its IP lookup", async () => {
    storageData.settings = {
      ...DEFAULT_SETTINGS,
      vpnSyncEnabled: true,
      enabled: true,
    };

    // The IP detection is held; the three geo services answer as above.
    const ipResponse = deferred<Response>();
    vi.mocked(fetch)
      .mockReturnValueOnce(ipResponse.promise)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ip: "203.0.113.42",
            city: "San Francisco",
            country: "United States",
            latitude: "37.7749",
            longitude: "-122.4194",
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ipAddress: "203.0.113.42",
            cityName: "San Francisco",
            countryName: "United States",
            latitude: 37.7749,
            longitude: -122.4194,
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ip: "203.0.113.42",
            city: "San Francisco",
            country_name: "United States",
            latitude: 37.7749,
            longitude: -122.4194,
          }),
      } as Response);

    const { initialize, loadSettings, handleSetLocation } = await importBackground();
    const startup = initialize();
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some((c) => typeof c[0] === "string" && IP_ECHO_HOST_RE.test(c[0]))
      ).toBe(true)
    );

    // A manual set with a name, as bridge step 2's manual branch makes, so no
    // reverse-geocode fetch.
    await handleSetLocation(
      { latitude: 48.8566, longitude: 2.3522 },
      { locationName: { city: "Paris", country: "France", displayName: "Paris, France" } }
    );

    ipResponse.resolve({ ok: true, text: () => Promise.resolve("203.0.113.42\n") } as Response);
    await startup;

    const settings = await loadSettings();
    expect(settings.location!.latitude).toBe(48.8566);
    expect(settings.location!.longitude).toBe(2.3522);
    expect(settings.vpnSyncEnabled).toBe(false);
  });

  /**
   * Test auto-sync does NOT trigger when vpnSyncEnabled is false
   * Validates: Requirements 4.3
   */
  test("should not auto-sync when vpnSyncEnabled is false", async () => {
    storageData.settings = {
      ...DEFAULT_SETTINGS,
      vpnSyncEnabled: false,
    };

    const { initialize } = await importBackground();
    await initialize();

    // fetch should not have been called for VPN sync (may be called for other init tasks)
    // The key assertion is that no VPN-related fetch calls were made
    const fetchCalls = vi.mocked(fetch).mock.calls;
    const vpnIpCalls = fetchCalls.filter(
      (call) => typeof call[0] === "string" && IP_ECHO_HOST_RE.test(call[0])
    );
    expect(vpnIpCalls).toHaveLength(0);
  });

  /**
   * Test auto-sync failure does not block startup
   * Validates: Requirements 4.3
   */
  test("should not block startup when auto-sync fails", async () => {
    storageData.settings = {
      ...DEFAULT_SETTINGS,
      vpnSyncEnabled: true,
    };

    // Mock fetch to fail for IP detection
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network unavailable"));

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { initialize, loadSettings } = await importBackground();

    // initialize should complete without throwing
    await expect(initialize()).resolves.not.toThrow();

    const settings = await loadSettings();
    // vpnSyncEnabled should remain true (not cleared on failure)
    expect(settings.vpnSyncEnabled).toBe(true);

    consoleSpy.mockRestore();
  });

  /**
   * Test auto-sync uses cache (forceRefresh=false)
   * Validates: Requirements 4.3
   */
  test("should use cache for startup auto-sync (forceRefresh=false)", async () => {
    storageData.settings = {
      ...DEFAULT_SETTINGS,
      vpnSyncEnabled: true,
    };

    // Mock fetch for IP detection + 3 parallel geo services
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("10.0.0.1\n"),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ip: "10.0.0.1",
            city: "Berlin",
            country: "Germany",
            latitude: "52.52",
            longitude: "13.405",
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ipAddress: "10.0.0.1",
            cityName: "Berlin",
            countryName: "Germany",
            latitude: 52.52,
            longitude: 13.405,
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ip: "10.0.0.1",
            city: "Berlin",
            country_name: "Germany",
            latitude: 52.52,
            longitude: 13.405,
          }),
      } as Response);

    const { initialize, loadSettings } = await importBackground();
    await initialize();

    const settings = await loadSettings();
    expect(settings.location).not.toBeNull();
    expect(settings.location!.latitude).toBe(52.52);
    expect(settings.location!.longitude).toBe(13.405);
  });
});

// --- Per-endpoint geo-service cooldown ---------------------------------------

const GEOJS_HOST = "get.geojs.io";
const FREEIPAPI_HOST = "free.freeipapi.com";

/** A geo-service JSON success body in geojs's shape (lat/lng as strings). */
function geojsOk(ip: string, lat: number, lon: number, city: string, country: string) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({ ip, city, country, latitude: String(lat), longitude: String(lon) }),
  } as Response;
}

/** A freeipapi JSON success body. */
function freeIpApiOk(ip: string, lat: number, lon: number, city: string, country: string) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        ipAddress: ip,
        cityName: city,
        countryName: country,
        latitude: lat,
        longitude: lon,
      }),
  } as Response;
}

/**
 * Route fetch by URL substring instead of call order, so parallel geo requests
 * (raced via Promise.any) can each be answered deterministically and we can
 * assert which endpoints were actually hit.
 */
function routeFetch(handler: (url: string) => Response | undefined) {
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : "";
    const res = handler(url);
    if (res) return Promise.resolve(res);
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

/** True if any fetch call targeted a URL containing `host`. */
function fetchedHost(host: string): boolean {
  return vi.mocked(fetch).mock.calls.some((c) => typeof c[0] === "string" && c[0].includes(host));
}

describe("Per-endpoint geo-service cooldown", () => {
  test("a geo service that returns 429 is parked and skipped on the next sync", async () => {
    const { syncVpnLocation, clearIpGeoCache, resetRateLimiter } = await importBackground();
    await clearIpGeoCache();
    await resetRateLimiter();

    const ip = "203.0.113.42";
    // First sync: geojs 429s, freeipapi wins.
    routeFetch((url) => {
      if (IP_ECHO_HOST_RE.test(url))
        return { ok: true, text: () => Promise.resolve(`${ip}\n`) } as Response;
      if (url.includes(GEOJS_HOST))
        return { ok: false, status: 429, json: () => Promise.resolve({}) } as Response;
      if (url.includes(FREEIPAPI_HOST)) return freeIpApiOk(ip, 51.5074, -0.1278, "London", "UK");
      // other geo services: fail so freeipapi is unambiguously the winner
      return { ok: false, status: 500, json: () => Promise.resolve({}) } as Response;
    });

    const first = await syncVpnLocation(true);
    expect("error" in first).toBe(false);

    // Second sync (force, to bypass cache + dedup): geojs is parked, so it must
    // not be fetched again; freeipapi serves the result.
    vi.mocked(fetch).mockClear();
    routeFetch((url) => {
      if (IP_ECHO_HOST_RE.test(url))
        return { ok: true, text: () => Promise.resolve(`${ip}\n`) } as Response;
      if (url.includes(FREEIPAPI_HOST)) return freeIpApiOk(ip, 51.5074, -0.1278, "London", "UK");
      if (url.includes(GEOJS_HOST))
        return { ok: false, status: 429, json: () => Promise.resolve({}) } as Response;
      return { ok: false, status: 500, json: () => Promise.resolve({}) } as Response;
    });

    const second = await syncVpnLocation(true);
    expect("error" in second).toBe(false);

    expect(fetchedHost(GEOJS_HOST)).toBe(false);
  });

  test("clearEndpointCooldowns un-parks a service so it is tried again", async () => {
    const { syncVpnLocation, clearIpGeoCache, clearEndpointCooldowns, resetRateLimiter } =
      await importBackground();
    await clearIpGeoCache();
    await resetRateLimiter();

    const ip = "198.51.100.7";
    routeFetch((url) => {
      if (IP_ECHO_HOST_RE.test(url))
        return { ok: true, text: () => Promise.resolve(`${ip}\n`) } as Response;
      if (url.includes(GEOJS_HOST))
        return { ok: false, status: 429, json: () => Promise.resolve({}) } as Response;
      if (url.includes(FREEIPAPI_HOST)) return freeIpApiOk(ip, 35.6762, 139.6503, "Tokyo", "Japan");
      return { ok: false, status: 500, json: () => Promise.resolve({}) } as Response;
    });

    await syncVpnLocation(true); // parks geojs

    // A manual sync clears cooldowns — geojs should get a fresh shot.
    clearEndpointCooldowns();
    vi.mocked(fetch).mockClear();
    routeFetch((url) => {
      if (IP_ECHO_HOST_RE.test(url))
        return { ok: true, text: () => Promise.resolve(`${ip}\n`) } as Response;
      if (url.includes(GEOJS_HOST)) return geojsOk(ip, 35.6762, 139.6503, "Tokyo", "Japan");
      if (url.includes(FREEIPAPI_HOST)) return freeIpApiOk(ip, 35.6762, 139.6503, "Tokyo", "Japan");
      return { ok: false, status: 500, json: () => Promise.resolve({}) } as Response;
    });

    await syncVpnLocation(true);

    expect(fetchedHost(GEOJS_HOST)).toBe(true);
  });
});
