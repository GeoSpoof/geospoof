import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Settings, SiteLocation } from "@/shared/types/settings";
import {
  DEFAULT_ACCURACY_M,
  DEFAULT_SETTINGS,
  MAX_PATTERNS_PER_SITE_LOCATION,
  MAX_SITE_LOCATIONS,
} from "@/shared/types/settings";
import { parsePattern } from "@/shared/utils/scope";
import {
  compareSpecificity,
  matchSiteLocation,
  parseSiteLocationPattern,
  resolveSiteSettings,
  siteLocationDisplayName,
  siteLocationSpecificity,
  suggestSiteLocationPattern,
  validateSiteLocations,
} from "@/shared/utils/site-locations";
import { isRestrictedUrl } from "@/background/restricted-url";
import {
  DUBLIN_TZ,
  ENTRY_DUBLIN,
  ENTRY_MEXICO_CITY,
  TOKYO,
  TOKYO_NAME,
  TOKYO_TZ,
  makeSiteLocation,
} from "../../helpers/site-locations";

/**
 * Vitest compiles `__SAFARI__` to false, so the real Pro gate is a no-op here.
 * The mock below swaps in the Safari behavior while `safariGate.on` is set, and
 * otherwise defers to the real function. It can intercept the resolver's call
 * only because the gate lives in scope.ts, a different module.
 */
const safariGate = vi.hoisted(() => ({ on: false }));
vi.mock("@/shared/utils/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/utils/scope")>();
  return {
    ...actual,
    computeEffectiveSiteLocations: (list: unknown, proFeaturesBlocked?: boolean) =>
      safariGate.on && proFeaturesBlocked === true
        ? []
        : actual.computeEffectiveSiteLocations(list, proFeaturesBlocked),
  };
});

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    location: TOKYO,
    timezone: TOKYO_TZ,
    locationName: TOKYO_NAME,
    siteLocations: [ENTRY_DUBLIN, ENTRY_MEXICO_CITY],
    ...overrides,
  };
}

describe("parseSiteLocationPattern", () => {
  it.each(["twitch.tv/videos", "example.com/*", "https://example.com/a/b"])(
    "rejects the path pattern %s",
    (input) => {
      expect(parsePattern(input)).not.toBeNull(); // a valid Filters pattern…
      expect(parseSiteLocationPattern(input)).toBeNull(); // …but not a site
    }
  );

  it.each(["*", "*://*", "https://*", "https://*:8080", "*:443"])(
    "rejects the wildcard-only host %s",
    (input) => {
      expect(parseSiteLocationPattern(input)).toBeNull();
    }
  );

  it.each([
    "twitch.tv",
    "WWW.Example.com",
    "http://example.com",
    "*.example.com",
    "example.com:8080",
    "localhost",
    "10.0.0.1",
    "münchen.de",
  ])("accepts %s with the Filters canonical form", (input) => {
    const canonical = parseSiteLocationPattern(input);
    expect(canonical).not.toBeNull();
    expect(canonical).toBe(parsePattern(input));
  });
});

describe("siteLocationSpecificity", () => {
  it.each([
    ["www.example.com", [3, 0, 1, 0]],
    ["*.example.com", [2, 1, 1, 0]],
    ["https://example.com", [2, 0, 2, 0]],
    ["http://example.com", [2, 0, 2, 0]],
    ["example.com:443", [2, 0, 1, 1]],
    ["example.com", [2, 0, 1, 0]],
    ["*://example.com", [2, 0, 0, 0]],
    ["*.com", [1, 1, 1, 0]],
    ["127.0.0.1", [4, 0, 1, 0]],
    ["localhost", [1, 0, 1, 0]],
    ["localhost:3000", [1, 0, 1, 1]],
  ] as const)("%s → %j", (pattern, expected) => {
    expect(siteLocationSpecificity(pattern)).toEqual(expected);
  });

  it("compareSpecificity is lexicographic and positive when a is more specific", () => {
    expect(compareSpecificity([3, 0, 0, 0], [2, 1, 2, 1])).toBeGreaterThan(0);
    expect(compareSpecificity([2, 1, 0, 0], [2, 0, 2, 1])).toBeGreaterThan(0);
    expect(compareSpecificity([2, 0, 1, 1], [2, 0, 2, 0])).toBeLessThan(0);
    expect(compareSpecificity([2, 0, 1, 0], [2, 0, 1, 0])).toBe(0);
  });
});

