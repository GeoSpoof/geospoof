/**
 * Firefox head start with site groups (plan item 13). Group and link tokens
 * can't be match patterns, so a script that must honor them inlines the
 * groups' framed strings into a host gate in front of the seed. The invariant
 * still holds: the bootstrap may be absent but must never be wrong.
 *
 * Gates are checked by running the generated code with a stub `location` and
 * a capturing `globalThis`, so the tests exercise the code Firefox runs.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import type { Settings, SiteLocation } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import {
  createSiteGroupLookup,
  frameEntries,
  unionGroupStrings,
  type SiteGroupData,
  type SiteGroupStrings,
} from "@/shared/site-groups/matcher";
import {
  buildBootstrapCode,
  planBootstrapScripts,
  type BootstrapPlanItem,
} from "@/background/bootstrap-register";
import { buildBootstrapPayload, buildPagePayload } from "@/background/page-payload";
import { RESTRICTED_DOMAINS } from "@/background/restricted-url";
import {
  __resetSiteGroupStoreForTest,
  writeSiteGroupData,
  type StoredSiteGroup,
} from "@/background/site-groups-store";
import { installUserScriptsMock, parseBootstrapPayload } from "../../helpers/cadence";
import { scriptMatchesUrl } from "../../helpers/match-pattern";
import { installLocalStore, storedGroup } from "../../helpers/site-groups";
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
import vectors from "../../fixtures/site-group-vectors.json";

const HTTP_ALL = ["http://*/*", "https://*/*"];
const RESTRICTED = RESTRICTED_DOMAINS.map((d) => `*://*.${d}/*`);
/** Same derivation as `BOOT_KEY` in bootstrap-register.ts. */
const BOOT_KEY = (process.env.EVENT_NAME || "__x_evt") + "_b";

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

function strings(domains: readonly string[], fulls: readonly string[] = []): SiteGroupStrings {
  return { d: frameEntries(domains), f: frameEntries(fulls) };
}

/** Run bootstrap code on a page with this hostname; the value it seeds, or undefined. */
function runCode(code: string, hostname: string): unknown {
  const page: Record<string, unknown> = {};
  // The code only reads `location.hostname` and writes `globalThis[BOOT_KEY]`.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function("location", "globalThis", code) as (
    location: { hostname: string },
    globalThis: Record<string, unknown>
  ) => void;
  run({ hostname }, page);
  return page[BOOT_KEY];
}

/** True when the item's gate lets it seed a page with this hostname. */
function gatePasses(item: BootstrapPlanItem, hostname: string): boolean {
  return runCode(buildBootstrapCode({ id: item.id }, item.gate ?? null), hostname) !== undefined;
}

/** The planned items that seed `url`: their patterns run there and their gate passes. */
function seeding(plan: BootstrapPlanItem[], url: string): BootstrapPlanItem[] {
  const hostname = new URL(url).hostname;
  return plan.filter((item) => scriptMatchesUrl(item, url) && gatePasses(item, hostname));
}

function ids(plan: BootstrapPlanItem[]): string[] {
  return plan.map((i) => i.id);
}

// ─────────────────────────────── Planner ───────────────────────────────

