/**
 * Site locations: resolution properties.
 *
 *   (a) `matchSiteLocation` doesn't depend on list order.
 *   (b) Out of scope, no entry applies: the page gets the main location and zone.
 *   (c) An entry's coordinates and zone appear only in payloads for URLs where it
 *       is the match AND Filters keep GeoSpoof on.
 *   (d) The page payload has exactly the `UpdateSettingsPayload` keys, and never
 *       carries an entry id or pattern.
 */

import { describe, test, expect } from "vitest";
import fc from "fast-check";
import type { ScopeMode, Settings, SiteLocation, Timezone } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import { computeEffectiveEnabled } from "@/shared/utils/scope";
import { matchSiteLocation } from "@/shared/utils/site-locations";
import { buildPagePayload } from "@/background/page-payload";
import { isRestrictedUrl } from "@/background/restricted-url";
import { TOKYO, TOKYO_TZ } from "../helpers/site-locations";

const NUM_RUNS = 200;

const PATTERN_POOL = [
  "example.com",
  "*.example.com",
  "a.example.com",
  "https://example.com",
  "example.com:8080",
  "*.com",
  "test.org",
  "localhost",
  "127.0.0.1",
  "münchen.de",
  "twitch.tv",
  "*://chatgpt.com",
];

const FILTER_POOL = ["example.com", "*.example.com", "example.com/x", "test.org", "*", "twitch.tv"];

const URL_POOL = [
  "https://example.com/",
  "http://example.com/x",
  "https://a.example.com/",
  "https://b.example.com/p?q=1",
  "https://example.com:8080/",
  "https://other.com/",
  "https://test.org/",
  "http://localhost:3000/",
  "http://127.0.0.1/",
  "https://xn--mnchen-3ya.de/",
  "https://www.twitch.tv/",
  "https://chatgpt.com/",
  "about:blank",
  "https://addons.mozilla.org/",
];

/** Distinct real zones, none equal to the main one (Asia/Tokyo). */
const ZONES = [
  "Europe/Dublin",
  "America/Mexico_City",
  "Europe/Paris",
  "Asia/Kolkata",
  "Africa/Cairo",
  "Australia/Sydney",
];

/** The exact key set of `UpdateSettingsPayload`. */
const PAYLOAD_KEYS = [
  "accuracySeed",
  "accuracySetting",
  "debugLogging",
  "enabled",
  "locale",
  "location",
  "preserveGeolocationPrompt",
  "timezone",
  "verbosityLevel",
  "webrtcProtection",
].sort();

/** An entry with sentinel coordinates, zone, and id derived from its index. */
function sentinelEntry(index: number, patterns: string[], updatedAt: number): SiteLocation {
  const timezone: Timezone = { identifier: ZONES[index], offset: 0, dstOffset: 0 };
  return {
    id: `sl-sentinel-${index}-id`,
    kind: "location",
    patterns,
    location: { latitude: 10 + index, longitude: 20 + index, accuracy: 45 },
    timezone,
    locationName: { city: `City${index}`, country: "", displayName: `City${index}` },
    label: null,
    updatedAt,
  };
}

/** Up to six entries with patterns unique across entries (as the validator guarantees). */
const uniqueEntriesArb: fc.Arbitrary<SiteLocation[]> = fc
  .uniqueArray(fc.constantFrom(...PATTERN_POOL), { minLength: 0, maxLength: PATTERN_POOL.length })
  .chain((patterns) =>
    fc
      .array(fc.integer({ min: 0, max: ZONES.length - 1 }), {
        minLength: patterns.length,
        maxLength: patterns.length,
      })
      .chain((owners) =>
        fc
          .array(fc.integer({ min: 0, max: 3 }), {
            minLength: ZONES.length,
            maxLength: ZONES.length,
          })
          .map((updatedAts) => {
            const out: SiteLocation[] = [];
            for (let i = 0; i < ZONES.length; i++) {
              const mine = patterns.filter((_, p) => owners[p] === i);
              if (mine.length > 0) out.push(sentinelEntry(i, mine, updatedAts[i]));
            }
            return out;
          })
      )
  );

