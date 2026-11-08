/**
 * Per-site locations against Filters: the S4 relation, the per-pattern
 * outcome and the row mark (a port of the app's `SiteLocationFiltersCheck`,
 * in the order of direction.md section 7, M2), and the deciding Filters entry
 * (evaluation.md 8.5.3).
 */
import { describe, it, expect } from "vitest";
import type { ScopeMode } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import { createSiteGroupLookup, frameEntries, NO_SITE_GROUPS } from "@/shared/site-groups/matcher";
import { parseFilterEntry, parseSiteLocationEntry } from "@/shared/utils/filter-entries";
import {
  filterEntryRelation,
  filterProbeUrl,
  findDecidingFilterEntry,
  siteFilterOutcome,
  siteLocationFiltersMark,
  type SiteFilterOutcome,
} from "@/shared/utils/site-locations";

const GROUPS = createSiteGroupLookup({
  "geosite:google": {
    d: frameEntries(["google.com", "youtube.com"]),
    f: frameEntries([]),
    n: 964,
  },
  "geosite:twitch": { d: frameEntries(["twitch.tv", "ttvnw.net"]), f: frameEntries([]), n: 12 },
  "geosite:video": {
    d: frameEntries(["twitch.tv", "youtube.com", "vimeo.com"]),
    f: frameEntries([]),
    n: 300,
  },
});

/** Canonicalize a Filters entry the way the background stores it; fail loudly when it isn't one. */
function entry(raw: string): string {
  const parsed = parseFilterEntry(raw);
  if (parsed === null) throw new Error(`not a Filters entry: ${raw}`);
  return parsed;
}

/** Canonicalize a per-site location pattern; fail loudly when it isn't one. */
function site(raw: string): string {
  const parsed = parseSiteLocationEntry(raw);
  if (parsed === null) throw new Error(`not a per-site location pattern: ${raw}`);
  return parsed;
}

function args(mode: ScopeMode, list: string[], other: string[] = []) {
  return {
    scopeMode: mode,
    allowlist: mode === "denylist" ? other.map(entry) : list.map(entry),
    denylist: mode === "denylist" ? list.map(entry) : other.map(entry),
    siteGroups: GROUPS,
  };
}

interface Row {
  name: string;
  mode: "allowlist" | "denylist";
  list: string[];
  sites: string[];
  /** One TS outcome per site, in order. */
  expected: SiteFilterOutcome[];
}

const allow = (name: string, list: string[], sites: string[], expected: SiteFilterOutcome[]) => ({
  name,
  mode: "allowlist" as const,
  list,
  sites,
  expected,
});
const deny = (name: string, list: string[], sites: string[], expected: SiteFilterOutcome[]) => ({
  name,
  mode: "denylist" as const,
  list,
  sites,
  expected,
});

/**
 * The 51 rows of geospoof-ios `SiteLocationFiltersHintTests.swift`, in order.
 * Swift's hints map to outcomes: `allowlistNone` and `denylistCovered` →
 * "off"; `allowlistPartial` and `denylistPartial` → "somePages"; a site with
 * no hint → "on", or "skipped" where the TS check doesn't look (a wildcard
 * host such as `*.twitch.tv`, which has no probe URL, and a host with no
 * A-label form). Every raw Swift input is a valid canonical TS entry or
 * pattern (`entry()` and `site()` throw otherwise), so no row is omitted.
 */
