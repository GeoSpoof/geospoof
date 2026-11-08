/**
 * The THIS SITE card's "this site" and its undo:
 *   (a) `suggestSiteLocationPattern` strips exactly one leading `www.` when
 *       what's left has a dot; the site matches the tab; and the site, the
 *       raw host, `=host`, `https://host` and `host:3000` are all own entries.
 *   (b) An own typed entry E alone in either list gets "Remove E", and after
 *       removing it with the undo record set, the card offers "Add E" with E
 *       exactly as stored, which `parseFilterEntry` keeps unchanged.
 */
import { describe, test, expect } from "vitest";
import fc from "fast-check";
import type { Settings } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import { NO_SITE_GROUPS } from "@/shared/site-groups/matcher";
import { parseFilterEntry } from "@/shared/utils/filter-entries";
import { matchesPattern } from "@/shared/utils/scope";
import { suggestSiteLocationPattern } from "@/shared/utils/site-locations";
import { isRestrictedUrl } from "@/background/restricted-url";
import { computeThisSiteCard, isOwnFilterEntry } from "@/popup/this-site";
import { TOKYO, TOKYO_NAME, TOKYO_TZ } from "../helpers/site-locations";

const NUM_RUNS = 300;

const labelArb = fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/);
/** A host of one to three labels, with or without a leading `www.`. */
const hostArb = fc.oneof(
  fc
    .tuple(
      fc.boolean(),
      fc.array(labelArb, { minLength: 1, maxLength: 3 }),
      fc.constantFrom("com", "tv", "org")
    )
    .map(([www, labels, tld]) => `${www ? "www." : ""}${[...labels, tld].join(".")}`),
  // `www.` with no dot after it stays whole.
  fc.constantFrom("www.com", "www.tv")
);

function settings(overrides: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    location: TOKYO,
    timezone: TOKYO_TZ,
    locationName: TOKYO_NAME,
    ...overrides,
  };
}

/** The own typed spellings for a host, given the tab's site. */
function ownEntries(host: string, site: string): string[] {
  return [site, host, `=${host}`, `https://${host}`, `${host}:3000`];
}

describe("this site", () => {
  test("strips one www., matches the tab, and owns every typed spelling", () => {
    fc.assert(
      fc.property(hostArb, fc.boolean(), (host, withPort) => {
        const tabUrl = `https://${host}${withPort ? ":3000" : ""}/`;
        const site = suggestSiteLocationPattern(tabUrl);
        const rest = host.slice(4);
        const expected = host.startsWith("www.") && rest.includes(".") ? rest : host;
        expect(site).toBe(expected);
        if (site === null) return;
        expect(matchesPattern(tabUrl, site)).toBe(true);
        for (const e of ownEntries(host, site)) {
          expect(isOwnFilterEntry(e, site, tabUrl)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  test("a card Remove of an own entry is undone exactly", () => {
    fc.assert(
      fc.property(
        hostArb,
        fc.constantFrom("allowlist" as const, "denylist" as const),
        fc.integer({ min: 0, max: 4 }),
        (host, list, pick) => {
          // The tab carries :3000, so every own spelling (host:3000 too) covers it.
          const tabUrl = `https://${host}:3000/`;
          const site = suggestSiteLocationPattern(tabUrl);
          if (site === null) return;
          const stored = parseFilterEntry(ownEntries(host, site)[pick]);
          expect(stored).not.toBeNull();
          if (stored === null) return;
          const compute = (entries: string[], undo: boolean) =>
            computeThisSiteCard({
              settings: settings({
                scopeMode: list,
                allowlist: list === "allowlist" ? entries : [],
                denylist: list === "denylist" ? entries : [],
              }),
              tabUrl,
              proLocked: false,
              isOptionsPage: false,
              isRestricted: isRestrictedUrl,
              siteGroups: NO_SITE_GROUPS,
              undo: undo ? { tabUrl, list, entry: stored } : null,
            });

          const listed = compute([stored], false);
          expect(listed).toMatchObject({ button: { action: "remove", list, pattern: stored } });

          const removed = compute([], true);
          expect(removed).toMatchObject({ button: { action: "add", list, pattern: stored } });
          expect(parseFilterEntry(stored)).toBe(stored);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
