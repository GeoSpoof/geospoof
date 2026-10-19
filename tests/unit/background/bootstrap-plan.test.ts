/**
 * Firefox bootstrap planner: the bootstrap may be absent but must never be
 * wrong. Every planned script's `matches` must under-approximate, and its
 * `excludeMatches` over-approximate, the pages whose async payload agrees with
 * the script's inlined one.
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import fc from "fast-check";
import type { Settings, SiteLocation } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import { parsePattern } from "@/shared/utils/scope";
import { planBootstrapScripts, type BootstrapPlanItem } from "@/background/bootstrap-register";
import { buildBootstrapPayload, buildPagePayload } from "@/background/page-payload";
import { RESTRICTED_DOMAINS } from "@/background/restricted-url";
import { installUserScriptsMock, parseBootstrapPayload } from "../../helpers/cadence";
import { scriptMatchesUrl } from "../../helpers/match-pattern";
import {
  DUBLIN,
  DUBLIN_NAME,
  DUBLIN_TZ,
  MEXICO_CITY,
  MEXICO_CITY_NAME,
  MEXICO_CITY_TZ,
  TOKYO,
  TOKYO_NAME,
  TOKYO_TZ,
  makeSiteLocation,
} from "../../helpers/site-locations";

const HTTP_ALL = ["http://*/*", "https://*/*"];
const RESTRICTED = RESTRICTED_DOMAINS.map((d) => `*://*.${d}/*`);

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    onboardingCompleted: true,
    location: TOKYO,
    timezone: TOKYO_TZ,
    locationName: TOKYO_NAME,
    locationPrecision: { mode: "exact" },
    localeSpoofing: { mode: "match" },
    ...overrides,
  };
}

function entry(id: string, patterns: string[], overrides: Partial<SiteLocation> = {}) {
  return makeSiteLocation({ id, patterns, ...overrides });
}

/** The planned items whose patterns run on `url`. */
function matching(plan: BootstrapPlanItem[], url: string): BootstrapPlanItem[] {
  return plan.filter((item) => scriptMatchesUrl(item, url));
}