const SWIFT_ROWS: Row[] = [
  // Schemes: unset is http + https, explicit is that one, * is any.
  allow("unset covers unset", ["example.com"], ["example.com"], ["on"]),
  allow("unset covers http", ["example.com"], ["http://example.com"], ["on"]),
  allow("unset covers https", ["example.com"], ["https://example.com"], ["on"]),
  allow(
    "https reaches only part of unset",
    ["https://example.com"],
    ["example.com"],
    ["somePages"]
  ),
  allow("http misses https", ["http://example.com"], ["https://example.com"], ["off"]),
  allow("https covers https", ["https://example.com"], ["https://example.com"], ["on"]),
  allow("* covers https", ["*://example.com"], ["https://example.com"], ["on"]),
  allow("* covers *", ["*://example.com"], ["*://example.com"], ["on"]),
  allow("unset reaches only part of *", ["example.com"], ["*://example.com"], ["somePages"]),
  allow("http reaches only part of *", ["http://example.com"], ["*://example.com"], ["somePages"]),

  // Hosts.
  // Swift: no hint (covered). TS skips a wildcard-host site: there's no URL to probe.
  allow("apex covers *.L", ["twitch.tv"], ["*.twitch.tv"], ["skipped"]),
  allow("*.L misses the apex", ["*.twitch.tv"], ["twitch.tv"], ["somePages"]),
  allow("apex covers a deeper subdomain", ["twitch.tv"], ["a.clips.twitch.tv"], ["on"]),
  // Swift: no hint (covered). Skipped in TS, as above.
  allow("*.L covers a deeper *.", ["*.twitch.tv"], ["*.clips.twitch.tv"], ["skipped"]),
  allow(
    "a subdomain entry reaches part of the apex",
    ["clips.twitch.tv"],
    ["twitch.tv"],
    ["somePages"]
  ),
  allow("*.tv covers twitch.tv", ["*.tv"], ["twitch.tv"], ["on"]),
  allow("witch.tv doesn't contain twitch.tv", ["witch.tv"], ["twitch.tv"], ["off"]),
  allow("twitch.tv doesn't contain witch.tv", ["twitch.tv"], ["witch.tv"], ["off"]),
  allow(
    "* covers anything",
    ["*"],
    ["twitch.tv", "127.0.0.1", "localhost:3000"],
    ["on", "on", "on"]
  ),

  // IPv4 matches exactly.
  allow("IPv4 covers itself", ["127.0.0.1"], ["127.0.0.1"], ["on"]),
  allow("IPv4 misses another", ["127.0.0.2"], ["127.0.0.1"], ["off"]),
  allow("*.IPv4 misses the literal", ["*.127.0.0.1"], ["127.0.0.1"], ["off"]),

  // Ports: unset is any.
  allow("a port reaches only part of any port", ["localhost:3000"], ["localhost"], ["somePages"]),
  allow("any port covers a port", ["localhost"], ["localhost:3000"], ["on"]),
  allow("the same port covers", ["localhost:3000"], ["localhost:3000"], ["on"]),
  allow("another port misses", ["localhost:3000"], ["localhost:8080"], ["off"]),

  // Paths: an entry with a path reaches part of the site; /* is every path.
  allow("a path entry is partial", ["twitch.tv/videos/*"], ["twitch.tv"], ["somePages"]),
  allow("/* covers", ["twitch.tv/*"], ["twitch.tv"], ["on"]),
  allow("a path doesn't rescue a host mismatch", ["witch.tv/*"], ["twitch.tv"], ["off"]),
  allow(
    "a covering entry beats a partial one",
    ["twitch.tv/videos/*", "twitch.tv"],
    ["twitch.tv"],
    ["on"]
  ),

  // IDN: both sides are compared as A-labels.
  allow("an A-label entry covers its U-label site", ["xn--mnchen-3ya.de"], ["münchen.de"], ["on"]),
  allow("a U-label entry covers its A-label site", ["münchen.de"], ["xn--mnchen-3ya.de"], ["on"]),
  allow("identical U-labels cover", ["münchen.de"], ["münchen.de"], ["on"]),
  allow(
    "a U-label apex covers a subdomain across forms",
    ["münchen.de"],
    ["shop.xn--mnchen-3ya.de"],
    ["on"]
  ),
  allow(
    "an A-label path entry is partial for its U-label site",
    ["xn--mnchen-3ya.de/x/*"],
    ["münchen.de"],
    ["somePages"]
  ),
  allow(
    "a fullwidth entry covers the site it maps to",
    ["ｔｗｉｔｃｈ.ｔｖ"],
    ["twitch.tv"],
    ["on"]
  ),
  allow("a mapped full stop splits labels as the compiler does", ["*.b.com"], ["a。b.com"], ["on"]),
  allow("different IDN hosts don't meet", ["xn--bcher-kva.example"], ["münchen.de"], ["off"]),
  allow("an entry with no A-label form matches nothing", ["xn--zz.de"], ["münchen.de"], ["off"]),
  allow("a site with no A-label form gets no hint", [], ["xn--zz.de"], ["skipped"]),
  deny("the denylist covers across IDN forms", ["xn--mnchen-3ya.de"], ["münchen.de"], ["off"]),

  // Empty lists.
  allow("an empty allowlist spoofs nothing", [], ["twitch.tv"], ["off"]),
  deny("an empty denylist blocks nothing", [], ["twitch.tv"], ["on"]),

  // Denylist.
  deny("a denylisted site", ["twitch.tv"], ["twitch.tv"], ["off"]),
  deny("a denylisted path", ["twitch.tv/videos/*"], ["twitch.tv"], ["somePages"]),
  deny("denylisted subdomains", ["*.twitch.tv"], ["twitch.tv"], ["somePages"]),
  deny("an unrelated denylist entry", ["kick.com"], ["twitch.tv"], ["on"]),
  deny("witch.tv on the denylist doesn't block twitch.tv", ["witch.tv"], ["twitch.tv"], ["on"]),

  // Several sites.
  allow("device test 11", ["twitch.tv"], ["twitch.tv", "kick.com"], ["on", "off"]),
  allow(
    "mixed allowlist",
    ["twitch.tv", "*.example.com"],
    ["example.com", "kick.com", "twitch.tv", "a.org"],
    ["somePages", "off", "on", "off"]
  ),
  deny(
    "mixed denylist",
    ["*.kick.com", "twitch.tv"],
    ["kick.com", "twitch.tv"],
    ["somePages", "off"]
  ),
];

