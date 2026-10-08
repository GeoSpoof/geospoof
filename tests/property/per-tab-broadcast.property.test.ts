/**
 * Property-Based Tests for Per-Tab Settings Broadcast (Site-Scoping)
 *
 * Feature: site-scoping
 *
 * The background is the sole gatekeeper for the per-tab spoofing decision.
 * `broadcastSettingsToTabs` must resolve `enabled` separately for each open
 * tab via `computeEffectiveEnabled` against that tab's top-level URL, deliver
 * that single value to the tab (which the runtime fans out to every frame),
 * and carry the persisted non-scope fields unchanged. The allowlist/denylist
 * arrays must never appear in any page-bound payload.
 *
 * **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3, 8.4, 8.6, 9.3**
 *
 * NOTE (test-first): these tests are written before task 5.2 refactors
 * `broadcastSettingsToTabs` to be per-tab. Until that refactor lands the
 * broadcast sends the global `enabled` to every tab, so any case where a
 * tab's `Effective_Enabled` differs from the global flag (restricted URLs,
 * undeterminable URLs, allowlist/denylist modes) will fail. That is the
 * expected red state until 5.2 is implemented.
 */

import fc from "fast-check";
import type { Settings, ScopeMode } from "@/shared/types/settings";
import type { Message } from "@/shared/types/messages";
import { computeEffectiveEnabled } from "@/shared/utils/scope";
import { importBackground } from "../helpers/import-background";

/** Build a complete Settings object from partial test data. */
function makeSettings(partial: Partial<Settings>): Settings {
  return {
    enabled: false,
    location: null,
    timezone: null,
    locationName: null,
    webrtcProtection: false,
    preserveGeolocationPrompt: false,
    onboardingCompleted: true,
    version: "1.1",
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
    accuracySetting: { mode: "auto" },
    accuracySeed: 0,
    locationPrecision: { mode: "exact" },
    precisionSeed: 0,
    localeSpoofing: { mode: "off" as const },
    ...partial,
  };
}

/** Domains used both for tab URLs and for list entries so matches occur. */
const DOMAIN_POOL = ["example.com", "test.org", "app.example.com", "foo.net", "deep.sub.test.org"];

/** List entries drawn from registrable domains in the pool. */
const LIST_DOMAINS = ["example.com", "test.org", "foo.net"];

/** A specification for a tab's top-level URL: a real page, a restricted page, or none. */
type UrlSpec =
  { kind: "http"; domain: string } | { kind: "restricted"; value: string } | { kind: "none" };

const urlSpecArb: fc.Arbitrary<UrlSpec> = fc.oneof(
  fc.record({ kind: fc.constant("http" as const), domain: fc.constantFrom(...DOMAIN_POOL) }),
  fc.record({
    kind: fc.constant("restricted" as const),
    value: fc.constantFrom(
      "about:blank",
      "about:debugging",
      "chrome://settings",
      "moz-extension://abcd/options.html"
    ),
  }),
  fc.record({ kind: fc.constant("none" as const) })
);

/** Resolve a UrlSpec to the `url` field a tab would carry. */
function urlFromSpec(spec: UrlSpec): string | undefined {
  switch (spec.kind) {
    case "http":
      return `https://${spec.domain}/some/path?q=1`;
    case "restricted":
      return spec.value;
    case "none":
      return undefined;
  }
}

const listArb = fc.uniqueArray(fc.constantFrom(...LIST_DOMAINS), { maxLength: 3 });

const scopeModeArb: fc.Arbitrary<ScopeMode> = fc.constantFrom("all", "allowlist", "denylist");

/** fast-check arbitrary for an AccuracySetting union value. */
const accuracySettingArb = fc.oneof(
  fc.constant({ mode: "auto" as const }),
  fc.record({ mode: fc.constant("fixed" as const), meters: fc.integer({ min: 1, max: 5000 }) }),
  fc
    .tuple(fc.integer({ min: 1, max: 2500 }), fc.integer({ min: 2500, max: 5000 }))
    .map(([min, max]) => ({ mode: "range" as const, min, max }))
);

const accuracySeedArb = fc.integer({ min: 0, max: 2 ** 31 });

const locationArb = fc.option(
  fc.record({
    latitude: fc.double({ min: -90, max: 90, noNaN: true }),
    // [-180, 180): +180 canonicalizes to -180 in the delivered payload
    // (wrapLongitude), so keep generated anchors in the canonical domain.
    longitude: fc.double({ min: -180, max: 180, maxExcluded: true, noNaN: true }),
    accuracy: fc.integer({ min: 1, max: 1000 }),
  }),
  { nil: null }
);

const timezoneArb = fc.option(
  fc.record({
    identifier: fc.constantFrom("America/Los_Angeles", "Europe/London", "Asia/Tokyo"),
    offset: fc.integer({ min: -720, max: 840 }),
    dstOffset: fc.integer({ min: 0, max: 60 }),
  }),
  { nil: null }
);

interface BroadcastResult {
  settings: Settings;
  tabs: { id: number; url: string | undefined }[];
  /** Last message delivered to each tab id. */
  messagesByTab: Map<number, Message<Settings>>;
  /** Number of sendMessage calls per tab id. */
  callsByTab: Map<number, number>;
}

/**
 * Drive `broadcastSettingsToTabs` against a generated set of tabs and capture
 * every message delivered, keyed by tab id.
 */