describe("matchSiteLocation precedence", () => {
  const URL_WWW = "https://www.example.com/";
  // The plan's precedence example, most specific first.
  const ORDER = [
    "www.example.com",
    "*.example.com",
    "https://example.com",
    "example.com",
    "*://example.com",
    "*.com",
  ];

  function entriesFor(patterns: string[]): SiteLocation[] {
    return patterns.map((p, i) => makeSiteLocation({ id: `id-${i}`, patterns: [p] }));
  }

  it("the most specific pattern wins, step by step", () => {
    const remaining = [...ORDER, "example.com:443"];
    for (const expected of ORDER) {
      const m = matchSiteLocation(URL_WWW, entriesFor(remaining));
      expect(m?.pattern).toBe(expected);
      remaining.splice(remaining.indexOf(expected), 1);
    }
    // Only the port pattern is left, and the URL has no explicit port.
    expect(remaining).toEqual(["example.com:443"]);
    expect(matchSiteLocation(URL_WWW, entriesFor(remaining))).toBeNull();
  });

  it("an apex URL skips *.example.com and www.example.com", () => {
    const m = matchSiteLocation("https://example.com/", entriesFor(ORDER));
    expect(m?.pattern).toBe("https://example.com");
  });

  it("an explicit port pattern beats the bare host on that port", () => {
    const entries = entriesFor(["example.com", "example.com:8443"]);
    expect(matchSiteLocation("https://example.com:8443/", entries)?.pattern).toBe(
      "example.com:8443"
    );
    expect(matchSiteLocation("https://example.com/", entries)?.pattern).toBe("example.com");
  });

  it("an entry scores its best matching pattern", () => {
    const multi = makeSiteLocation({ id: "multi", patterns: ["*.com", "www.example.com"] });
    const single = makeSiteLocation({ id: "single", patterns: ["*.example.com"] });
    const m = matchSiteLocation(URL_WWW, [single, multi]);
    expect(m?.entry.id).toBe("multi");
    expect(m?.pattern).toBe("www.example.com");
  });

  it("returns null when nothing matches", () => {
    expect(matchSiteLocation("https://other.org/", entriesFor(ORDER))).toBeNull();
    expect(matchSiteLocation("", entriesFor(ORDER))).toBeNull();
  });

  it("ties go to the higher updatedAt, regardless of order", () => {
    const older = makeSiteLocation({ id: "a", updatedAt: 1 });
    const newer = makeSiteLocation({ id: "b", updatedAt: 2 });
    expect(matchSiteLocation("https://example.com/", [older, newer])?.entry.id).toBe("b");
    expect(matchSiteLocation("https://example.com/", [newer, older])?.entry.id).toBe("b");
  });

  it("then to the lexicographically smaller id, regardless of order", () => {
    const x = makeSiteLocation({ id: "10", updatedAt: 5 });
    const y = makeSiteLocation({ id: "9", updatedAt: 5 });
    // Plain `<`: "10" < "9".
    expect(matchSiteLocation("https://example.com/", [x, y])?.entry.id).toBe("10");
    expect(matchSiteLocation("https://example.com/", [y, x])?.entry.id).toBe("10");
  });

  it("matches IDN patterns against A-label page URLs", () => {
    const entry = makeSiteLocation({ patterns: [parseSiteLocationPattern("MÜNCHEN.de")!] });
    expect(entry.patterns).toEqual(["münchen.de"]);
    expect(matchSiteLocation("https://xn--mnchen-3ya.de/", [entry])?.pattern).toBe("münchen.de");
    expect(matchSiteLocation("https://www.xn--mnchen-3ya.de/x", [entry])).not.toBeNull();
    expect(matchSiteLocation("https://muenchen.de/", [entry])).toBeNull();
  });
});

describe("suggestSiteLocationPattern", () => {
  it.each([
    ["https://www.twitch.tv/x", "twitch.tv"],
    ["https://chatgpt.com/c/123?x=1", "chatgpt.com"],
    ["https://www.com/", "www.com"],
    ["https://sub.www.example.com/", "sub.www.example.com"],
    ["http://localhost:3000/", "localhost"],
    ["http://192.168.1.10:8080/a", "192.168.1.10"],
    ["about:blank", null],
    ["not a url", null],
  ])("%s → %s", (url, expected) => {
    expect(suggestSiteLocationPattern(url)).toBe(expected);
  });
});