describe("siteFilterOutcome: the app's 51 Site Filters hint rows", () => {
  it("ports every row", () => {
    expect(SWIFT_ROWS).toHaveLength(51);
  });

  it.each(SWIFT_ROWS.map((row) => [row.name, row] as const))("%s", (_name, row) => {
    const a = args(row.mode, row.list);
    expect(row.sites.map((s) => siteFilterOutcome(site(s), a))).toEqual(row.expected);
  });

  it("marks several sites by their strongest outcome, naming the hosts", () => {
    const rows = Object.fromEntries(SWIFT_ROWS.map((row) => [row.name, row]));
    const mark = (row: Row) =>
      siteLocationFiltersMark(row.sites.map(site), args(row.mode, row.list));
    expect(mark(rows["device test 11"])).toEqual({
      kind: "off",
      hosts: ["kick.com"],
      single: false,
    });
    expect(mark(rows["mixed allowlist"])).toEqual({
      kind: "off",
      hosts: ["kick.com", "a.org"],
      single: false,
    });
    expect(mark(rows["mixed denylist"])).toEqual({
      kind: "off",
      hosts: ["twitch.tv"],
      single: false,
    });
    expect(mark(rows["a path entry is partial"])).toEqual({
      kind: "somePages",
      hosts: ["twitch.tv"],
      single: true,
    });
    expect(mark(rows["unset covers unset"])).toEqual({ kind: "none" });
  });
});

describe("filterEntryRelation", () => {
  it("treats an exact address as that host only", () => {
    expect(filterEntryRelation(entry("=twitch.tv"), site("twitch.tv"))).toBe("intersects");
    expect(filterEntryRelation(entry("twitch.tv"), site("=twitch.tv"))).toBe("covers");
    expect(filterEntryRelation(entry("=a.b.com"), site("=a.b.com"))).toBe("covers");
    expect(filterEntryRelation(entry("=www.twitch.tv"), site("twitch.tv"))).toBe("intersects");
    expect(filterEntryRelation(entry("=twitch.tv"), site("*.twitch.tv"))).toBe("disjoint");
    expect(filterEntryRelation(entry("=a.b.com"), site("=c.b.com"))).toBe("disjoint");
    expect(filterEntryRelation(entry("*.b.com"), site("=a.b.com"))).toBe("covers");
  });

  it("leaves site groups and links to the probe", () => {
    expect(filterEntryRelation("geosite:twitch", site("twitch.tv"))).toBe("disjoint");
    expect(filterEntryRelation(entry("twitch.tv"), "geosite:twitch")).toBe("disjoint");
  });
});

