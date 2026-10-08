/**
 * End-to-End Integration Tests for Timezone Spoofing
 *
 * Tests complete flow: set location → resolve timezone (browser-geo-tz) → transmit data → override APIs → display status
 *
 * Requirements: 4.1, 4.2, 4.3, 6.1, 6.2, 9.4, 9.5
 */

import {
  getSavedSettings,
  getLastSavedSettings,
  getLastBroadcastMessage,
  getBroadcastMessage,
  expectStorageSet,
  expectTabsSendMessage,
  expectWebRTCPolicySet,
  tabsSendMessageCallCount,
} from "../helpers/mock-types";
import { vi } from "vitest";

// Mock browser-geo-tz at the module level — timezone resolution is now offline
vi.mock("browser-geo-tz", () => ({
  init: vi.fn(() => ({
    find: vi.fn().mockResolvedValue([]),
  })),
}));

// Mock DOM for content script testing. Use vi.stubGlobal rather than direct
// assignment: under the jsdom bundled with vitest 5, `document` is a getter-only
// property on the global, so `globalThis.document = {...}` throws a TypeError.
vi.stubGlobal("document", {
  addEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
});

vi.stubGlobal("window", {
  addEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
});

(globalThis as Record<string, unknown>).CustomEvent = class CustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, options?: { detail?: unknown }) {
    this.type = type;
    this.detail = options?.detail;
  }
};

const background = await import("@/background");
const fetchMock = vi.mocked(fetch);

// Get the find mock from the object returned by init()
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