describe("siteLocationDisplayName", () => {
  it("prefers the label", () => {
    expect(siteLocationDisplayName(makeSiteLocation({ label: "Work" }))).toBe("Work");
  });

  it("falls back to the city, then the display name", () => {
    expect(siteLocationDisplayName(makeSiteLocation())).toBe("Dublin");
    expect(
      siteLocationDisplayName(
        makeSiteLocation({ locationName: { city: "", country: "IE", displayName: "Leinster" } })
      )
    ).toBe("Leinster");
  });

  it("falls back to coordinates to four decimals", () => {
    expect(siteLocationDisplayName(makeSiteLocation({ locationName: null }))).toBe(
      "53.3498, -6.2603"
    );
    expect(
      siteLocationDisplayName(
        makeSiteLocation({ locationName: { city: "", country: "", displayName: "" } })
      )
    ).toBe("53.3498, -6.2603");
  });
});

describe("validateSiteLocations", () => {
  const valid = makeSiteLocation();

  it("absent or non-array input gives []", () => {
    expect(validateSiteLocations(undefined)).toEqual([]);
    expect(validateSiteLocations(null)).toEqual([]);
    expect(validateSiteLocations({})).toEqual([]);
    expect(validateSiteLocations("[]")).toEqual([]);
  });

  it("keeps a valid entry unchanged", () => {
    expect(validateSiteLocations([valid])).toEqual([valid]);
  });

  it.each<[string, unknown]>([
    ["a non-object", 42],
    ["null", null],
    ["an empty id", { ...valid, id: "" }],
    ["a non-string id", { ...valid, id: 7 }],
    ["an id over 64 chars", { ...valid, id: "x".repeat(65) }],
    ["an unknown kind", { ...valid, kind: "proxy" }],
    ["a missing kind", { ...valid, kind: undefined }],
    ["latitude out of range", { ...valid, location: { ...valid.location, latitude: 91 } }],
    ["longitude out of range", { ...valid, location: { ...valid.location, longitude: -181 } }],
    ["a non-finite latitude", { ...valid, location: { ...valid.location, latitude: NaN } }],
    ["a missing location", { ...valid, location: null }],
    ["a missing timezone", { ...valid, timezone: null }],
    ["a fallback timezone", { ...valid, timezone: { ...DUBLIN_TZ, fallback: true } }],
    ["an invalid IANA id", { ...valid, timezone: { ...DUBLIN_TZ, identifier: "Not a zone" } }],
    ["a non-finite offset", { ...valid, timezone: { ...DUBLIN_TZ, offset: Infinity } }],
    ["non-array patterns", { ...valid, patterns: "example.com" }],
    ["no valid patterns", { ...valid, patterns: ["*", "example.com/path", 5] }],
    ["empty patterns", { ...valid, patterns: [] }],
  ])("drops an entry with %s", (_label, entry) => {
    expect(validateSiteLocations([entry])).toEqual([]);
  });

  it("strips a fallback: false key from the stored timezone", () => {
    const [out] = validateSiteLocations([
      { ...valid, timezone: { ...DUBLIN_TZ, fallback: false } },
    ]);
    expect(out.timezone).toEqual(DUBLIN_TZ);
    expect(out.timezone).not.toHaveProperty("fallback");
  });

  it("repairs accuracy to the default", () => {
    for (const accuracy of [0, -1, NaN, "45", undefined]) {
      const [out] = validateSiteLocations([
        { ...valid, location: { ...valid.location, accuracy } },
      ]);
      expect(out.location.accuracy).toBe(DEFAULT_ACCURACY_M);
    }
  });

  it("normalizes the label", () => {
    const label = (value: unknown) => validateSiteLocations([{ ...valid, label: value }])[0].label;
    expect(label("  Work  ")).toBe("Work");
    expect(label("   ")).toBeNull();
    expect(label("")).toBeNull();
    expect(label(42)).toBeNull();
    expect(label(undefined)).toBeNull();
    expect(label("x".repeat(150))).toBe("x".repeat(100));
  });

  it("normalizes locationName like the main location", () => {
    const name = (value: unknown) =>
      validateSiteLocations([{ ...valid, locationName: value }])[0].locationName;
    expect(name({ displayName: "Dublin" })).toEqual({
      city: "",
      country: "",
      displayName: "Dublin",
    });
    expect(name({ city: "Dublin" })).toBeNull();
    expect(name("Dublin")).toBeNull();
  });

  it("repairs updatedAt to 0", () => {
    for (const updatedAt of [-1, NaN, "1", undefined]) {
      expect(validateSiteLocations([{ ...valid, updatedAt }])[0].updatedAt).toBe(0);
    }
  });

  it("canonicalizes patterns and drops invalid and duplicate ones within an entry", () => {
    const [out] = validateSiteLocations([
      { ...valid, patterns: ["Twitch.TV", "twitch.tv", "bad/path", "https://Twitch.tv/"] },
    ]);
    expect(out.patterns).toEqual(["twitch.tv", "https://twitch.tv"]);
  });

  it("dedupes patterns across entries, first occurrence wins", () => {
    const a = makeSiteLocation({ id: "a", patterns: ["a.com", "shared.com"] });
    const b = makeSiteLocation({ id: "b", patterns: ["SHARED.com", "b.com"] });
    const c = makeSiteLocation({ id: "c", patterns: ["a.com"] });
    const out = validateSiteLocations([a, b, c]);
    expect(out.map((e) => [e.id, e.patterns])).toEqual([
      ["a", ["a.com", "shared.com"]],
      ["b", ["b.com"]],
    ]);
  });

  it("drops a duplicate id, keeping the first", () => {
    const a = makeSiteLocation({ id: "same", patterns: ["a.com"] });
    const b = makeSiteLocation({ id: "same", patterns: ["b.com"] });
    expect(validateSiteLocations([a, b])).toEqual([a]);
  });

  it("a dropped entry claims neither its id nor its patterns", () => {
    const bad = { ...makeSiteLocation({ id: "x", patterns: ["a.com"] }), kind: "proxy" };
    const good = makeSiteLocation({ id: "x", patterns: ["a.com"] });
    expect(validateSiteLocations([bad, good])).toEqual([good]);
  });

  it(`caps patterns at ${MAX_PATTERNS_PER_SITE_LOCATION}`, () => {
    const patterns = Array.from({ length: 12 }, (_, i) => `site${i}.com`);
    const [out] = validateSiteLocations([{ ...valid, patterns }]);
    expect(out.patterns).toEqual(patterns.slice(0, MAX_PATTERNS_PER_SITE_LOCATION));
  });

  it(`caps the list at ${MAX_SITE_LOCATIONS}, preserving order`, () => {
    const list = Array.from({ length: MAX_SITE_LOCATIONS + 3 }, (_, i) =>
      makeSiteLocation({ id: String(i), patterns: [`site${i}.com`] })
    );
    const out = validateSiteLocations(list);
    expect(out).toHaveLength(MAX_SITE_LOCATIONS);
    expect(out.map((e) => e.id)).toEqual(list.slice(0, MAX_SITE_LOCATIONS).map((e) => e.id));
  });
});

