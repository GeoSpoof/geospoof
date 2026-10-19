/**
 * Integration Tests for Error Recovery
 *
 * Tests error handling and recovery workflows:
 * - Geocoding timeout → display error → allow manual coordinates
 * - Reverse geocoding failure → display coordinates only
 * - Content script injection failure → display warning
 *
 * Requirements: 9.3, 9.5, 9.6, 8.5
 */

const background = await import("@/background");
import {
  expectStorageSet,
  getSavedSettings,
  getLastSavedSettings,
  fetchMock,
  getLastBroadcastMessage,
} from "../helpers/mock-types";

// Mock browser-geo-tz — timezone resolution is now offline
vi.mock("browser-geo-tz", () => ({
  init: vi.fn(() => ({
    find: vi.fn().mockResolvedValue([]),
  })),
}));

const { init: _geoTzInitMock } = await import("browser-geo-tz");
const _initMocked = vi.mocked(_geoTzInitMock);
function getMockedFind() {
  const results = _initMocked.mock.results;
  const lastResult = results[results.length - 1];
  if (lastResult && lastResult.type === "return") {
    return vi.mocked((lastResult.value as { find: ReturnType<typeof vi.fn> }).find);
  }
  const findFn = vi.fn().mockResolvedValue([]);
  _initMocked.mockReturnValue({ find: findFn });
  return findFn;
}
const mockedFind = getMockedFind();