describe("planBootstrapScripts: unit cases", () => {
  test("master off plans nothing", () => {
    expect(planBootstrapScripts(makeSettings({ enabled: false }))).toEqual([]);
  });

  test("mode all with no site locations: one main script in every http(s) frame", () => {
    const s = makeSettings();
    const plan = planBootstrapScripts(s);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual({
      id: "gs-tz-bootstrap",
      matches: HTTP_ALL,
      excludeMatches: [...RESTRICTED].sort(),
      allFrames: true,
      settings: s,
    });
  });

  test("restricted domains are excluded from every script", () => {
    const plan = planBootstrapScripts(
      makeSettings({ siteLocations: [entry("1", ["*.org"]), entry("2", ["*.com"])] })
    );
    expect(plan).toHaveLength(3);
    for (const item of plan) {
      for (const r of RESTRICTED) expect(item.excludeMatches).toContain(r);
    }
    expect(matching(plan, "https://addons.mozilla.org/")).toEqual([]);
    expect(matching(plan, "https://chrome.google.com/webstore")).toEqual([]);
  });

  test("file: pages are never seeded", () => {
    expect(matching(planBootstrapScripts(makeSettings()), "file:///tmp/x.html")).toEqual([]);
  });

  test("denylist entries exclude their whole host, on any scheme, port, or path", () => {
    const plan = planBootstrapScripts(
      makeSettings({
        scopeMode: "denylist",
        denylist: ["example.com", "https://foo.org/path", "test.org:8080", "127.0.0.1"],
      })
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].matches).toEqual(HTTP_ALL);
    expect(plan[0].allFrames).toBe(false);
    expect(plan[0].excludeMatches).toEqual(
      expect.arrayContaining([
        "*://*.example.com/*",
        "*://*.foo.org/*",
        "*://*.test.org/*",
        "*://127.0.0.1/*",
      ])
    );
    expect(matching(plan, "https://www.example.com/")).toEqual([]);
    expect(matching(plan, "http://foo.org/other")).toEqual([]);
    expect(matching(plan, "https://example.net/")).toHaveLength(1);
  });

  test("a denylist entry matching every host plans nothing", () => {
    for (const denylist of [["*"], ["*://*"], ["example.com", "*:8080"]]) {
      expect(planBootstrapScripts(makeSettings({ scopeMode: "denylist", denylist }))).toEqual([]);
    }
  });

  test("allowlist: only path-free, port-free entries are seeded, apexes of *.L excluded", () => {
    const plan = planBootstrapScripts(
      makeSettings({
        scopeMode: "allowlist",
        allowlist: ["example.com", "https://a.org", "b.org/app", "c.org:8080", "*.d.org"],
      })
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].allFrames).toBe(false);
    expect(plan[0].matches).toEqual([
      "http://*.d.org/*",
      "http://*.example.com/*",
      "https://*.a.org/*",
      "https://*.d.org/*",
      "https://*.example.com/*",
    ]);
    expect(plan[0].excludeMatches).toContain("*://d.org/*");
    expect(matching(plan, "https://d.org/")).toEqual([]);
    expect(matching(plan, "https://x.d.org/")).toHaveLength(1);
    expect(matching(plan, "http://a.org/")).toEqual([]);
    expect(matching(plan, "https://b.org/app")).toEqual([]);
  });

  test("allowlist: the apex stays seeded when another entry covers it", () => {
    const plan = planBootstrapScripts(
      makeSettings({ scopeMode: "allowlist", allowlist: ["*.d.org", "d.org"] })
    );
    expect(plan[0].excludeMatches).not.toContain("*://d.org/*");
    expect(matching(plan, "https://d.org/")).toHaveLength(1);
  });

  test("an empty or unseedable allowlist plans no main script", () => {
    expect(planBootstrapScripts(makeSettings({ scopeMode: "allowlist", allowlist: [] }))).toEqual(
      []
    );
    expect(
      planBootstrapScripts(makeSettings({ scopeMode: "allowlist", allowlist: ["a.org/x"] }))
    ).toEqual([]);
  });

  test("site locations make every script top-frame only, main first", () => {
    const plan = planBootstrapScripts(makeSettings({ siteLocations: [entry("1", ["twitch.tv"])] }));
    expect(plan.map((i) => i.id)).toEqual(["gs-tz-bootstrap", "gs-tz-bootstrap-site-0"]);
    expect(plan.map((i) => i.allFrames)).toEqual([false, false]);
    expect(plan[0].excludeMatches).toContain("*://*.twitch.tv/*");
    expect(plan[1].matches).toEqual(["http://*.twitch.tv/*", "https://*.twitch.tv/*"]);
    expect(plan[1].settings.timezone).toEqual(DUBLIN_TZ);
    expect(plan[1].settings.location).toEqual(DUBLIN);
    expect(plan[1].settings.locationName).toEqual(DUBLIN_NAME);
  });

  test("entry scripts are ordered by id", () => {
    const plan = planBootstrapScripts(
      makeSettings({
        timezone: null,
        siteLocations: [
          entry("b", ["twitch.tv"], { timezone: MEXICO_CITY_TZ }),
          entry("a", ["chatgpt.com"]),
        ],
      })
    );
    expect(plan.map((i) => i.settings.timezone?.identifier)).toEqual([
      "Europe/Dublin",
      "America/Mexico_City",
    ]);
  });

  test("a port pattern gets no entry script, and its host is excluded from main", () => {
    const plan = planBootstrapScripts(
      makeSettings({ siteLocations: [entry("1", ["example.com:8080"])] })
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].id).toBe("gs-tz-bootstrap");
    expect(plan[0].excludeMatches).toContain("*://*.example.com/*");
    expect(matching(plan, "https://example.com/")).toEqual([]);
    expect(matching(plan, "https://example.com:8080/")).toEqual([]);
  });

  test("a *.L entry pattern excludes its apex unless the entry also covers it", () => {
    const sub = planBootstrapScripts(
      makeSettings({ siteLocations: [entry("1", ["*.example.com"])] })
    );
    expect(sub[1].matches).toEqual(["http://*.example.com/*", "https://*.example.com/*"]);
    expect(sub[1].excludeMatches).toContain("*://example.com/*");
    // Neither: main must exclude `*.example.com` whole, apex included, since
    // a match pattern can't say "subdomains only".
    expect(matching(sub, "https://example.com/")).toEqual([]);
    expect(matching(sub, "https://a.example.com/").map((i) => i.id)).toEqual([
      "gs-tz-bootstrap-site-0",
    ]);

    const both = planBootstrapScripts(
      makeSettings({ siteLocations: [entry("1", ["*.example.com", "example.com"])] })
    );
    expect(both[1].excludeMatches).not.toContain("*://example.com/*");
    expect(matching(both, "https://example.com/").map((i) => i.id)).toEqual([
      "gs-tz-bootstrap-site-0",
    ]);
  });

  test("an entry leaves hosts where a more specific entry could win unseeded", () => {
    const plan = planBootstrapScripts(
      makeSettings({
        siteLocations: [
          entry("1", ["example.com"]),
          entry("2", ["a.example.com"], { timezone: MEXICO_CITY_TZ }),
        ],
      })
    );
    const [, broad, narrow] = plan;
    expect(broad.excludeMatches).toContain("*://*.a.example.com/*");
    expect(narrow.excludeMatches).not.toContain("*://*.example.com/*");
    expect(matching(plan, "https://b.a.example.com/")).toEqual([narrow]);
    expect(matching(plan, "https://example.com/")).toEqual([broad]);
    expect(matching(plan, "https://example.net/")).toEqual([plan[0]]);
  });

  test("allowlist: an entry pattern the allowlist doesn't cover gets no seed", () => {
    const plan = planBootstrapScripts(
      makeSettings({
        scopeMode: "allowlist",
        allowlist: ["chatgpt.com"],
        siteLocations: [entry("1", ["chatgpt.com", "openai.com"])],
      })
    );
    expect(plan.map((i) => i.id)).toEqual(["gs-tz-bootstrap", "gs-tz-bootstrap-site-0"]);
    const site = plan.find((i) => i.id === "gs-tz-bootstrap-site-0")!;
    expect(site.matches).toEqual(["http://*.chatgpt.com/*", "https://*.chatgpt.com/*"]);
    expect(matching(plan, "https://openai.com/")).toEqual([]);
    expect(matching(plan, "https://chatgpt.com/")).toEqual([site]);
  });

  test("no main timezone: entry scripts only", () => {
    const plan = planBootstrapScripts(
      makeSettings({ timezone: null, siteLocations: [entry("1", ["twitch.tv"])] })
    );
    expect(plan.map((i) => i.id)).toEqual(["gs-tz-bootstrap-site-0"]);
  });

  test("IDN hosts are emitted as A-labels", () => {
    const plan = planBootstrapScripts(
      makeSettings({ siteLocations: [entry("1", ["münchen.de"])] })
    );
    expect(plan[0].excludeMatches).toContain("*://*.xn--mnchen-3ya.de/*");
    expect(plan[1].matches).toEqual([
      "http://*.xn--mnchen-3ya.de/*",
      "https://*.xn--mnchen-3ya.de/*",
    ]);
    expect(matching(plan, "https://www.xn--mnchen-3ya.de/")).toEqual([plan[1]]);
  });

  test("a Unicode and an A-label pattern for one host are treated as overlapping", () => {
    const plan = planBootstrapScripts(
      makeSettings({
        timezone: null,
        siteLocations: [
          entry("1", ["münchen.de"]),
          entry("2", ["xn--mnchen-3ya.de"], { timezone: MEXICO_CITY_TZ }),
        ],
      })
    );
    expect(matching(plan, "https://xn--mnchen-3ya.de/")).toEqual([]);
  });
});