describe("planBootstrapScripts: allowlist groups", () => {
  const T = strings(["example.com"]);
  const S = strings(["stream.example.com"]);
  const groups = { "geosite:t": T, "geosite:s": S };

  test("a groups script on every http(s) page, gated on the allowed groups minus the site locations'", () => {
    const s = makeSettings({
      scopeMode: "allowlist",
      allowlist: ["geosite:t", "example.org"],
      siteLocations: [entry("1", ["geosite:s", "twitch.tv"])],
    });
    const plan = planBootstrapScripts(s, groups);
    expect(ids(plan)).toEqual(["gs-tz-bootstrap", "gs-tz-bootstrap-groups"]);
    expect(plan[0].gate).toEqual({ skip: S });
    expect(plan[1]).toEqual({
      id: "gs-tz-bootstrap-groups",
      matches: HTTP_ALL,
      excludeMatches: [...RESTRICTED, "*://*.twitch.tv/*"].sort(),
      allFrames: false,
      settings: s,
      gate: { allow: T, skip: S },
    });

    expect(ids(seeding(plan, "https://www.example.com/"))).toEqual(["gs-tz-bootstrap-groups"]);
    expect(seeding(plan, "https://stream.example.com/"), "a site location's group").toEqual([]);
    expect(ids(seeding(plan, "https://example.org/"))).toEqual(["gs-tz-bootstrap"]);
    expect(seeding(plan, "https://other.net/")).toEqual([]);
    expect(seeding(plan, "https://twitch.tv/")).toEqual([]);
    expect(seeding(plan, "https://addons.mozilla.org/")).toEqual([]);
  });

  test("the groups script also leaves out a site location's typed hosts", () => {
    const plan = planBootstrapScripts(
      makeSettings({
        scopeMode: "allowlist",
        allowlist: ["geosite:t"],
        siteLocations: [entry("1", ["=www.example.com", "a.example.com:8080"])],
      }),
      groups
    );
    expect(ids(plan)).toEqual(["gs-tz-bootstrap-groups"]);
    expect(plan[0].gate).toEqual({ allow: T });
    expect(plan[0].excludeMatches).toEqual(
      expect.arrayContaining(["*://www.example.com/*", "*://*.a.example.com/*"])
    );
    expect(seeding(plan, "https://www.example.com/")).toEqual([]);
    expect(seeding(plan, "https://a.example.com/")).toEqual([]);
    expect(seeding(plan, "https://b.example.com/")).toEqual(plan);
  });

  test("several allowed groups are inlined once, as their union", () => {
    const plan = planBootstrapScripts(
      makeSettings({ scopeMode: "allowlist", allowlist: ["geosite:t", "geosite:s"] }),
      groups
    );
    expect(ids(plan)).toEqual(["gs-tz-bootstrap-groups"]);
    expect(plan[0].gate).toEqual({ allow: unionGroupStrings(groups, ["geosite:t", "geosite:s"]) });
  });

  test("no groups script without allowed group data or a main timezone", () => {
    expect(
      planBootstrapScripts(makeSettings({ scopeMode: "allowlist", allowlist: ["geosite:t"] }), {})
    ).toEqual([]);
    const typedOnly = planBootstrapScripts(
      makeSettings({ scopeMode: "allowlist", allowlist: ["geosite:missing", "example.org"] }),
      groups
    );
    expect(ids(typedOnly)).toEqual(["gs-tz-bootstrap"]);
    expect(typedOnly[0]).not.toHaveProperty("gate");
    expect(
      planBootstrapScripts(
        makeSettings({ scopeMode: "allowlist", allowlist: ["geosite:t"], timezone: null }),
        groups
      )
    ).toEqual([]);
  });

  test("allowed groups only count in allowlist mode", () => {
    for (const scopeMode of ["all", "denylist"] as const) {
      const plan = planBootstrapScripts(
        makeSettings({ scopeMode, allowlist: ["geosite:t"] }),
        groups
      );
      expect(ids(plan), scopeMode).toEqual(["gs-tz-bootstrap"]);
      expect(plan[0], scopeMode).not.toHaveProperty("gate");
    }
  });
});