describe("resolveSiteSettings", () => {
  it("applies the matching entry's location, timezone, and name, and nothing else", () => {
    const settings = makeSettings({ webrtcProtection: true, localeSpoofing: { mode: "match" } });
    const r = resolveSiteSettings(settings, "https://chatgpt.com/c/1", isRestrictedUrl);
    expect(r.enabled).toBe(true);
    expect(r.siteLocation).toBe(ENTRY_DUBLIN);
    expect(r.matchedPattern).toBe("chatgpt.com");
    expect(r.settings).not.toBe(settings);
    expect(r.settings).toEqual({
      ...settings,
      location: ENTRY_DUBLIN.location,
      timezone: ENTRY_DUBLIN.timezone,
      locationName: ENTRY_DUBLIN.locationName,
    });
  });

  it("returns the same reference when nothing matches", () => {
    const settings = makeSettings();
    const r = resolveSiteSettings(settings, "https://example.org/", isRestrictedUrl);
    expect(r).toEqual({ enabled: true, siteLocation: null, matchedPattern: null, settings });
    expect(r.settings).toBe(settings);
  });

  it("master off: disabled, same reference, no entry", () => {
    const settings = makeSettings({ enabled: false });
    const r = resolveSiteSettings(settings, "https://chatgpt.com/", isRestrictedUrl);
    expect(r.enabled).toBe(false);
    expect(r.siteLocation).toBeNull();
    expect(r.settings).toBe(settings);
  });

  it.each(["about:blank", "https://addons.mozilla.org/", "file:///tmp/x.html"])(
    "restricted URL %s: disabled, same reference",
    (url) => {
      const settings = makeSettings({ siteLocations: [makeSiteLocation({ patterns: ["*.org"] })] });
      const r = resolveSiteSettings(settings, url, isRestrictedUrl);
      expect(r.enabled).toBe(false);
      expect(r.settings).toBe(settings);
    }
  );

  it("no URL: disabled, same reference", () => {
    const settings = makeSettings();
    const r = resolveSiteSettings(settings, undefined, isRestrictedUrl);
    expect(r.enabled).toBe(false);
    expect(r.settings).toBe(settings);
  });

  it("scope all: a match applies everywhere it matches", () => {
    const settings = makeSettings({ scopeMode: "all" });
    expect(
      resolveSiteSettings(settings, "https://www.twitch.tv/x", isRestrictedUrl).siteLocation
    ).toBe(ENTRY_MEXICO_CITY);
  });

  it("allowlist: applies only to allowlisted sites", () => {
    const settings = makeSettings({ scopeMode: "allowlist", allowlist: ["twitch.tv"] });
    const inScope = resolveSiteSettings(settings, "https://twitch.tv/", isRestrictedUrl);
    expect(inScope.enabled).toBe(true);
    expect(inScope.siteLocation).toBe(ENTRY_MEXICO_CITY);

    const outOfScope = resolveSiteSettings(settings, "https://chatgpt.com/", isRestrictedUrl);
    expect(outOfScope.enabled).toBe(false);
    expect(outOfScope.siteLocation).toBeNull();
    expect(outOfScope.settings).toBe(settings);
  });

  it("denylist: never applies to a denied site", () => {
    const settings = makeSettings({ scopeMode: "denylist", denylist: ["chatgpt.com"] });
    const denied = resolveSiteSettings(settings, "https://chatgpt.com/", isRestrictedUrl);
    expect(denied.enabled).toBe(false);
    expect(denied.siteLocation).toBeNull();
    expect(denied.settings).toBe(settings);

    const allowed = resolveSiteSettings(settings, "https://openai.com/", isRestrictedUrl);
    expect(allowed.enabled).toBe(true);
    expect(allowed.siteLocation).toBe(ENTRY_DUBLIN);
  });

  it("an unvalidated non-array siteLocations is treated as empty", () => {
    const settings = makeSettings({ siteLocations: "junk" as unknown as SiteLocation[] });
    const r = resolveSiteSettings(settings, "https://chatgpt.com/", isRestrictedUrl);
    expect(r.enabled).toBe(true);
    expect(r.settings).toBe(settings);
  });
});

describe("resolveSiteSettings — Safari Pro gate (vi.mock'd)", () => {
  beforeEach(() => {
    safariGate.on = true;
  });
  afterEach(() => {
    safariGate.on = false;
  });

  it("a non-Pro Safari user gets the main location on a matching site", () => {
    const settings = makeSettings({ proFeaturesBlocked: true });
    const r = resolveSiteSettings(settings, "https://chatgpt.com/", isRestrictedUrl);
    expect(r.enabled).toBe(true);
    expect(r.siteLocation).toBeNull();
    expect(r.settings).toBe(settings);
    // The stored list is untouched, so re-subscribing restores it.
    expect(settings.siteLocations).toEqual([ENTRY_DUBLIN, ENTRY_MEXICO_CITY]);
  });

  it("a Pro (or unflagged) user still gets the site location", () => {
    const settings = makeSettings({ proFeaturesBlocked: false });
    const r = resolveSiteSettings(settings, "https://chatgpt.com/", isRestrictedUrl);
    expect(r.siteLocation).toBe(ENTRY_DUBLIN);
  });
});
