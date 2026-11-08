/**
 * The deciding Filters entry (evaluation.md 8.5.3):
 *   (a) it's non-null exactly when the active list decided the page: the
 *       Allowlist keeps it on, or the Denylist keeps it off, per
 *       `computeEffectiveEnabled` with Location Protection on;
 *   (b) that entry alone in the list decides the page the same way.
 */
import { describe, test, expect } from "vitest";
import fc from "fast-check";
import type { ScopeMode } from "@/shared/types/settings";
import { createSiteGroupLookup, frameEntries } from "@/shared/site-groups/matcher";
import { computeEffectiveEnabled } from "@/shared/utils/scope";
import { findDecidingFilterEntry } from "@/shared/utils/site-locations";

const NUM_RUNS = 300;

const FILTER_POOL = [
  "example.com",
  "*.example.com",
  "=example.com",
  "=a.example.com",
  "https://example.com",
  "http://example.com",
  "*://example.com",
  "example.com/x/*",
  "example.com:8080",
  "*.com",
  "*",
  "localhost",
  "localhost:3000",
  "127.0.0.1",
  "münchen.de",
  "twitch.tv",
  "www.twitch.tv",
  "*.tv",
  "twitch.tv/videos/*",
  "geosite:twitch",
  "geosite:video",
  "geosite:google",
];

/** URLs with a hostname (a host-less URL is never decided by a list). */
const URL_POOL = [
  "https://example.com/",
  "http://example.com/x/y",
  "https://a.example.com/",
  "https://example.com:8080/",
  "http://localhost:3000/",
  "http://127.0.0.1/",
  "https://xn--mnchen-3ya.de/",
  "https://twitch.tv/",
  "https://www.twitch.tv/videos/1",
  "https://youtube.com/",
  "https://other.org/",
];

const GROUPS = createSiteGroupLookup({
  "geosite:twitch": { d: frameEntries(["twitch.tv"]), f: frameEntries([]), n: 12 },
  "geosite:video": {
    d: frameEntries(["twitch.tv", "youtube.com"]),
    f: frameEntries([]),
    n: 300,
  },
  "geosite:google": { d: frameEntries(["youtube.com"]), f: frameEntries([]), n: 964 },
});

const listArb = fc.uniqueArray(fc.constantFrom(...FILTER_POOL), { maxLength: 6 });

function enabled(scopeMode: ScopeMode, allowlist: string[], denylist: string[], url: string) {
  return computeEffectiveEnabled({
    masterEnabled: true,
    scopeMode,
    allowlist,
    denylist,
    topLevelUrl: url,
    isRestricted: () => false,
    siteGroups: GROUPS,
  });
}

describe("findDecidingFilterEntry", () => {
  test("is non-null exactly when the active list decided, and decides alone", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ScopeMode>("all", "allowlist", "denylist"),
        listArb,
        listArb,
        fc.constantFrom(...URL_POOL),
        (scopeMode, allowlist, denylist, url) => {
          const deciding = findDecidingFilterEntry({
            scopeMode,
            allowlist,
            denylist,
            topLevelUrl: url,
            siteGroups: GROUPS,
          });
          const on = enabled(scopeMode, allowlist, denylist, url);
          const decided = (scopeMode === "allowlist" && on) || (scopeMode === "denylist" && !on);
          expect(deciding !== null).toBe(decided);
          if (deciding === null) return;
          const list = scopeMode === "allowlist" ? allowlist : denylist;
          expect(list).toContain(deciding);
          const alone =
            scopeMode === "allowlist"
              ? enabled(scopeMode, [deciding], denylist, url)
              : enabled(scopeMode, allowlist, [deciding], url);
          expect(alone).toBe(on);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