async function runBroadcast(
  urlSpecs: UrlSpec[],
  settingsPartial: Partial<Settings>
): Promise<BroadcastResult> {
  vi.clearAllMocks();

  const tabs = urlSpecs.map((spec, i) => ({ id: i + 1, url: urlFromSpec(spec) }));

  browser.tabs.query.mockResolvedValue(tabs);

  const messagesByTab = new Map<number, Message<Settings>>();
  const callsByTab = new Map<number, number>();
  browser.tabs.sendMessage.mockImplementation((tabId: number, message: Message<Settings>) => {
    messagesByTab.set(tabId, message);
    callsByTab.set(tabId, (callsByTab.get(tabId) ?? 0) + 1);
    return Promise.resolve();
  });

  const settings = makeSettings(settingsPartial);

  const bg = await importBackground();
  await bg.broadcastSettingsToTabs(settings);

  return { settings, tabs, messagesByTab, callsByTab };
}

/** Expected Effective_Enabled for a tab, using the shared source of truth. */
async function expectedEnabledFor(settings: Settings, url: string | undefined): Promise<boolean> {
  const { isRestrictedUrl } = await importBackground();
  return computeEffectiveEnabled({
    masterEnabled: settings.enabled,
    scopeMode: settings.scopeMode,
    allowlist: settings.allowlist,
    denylist: settings.denylist,
    topLevelUrl: url,
    isRestricted: isRestrictedUrl,
  });
}

describe("Per-Tab Settings Broadcast", () => {
  test("each tab's enabled equals computeEffectiveEnabled for its top-level URL; non-scope fields match persisted settings", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(urlSpecArb, { minLength: 1, maxLength: 12 }),
        fc.boolean(),
        scopeModeArb,
        listArb,
        listArb,
        locationArb,
        timezoneArb,
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom("ERROR", "WARN", "INFO", "DEBUG", "TRACE"),
        accuracySettingArb,
        accuracySeedArb,
        async (
          urlSpecs,
          enabled,
          scopeMode,
          allowlist,
          denylist,
          location,
          timezone,
          debugLogging,
          webrtcProtection,
          verbosityLevel,
          accuracySetting,
          accuracySeed
        ) => {
          const { settings, tabs, messagesByTab, callsByTab } = await runBroadcast(urlSpecs, {
            enabled,
            scopeMode,
            allowlist,
            denylist,
            location,
            timezone,
            debugLogging,
            webrtcProtection,
            verbosityLevel,
            accuracySetting,
            accuracySeed,
          });

          // Every open tab receives a settings broadcast (Req 8.1).
          expect(messagesByTab.size).toBe(tabs.length);

          for (const tab of tabs) {
            const message = messagesByTab.get(tab.id);
            expect(message).toBeDefined();
            expect(message!.type).toBe("UPDATE_SETTINGS");
            const payload = message!.payload as unknown as Record<string, unknown>;

            // Exactly one message per tab — the single per-tab value the
            // runtime fans out identically to every frame (Req 7.2).
            expect(callsByTab.get(tab.id)).toBe(1);

            // enabled is resolved per tab via the shared source of truth
            // (Req 7.1, 8.1, 8.2; restricted/undeterminable handled by Req 8.6).
            const expected = await expectedEnabledFor(settings, tab.url);
            expect(payload.enabled).toBe(expected);

            // Non-scope fields are identical to the persisted Settings (Req 8.3).
            expect(payload.location).toEqual(settings.location);
            expect(payload.timezone).toEqual(settings.timezone);
            expect(payload.debugLogging).toBe(settings.debugLogging);
            expect(payload.verbosityLevel).toBe(settings.verbosityLevel);
            expect(payload.webrtcProtection).toBe(settings.webrtcProtection);

            // Accuracy resolution inputs are threaded end-to-end so the
            // injected Resolver uses the user's chosen setting/seed rather
            // than always falling back to auto/0 (the wiring bug).
            expect(payload.accuracySetting).toEqual(settings.accuracySetting);
            expect(payload.accuracySeed).toBe(settings.accuracySeed);

            // Privacy invariant: lists never appear in a page-bound payload.
            expect(payload).not.toHaveProperty("allowlist");
            expect(payload).not.toHaveProperty("denylist");
          }
        }
      ),
      { numRuns: 60 }
    );
  });

  test("an undeterminable top-level URL yields enabled: false for that tab", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.boolean(),
        scopeModeArb,
        listArb,
        listArb,
        async (numTabs, enabled, scopeMode, allowlist, denylist) => {
          // Every tab has an undeterminable (undefined) top-level URL.
          const urlSpecs: UrlSpec[] = Array.from({ length: numTabs }, () => ({ kind: "none" }));

          const { tabs, messagesByTab } = await runBroadcast(urlSpecs, {
            enabled,
            scopeMode,
            allowlist,
            denylist,
          });

          expect(messagesByTab.size).toBe(tabs.length);
          for (const tab of tabs) {
            const message = messagesByTab.get(tab.id);
            expect(message).toBeDefined();
            const payload = message!.payload as unknown as Record<string, unknown>;
            // Req 8.6 / 6.9: cannot determine the top-level URL ⇒ enabled false.
            expect(payload.enabled).toBe(false);
          }
        }
      ),
      { numRuns: 40 }
    );
  });
});