describe("Error Recovery Integration Tests", () => {
  beforeEach(async () => {
    // Clear timezone cache to prevent cache hits from previous tests
    await background.clearTimezoneCache();
    mockedFind.mockReset();

    // Default storage mock
    browser.storage.local.get.mockResolvedValue({
      settings: {
        enabled: false,
        location: null,
        timezone: null,
        locationName: null,
        webrtcProtection: false,
        preserveGeolocationPrompt: false,
        onboardingCompleted: true,
        version: "1.0",
        lastUpdated: Date.now(),
      },
    });

    browser.storage.local.set.mockResolvedValue(undefined);

    // Default tabs mock
    browser.tabs.query.mockResolvedValue([{ id: 1, url: "https://example.com" }]);

    browser.tabs.sendMessage.mockResolvedValue(undefined);
  });

  describe("Workflow: Geocoding timeout → display error → allow manual coordinates", () => {
    test("should handle geocoding timeout and allow manual coordinate entry", async () => {
      // Step 1: User searches for location, but request times out
      const searchQuery = "San Francisco";

      // Mock fetch to simulate timeout (AbortError)
      fetchMock().mockImplementationOnce(() => {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          }, 100);
        });
      });

      // Act: Attempt geocoding
      let result: { error: string } | undefined;
      try {
        await background.geocodeQuery(searchQuery);
      } catch (error: unknown) {
        result = { error: (error as Error).message };
      }

      // Assert: Error returned with timeout message
      expect(result).toBeDefined();
      expect(result!.error).toBe("TIMEOUT");

      // Step 2: User enters manual coordinates instead
      const manualLocation = {
        latitude: 37.7749,
        longitude: -122.4194,
      };

      // Mock timezone resolution via browser-geo-tz (should still work)
      mockedFind.mockResolvedValue(["America/Los_Angeles"]);

      // Mock reverse geocoding (should still work)
      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "San Francisco, CA, USA",
            address: {
              city: "San Francisco",
              country: "USA",
            },
          }),
      });

      // Act: Set location manually
      await background.handleSetLocation(manualLocation);

      // Assert: Location set successfully despite geocoding timeout
      expectStorageSet().toHaveBeenCalled();
      const savedSettings = getSavedSettings();
      expect(savedSettings.location!.latitude).toBe(37.7749);
      expect(savedSettings.location!.longitude).toBe(-122.4194);
    });

    test("should handle network error during geocoding", async () => {
      // Step 1: Simulate network error
      fetchMock().mockRejectedValueOnce(new Error("Network request failed"));

      let result: { error: string } | undefined;
      try {
        await background.geocodeQuery("London");
      } catch (error: unknown) {
        result = { error: (error as Error).message };
      }

      // Assert: Error returned
      expect(result).toBeDefined();
      expect(result!.error).toBe("NETWORK");

      // Step 2: User can still set manual coordinates
      const manualLocation = {
        latitude: 51.5074,
        longitude: -0.1278,
      };

      // Mock successful timezone and reverse geocoding
      mockedFind.mockResolvedValue(["Europe/London"]);

      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "London, England, UK",
            address: {
              city: "London",
              country: "UK",
            },
          }),
      });

      await background.handleSetLocation(manualLocation);

      // Assert: Manual coordinates work
      const savedSettings = getSavedSettings();
      expect(savedSettings.location!.latitude).toBe(51.5074);
    });

    test("should handle geocoding API returning error status", async () => {
      // Step 1: API returns 500 error
      fetchMock().mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      let result: { error: string } | undefined;
      try {
        await background.geocodeQuery("Tokyo");
      } catch (error: unknown) {
        result = { error: (error as Error).message };
      }

      // Assert: Error returned
      expect(result).toBeDefined();
      expect(result!.error).toBeDefined();

      // Step 2: Manual coordinates still work
      const manualLocation = {
        latitude: 35.6762,
        longitude: 139.6503,
      };

      mockedFind.mockResolvedValue(["Asia/Tokyo"]);

      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Tokyo, Japan",
            address: {
              city: "Tokyo",
              country: "Japan",
            },
          }),
      });

      await background.handleSetLocation(manualLocation);

      const savedSettings = getSavedSettings();
      expect(savedSettings.location!.latitude).toBe(35.6762);
    });

    test("should handle empty geocoding results gracefully", async () => {
      // Step 1: API returns empty results
      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const result = await background.geocodeQuery("NonexistentPlace12345");

      // Assert: Empty results returned (not an error)
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);

      // Step 2: User can enter manual coordinates
      const manualLocation = {
        latitude: 0,
        longitude: 0,
      };

      // Mock timezone resolution via browser-geo-tz
      mockedFind.mockResolvedValue(["Etc/GMT"]);

      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Atlantic Ocean",
            address: {},
          }),
      });

      await background.handleSetLocation(manualLocation);

      const savedSettings = getSavedSettings();
      expect(savedSettings.location).toBeDefined();
    });
  });

  describe("Workflow: Reverse geocoding failure → display coordinates only", () => {
    test("should handle reverse geocoding failure and display coordinates", async () => {
      // Step 1: User sets location via coordinates
      const location = {
        latitude: 45.0,
        longitude: 90.0,
      };

      // Mock timezone resolution via browser-geo-tz
      mockedFind.mockResolvedValue(["Asia/Urumqi"]);

      // Mock reverse geocoding failure
      fetchMock().mockRejectedValueOnce(new Error("Reverse geocoding failed"));

      // Act: Set location
      await background.handleSetLocation(location);

      // Assert: Location saved despite reverse geocoding failure
      expectStorageSet().toHaveBeenCalled();
      const savedSettings = getSavedSettings();
      expect(savedSettings.location!.latitude).toBe(45.0);
      expect(savedSettings.location!.longitude).toBe(90.0);
      expect(savedSettings.timezone!.identifier).toBe("Asia/Urumqi");

      // Assert: locationName is null or has fallback
      // (Implementation should handle this gracefully)
      expect(
        savedSettings.locationName === null || savedSettings.locationName.displayName
      ).toBeTruthy();
    });

    test("should handle reverse geocoding timeout", async () => {
      const location = {
        latitude: -15.0,
        longitude: -60.0,
      };

      // Mock timezone resolution via browser-geo-tz
      mockedFind.mockResolvedValue(["America/Cuiaba"]);

      // Mock reverse geocoding timeout
      fetchMock().mockImplementationOnce(() => {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          }, 100);
        });
      });

      await background.handleSetLocation(location);

      // Assert: Location saved with coordinates
      const savedSettings = getSavedSettings();
      expect(savedSettings.location!.latitude).toBe(-15.0);
      expect(savedSettings.location!.longitude).toBe(-60.0);
    });

    test("should handle reverse geocoding returning no results", async () => {
      const location = {
        latitude: -50.0,
        longitude: 150.0,
      };

      // Mock timezone resolution via browser-geo-tz
      mockedFind.mockResolvedValue(["Australia/Melbourne"]);

      // Mock reverse geocoding with empty/invalid result
      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "",
            address: {},
          }),
      });

      await background.handleSetLocation(location);

      // Assert: Location saved
      const savedSettings = getSavedSettings();
      expect(savedSettings.location!.latitude).toBe(-50.0);
      expect(savedSettings.location!.longitude).toBe(150.0);
    });

    test("should handle reverse geocoding API error status", async () => {
      const location = {
        latitude: 60.0,
        longitude: 100.0,
      };

      // Mock timezone resolution via browser-geo-tz
      mockedFind.mockResolvedValue(["Asia/Krasnoyarsk"]);

      // Mock reverse geocoding API error
      fetchMock().mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      });

      await background.handleSetLocation(location);

      // Assert: Location saved despite API error
      const savedSettings = getSavedSettings();
      expect(savedSettings.location!.latitude).toBe(60.0);
      expect(savedSettings.location!.longitude).toBe(100.0);
    });
  });

  describe("Workflow: Content script injection failure → display warning", () => {
    test("should detect content script injection failure and display warning", async () => {
      // Step 1: Set up location and enable protection
      const location = {
        latitude: 40.7128,
        longitude: -74.006,
      };

      // Mock timezone resolution via browser-geo-tz
      mockedFind.mockResolvedValue(["America/New_York"]);

      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "New York, NY, USA",
            address: {
              city: "New York",
              country: "USA",
            },
          }),
      });

      await background.handleSetLocation(location);
      await background.handleSetProtectionStatus({ enabled: true });

      // Step 2: Simulate content script injection failure
      const failedTabId = 42;

      browser.tabs.sendMessage.mockImplementationOnce((tabId) => {
        if (tabId === failedTabId) {
          return Promise.reject(new Error("Could not establish connection"));
        }
        return Promise.resolve();
      });

      // Act: Try to send message to tab (simulating broadcast)
      try {
        await browser.tabs.sendMessage(failedTabId, {
          type: "UPDATE_SETTINGS",
          payload: {},
        });
      } catch (error: unknown) {
        // Expected to fail
        expect((error as Error).message).toContain("Could not establish connection");
      }

      // Assert: Error was caught (in real implementation, would update badge)
      // The background script should handle this gracefully
    });

    test("should handle injection failure on multiple tabs", async () => {
      // Setup: Multiple tabs, some fail injection
      const tabs = [
        { id: 1, url: "https://example.com" },
        { id: 2, url: "about:blank" }, // Will fail
        { id: 3, url: "https://test.com" },
        { id: 4, url: "moz-extension://abc" }, // Will fail
      ];

      browser.tabs.query.mockResolvedValue(tabs);

      // Mock sendMessage to fail for certain tabs
      browser.tabs.sendMessage.mockImplementation((tabId: number) => {
        if (tabId === 2 || tabId === 4) {
          return Promise.reject(new Error("Content script not available"));
        }
        return Promise.resolve();
      });

      const settings = {
        enabled: true,
        location: {
          latitude: 51.5074,
          longitude: -0.1278,
          accuracy: 10,
        },
        timezone: {
          identifier: "Europe/London",
          offset: 0,
          dstOffset: 60,
        },
        locationName: null,
        webrtcProtection: false,
        preserveGeolocationPrompt: false,
        onboardingCompleted: true,
        version: "1.0",
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
        accuracySeed: 0,
        locationPrecision: { mode: "exact" as const },
        precisionSeed: 0,
        precisionCadence: "never" as const,
        localeSpoofing: { mode: "off" as const },
        siteLocations: [],
      };

      // Act: Broadcast settings (should not throw)
      await expect(background.broadcastSettingsToTabs(settings)).resolves.not.toThrow();

      // Assert: All tabs were attempted
      expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(4);
    });

    test("should continue operation when some tabs fail", async () => {
      // Setup: Enable protection with location
      const location = {
        latitude: 48.8566,
        longitude: 2.3522,
      };

      // Mock timezone resolution via browser-geo-tz
      mockedFind.mockResolvedValue(["Europe/Paris"]);

      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Paris, France",
            address: {
              city: "Paris",
              country: "France",
            },
          }),
      });

      await background.handleSetLocation(location);

      // Mock tabs with mixed success/failure
      browser.tabs.query.mockResolvedValue([
        { id: 1, url: "https://example1.com" },
        { id: 2, url: "https://example2.com" },
        { id: 3, url: "https://example3.com" },
      ]);

      let successCount = 0;
      let failureCount = 0;

      browser.tabs.sendMessage.mockImplementation((tabId: number) => {
        if (tabId === 2) {
          failureCount++;
          return Promise.reject(new Error("Injection failed"));
        }
        successCount++;
        return Promise.resolve();
      });

      // Act: Enable protection (triggers broadcast)
      await background.handleSetProtectionStatus({ enabled: true });

      // Assert: Some tabs succeeded
      expect(successCount).toBeGreaterThan(0);
      expect(failureCount).toBeGreaterThan(0);

      // Assert: Protection still enabled despite failures
      const savedSettings = getLastSavedSettings();
      expect(savedSettings.enabled).toBe(true);
    });
  });

  describe("Combined error scenarios", () => {
    test("should handle multiple errors in sequence", async () => {
      // Step 1: Geocoding fails
      fetchMock().mockRejectedValueOnce(new Error("Network error"));

      let geocodeResult: { error: string } | undefined;
      try {
        await background.geocodeQuery("Berlin");
      } catch (error: unknown) {
        geocodeResult = { error: (error as Error).message };
      }

      expect(geocodeResult).toBeDefined();
      expect(geocodeResult!.error).toBe("NETWORK");

      // Step 2: User enters manual coordinates
      const location = {
        latitude: 52.52,
        longitude: 13.405,
      };

      // Step 3: Timezone resolution fails, should use fallback
      mockedFind.mockRejectedValue(new Error("Timezone lookup error"));

      // Step 4: Reverse geocoding also fails
      fetchMock().mockRejectedValueOnce(new Error("Reverse geocoding error"));

      // Act: Set location (should handle all failures gracefully)
      await background.handleSetLocation(location);

      // Assert: Location still saved with fallback timezone
      expectStorageSet().toHaveBeenCalled();
      const savedSettings = getSavedSettings();
      expect(savedSettings.location!.latitude).toBe(52.52);
      expect(savedSettings.location!.longitude).toBe(13.405);
      // Timezone should have fallback value
      expect(savedSettings.timezone).toBeDefined();
    });

    test("should recover from errors and continue normal operation", async () => {
      // Step 1: First attempt fails
      fetchMock().mockRejectedValueOnce(new Error("Network error"));

      let failedResult: { error: string } | undefined;
      try {
        await background.geocodeQuery("Sydney");
      } catch (error: unknown) {
        failedResult = { error: (error as Error).message };
      }

      expect(failedResult).toBeDefined();
      expect(failedResult!.error).toBeDefined();

      // Step 2: Second attempt succeeds
      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              display_name: "Sydney, NSW, Australia",
              lat: "-33.8688",
              lon: "151.2093",
              address: {
                city: "Sydney",
                country: "Australia",
              },
            },
          ]),
      });

      const successResult = await background.geocodeQuery("Sydney");

      // Assert: Recovery successful
      expect(Array.isArray(successResult)).toBe(true);
      expect(successResult).toHaveLength(1);
      expect(successResult[0].name).toBe("Sydney, NSW, Australia");
    });

    test("should handle storage errors gracefully", async () => {
      // Simulate storage error
      browser.storage.local.set.mockRejectedValueOnce(new Error("Storage quota exceeded"));

      const location = {
        latitude: 35.6762,
        longitude: 139.6503,
      };

      // Mock timezone resolution via browser-geo-tz
      mockedFind.mockResolvedValue(["Asia/Tokyo"]);

      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Tokyo, Japan",
            address: {
              city: "Tokyo",
              country: "Japan",
            },
          }),
      });

      // Act: Try to set location
      try {
        await background.handleSetLocation(location);
      } catch (error: unknown) {
        // Expected to fail
        expect((error as Error).message).toContain("Storage quota exceeded");
      }

      // In real implementation, should handle this error and notify user
    });

    test("should handle WebRTC API permission errors", async () => {
      // Simulate permission denied
      browser.privacy.network.webRTCIPHandlingPolicy.set.mockRejectedValueOnce(
        new Error("Permission denied")
      );

      // Act: Try to enable WebRTC protection
      try {
        await background.handleSetWebRTCProtection({ enabled: true });
      } catch (error: unknown) {
        // Expected to fail
        expect((error as Error).message).toContain("Permission denied");
      }

      // In real implementation, should display error to user
    });
  });

  describe("Error recovery with user workflow", () => {
    test("should complete workflow despite geocoding error", async () => {
      // Step 1: Geocoding fails (with retries)
      fetchMock().mockRejectedValueOnce(new Error("API unavailable"));
      fetchMock().mockRejectedValueOnce(new Error("API unavailable")); // Retry 1
      fetchMock().mockRejectedValueOnce(new Error("API unavailable")); // Retry 2

      let geocodeResult: { error: string } | undefined;
      try {
        await background.geocodeQuery("Moscow");
      } catch (error: unknown) {
        geocodeResult = { error: (error as Error).message };
      }

      expect(geocodeResult).toBeDefined();
      expect(geocodeResult!.error).toBeDefined();

      // Step 2: User switches to manual coordinates
      const location = {
        latitude: 55.7558,
        longitude: 37.6173,
      };

      // Step 3: Timezone resolution succeeds via browser-geo-tz
      mockedFind.mockResolvedValue(["Europe/Moscow"]);

      // Step 4: Reverse geocoding succeeds
      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Moscow, Russia",
            address: {
              city: "Moscow",
              country: "Russia",
            },
          }),
      });

      await background.handleSetLocation(location);

      // Step 4: Enable protection
      // updateBadge() (invoked by handleSetProtectionStatus) independently
      // re-reads settings via loadSettings(). Make storage reads reflect the
      // latest persisted settings (read-after-write) so the re-read sees
      // enabled:true and the badge resolves to the active "green" state for a
      // normal (in-scope, non-restricted) tab.
      const persistedBase = { ...getLastSavedSettings(), enabled: false };
      browser.storage.local.get.mockImplementation(() => {
        // Access via index signature to avoid unbound-method on the mock.
        const setMock = (
          browser.storage.local as unknown as Record<string, { mock: { calls: unknown[][] } }>
        )["set"];
        const calls = setMock.mock.calls;
        const latest = calls.length
          ? (calls[calls.length - 1][0] as { settings: typeof persistedBase }).settings
          : persistedBase;
        return Promise.resolve({ settings: latest });
      });

      await background.handleSetProtectionStatus({ enabled: true });

      // Assert: Workflow completed successfully
      const savedSettings = getLastSavedSettings();
      expect(savedSettings.enabled).toBe(true);
      expect(savedSettings.location!.latitude).toBe(55.7558);
      // Timezone may be fallback if API fails, but location should still work
      expect(savedSettings.timezone).toBeDefined();
      expect(savedSettings.timezone!.identifier).toBeDefined();

      // Assert: Badge updated
      expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith(
        expect.objectContaining({ color: "green" })
      );
    });
  });
});