describe("planBootstrapScripts: denylist groups", () => {
  const T = strings(["example.com"], ["exact.example.net"]);
  const groups = { "geosite:t": T };

  test("the main script skips the denied groups' hosts", () => {
    const plan = planBootstrapScripts(
      makeSettings({ scopeMode: "denylist", denylist: ["geosite:t", "example.org"] }),
      groups
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].matches).toEqual(HTTP_ALL);
    expect(plan[0].allFrames).toBe(false);
    expect(plan[0].excludeMatches).toEqual([...RESTRICTED, "*://*.example.org/*"].sort());
    expect(plan[0].gate).toEqual({ deny: T });

    expect(seeding(plan, "https://example.com/")).toEqual([]);
    expect(seeding(plan, "https://www.example.com/")).toEqual([]);
    expect(seeding(plan, "https://exact.example.net/")).toEqual([]);
    expect(seeding(plan, "https://a.exact.example.net/")).toEqual(plan);
    expect(seeding(plan, "https://example.net/")).toEqual(plan);
    expect(seeding(plan, "https://foo.org/")).toEqual(plan);
    expect(seeding(plan, "https://example.org/")).toEqual([]);
  });

  test("denied groups only count in denylist mode", () => {
    for (const scopeMode of ["all", "allowlist"] as const) {
      const plan = planBootstrapScripts(
        makeSettings({ scopeMode, allowlist: ["example.org"], denylist: ["geosite:t"] }),
        groups
      );
      expect(plan, scopeMode).toHaveLength(1);
      expect(plan[0], scopeMode).not.toHaveProperty("gate");
    }
  });

  test("site-location groups and denied groups gate the main script together", () => {
    const S = strings(["twitch.tv"]);
    const plan = planBootstrapScripts(
      makeSettings({
        scopeMode: "denylist",
        denylist: ["geosite:t"],
        siteLocations: [entry("1", ["geosite:s"])],
      }),
      { ...groups, "geosite:s": S }
    );
    expect(ids(plan)).toEqual(["gs-tz-bootstrap"]);
    expect(plan[0].gate).toEqual({ deny: T, skip: S });
    expect(seeding(plan, "https://www.twitch.tv/")).toEqual([]);
    expect(seeding(plan, "https://www.example.com/")).toEqual([]);
    expect(seeding(plan, "https://foo.org/")).toEqual(plan);
  });
});

describe("planBootstrapScripts: site-location groups", () => {
  const S = strings(["example.com"]);
  const groups = { "geosite:s": S };

  test("a skip gate on the main script; per-site scripts get no gate and no group data", async () => {
    const plan = planBootstrapScripts(
      makeSettings({
        siteLocations: [
          entry("1", ["geosite:s", "twitch.tv"]),
          entry("2", ["chatgpt.com"], { timezone: MEXICO_CITY_TZ }),
        ],
      }),
      groups
    );
    expect(ids(plan)).toEqual([
      "gs-tz-bootstrap",
      "gs-tz-bootstrap-site-0",
      "gs-tz-bootstrap-site-1",
    ]);
    expect(plan[0].gate).toEqual({ skip: S });
    expect(plan[0].allFrames).toBe(false);
    for (const site of plan.slice(1)) {
      expect(site).not.toHaveProperty("gate");
      for (const p of [...site.matches, ...site.excludeMatches]) expect(p).not.toMatch(/geosite/);
      const code = buildBootstrapCode(
        await buildBootstrapPayload(site.settings),
        site.gate ?? null
      );
      expect(code).not.toContain("example.com");
      expect(code.startsWith("try{")).toBe(true);
    }
    expect(plan[1].matches).toEqual(["http://*.twitch.tv/*", "https://*.twitch.tv/*"]);

    expect(seeding(plan, "https://www.example.com/"), "the group's location applies").toEqual([]);
    expect(ids(seeding(plan, "https://twitch.tv/"))).toEqual(["gs-tz-bootstrap-site-0"]);
    expect(ids(seeding(plan, "https://chatgpt.com/"))).toEqual(["gs-tz-bootstrap-site-1"]);
    expect(ids(seeding(plan, "https://other.org/"))).toEqual(["gs-tz-bootstrap"]);
  });

  test("a typed pattern of another entry still seeds inside a group's hosts (typed beats group)", () => {
    const plan = planBootstrapScripts(
      makeSettings({
        siteLocations: [
          entry("1", ["geosite:s"]),
          entry("2", ["www.example.com"], { timezone: MEXICO_CITY_TZ }),
        ],
      }),
      groups
    );
    const site = plan.find((i) => i.id === "gs-tz-bootstrap-site-1")!;
    expect(seeding(plan, "https://www.example.com/")).toEqual([site]);
    expect(site.settings.timezone).toEqual(MEXICO_CITY_TZ);
  });
});