describe("filterProbeUrl", () => {
  it("builds a URL for a typed pattern", () => {
    expect(filterProbeUrl("example.com")).toBe("https://example.com/");
    expect(filterProbeUrl("=mail.example.com")).toBe("https://mail.example.com/");
    expect(filterProbeUrl("http://example.com:8080")).toBe("http://example.com:8080/");
    expect(filterProbeUrl("*://example.com")).toBe("https://example.com/");
    expect(filterProbeUrl("münchen.de")).toBe("https://xn--mnchen-3ya.de/");
    expect(filterProbeUrl("127.0.0.1")).toBe("https://127.0.0.1/");
  });

  it("is null for tokens, wildcard hosts and hosts without an A-label form", () => {
    expect(filterProbeUrl("geosite:google")).toBeNull();
    expect(filterProbeUrl("*.example.com")).toBeNull();
    expect(filterProbeUrl("*")).toBeNull();
    expect(filterProbeUrl("xn--zz.de")).toBeNull();
  });
});

describe("siteFilterOutcome", () => {
  it("never marks in All sites mode", () => {
    const a = {
      scopeMode: "all" as const,
      allowlist: [],
      denylist: ["twitch.tv"],
      siteGroups: GROUPS,
    };
    expect(siteFilterOutcome("twitch.tv", a)).toBe("skipped");
    expect(siteLocationFiltersMark(["twitch.tv"], a)).toEqual({ kind: "none" });
  });

  it("reads only the active list", () => {
    expect(siteFilterOutcome("twitch.tv", args("allowlist", ["twitch.tv"], ["twitch.tv"]))).toBe(
      "on"
    );
    expect(siteFilterOutcome("twitch.tv", args("denylist", ["kick.com"], []))).toBe("on");
    expect(siteFilterOutcome("twitch.tv", args("denylist", [], ["kick.com"]))).toBe("on");
  });

  it("answers site groups through the probe", () => {
    expect(siteFilterOutcome("twitch.tv", args("allowlist", ["geosite:twitch"]))).toBe("on");
    expect(siteFilterOutcome("twitch.tv", args("allowlist", ["geosite:google"]))).toBe("off");
    expect(siteFilterOutcome("twitch.tv", args("denylist", ["geosite:twitch"]))).toBe("off");
    // Without the group's data the token matches nothing.
    expect(
      siteFilterOutcome("twitch.tv", {
        ...args("allowlist", ["geosite:twitch"]),
        siteGroups: NO_SITE_GROUPS,
      })
    ).toBe("off");
  });

  it("skips tokens and wildcard hosts", () => {
    expect(siteFilterOutcome("geosite:google", args("allowlist", []))).toBe("skipped");
    expect(siteFilterOutcome("*.ru", args("allowlist", []))).toBe("skipped");
  });

  it("forces Location Protection on: a listed site is on while protection is off", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      enabled: false,
      scopeMode: "allowlist" as const,
      allowlist: ["example.com"],
    };
    expect(siteFilterOutcome("example.com", { ...settings, siteGroups: GROUPS })).toBe("on");
  });
});

describe("siteLocationFiltersMark (M13)", () => {
  it("names the hosts of a shared entry, and skips its tokens", () => {
    const mark = siteLocationFiltersMark(
      ["twitch.tv", "geosite:google"],
      args("allowlist", ["geosite:google"])
    );
    expect(mark).toEqual({ kind: "off", hosts: ["twitch.tv"], single: false });
  });

  it("is single only for a one-pattern entry", () => {
    expect(siteLocationFiltersMark(["twitch.tv"], args("allowlist", []))).toEqual({
      kind: "off",
      hosts: ["twitch.tv"],
      single: true,
    });
    expect(
      siteLocationFiltersMark(["twitch.tv", "kick.com"], args("allowlist", ["kick.com"]))
    ).toEqual({
      kind: "off",
      hosts: ["twitch.tv"],
      single: false,
    });
  });

  it("shows display hosts, de-duplicated, with off winning over some pages", () => {
    const mark = siteLocationFiltersMark(
      ["http://a.com", "https://a.com", "=b.com", "c.com"],
      args("allowlist", ["c.com/x/*"])
    );
    expect(mark).toEqual({ kind: "off", hosts: ["a.com", "b.com"], single: false });
    expect(
      siteLocationFiltersMark(["c.com", "d.com"], args("allowlist", ["c.com/x/*", "d.com"]))
    ).toEqual({ kind: "somePages", hosts: ["c.com"], single: false });
  });
});

