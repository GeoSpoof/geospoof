/**
 * Integration Tests for Multi-Tab Scenarios
 *
 * Tests settings propagation to multiple tabs, new tab handling,
 * and tab reload behavior.
 *
 * Requirements: 8.3, 8.4
 */

import { vi } from "vitest";
import type { Settings } from "@/shared/types/settings";
import type { Message } from "@/shared/types/messages";
import { expectTabsSendMessage } from "../helpers/mock-types";

const background = await import("@/background");

// Typed mock accessors for browser APIs
const tabsQuery = vi.mocked(browser.tabs.query);
const tabsSendMessage = vi.mocked(browser.tabs.sendMessage);
const storageGet = vi.mocked(
  (browser.storage.local as unknown as Record<string, unknown>)[
    "get"
  ] as typeof browser.storage.local.get
);
const storageSet = vi.mocked(
  (browser.storage.local as unknown as Record<string, unknown>)[
    "set"
  ] as typeof browser.storage.local.set
);

interface TrackedMessage {
  tabId: number;
  message: Message<Settings>;
}

interface TimestampedMessage extends TrackedMessage {
  timestamp?: number;
}

describe("Multi-Tab Integration Tests", () => {
  describe("Settings propagation to multiple tabs", () => {
    test("should handle tabs without content scripts gracefully", async () => {
      // Setup: Mix of tabs with and without content scripts
      const tabs = [
        {
          id: 1,
          url: "https://example.com",
          index: 0,
          highlighted: false,
          active: false,
          pinned: false,
          incognito: false,
        },
        {
          id: 2,
          url: "about:blank",
          index: 1,
          highlighted: false,
          active: false,
          pinned: false,
          incognito: false,
        },
        {
          id: 3,
          url: "moz-extension://abc123",
          index: 2,
          highlighted: false,
          active: false,
          pinned: false,
          incognito: false,
        },
        {
          id: 4,
          url: "https://test.com",
          index: 3,
          highlighted: false,
          active: false,
          pinned: false,
          incognito: false,
        },
      ] as browser.tabs.Tab[];

      tabsQuery.mockResolvedValue(tabs);

      // Simulate failure for non-http tabs
      tabsSendMessage.mockImplementation((tabId: number) => {
        if (tabId === 2 || tabId === 3) {
          return Promise.reject(new Error("Content script not available"));
        }
        return Promise.resolve();
      });

      const settings = {
        enabled: true,
        location: { latitude: 0, longitude: 0, accuracy: 10 },
        timezone: null,
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
      };

      // Act: Should not throw even if some tabs fail
      await expect(background.broadcastSettingsToTabs(settings)).resolves.not.toThrow();

      // Assert: All tabs were attempted
      expectTabsSendMessage().toHaveBeenCalledTimes(4);
    });
  });

  describe("New tab receives settings immediately", () => {
    test("should send settings to newly created tab", async () => {
      // Setup: Mock settings in storage
      const settings = {
        enabled: true,
        location: {
          latitude: 40.7128,
          longitude: -74.006,
          accuracy: 10,
        },
        timezone: {
          identifier: "America/New_York",
          offset: 300,
          dstOffset: 60,
        },
        locationName: {
          city: "New York",
          country: "USA",
          displayName: "New York, NY, USA",
        },
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
      };

      storageGet.mockResolvedValue({ settings });

      const messagesSent: TrackedMessage[] = [];
      tabsSendMessage.mockImplementation((tabId: number, message: Message<Settings>) => {
        messagesSent.push({ tabId, message });
        return Promise.resolve();
      });

      // Act: Load settings (simulating what happens when a new tab is created)
      const loadedSettings = await background.loadSettings();

      // Simulate sending to new tab
      const newTabId = 42;
      await tabsSendMessage(newTabId, {
        type: "UPDATE_SETTINGS",
        payload: loadedSettings,
      });

      // Assert: New tab received settings
      const payload = messagesSent[0].message.payload as Settings;
      expect(messagesSent).toHaveLength(1);
      expect(messagesSent[0].tabId).toBe(newTabId);
      expect(messagesSent[0].message.type).toBe("UPDATE_SETTINGS");
      expect(payload.enabled).toBe(true);
      expect(payload.location).toEqual(settings.location);
    });

    test("should send settings even when protection is disabled", async () => {
      // Setup: Settings with protection disabled
      const settings = {
        enabled: false,
        location: {
          latitude: 35.6762,
          longitude: 139.6503,
          accuracy: 10,
        },
        timezone: {
          identifier: "Asia/Tokyo",
          offset: -540,
          dstOffset: 0,
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
      };

      storageGet.mockResolvedValue({ settings });

      const messagesSent: TrackedMessage[] = [];
      tabsSendMessage.mockImplementation((tabId: number, message: Message<Settings>) => {
        messagesSent.push({ tabId, message });
        return Promise.resolve();
      });

      // Act: Load settings and send to new tab
      const loadedSettings = await background.loadSettings();
      const newTabId = 99;
      await tabsSendMessage(newTabId, {
        type: "UPDATE_SETTINGS",
        payload: loadedSettings,
      });

      // Assert: New tab received settings even though protection is disabled
      const payload = messagesSent[0].message.payload as Settings;
      expect(messagesSent).toHaveLength(1);
      expect(payload.enabled).toBe(false);
      expect(payload.location).toEqual(settings.location);
    });
  });

  describe("Tab reload preserves settings", () => {
    test("should reapply settings when tab is reloaded", async () => {
      // Setup: Mock settings in storage
      const settings = {
        enabled: true,
        location: {
          latitude: -33.8688,
          longitude: 151.2093,
          accuracy: 10,
        },
        timezone: {
          identifier: "Australia/Sydney",
          offset: -600,
          dstOffset: -60,
        },
        locationName: {
          city: "Sydney",
          country: "Australia",
          displayName: "Sydney, NSW, Australia",
        },
        webrtcProtection: true,
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
        // A valid (finite, non-zero) per-install seed: validateSettings keeps
        // it as-is, so the reloaded payload round-trips unchanged (Req 5.5).
        accuracySeed: 123456789,
        locationPrecision: { mode: "exact" as const },
        // Valid (finite, non-zero) precision seed so validateSettings preserves
        // it and the reloaded payload round-trips unchanged (mirrors accuracySeed).
        precisionSeed: 123456789,
        precisionCadence: "never" as const,
        localeSpoofing: { mode: "off" as const },
      };

      storageGet.mockResolvedValue({ settings });

      const messagesSent: TrackedMessage[] = [];
      tabsSendMessage.mockImplementation((tabId: number, message: Message<Settings>) => {
        messagesSent.push({ tabId, message });
        return Promise.resolve();
      });

      // Act: Simulate tab reload by loading settings and sending to tab
      const tabId = 5;
      const loadedSettings = await background.loadSettings();

      await tabsSendMessage(tabId, {
        type: "UPDATE_SETTINGS",
        payload: loadedSettings,
      });

      // Assert: Tab received settings after reload. loadSettings() migrates the
      // stored "1.0" object to schema "1.2" (Advanced Filtering Req 13.2), so
      // the delivered payload matches the stored settings with the bumped
      // version.
      expect(messagesSent).toHaveLength(1);
      expect(messagesSent[0].tabId).toBe(tabId);
      expect(messagesSent[0].message.type).toBe("UPDATE_SETTINGS");
      expect(messagesSent[0].message.payload).toEqual({ ...settings, version: "1.2" });
    });

    test("should handle multiple tab reloads consistently", async () => {
      // Setup: Mock settings
      const settings = {
        enabled: true,
        location: {
          latitude: 48.8566,
          longitude: 2.3522,
          accuracy: 10,
        },
        timezone: {
          identifier: "Europe/Paris",
          offset: -60,
          dstOffset: -60,
        },
        locationName: {
          city: "Paris",
          country: "France",
          displayName: "Paris, France",
        },
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
        // A valid (finite, non-zero) per-install seed so every loadSettings()
        // call keeps the same seed and the reloaded payloads stay identical
        // (Req 5.2/5.5). Without a stored seed, validateSettings would assign a
        // fresh random one on each load.
        accuracySeed: 987654321,
        // Valid (finite, non-zero) precision seed so every loadSettings() keeps
        // the same value and the reloaded payloads stay identical.
        precisionSeed: 987654321,
        precisionCadence: "never" as const,
        localeSpoofing: { mode: "off" as const },
      };

      storageGet.mockResolvedValue({ settings });

      const messagesSent: TrackedMessage[] = [];
      tabsSendMessage.mockImplementation((tabId: number, message: Message<Settings>) => {
        messagesSent.push({ tabId, message });
        return Promise.resolve();
      });

      // Act: Simulate multiple tab reloads
      const tabIds = [1, 2, 3];
      for (const tabId of tabIds) {
        const loadedSettings = await background.loadSettings();
        await tabsSendMessage(tabId, {
          type: "UPDATE_SETTINGS",
          payload: loadedSettings,
        });
      }

      // Assert: All tabs received identical settings
      expect(messagesSent).toHaveLength(3);

      const firstPayload = messagesSent[0].message.payload;
      messagesSent.forEach(({ message }) => {
        expect(message.payload).toEqual(firstPayload);
      });
    });
  });

  describe("Settings consistency across tab lifecycle", () => {
    test("should maintain consistent settings across tab creation, update, and reload", async () => {
      // Setup: Initial settings
      const settings = {
        enabled: true,
        location: {
          latitude: 55.7558,
          longitude: 37.6173,
          accuracy: 10,
        },
        timezone: {
          identifier: "Europe/Moscow",
          offset: -180,
          dstOffset: 0,
        },
        locationName: {
          city: "Moscow",
          country: "Russia",
          displayName: "Moscow, Russia",
        },
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
      };

      storageGet.mockResolvedValue({ settings });
      storageSet.mockResolvedValue(undefined);

      const tabs = [
        {
          id: 1,
          url: "https://example1.com",
          index: 0,
          highlighted: false,
          active: false,
          pinned: false,
          incognito: false,
        },
        {
          id: 2,
          url: "https://example2.com",
          index: 1,
          highlighted: false,
          active: false,
          pinned: false,
          incognito: false,
        },
      ] as browser.tabs.Tab[];
      tabsQuery.mockResolvedValue(tabs);

      const messagesSent: TimestampedMessage[] = [];
      tabsSendMessage.mockImplementation((tabId: number, message: Message<Settings>) => {
        messagesSent.push({ tabId, message, timestamp: Date.now() });
        return Promise.resolve();
      });

      // Act: Simulate tab lifecycle events

      // 1. Initial broadcast to existing tabs
      await background.broadcastSettingsToTabs(settings);
      const initialMessages = messagesSent.length;

      // 2. New tab created
      const newTabId = 3;
      const loadedSettings1 = await background.loadSettings();
      await tabsSendMessage(newTabId, {
        type: "UPDATE_SETTINGS",
        payload: loadedSettings1,
      });

      // 3. Tab updated (reload)
      const loadedSettings2 = await background.loadSettings();
      await tabsSendMessage(1, {
        type: "UPDATE_SETTINGS",
        payload: loadedSettings2,
      });

      // Assert: All messages contain identical settings
      const allPayloads = messagesSent.map((m) => m.message.payload as Settings);
      const firstPayload = allPayloads[0];

      allPayloads.forEach((payload) => {
        expect(payload.enabled).toBe(firstPayload.enabled);
        expect(payload.location).toEqual(firstPayload.location);
        expect(payload.timezone).toEqual(firstPayload.timezone);
      });

      // Assert: Correct number of messages sent
      expect(messagesSent.length).toBe(initialMessages + 2); // 2 existing + 1 new + 1 reload
    });
  });
});