const settingsArb: fc.Arbitrary<Settings> = fc
  .record({
    enabled: fc.boolean(),
    scopeMode: fc.constantFrom<ScopeMode>("all", "allowlist", "denylist"),
    allowlist: fc.uniqueArray(fc.constantFrom(...FILTER_POOL), { maxLength: 3 }),
    denylist: fc.uniqueArray(fc.constantFrom(...FILTER_POOL), { maxLength: 3 }),
    siteLocations: uniqueEntriesArb,
  })
  .map((r) => ({
    ...DEFAULT_SETTINGS,
    location: TOKYO,
    timezone: TOKYO_TZ,
    accuracySeed: 777,
    precisionSeed: 123456789,
    ...r,
  }));

function inScope(settings: Settings, url: string): boolean {
  return computeEffectiveEnabled({
    masterEnabled: settings.enabled,
    scopeMode: settings.scopeMode,
    allowlist: settings.allowlist,
    denylist: settings.denylist,
    proFeaturesBlocked: settings.proFeaturesBlocked,
    topLevelUrl: url,
    isRestricted: isRestrictedUrl,
  });
}

describe("Site locations: resolution properties", () => {
  test("(a) matchSiteLocation is independent of list order", () => {
    // Patterns may repeat across entries here, so the tie-break is exercised.
    const entriesArb = fc
      .array(
        fc.record({
          patterns: fc.uniqueArray(fc.constantFrom(...PATTERN_POOL), {
            minLength: 1,
            maxLength: 3,
          }),
          updatedAt: fc.integer({ min: 0, max: 2 }),
        }),
        { maxLength: ZONES.length }
      )
      .map((specs) => specs.map((s, i) => sentinelEntry(i, s.patterns, s.updatedAt)));

    fc.assert(
      fc.property(
        entriesArb.chain((entries) =>
          fc.tuple(
            fc.constant(entries),
            fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length })
          )
        ),
        fc.constantFrom(...URL_POOL),
        ([entries, shuffled], url) => {
          const a = matchSiteLocation(url, entries);
          const b = matchSiteLocation(url, shuffled);
          expect(b?.entry.id ?? null).toBe(a?.entry.id ?? null);
          expect(b?.pattern ?? null).toBe(a?.pattern ?? null);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  test("(b) out of scope never applies an entry", async () => {
    await fc.assert(
      fc.asyncProperty(settingsArb, fc.constantFrom(...URL_POOL), async (settings, url) => {
        fc.pre(!inScope(settings, url));
        const payload = await buildPagePayload(settings, url);
        expect(payload.enabled).toBe(false);
        expect(payload.location).toEqual(TOKYO);
        expect(payload.timezone).toEqual(TOKYO_TZ);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  test("(c) coordinates and zone appear only in matching, in-scope payloads", async () => {
    await fc.assert(
      fc.asyncProperty(settingsArb, async (settings) => {
        for (const url of URL_POOL) {
          const payload = await buildPagePayload(settings, url);
          const match = matchSiteLocation(url, settings.siteLocations);
          const applies = payload.enabled && match !== null;

          for (const entry of settings.siteLocations) {
            const isWinner = applies && match.entry.id === entry.id;
            expect(payload.location?.latitude === entry.location.latitude).toBe(isWinner);
            expect(payload.timezone?.identifier === entry.timezone.identifier).toBe(isWinner);
          }
          if (!applies) {
            expect(payload.location).toEqual(TOKYO);
            expect(payload.timezone).toEqual(TOKYO_TZ);
          }
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  test("(d) the payload has exactly the UpdateSettingsPayload keys and no entry data", async () => {
    await fc.assert(
      fc.asyncProperty(settingsArb, fc.constantFrom(...URL_POOL), async (settings, url) => {
        const payload = await buildPagePayload(settings, url);
        expect(Object.keys(payload).sort()).toEqual(PAYLOAD_KEYS);
        const json = JSON.stringify(payload);
        for (const entry of settings.siteLocations) {
          expect(json).not.toContain(entry.id);
          for (const pattern of entry.patterns) expect(json).not.toContain(pattern);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