describe("findDecidingFilterEntry", () => {
  const decide = (mode: ScopeMode, list: string[], url: string, groups = GROUPS) =>
    findDecidingFilterEntry({
      scopeMode: mode,
      allowlist: mode === "allowlist" ? list : [],
      denylist: mode === "denylist" ? list : [],
      topLevelUrl: url,
      siteGroups: groups,
    });

  it("prefers more labels (M12)", () => {
    expect(decide("allowlist", ["twitch.tv", "*.tv"], "https://twitch.tv/")).toBe("twitch.tv");
    expect(decide("allowlist", ["*.tv", "twitch.tv"], "https://twitch.tv/")).toBe("twitch.tv");
    expect(decide("allowlist", ["twitch.tv", "www.twitch.tv"], "https://www.twitch.tv/")).toBe(
      "www.twitch.tv"
    );
    expect(decide("allowlist", ["*.tv"], "https://twitch.tv/")).toBe("*.tv");
    expect(decide("denylist", ["twitch.tv", "*.tv"], "https://twitch.tv/")).toBe("twitch.tv");
  });

  it("then exact, then wildcard, then plain, at equal labels", () => {
    expect(
      decide("allowlist", ["mail.example.com", "=mail.example.com"], "https://mail.example.com/")
    ).toBe("=mail.example.com");
    // `*.b.com` and `b.com` both have two labels; the wildcard ranks higher.
    expect(decide("allowlist", ["b.com", "*.b.com"], "https://a.b.com/")).toBe("*.b.com");
    expect(decide("allowlist", ["a.b.com", "*.b.com"], "https://x.a.b.com/")).toBe("a.b.com");
    expect(decide("allowlist", ["c.d.e", "*.d.e"], "https://c.d.e/")).toBe("c.d.e");
    expect(decide("allowlist", ["b.c.d", "*.c.d"], "https://a.b.c.d/")).toBe("b.c.d");
  });

  it("puts an entry with a path or a port before the same host without one", () => {
    expect(decide("allowlist", ["twitch.tv", "twitch.tv/*"], "https://twitch.tv/x")).toBe(
      "twitch.tv/*"
    );
    expect(decide("allowlist", ["localhost", "localhost:3000"], "http://localhost:3000/")).toBe(
      "localhost:3000"
    );
  });

  it("puts typed entries before tokens, and the smaller group first", () => {
    expect(decide("allowlist", ["geosite:twitch", "*.tv"], "https://twitch.tv/")).toBe("*.tv");
    expect(decide("allowlist", ["geosite:video", "geosite:twitch"], "https://twitch.tv/")).toBe(
      "geosite:twitch"
    );
    expect(decide("allowlist", ["geosite:twitch", "geosite:video"], "https://twitch.tv/")).toBe(
      "geosite:twitch"
    );
  });

  it("keeps list order on equal ranks", () => {
    expect(decide("allowlist", ["*://twitch.tv", "https://twitch.tv"], "https://twitch.tv/")).toBe(
      "*://twitch.tv"
    );
    expect(decide("allowlist", ["https://twitch.tv", "*://twitch.tv"], "https://twitch.tv/")).toBe(
      "https://twitch.tv"
    );
  });

  it("is null in All mode, without a hostname, and when nothing matches", () => {
    expect(decide("all", ["twitch.tv"], "https://twitch.tv/")).toBeNull();
    expect(decide("allowlist", ["twitch.tv"], "about:blank")).toBeNull();
    expect(decide("allowlist", ["twitch.tv"], "not a url")).toBeNull();
    expect(decide("allowlist", ["kick.com", "geosite:google"], "https://twitch.tv/")).toBeNull();
    expect(decide("allowlist", [], "https://twitch.tv/")).toBeNull();
  });

  it("reads only the active list", () => {
    expect(
      findDecidingFilterEntry({
        scopeMode: "allowlist",
        allowlist: [],
        denylist: ["twitch.tv"],
        topLevelUrl: "https://twitch.tv/",
        siteGroups: GROUPS,
      })
    ).toBeNull();
  });
});