describe("Timezone Spoofing End-to-End Integration Tests", () => {
  beforeEach(() => {
    // Default storage mock
    browser.storage.local.get.mockResolvedValue({
      settings: {
        enabled: false,
        location: null,
        timezone: null,
        locationName: null,
        webrtcProtection: false,
        onboardingCompleted: true,
        version: "1.0",
        lastUpdated: Date.now(),
      },
    });

    browser.storage.local.set.mockResolvedValue(undefined);

    // Default tabs mock
    browser.tabs.query.mockResolvedValue([{ id: 1, url: "https://example.com" }]);

    browser.tabs.sendMessage.mockResolvedValue(undefined);

    // Reset browser-geo-tz mock
    mockedFind.mockReset();
  });

  describe("Complete Flow: Set Location → Resolve Timezone → Transmit Data → Override APIs", () => {
    test("should complete full timezone spoofing flow for Tokyo", async () => {
      const tokyoLocation = {
        latitude: 35.6762,
        longitude: 139.6503,
      };

      // Mock browser-geo-tz to return Tokyo timezone
      mockedFind.mockResolvedValue(["Asia/Tokyo"]);

      // Mock reverse geocoding response (still uses fetch)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Tokyo, Japan",
            address: {
              city: "Tokyo",
              country: "Japan",
            },
          }),
      } as Response);

      // Act: Set location (background script resolves timezone via browser-geo-tz)
      await background.handleSetLocation(tokyoLocation);

      // Assert: Timezone data resolved and stored
      expectStorageSet().toHaveBeenCalled();
      const savedSettings = getSavedSettings();

      expect(savedSettings.location!.latitude).toBe(35.6762);
      expect(savedSettings.location!.longitude).toBe(139.6503);
      expect(savedSettings.timezone).toBeDefined();
      expect(savedSettings.timezone!.identifier).toBe("Asia/Tokyo");
      // Offset computed via Intl API — Asia/Tokyo is UTC+9 = 540 minutes
      expect(savedSettings.timezone!.offset).toBe(540);
      expect(savedSettings.timezone!.dstOffset).toBe(0);

      // Step 2: Enable protection
      browser.storage.local.get.mockResolvedValueOnce({
        settings: {
          ...savedSettings,
          enabled: false,
        },
      });

      await background.handleSetProtectionStatus({ enabled: true });

      // Assert: Settings broadcast to tabs with timezone data
      expectTabsSendMessage().toHaveBeenCalled();
      const lastBroadcast = getLastBroadcastMessage();

      expect(lastBroadcast.type).toBe("UPDATE_SETTINGS");
      expect(lastBroadcast.payload?.enabled).toBe(true);
      expect(lastBroadcast.payload?.location).toBeDefined();
      expect(lastBroadcast.payload?.timezone).toBeDefined();
      expect(lastBroadcast.payload?.timezone?.identifier).toBe("Asia/Tokyo");
      expect(lastBroadcast.payload?.timezone?.offset).toBe(540);

      // Step 3: Verify content script would receive and transmit data
      const transmittedData = lastBroadcast.payload;

      expect(transmittedData).toHaveProperty("enabled", true);
      expect(transmittedData).toHaveProperty("location");
      expect(transmittedData).toHaveProperty("timezone");
      expect(transmittedData?.timezone).toHaveProperty("identifier");
      expect(transmittedData?.timezone).toHaveProperty("offset");
      expect(transmittedData?.timezone).toHaveProperty("dstOffset");
    });

    test("should complete full timezone spoofing flow for Los Angeles", async () => {
      const laLocation = {
        latitude: 34.0522,
        longitude: -118.2437,
      };

      // Mock browser-geo-tz to return LA timezone
      mockedFind.mockResolvedValue(["America/Los_Angeles"]);

      // Mock reverse geocoding response
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Los Angeles, CA, USA",
            address: {
              city: "Los Angeles",
              country: "USA",
            },
          }),
      } as Response);

      await background.handleSetLocation(laLocation);

      const savedSettings = getSavedSettings();

      expect(savedSettings.timezone!.identifier).toBe("America/Los_Angeles");
      // Offset computed via Intl API (varies by DST, but should be finite)
      expect(Number.isFinite(savedSettings.timezone!.offset)).toBe(true);
      expect(Number.isFinite(savedSettings.timezone!.dstOffset)).toBe(true);

      // Step 2: Enable protection
      browser.storage.local.get.mockResolvedValueOnce({
        settings: {
          ...savedSettings,
          enabled: false,
        },
      });

      await background.handleSetProtectionStatus({ enabled: true });

      const lastBroadcast = getLastBroadcastMessage();
      expect(lastBroadcast.payload?.timezone?.identifier).toBe("America/Los_Angeles");
    });

    test("should complete full timezone spoofing flow for London", async () => {
      const londonLocation = {
        latitude: 51.5074,
        longitude: -0.1278,
      };

      // Mock browser-geo-tz to return London timezone
      mockedFind.mockResolvedValue(["Europe/London"]);

      // Mock reverse geocoding response
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "London, England, UK",
            address: {
              city: "London",
              country: "UK",
            },
          }),
      } as Response);

      await background.handleSetLocation(londonLocation);

      const savedSettings = getSavedSettings();

      expect(savedSettings.timezone!.identifier).toBe("Europe/London");
      // Europe/London offset varies by DST but should be finite
      expect(Number.isFinite(savedSettings.timezone!.offset)).toBe(true);
      expect(Number.isFinite(savedSettings.timezone!.dstOffset)).toBe(true);
    });
  });

  describe("Multiple Locations and Timezones", () => {
    test("should handle switching between different timezones", async () => {
      // Step 1: Set location to Sydney
      mockedFind.mockResolvedValue(["Australia/Sydney"]);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Sydney, Australia",
            address: { city: "Sydney", country: "Australia" },
          }),
      } as Response);

      await background.handleSetLocation({ latitude: -33.8688, longitude: 151.2093 });

      const sydneySettings = getSavedSettings();
      expect(sydneySettings.timezone!.identifier).toBe("Australia/Sydney");
      expect(Number.isFinite(sydneySettings.timezone!.offset)).toBe(true);

      // Step 2: Switch to New York
      mockedFind.mockResolvedValue(["America/New_York"]);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "New York, NY, USA",
            address: { city: "New York", country: "USA" },
          }),
      } as Response);

      await background.handleSetLocation({ latitude: 40.7128, longitude: -74.006 });

      const nySettings = getSavedSettings(undefined, 1);
      expect(nySettings.timezone!.identifier).toBe("America/New_York");
      expect(Number.isFinite(nySettings.timezone!.offset)).toBe(true);

      // Step 3: Switch to Dubai (no DST)
      mockedFind.mockResolvedValue(["Asia/Dubai"]);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Dubai, UAE",
            address: { city: "Dubai", country: "UAE" },
          }),
      } as Response);

      await background.handleSetLocation({ latitude: 25.2048, longitude: 55.2708 });

      const dubaiSettings = getSavedSettings(undefined, 2);
      expect(dubaiSettings.timezone!.identifier).toBe("Asia/Dubai");
      expect(dubaiSettings.timezone!.offset).toBe(240); // UTC+4 = 240 minutes
      expect(dubaiSettings.timezone!.dstOffset).toBe(0);
    });

    test("should handle extreme timezone offsets", async () => {
      // Test UTC+14 (Kiribati)
      mockedFind.mockResolvedValue(["Pacific/Kiritimati"]);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Kiritimati, Kiribati",
            address: { country: "Kiribati" },
          }),
      } as Response);

      await background.handleSetLocation({ latitude: 1.8709, longitude: -157.3629 });

      const kiribatiSettings = getSavedSettings();
      expect(kiribatiSettings.timezone!.identifier).toBe("Pacific/Kiritimati");
      expect(kiribatiSettings.timezone!.offset).toBe(840); // UTC+14

      // Test UTC-11 (American Samoa)
      mockedFind.mockResolvedValue(["Pacific/Pago_Pago"]);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Pago Pago, American Samoa",
            address: { country: "American Samoa" },
          }),
      } as Response);

      await background.handleSetLocation({ latitude: -14.271, longitude: -170.1322 });

      const samoaSettings = getSavedSettings(undefined, 1);
      expect(samoaSettings.timezone!.identifier).toBe("Pacific/Pago_Pago");
      expect(samoaSettings.timezone!.offset).toBe(-660); // UTC-11
    });

    test("should handle timezone with 30-minute offset", async () => {
      mockedFind.mockResolvedValue(["Asia/Kolkata"]);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "New Delhi, India",
            address: { city: "New Delhi", country: "India" },
          }),
      } as Response);

      await background.handleSetLocation({ latitude: 28.6139, longitude: 77.209 });

      const indiaSettings = getSavedSettings();
      expect(indiaSettings.timezone!.identifier).toBe("Asia/Kolkata");
      expect(indiaSettings.timezone!.offset).toBe(330); // UTC+5:30
    });

    test("should handle timezone with 45-minute offset", async () => {
      mockedFind.mockResolvedValue(["Asia/Kathmandu"]);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Kathmandu, Nepal",
            address: { city: "Kathmandu", country: "Nepal" },
          }),
      } as Response);

      await background.handleSetLocation({ latitude: 27.7172, longitude: 85.324 });

      const nepalSettings = getSavedSettings();
      expect(nepalSettings.timezone!.identifier).toBe("Asia/Kathmandu");
      expect(nepalSettings.timezone!.offset).toBe(345); // UTC+5:45
    });
  });

  describe("Data Transmission Verification", () => {
    test("should transmit complete timezone data structure to content script", async () => {
      const location = { latitude: 48.8566, longitude: 2.3522 };

      mockedFind.mockResolvedValue(["Europe/Paris"]);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Paris, France",
            address: { city: "Paris", country: "France" },
          }),
      } as Response);

      await background.handleSetLocation(location);

      // Enable protection
      const savedSettings = getSavedSettings();
      browser.storage.local.get.mockResolvedValueOnce({
        settings: { ...savedSettings, enabled: false },
      });

      await background.handleSetProtectionStatus({ enabled: true });

      // Verify transmitted data structure
      const lastBroadcast = getLastBroadcastMessage();
      const payload = lastBroadcast.payload;

      expect(payload).toHaveProperty("enabled");
      expect(payload).toHaveProperty("location");
      expect(payload).toHaveProperty("timezone");

      expect(payload?.timezone).toHaveProperty("identifier");
      expect(payload?.timezone).toHaveProperty("offset");
      expect(payload?.timezone).toHaveProperty("dstOffset");

      expect(typeof payload?.timezone?.identifier).toBe("string");
      expect(typeof payload?.timezone?.offset).toBe("number");
      expect(typeof payload?.timezone?.dstOffset).toBe("number");

      expect(payload?.timezone?.identifier).toBe("Europe/Paris");
      expect(Number.isFinite(payload?.timezone?.offset)).toBe(true);
    });

    test("should transmit timezone data to multiple tabs", async () => {
      browser.tabs.query.mockResolvedValue([
        { id: 1, url: "https://example.com" },
        { id: 2, url: "https://test.com" },
        { id: 3, url: "https://demo.com" },
      ]);

      mockedFind.mockResolvedValue(["Europe/Berlin"]);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Berlin, Germany",
            address: { city: "Berlin", country: "Germany" },
          }),
      } as Response);

      await background.handleSetLocation({ latitude: 52.52, longitude: 13.405 });

      // Enable protection
      const savedSettings = getSavedSettings();
      browser.storage.local.get.mockResolvedValueOnce({
        settings: { ...savedSettings, enabled: false },
      });

      await background.handleSetProtectionStatus({ enabled: true });

      // Clear previous calls and verify only the broadcast to tabs
      vi.clearAllMocks();
      mockedFind.mockReset();

      browser.tabs.query.mockResolvedValue([
        { id: 1, url: "https://example.com" },
        { id: 2, url: "https://test.com" },
        { id: 3, url: "https://demo.com" },
      ]);

      browser.storage.local.get.mockResolvedValueOnce({
        settings: { ...savedSettings, enabled: true },
      });

      await background.broadcastSettingsToTabs(savedSettings);

      expectTabsSendMessage().toHaveBeenCalledTimes(3);

      for (let i = 0; i < tabsSendMessageCallCount(); i++) {
        const message = getBroadcastMessage(undefined, i);
        expect(message.type).toBe("UPDATE_SETTINGS");
        expect(message.payload?.timezone).toBeDefined();
        expect(message.payload?.timezone?.identifier).toBe("Europe/Berlin");
      }
    });
  });

  describe("Integration with Existing Features", () => {
    test("should maintain geolocation spoofing when timezone data is added", async () => {
      mockedFind.mockResolvedValue(["America/Sao_Paulo"]);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Rio de Janeiro, Brazil",
            address: { city: "Rio de Janeiro", country: "Brazil" },
          }),
      } as Response);

      await background.handleSetLocation({ latitude: -22.9068, longitude: -43.1729 });

      const savedSettings = getSavedSettings();
      browser.storage.local.get.mockResolvedValueOnce({
        settings: { ...savedSettings, enabled: false },
      });

      await background.handleSetProtectionStatus({ enabled: true });

      const lastBroadcast = getLastBroadcastMessage();
      const payload = lastBroadcast.payload;

      // Verify geolocation data
      expect(payload?.location).toBeDefined();
      expect(payload?.location?.latitude).toBe(-22.9068);
      expect(payload?.location?.longitude).toBe(-43.1729);

      // Verify timezone data
      expect(payload?.timezone).toBeDefined();
      expect(payload?.timezone?.identifier).toBe("America/Sao_Paulo");
      expect(Number.isFinite(payload?.timezone?.offset)).toBe(true);
    });

    test("should work with WebRTC protection enabled", async () => {
      mockedFind.mockResolvedValue(["Europe/Moscow"]);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            display_name: "Moscow, Russia",
            address: { city: "Moscow", country: "Russia" },
          }),
      } as Response);

      await background.handleSetLocation({ latitude: 55.7558, longitude: 37.6173 });

      const savedSettings = getSavedSettings();
      browser.storage.local.get.mockResolvedValueOnce({
        settings: { ...savedSettings, enabled: false },
      });

      await background.handleSetProtectionStatus({ enabled: true });

      browser.storage.local.get.mockResolvedValueOnce({
        settings: { ...getLastSavedSettings(), webrtcProtection: false },
      });

      await background.handleSetWebRTCProtection({ enabled: true });

      const finalSettings = getLastSavedSettings();

      expect(finalSettings.enabled).toBe(true);
      expect(finalSettings.webrtcProtection).toBe(true);
      expect(finalSettings.location).toBeDefined();
      expect(finalSettings.timezone).toBeDefined();
      expect(finalSettings.timezone?.identifier).toBe("Europe/Moscow");

      expectWebRTCPolicySet().toHaveBeenCalled();
    });
  });
});