// ─────────────────────────────── Property ───────────────────────────────

/** Patterns site locations may use (unique across entries). */
const ENTRY_POOL = [
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
];

/** Filters may also use paths and a wildcard host. */
const FILTER_POOL = [...ENTRY_POOL, "*", "example.com/app", "*://test.org", "http://*.test.org"];

const URL_POOL = [
  "http://example.com/",
  "https://example.com/",
  "https://example.com:8080/",
  "http://example.com:8080/x",
  "https://www.example.com/",
  "https://a.example.com/",
  "https://b.a.example.com/",
  "https://example.com/app/page",
  "https://foo.com/",
  "https://com/",
  "https://example.net/",
  "https://test.org/",
  "http://sub.test.org/",
  "http://localhost:3000/",
  "http://dev.localhost/",
  "http://127.0.0.1/",
  "http://127.0.0.1:8080/",
  "https://xn--mnchen-3ya.de/",
  "https://www.münchen.de/",
  "https://addons.mozilla.org/",
  "https://chrome.google.com/webstore",
  "file:///tmp/x.html",
];

const ENTRY_PLACES = [
  { location: DUBLIN, timezone: DUBLIN_TZ, locationName: DUBLIN_NAME },
  { location: MEXICO_CITY, timezone: MEXICO_CITY_TZ, locationName: MEXICO_CITY_NAME },
  {
    location: { latitude: 40.7128, longitude: -74.006, accuracy: 45 },
    timezone: { identifier: "America/New_York", offset: 300, dstOffset: 60 },
    locationName: null,
  },
];

const settingsArb = fc
  .record({
    scopeMode: fc.constantFrom("all" as const, "allowlist" as const, "denylist" as const),
    allowlist: fc.subarray(FILTER_POOL),
    denylist: fc.subarray(FILTER_POOL),
    // For each pool pattern: which entry owns it (-1 = none).
    owners: fc.array(fc.integer({ min: -1, max: ENTRY_PLACES.length - 1 }), {
      minLength: ENTRY_POOL.length,
      maxLength: ENTRY_POOL.length,
    }),
    ids: fc.shuffledSubarray(["10", "20", "30"], { minLength: 3, maxLength: 3 }),
    updatedAt: fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 3, maxLength: 3 }),
    hasMainTimezone: fc.boolean(),
  })
  .map((r): Settings => {
    const siteLocations: SiteLocation[] = [];
    ENTRY_PLACES.forEach((place, i) => {
      const patterns = ENTRY_POOL.filter((_, p) => r.owners[p] === i);
      if (patterns.length === 0) return;
      siteLocations.push(
        makeSiteLocation({ id: r.ids[i], patterns, updatedAt: r.updatedAt[i], ...place })
      );
    });
    return makeSettings({
      scopeMode: r.scopeMode,
      allowlist: r.allowlist,
      denylist: r.denylist,
      timezone: r.hasMainTimezone ? TOKYO_TZ : null,
      siteLocations,
    });
  });