describe("planBootstrapScripts: denied groups and per-site scripts", () => {
  /** A deny group with domain entries, full entries, a single-label entry and nested names. */
  const DENY = strings(
    ["ads.example.com", "cn", "b.sub.example.net"],
    ["exact.example.org", "x.full.example.io"]
  );

  /** [pattern, a URL the pattern matches, whether a denied group may touch its hosts] */
  const CASES: Array<[string, string, boolean]> = [
    ["example.com", "https://example.com/", true],
    ["*.example.com", "https://a.example.com/", true],
    ["ads.example.com", "https://ads.example.com/", true],
    ["www.ads.example.com", "https://www.ads.example.com/", true],
    ["=www.ads.example.com", "https://www.ads.example.com/", true],
    ["foo.cn", "https://foo.cn/", true],
    ["=exact.example.org", "https://exact.example.org/", true],
    ["exact.example.org", "https://exact.example.org/", true],
    ["*.exact.example.org", "https://a.exact.example.org/", false],
    ["example.org", "https://example.org/", true],
    ["=example.org", "https://example.org/", false],
    ["*.full.example.io", "https://a.full.example.io/", true],
    ["=full.example.io", "https://full.example.io/", false],
    ["*.example.io", "https://a.example.io/", true],
    ["sub.example.net", "https://sub.example.net/", true],
    ["=sub.example.net", "https://sub.example.net/", false],
    ["=b.sub.example.net", "https://b.sub.example.net/", true],
    ["*.b.sub.example.net", "https://x.b.sub.example.net/", true],
    ["twitch.tv", "https://twitch.tv/", false],
    ["https://twitch.tv", "https://twitch.tv/", false],
    ["127.0.0.1", "http://127.0.0.1/", false],
  ];

  test.each(CASES)("%s seeds %s unless a denied group touches it (%s)", (pattern, url, touched) => {
    const settings = makeSettings({
      scopeMode: "denylist",
      denylist: ["geosite:t"],
      siteLocations: [entry("1", [pattern])],
    });
    const plan = planBootstrapScripts(settings, { "geosite:t": DENY });
    const site = plan.find((i) => i.id === "gs-tz-bootstrap-site-0");
    expect(site).toBeDefined();
    expect(site).not.toHaveProperty("gate");
    expect(seeding(plan, url)).toEqual(touched ? [] : [site]);

    // Without the group's data the token matches nothing, and the pattern seeds.
    const bare = planBootstrapScripts(settings, {});
    expect(ids(seeding(bare, url))).toEqual(["gs-tz-bootstrap-site-0"]);
  });

  test("in allowlist and all modes the denylist's groups don't touch per-site scripts", () => {
    for (const scopeMode of ["all", "allowlist"] as const) {
      const plan = planBootstrapScripts(
        makeSettings({
          scopeMode,
          allowlist: ["example.com"],
          denylist: ["geosite:t"],
          siteLocations: [entry("1", ["example.com"])],
        }),
        { "geosite:t": DENY }
      );
      expect(ids(seeding(plan, "https://example.com/")), scopeMode).toEqual([
        "gs-tz-bootstrap-site-0",
      ]);
    }
  });
});

// ─────────────────────────────── Code ───────────────────────────────

