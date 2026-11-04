import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  NO_SITE_GROUPS,
  createSiteGroupLookup,
  frameEntries,
  hostInGroupStrings,
  unionGroupStrings,
} from "@/shared/site-groups/matcher";

const D = frameEntries(["google.com", "cn", "youtube.com"]);
const F = frameEntries(["fonts.gstatic.com"]);

describe("frameEntries", () => {
  it("frames entries with newlines on both sides", () => {
    expect(frameEntries(["a.com", "b.com"])).toBe("\na.com\nb.com\n");
    expect(frameEntries([])).toBe("\n");
  });
});

describe("hostInGroupStrings", () => {
  it.each([
    ["google.com", true],
    ["www.google.com", true],
    ["a.b.c.google.com", true],
    ["notgoogle.com", false],
    ["google.com.evil.net", false],
    ["google", false],
    ["a.b.cn", true],
    ["cn", true],
    ["cnn.com", false],
    ["fonts.gstatic.com", true],
    ["x.fonts.gstatic.com", false],
    ["gstatic.com", false],
    ["www.google.com.", false],
    ["example.cn.", false],
    ["[::1]", false],
    ["", false],
  ])("%s → %s", (host, expected) => {
    expect(hostInGroupStrings(D, F, host)).toBe(expected);
  });

  it("matches nothing with empty data", () => {
    expect(hostInGroupStrings("\n", "\n", "google.com")).toBe(false);
    expect(hostInGroupStrings("", "", "google.com")).toBe(false);
  });
});

describe("createSiteGroupLookup", () => {
  const lookup = createSiteGroupLookup({
    "geosite:google": { d: D, f: F, n: 4 },
    "geosite:empty": { d: "\n", f: "\n", n: 0 },
  });

  it("answers has() like the string form", () => {
    expect(lookup.has("geosite:google", "www.google.com")).toBe(true);
    expect(lookup.has("geosite:google", "fonts.gstatic.com")).toBe(true);
    expect(lookup.has("geosite:google", "x.fonts.gstatic.com")).toBe(false);
    expect(lookup.has("geosite:google", "")).toBe(false);
    expect(lookup.has("geosite:empty", "google.com")).toBe(false);
  });

  it("an unknown token matches nothing and has no size", () => {
    expect(lookup.has("geosite:netflix", "netflix.com")).toBe(false);
    expect(lookup.size("geosite:netflix")).toBeUndefined();
    expect(lookup.has("constructor", "google.com")).toBe(false);
    expect(lookup.size("toString")).toBeUndefined();
  });

  it("reports the stored size", () => {
    expect(lookup.size("geosite:google")).toBe(4);
    expect(lookup.size("geosite:empty")).toBe(0);
  });

  it("NO_SITE_GROUPS matches nothing", () => {
    expect(NO_SITE_GROUPS.has("geosite:google", "google.com")).toBe(false);
    expect(NO_SITE_GROUPS.size("geosite:google")).toBeUndefined();
  });

  it("agrees with hostInGroupStrings on random hosts and lists (property)", () => {
    const label = fc.constantFrom("a", "b", "c", "cn", "com", "x-y", "1");
    const host = fc.array(label, { minLength: 1, maxLength: 4 }).map((l) => l.join("."));
    fc.assert(
      fc.property(
        fc.array(host, { maxLength: 8 }),
        fc.array(host, { maxLength: 8 }),
        fc.array(
          fc.oneof(
            host,
            host.map((h) => `${h}.`),
            fc.constant("")
          ),
          { maxLength: 10 }
        ),
        (domains, fulls, hosts) => {
          const d = frameEntries(domains);
          const f = frameEntries(fulls);
          const l = createSiteGroupLookup({ t: { d, f, n: domains.length + fulls.length } });
          return hosts.every((h) => l.has("t", h) === hostInGroupStrings(d, f, h));
        }
      )
    );
  });
});

describe("unionGroupStrings", () => {
  const groups = {
    a: { d: frameEntries(["x.com", "y.com"]), f: frameEntries(["f.x.com"]) },
    b: { d: frameEntries(["y.com", "z.com"]), f: frameEntries([]) },
  };

  it("is null when no token has data", () => {
    expect(unionGroupStrings(groups, [])).toBeNull();
    expect(unionGroupStrings(groups, ["missing"])).toBeNull();
  });

  it("returns one token's strings as they are", () => {
    expect(unionGroupStrings(groups, ["a", "missing", "a"])).toEqual(groups.a);
  });

  it("dedupes the union in first-seen order", () => {
    expect(unionGroupStrings(groups, ["a", "b"])).toEqual({
      d: "\nx.com\ny.com\nz.com\n",
      f: "\nf.x.com\n",
    });
  });

  it("matches a host in any of the tokens", () => {
    const u = unionGroupStrings(groups, ["a", "b"])!;
    expect(hostInGroupStrings(u.d, u.f, "www.z.com")).toBe(true);
    expect(hostInGroupStrings(u.d, u.f, "f.x.com")).toBe(true);
    expect(hostInGroupStrings(u.d, u.f, "q.com")).toBe(false);
  });
});
