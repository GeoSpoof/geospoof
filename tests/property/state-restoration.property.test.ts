/**
 * Property-Based Tests for State Restoration on Re-awakening
 * Feature: mv3-manifest-compat, Property 7: State restoration on re-awakening
 *
 * Validates: Requirements 2.4, 8.3
 *
 * For any valid Settings object persisted in browser.storage.local where
 * webrtcProtection is true, when the background script initializes (simulating
 * re-awakening), it should call setWebRTCProtection(true) and restore the
 * protection state.
 */

import fc from "fast-check";
import type { Settings } from "@/shared/types/settings";

const locationArb = fc.record({
  latitude: fc.double({ min: -90, max: 90, noNaN: true }),
  longitude: fc.double({ min: -180, max: 180, noNaN: true }),
  accuracy: fc.double({ min: 1, max: 100, noNaN: true }),
});

const timezoneArb = fc.record({
  identifier: fc.constantFrom(
    "America/Los_Angeles",
    "America/New_York",
    "Europe/London",
    "Asia/Tokyo"
  ),
  offset: fc.integer({ min: -720, max: 840 }),
  dstOffset: fc.integer({ min: 0, max: 60 }),
});

const settingsArb: fc.Arbitrary<Settings> = fc.record({
  enabled: fc.boolean(),
  location: fc.option(locationArb, { nil: null }),
  timezone: fc.option(timezoneArb, { nil: null }),
  locationName: fc.option(
    fc.record({
      city: fc.string({ minLength: 0, maxLength: 30 }),
      country: fc.string({ minLength: 0, maxLength: 30 }),
      displayName: fc.string({ minLength: 0, maxLength: 60 }),
    }),
    { nil: null }
  ),
  webrtcProtection: fc.boolean(),
  preserveGeolocationPrompt: fc.boolean(),
  onboardingCompleted: fc.boolean(),
  version: fc.constant("1.0"),
  lastUpdated: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  vpnSyncEnabled: fc.constant(false), // Disable VPN sync to avoid fetch timeouts in tests
  debuggerModeEnabled: fc.constant(false),
  autoSyncBlocked: fc.boolean(),
  proFeaturesBlocked: fc.boolean(),
  debugLogging: fc.boolean(),
  verbosityLevel: fc.constantFrom("DEBUG", "INFO", "WARN", "ERROR"),
  theme: fc.constantFrom("system", "light", "dark"),
  uiLanguage: fc.constantFrom("", "en", "ru", "pt_BR", "zh_CN"),
  favorites: fc.constant([]),
  scopeMode: fc.constantFrom("all", "allowlist", "denylist"),
  allowlist: fc.constant([]),
  denylist: fc.constant([]),
  accuracySetting: fc.constant({ mode: "auto" as const }),
  accuracySeed: fc.constant(0),
  locationPrecision: fc.constant({ mode: "exact" as const }),
  precisionSeed: fc.constant(0),
  precisionCadence: fc.constant("never" as const),
  // Pinned like `locationPrecision`; locale behavior has its own suite in
  // locale-resolver.property.test.ts.
  localeSpoofing: fc.constant({ mode: "off" as const }),
  siteLocations: fc.constant([]),
});

describe("Property 7: State restoration on re-awakening", () => {
  test("WebRTC protection is re-applied when settings have it enabled", async () => {
    await fc.assert(
      fc.asyncProperty(
        settingsArb.filter((s) => s.webrtcProtection === true),
        async (settings: Settings) => {
          vi.clearAllMocks();
          vi.resetModules();

          browser.storage.local.get = vi.fn().mockResolvedValue({ settings });
          browser.storage.local.set = vi.fn().mockResolvedValue(undefined);
          browser.tabs.query = vi.fn().mockResolvedValue([]);

          const bg = await import("@/background");
          await bg.initialize();

          const policySet = browser.privacy.network.webRTCIPHandlingPolicy as unknown as Record<
            string,
            ReturnType<typeof vi.fn>
          >;
          expect(policySet["set"]).toHaveBeenCalledWith({
            value: "disable_non_proxied_udp",
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  test("WebRTC protection is NOT applied when settings have it disabled", async () => {
    await fc.assert(
      fc.asyncProperty(
        settingsArb.filter((s) => s.webrtcProtection === false),
        async (settings: Settings) => {
          vi.clearAllMocks();
          vi.resetModules();

          browser.storage.local.get = vi.fn().mockResolvedValue({ settings });
          browser.storage.local.set = vi.fn().mockResolvedValue(undefined);
          browser.tabs.query = vi.fn().mockResolvedValue([]);

          const bg = await import("@/background");
          await bg.initialize();

          const policySet = browser.privacy.network.webRTCIPHandlingPolicy as unknown as Record<
            string,
            ReturnType<typeof vi.fn>
          >;
          expect(policySet["set"]).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 100 }
    );
  });

  test("badge is updated on initialization based on enabled state", async () => {
    await fc.assert(
      fc.asyncProperty(settingsArb, async (settings: Settings) => {
        vi.clearAllMocks();
        vi.resetModules();

        browser.storage.local.get = vi.fn().mockResolvedValue({ settings });
        browser.storage.local.set = vi.fn().mockResolvedValue(undefined);
        browser.tabs.query = vi.fn().mockResolvedValue([]);

        const bg = await import("@/background");
        await bg.initialize();

        // updateBadge should have been called (it queries tabs internally)
        const queryCalls = (browser.tabs.query as ReturnType<typeof vi.fn>).mock.calls;
        expect(queryCalls.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 100 }
    );
  });

  test("settings are broadcast when enabled with a location", async () => {
    await fc.assert(
      fc.asyncProperty(
        settingsArb.filter((s) => s.enabled && s.location !== null),
        async (settings: Settings) => {
          vi.clearAllMocks();
          vi.resetModules();

          const mockTabs = [
            { id: 1, url: "https://example.com" },
            { id: 2, url: "https://github.com" },
          ];
          browser.storage.local.get = vi.fn().mockResolvedValue({ settings });
          browser.storage.local.set = vi.fn().mockResolvedValue(undefined);
          browser.tabs.query = vi.fn().mockResolvedValue(mockTabs);
          browser.tabs.sendMessage = vi.fn().mockResolvedValue(undefined);

          const bg = await import("@/background");
          await bg.initialize();

          // broadcastSettingsToTabs should have sent messages
          const sendCalls = (browser.tabs.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
          expect(sendCalls.length).toBeGreaterThanOrEqual(1);
        }
      ),
      { numRuns: 100 }
    );
  });
});
