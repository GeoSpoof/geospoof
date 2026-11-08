/**
 * Per-site location marks never contradict Filters: for a typed pattern,
 * "off" means Filters (with Location Protection forced on) keep GeoSpoof off
 * at the pattern's probe URL, and "on" means they keep it on there.
 */
import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { createSiteGroupLookup, frameEntries } from "@/shared/site-groups/matcher";
import { computeEffectiveEnabled } from "@/shared/utils/scope";
import { filterProbeUrl, siteFilterOutcome } from "@/shared/utils/site-locations";

const NUM_RUNS = 300;

const SITE_POOL = [
  "example.com",
  "http://example.com",
  "https://example.com",
  "*://example.com",
  "=example.com",
  "a.example.com",
  "=a.example.com",
  "example.com:8080",
  "https://example.com:8080",
  "localhost",
  "localhost:3000",
  "127.0.0.1",
  "münchen.de",
  "xn--mnchen-3ya.de",
  "twitch.tv",
  "www.twitch.tv",
  "http://twitch.tv:8080",
  "kick.com",
];

const FILTER_POOL = [
  "example.com",
  "*.example.com",
  "=example.com",
  "=a.example.com",
  "https://example.com",
  "http://example.com",
  "*://example.com",
  "example.com/x/*",
  "example.com/*",
  "example.com:8080",
  "*.com",
  "*",
  "localhost",
  "localhost:3000",
  "127.0.0.1",
  "xn--mnchen-3ya.de",
  "münchen.de/*",
  "twitch.tv",
  "*.tv",
  "=www.twitch.tv",
  "http://*.tv",
  "geosite:twitch",
  "geosite:google",
];

const GROUPS = createSiteGroupLookup({
  "geosite:twitch": { d: frameEntries(["twitch.tv"]), f: frameEntries([]), n: 12 },
  "geosite:google": { d: frameEntries(["google.com"]), f: frameEntries(["kick.com"]), n: 964 },
});

const listArb = fc.uniqueArray(fc.constantFrom(...FILTER_POOL), { maxLength: 5 });

describe("siteFilterOutcome agrees with computeEffectiveEnabled at the probe", () => {
  test("off ⇒ the probe is off, on ⇒ the probe is on", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("allowlist" as const, "denylist" as const),
        listArb,
        listArb,
        fc.constantFrom(...SITE_POOL),
        (scopeMode, allowlist, denylist, pattern) => {
          const outcome = siteFilterOutcome(pattern, {
            scopeMode,
            allowlist,
            denylist,
            siteGroups: GROUPS,
          });
          const probe = filterProbeUrl(pattern);
          expect(probe).not.toBeNull();
          const probeOn = computeEffectiveEnabled({
            masterEnabled: true,
            scopeMode,
            allowlist,
            denylist,
            topLevelUrl: probe ?? undefined,
            isRestricted: () => false,
            siteGroups: GROUPS,
          });
          if (outcome === "off") expect(probeOn).toBe(false);
          if (outcome === "on") expect(probeOn).toBe(true);
          expect(outcome).not.toBe("skipped");
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