describe("buildBootstrapCode", () => {
  const payload = { enabled: true, timezone: TOKYO_TZ, note: "a\nb" };

  test("no gate: exactly the seed it has always been", () => {
    const expected =
      `try{Object.defineProperty(globalThis,${JSON.stringify(BOOT_KEY)},` +
      `{value:${JSON.stringify(payload)},configurable:true,enumerable:false,writable:true});}catch(e){}`;
    expect(buildBootstrapCode(payload)).toBe(expected);
    expect(buildBootstrapCode(payload, null)).toBe(expected);
    expect(runCode(expected, "anything.example")).toEqual(payload);
  });

  test("a gate wraps the unchanged seed, checking skip, deny, then allow", () => {
    const seed = buildBootstrapCode(payload);
    const code = buildBootstrapCode(payload, {
      allow: strings(["a.test"]),
      deny: strings(["d.test"]),
      skip: strings(["s.test"]),
    });
    expect(code.startsWith("(function(){var h=location.hostname;function m(d,f){")).toBe(true);
    expect(code.endsWith(`${seed}})();`)).toBe(true);
    const skipAt = code.indexOf('if(m("\\ns.test\\n","\\n"))return;');
    const denyAt = code.indexOf('if(m("\\nd.test\\n","\\n"))return;');
    const allowAt = code.indexOf('if(!m("\\na.test\\n","\\n"))return;');
    expect(skipAt).toBeGreaterThan(0);
    expect(denyAt).toBeGreaterThan(skipAt);
    expect(allowAt).toBeGreaterThan(denyAt);
    expect(code.indexOf(seed)).toBeGreaterThan(allowAt);
  });

  test("parseBootstrapPayload still extracts the payload from gated code", async () => {
    const real = await buildBootstrapPayload(makeSettings());
    const code = buildBootstrapCode(real, {
      allow: strings(["a.test", "b.test"], ["c.test"]),
      deny: strings(["d.test"]),
      skip: strings(["s.test"]),
    });
    expect(parseBootstrapPayload(code)).toEqual(JSON.parse(JSON.stringify(real)));
  });

  test("an empty hostname seeds nothing behind any gate", () => {
    for (const gate of [{ skip: strings(["x.test"]) }, { deny: strings(["x.test"]) }]) {
      expect(runCode(buildBootstrapCode(payload, gate), "")).toBeUndefined();
    }
  });

  describe("the inlined gate agrees with createSiteGroupLookup on every fixture lookup case", () => {
    const fixtureGroups = vectors.lookup.groups as Record<
      string,
      { domains: string[]; full: string[] }
    >;
    const data: Record<string, SiteGroupData> = Object.fromEntries(
      Object.entries(fixtureGroups).map(([token, g]) => [
        token,
        {
          d: frameEntries(g.domains),
          f: frameEntries(g.full),
          n: g.domains.length + g.full.length,
        },
      ])
    );
    const lookup = createSiteGroupLookup(data);

    test.each(vectors.lookup.cases)("$token has $host → $expected", ({ token, host, expected }) => {
      const has = lookup.has(token, host);
      expect(has).toBe(expected);
      const g = unionGroupStrings(data, [token]);
      if (g === null) {
        // No data: no gate is built, so nothing is seeded on its account.
        expect(has).toBe(false);
        return;
      }
      const seeds = (gate: Parameters<typeof buildBootstrapCode>[1]) =>
        runCode(buildBootstrapCode(payload, gate), host) !== undefined;
      expect(seeds({ allow: g }), "allow").toBe(has);
      expect(seeds({ deny: g }), "deny").toBe(host !== "" && !has);
      expect(seeds({ skip: g }), "skip").toBe(host !== "" && !has);
    });
  });
});

// ─────────────────────────────── Property ───────────────────────────────

/** The group data the property runs with; `geosite:missing` has none. */
const GROUPS: Record<string, StoredSiteGroup> = {
  "geosite:a": storedGroup(["example.com", "cn"], {}, ["exact.test.org"]),
  "geosite:b": storedGroup(["a.example.com", "twitch.tv"]),
  "list:https://example.org/l.txt": storedGroup(["sub.test.org"], { source: "link" }, [
    "example.net",
  ]),
};

const TOKENS = ["geosite:a", "geosite:b", "geosite:missing", "list:https://example.org/l.txt"];

/** Entries site locations may use (unique across entries). */
const ENTRY_POOL = [
  "example.com",
  "*.example.com",
  "a.example.com",
  "=example.com",
  "=www.example.com",
  "https://example.com",
  "test.org",
  "=test.org",
  "*.test.org",
  "twitch.tv",
  "localhost",
  "127.0.0.1",
  ...TOKENS,
];

/** Filters may also use paths, ports and a wildcard host. */
const FILTER_POOL = [
  ...ENTRY_POOL,
  "*",
  "example.com/app",
  "=https://example.com",
  "=a.example.com:8080",
  "foo.cn",
];