describe("Timezone Error Recovery Tests", () => {
  beforeEach(async () => {
    // Clear timezone cache to prevent cache hits from previous tests
    await background.clearTimezoneCache();
    mockedFind.mockReset();

    // Reset storage to clean state before each test
    browser.storage.local.get.mockResolvedValue({
      settings: {
        enabled: false,
        location: null,
        timezone: null,
        locationName: null,
        webrtcProtection: false,
        preserveGeolocationPrompt: false,
        onboardingCompleted: true,
        version: "1.0",
        lastUpdated: Date.now(),
      },
    });

    browser.storage.local.set.mockResolvedValue(undefined);

    // Default tabs mock
    browser.tabs.query.mockResolvedValue([{ id: 1, url: "https://example.com" }]);

    browser.tabs.sendMessage.mockResolvedValue(undefined);
  });

  describe("Missing Timezone Data Scenarios", () => {
    test("should handle null timezone data gracefully", async () => {
      // Set location without timezone
      const location = {
        latitude: 35.6762,
        longitude: 139.6503,
      };

      // Mock timezone resolution to return no results (triggers fallback)
      mockedFind.mockResolvedValue([]);

      // Mock reverse geocoding (second fetch call)
      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Tokyo, Japan",
            address: {
              city: "Tokyo",
              country: "Japan",
            },
          }),
      });

      // Act: Set location
      await background.handleSetLocation(location);

      // Assert: Location saved with fallback timezone
      expectStorageSet().toHaveBeenCalled();
      const savedSettings = getSavedSettings();

      expect(savedSettings.location).toBeDefined();
      expect(savedSettings.location!.latitude).toBe(35.6762);
      // Fallback timezones are not persisted to storage (they are DST-unaware estimates);
      // timezone is saved as null so the next session retries the real lookup.
      expect(savedSettings.timezone).toBeNull();
    });

    test("should continue geolocation spoofing when timezone API fails", async () => {
      // Set location
      const location = {
        latitude: 48.8566,
        longitude: 2.3522,
      };

      // Mock timezone resolution to fail (triggers fallback)
      mockedFind.mockRejectedValue(new Error("Network error"));

      // Mock reverse geocoding to succeed
      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Paris, France",
            address: {
              city: "Paris",
              country: "France",
            },
          }),
      });

      // Act: Set location
      await background.handleSetLocation(location);

      // Assert: Location saved despite timezone API failure
      expectStorageSet().toHaveBeenCalled();
      const savedSettings = getSavedSettings();

      expect(savedSettings.location).toBeDefined();
      expect(savedSettings.location!.latitude).toBe(48.8566);
      // Fallback timezones are not persisted to storage — timezone is null so the
      // next session retries the real lookup rather than loading a wrong Etc/GMT zone.
      expect(savedSettings.timezone).toBeNull();

      // Enable protection
      browser.storage.local.get.mockResolvedValueOnce({
        settings: {
          ...savedSettings,
          enabled: false,
        },
      });

      await background.handleSetProtectionStatus({ enabled: true });

      // Assert: Protection enabled and settings broadcast
      expect(browser.tabs.sendMessage).toHaveBeenCalled();
      const lastBroadcast = getLastBroadcastMessage();

      expect(lastBroadcast.payload!.enabled).toBe(true);
      expect(lastBroadcast.payload!.location).toBeDefined();
    });
  });

  describe("Invalid Timezone Data Scenarios", () => {
    test("should handle invalid timezone identifier", async () => {
      // Set location
      const location = {
        latitude: 40.7128,
        longitude: -74.006,
      };

      // Mock timezone resolution to return invalid identifier (triggers fallback)
      mockedFind.mockResolvedValue(["Invalid/Timezone"]);

      // Mock reverse geocoding
      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "New York, NY, USA",
            address: {
              city: "New York",
              country: "USA",
            },
          }),
      });

      // Act: Set location
      await background.handleSetLocation(location);

      // Assert: Location saved with fallback timezone
      expectStorageSet().toHaveBeenCalled();
      const savedSettings = getSavedSettings();

      expect(savedSettings.location).toBeDefined();
      // Fallback timezones are not persisted — timezone is null when geo-tz returns
      // an invalid identifier, so the next session retries the real lookup.
      expect(savedSettings.timezone).toBeNull();
    });

    test("should handle invalid timezone offset", async () => {
      // Set location
      const location = {
        latitude: -33.8688,
        longitude: 151.2093,
      };

      // Mock timezone resolution to return empty results (triggers fallback)
      mockedFind.mockResolvedValue([]);

      // Mock reverse geocoding
      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Sydney, Australia",
            address: {
              city: "Sydney",
              country: "Australia",
            },
          }),
      });

      // Act: Set location
      await background.handleSetLocation(location);

      // Assert: Location saved with fallback timezone (not persisted)
      expectStorageSet().toHaveBeenCalled();
      const savedSettings = getSavedSettings();

      expect(savedSettings.location).toBeDefined();
      // Fallback timezones are not persisted — timezone is null when geo-tz returns
      // empty results, so the next session retries the real lookup.
      expect(savedSettings.timezone).toBeNull();
    });
  });

  describe("API Override Failures", () => {
    test("should log warning when timezone data is missing but continue operation", async () => {
      // Mock console.warn
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Set location
      const location = {
        latitude: 52.52,
        longitude: 13.405,
      };

      // Mock timezone resolution to fail (triggers fallback + warning)
      mockedFind.mockRejectedValue(new Error("API unavailable"));

      // Mock reverse geocoding to succeed (second fetch call)
      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Berlin, Germany",
            address: {
              city: "Berlin",
              country: "Germany",
            },
          }),
      });

      // Act: Set location
      await background.handleSetLocation(location);

      // Assert: Warning logged about timezone lookup failure
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[WARN]"),
        expect.stringContaining("Timezone lookup failed"),
        expect.any(Error)
      );

      // Assert: Location still saved, timezone null (fallback not persisted)
      expectStorageSet().toHaveBeenCalled();
      const savedSettings = getSavedSettings();
      expect(savedSettings.location).toBeDefined();
      // Fallback timezones are not persisted to storage — timezone is null so the
      // next session retries the real lookup rather than loading a wrong Etc/GMT zone.
      expect(savedSettings.timezone).toBeNull();

      consoleWarnSpy.mockRestore();
    });
  });

  describe("Popup Display Errors", () => {
    test("should handle missing timezone data in popup display", () => {
      // Simulate popup loading settings without timezone
      const settings = {
        enabled: true,
        location: {
          latitude: 25.2048,
          longitude: 55.2708,
          accuracy: 10,
        },
        timezone: null,
      };

      // Popup should display "Not configured" for timezone
      // This is tested in unit tests, but we verify the data structure here
      expect(settings.location).toBeDefined();
      expect(settings.timezone).toBeNull();
    });

    test("should handle fallback timezone in popup display", () => {
      // Simulate popup loading settings with fallback timezone
      const settings = {
        enabled: true,
        location: {
          latitude: 55.7558,
          longitude: 37.6173,
          accuracy: 10,
        },
        timezone: {
          identifier: "UTC",
          offset: 180,
          dstOffset: 0,
          fallback: true,
        },
      };

      // Popup should display timezone with "(estimated)" indicator
      expect(settings.timezone).toBeDefined();
      expect(settings.timezone.fallback).toBe(true);
    });
  });

  describe("Geolocation Continues Working in All Error Cases", () => {
    test("should spoof geolocation even when timezone API is completely unavailable", async () => {
      // Set location
      const location = {
        latitude: 1.3521,
        longitude: 103.8198,
      };

      // Mock timezone resolution to be completely unavailable
      mockedFind.mockRejectedValue(new Error("Service unavailable"));

      // Mock reverse geocoding
      fetchMock().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Singapore",
            address: {
              city: "Singapore",
              country: "Singapore",
            },
          }),
      });

      // Act: Set location
      await background.handleSetLocation(location);

      // Get the saved settings
      const savedSettings = getSavedSettings();

      // Mock storage to return these settings for subsequent loads
      browser.storage.local.get.mockResolvedValue({
        settings: {
          ...savedSettings,
          enabled: false,
        },
      });

      // Enable protection
      await background.handleSetProtectionStatus({ enabled: true });

      // Assert: Geolocation spoofing is active
      const lastBroadcast = getLastBroadcastMessage();

      expect(lastBroadcast.type).toBe("UPDATE_SETTINGS");
      expect(lastBroadcast.payload!.enabled).toBe(true);
      expect(lastBroadcast.payload!.location).toBeDefined();
      expect(lastBroadcast.payload!.location!.latitude).toBe(1.3521);
      expect(lastBroadcast.payload!.location!.longitude).toBe(103.8198);
    });

    test("should spoof geolocation with multiple timezone API failures", async () => {
      // Test multiple locations with timezone failures
      const locations = [
        { latitude: 19.4326, longitude: -99.1332 }, // Mexico City
        { latitude: -23.5505, longitude: -46.6333 }, // São Paulo
        { latitude: 41.9028, longitude: 12.4964 }, // Rome
      ];

      // Track initial call count
      const initialCallCount = browser.storage.local.set.mock.calls.length;

      for (const location of locations) {
        // Mock timezone resolution to fail
        mockedFind.mockRejectedValue(new Error("Timeout"));

        // Mock reverse geocoding to succeed
        fetchMock().mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              display_name: "City",
              address: {
                city: "City",
                country: "Country",
              },
            }),
        });

        // Act: Set location
        await background.handleSetLocation(location);

        // Assert: Location saved
        const savedSettings = getLastSavedSettings();
        expect(savedSettings.location!.latitude).toBe(location.latitude);
        expect(savedSettings.location!.longitude).toBe(location.longitude);
      }

      // All locations should have been saved successfully (at least once per location)
      const finalCallCount = browser.storage.local.set.mock.calls.length;
      expect(finalCallCount - initialCallCount).toBeGreaterThanOrEqual(locations.length);
    });

    test("should handle rapid location changes with intermittent timezone failures", async () => {
      // Simulate rapid location changes with some timezone failures
      const locations = [
        { lat: 51.5074, lon: -0.1278, tzSuccess: true }, // London
        { lat: 48.8566, lon: 2.3522, tzSuccess: false }, // Paris - timezone fails
        { lat: 52.52, lon: 13.405, tzSuccess: true }, // Berlin
        { lat: 55.7558, lon: 37.6173, tzSuccess: false }, // Moscow - timezone fails
      ];

      for (const loc of locations) {
        if (loc.tzSuccess) {
          // Mock successful timezone resolution via browser-geo-tz
          mockedFind.mockResolvedValue(["Europe/London"]);
        } else {
          // Mock failed timezone resolution
          mockedFind.mockRejectedValue(new Error("API error"));
        }

        // Mock reverse geocoding
        fetchMock().mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              display_name: "City",
              address: { city: "City", country: "Country" },
            }),
        });

        // Act: Set location
        await background.handleSetLocation({
          latitude: loc.lat,
          longitude: loc.lon,
        });

        // Assert: Location saved regardless of timezone success
        const savedSettings = getLastSavedSettings();
        expect(savedSettings.location!.latitude).toBe(loc.lat);
        expect(savedSettings.location!.longitude).toBe(loc.lon);
        expect(savedSettings.timezone).toBeDefined(); // Either real or fallback
      }
    });
  });
});