describe("planBootstrapScripts: property", () => {
  test("pools are canonical patterns", () => {
    for (const p of FILTER_POOL) expect(parsePattern(p)).toBe(p);
  });

  test("at most one script matches a URL, and a matching script agrees with the page payload", async () => {
    await fc.assert(
      fc.asyncProperty(settingsArb, async (settings) => {
        const plan = planBootstrapScripts(settings);
        for (const url of URL_POOL) {
          const hits = matching(plan, url);
          expect(hits.length, `${url}: ${hits.map((h) => h.id).join(", ")}`).toBeLessThanOrEqual(1);
          if (hits.length === 0) continue;
          const page = await buildPagePayload(settings, url);
          const boot = await buildBootstrapPayload(hits[0].settings);
          expect(page.enabled, url).toBe(true);
          expect(boot.timezone, url).toEqual(page.timezone);
          expect(boot.location, url).toEqual(page.location);
          expect(boot.locale, url).toEqual(page.locale);
        }
      }),
      { numRuns: 300 }
    );
  });
});

// ─────────────────────────────── registerNow ───────────────────────────────

describe("registerNow", () => {
  afterEach(() => {
    vi.doUnmock("@/background/restricted-url");
    vi.resetModules();
  });

  type Registration = Record<string, unknown> & { id: string; js: Array<{ code: string }> };

  function batches(register: { mock: { calls: unknown[][] } }): Registration[][] {
    return register.mock.calls.map((c) => c[0] as Registration[]);
  }

  test("one unfiltered unregister and one batched register per call, main first", async () => {
    vi.resetModules();
    const userScripts = installUserScriptsMock();
    try {
      const { updateBootstrapRegistration } = await import("@/background/bootstrap-register");
      const s = makeSettings({
        siteLocations: [entry("1", ["twitch.tv"], { timezone: MEXICO_CITY_TZ })],
      });
      await updateBootstrapRegistration(s);
      await updateBootstrapRegistration(s);

      expect(userScripts.log).toEqual(["unregister", "register", "unregister", "register"]);
      for (const call of userScripts.unregister.mock.calls) expect(call).toEqual([]);
      const [batch] = batches(userScripts.register);
      expect(batch.map((r) => r.id)).toEqual(["gs-tz-bootstrap", "gs-tz-bootstrap-site-0"]);
      for (const r of batch) {
        expect(r.runAt).toBe("document_start");
        expect(r.world).toBe("MAIN");
        expect(r.allFrames).toBe(false);
        expect(r).toHaveProperty("excludeMatches");
      }
      expect(parseBootstrapPayload(batch[0].js[0].code).timezone).toEqual(TOKYO_TZ);
      expect(parseBootstrapPayload(batch[1].js[0].code).timezone).toEqual(MEXICO_CITY_TZ);
    } finally {
      userScripts.restore();
    }
  });

  test("nothing to seed: unregister only", async () => {
    vi.resetModules();
    const userScripts = installUserScriptsMock();
    try {
      const { updateBootstrapRegistration } = await import("@/background/bootstrap-register");
      await updateBootstrapRegistration(makeSettings({ enabled: false }));
      await updateBootstrapRegistration(makeSettings({ timezone: null }));
      expect(userScripts.log).toEqual(["unregister", "unregister"]);
      expect(userScripts.register).not.toHaveBeenCalled();
    } finally {
      userScripts.restore();
    }
  });

  test("an empty excludeMatches list is omitted, not sent empty", async () => {
    vi.resetModules();
    vi.doMock("@/background/restricted-url", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/background/restricted-url")>()),
      RESTRICTED_DOMAINS: [],
    }));
    const userScripts = installUserScriptsMock();
    try {
      const { updateBootstrapRegistration } = await import("@/background/bootstrap-register");
      await updateBootstrapRegistration(makeSettings());
      const [batch] = batches(userScripts.register);
      expect(batch).toHaveLength(1);
      expect(batch[0]).not.toHaveProperty("excludeMatches");
      expect(batch[0].matches).toEqual(HTTP_ALL);
      expect(batch[0].allFrames).toBe(true);
    } finally {
      userScripts.restore();
    }
  });
});