const URL_POOL = [
  "http://example.com/",
  "https://example.com/",
  "https://example.com:8080/",
  "https://example.com/app/page",
  "https://www.example.com/",
  "https://a.example.com/",
  "https://a.example.com:8080/",
  "https://b.a.example.com/",
  "https://foo.cn/",
  "https://exact.test.org/",
  "https://test.org/",
  "https://sub.test.org/",
  "https://x.sub.test.org/",
  "https://example.net/",
  "https://www.example.net/",
  "https://twitch.tv/",
  "https://www.twitch.tv/",
  "http://localhost:3000/",
  "http://127.0.0.1/",
  "https://other.org/",
  "https://addons.mozilla.org/",
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

describe("planBootstrapScripts with site groups: property", () => {
  beforeEach(async () => {
    __resetSiteGroupStoreForTest();
    installLocalStore();
    // The page payload reads the same data through the store's lookup.
    await writeSiteGroupData(GROUPS);
  });

  afterEach(() => {
    __resetSiteGroupStoreForTest();
  });

  test("every script that seeds a URL agrees with the page payload", async () => {
    await fc.assert(
      fc.asyncProperty(settingsArb, async (settings) => {
        const plan = planBootstrapScripts(settings, GROUPS);
        for (const url of URL_POOL) {
          const hits = seeding(plan, url);
          if (hits.length === 0) continue;
          const page = await buildPagePayload(settings, url);
          for (const hit of hits) {
            const boot = await buildBootstrapPayload(hit.settings);
            const at = `${url} (${hit.id})`;
            expect(page.enabled, at).toBe(true);
            expect(boot.timezone, at).toEqual(page.timezone);
            expect(boot.location, at).toEqual(page.location);
            expect(boot.locale, at).toEqual(page.locale);
          }
        }
      }),
      { numRuns: 300 }
    );
  });
});

// ─────────────────────────────── registerNow ───────────────────────────────

describe("registerNow uses the store's group data", () => {
  afterEach(() => {
    vi.resetModules();
  });

  type Registration = Record<string, unknown> & { id: string; js: Array<{ code: string }> };

  test("the groups script is registered with its gate, and per-site scripts without one", async () => {
    vi.resetModules();
    installLocalStore();
    const userScripts = installUserScriptsMock();
    try {
      const store = await import("@/background/site-groups-store");
      await store.writeSiteGroupData({
        "geosite:t": storedGroup(["example.com"]),
        "geosite:s": storedGroup(["stream.example.com"]),
      });
      const { updateBootstrapRegistration } = await import("@/background/bootstrap-register");
      await updateBootstrapRegistration(
        makeSettings({
          scopeMode: "allowlist",
          allowlist: ["geosite:t", "twitch.tv"],
          siteLocations: [entry("1", ["geosite:s", "twitch.tv"], { timezone: MEXICO_CITY_TZ })],
        })
      );

      expect(userScripts.register).toHaveBeenCalledTimes(1);
      const [batch] = userScripts.register.mock.calls[0] as [Registration[]];
      expect(batch.map((r) => r.id)).toEqual([
        "gs-tz-bootstrap",
        "gs-tz-bootstrap-groups",
        "gs-tz-bootstrap-site-0",
      ]);
      const [main, groupsScript, site] = batch;

      // The main script skips the site location's group.
      const mainCode = main.js[0].code;
      expect(runCode(mainCode, "stream.example.com")).toBeUndefined();
      expect(runCode(mainCode, "www.twitch.tv")).toBeDefined();

      expect(groupsScript.matches).toEqual(HTTP_ALL);
      expect(groupsScript.allFrames).toBe(false);
      const code = groupsScript.js[0].code;
      expect(parseBootstrapPayload(code).timezone).toEqual(TOKYO_TZ);
      expect(
        (runCode(code, "www.example.com") as { timezone: unknown } | undefined)?.timezone
      ).toEqual(TOKYO_TZ);
      expect(runCode(code, "stream.example.com")).toBeUndefined();
      expect(runCode(code, "other.org")).toBeUndefined();

      const siteCode = site.js[0].code;
      expect(siteCode.startsWith("try{")).toBe(true);
      expect(siteCode).not.toContain("example.com");
      expect(parseBootstrapPayload(siteCode).timezone).toEqual(MEXICO_CITY_TZ);
    } finally {
      userScripts.restore();
    }
  });
});
