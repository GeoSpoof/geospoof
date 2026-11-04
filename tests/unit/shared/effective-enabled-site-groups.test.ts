import { describe, it, expect } from "vitest";
import { computeEffectiveEnabled } from "@/shared/utils/scope";
import { createSiteGroupLookup, frameEntries } from "@/shared/site-groups/matcher";

/**
 * Filters take the union of typed entries and site group tokens: in Allowlist
 * mode a URL is on when any typed entry matches or any group holds its host;
 * in Denylist mode it is off on the same condition. A token whose data is
 * missing matches nothing.
 */

const lookup = createSiteGroupLookup({
  "geosite:google": { d: frameEntries(["google.com", "youtube.com"]), f: frameEntries([]), n: 2 },
  "list:https://example.org/a.txt": {
    d: frameEntries([]),
    f: frameEntries(["exact.example.net"]),
    n: 1,
  },
});

function enabled(
  scopeMode: "all" | "allowlist" | "denylist",
  list: string[],
  url: string,
  withGroups = true
): boolean {
  return computeEffectiveEnabled({
    masterEnabled: true,
    scopeMode,
    allowlist: scopeMode === "allowlist" ? list : [],
    denylist: scopeMode === "denylist" ? list : [],
    topLevelUrl: url,
    isRestricted: () => false,
    ...(withGroups ? { siteGroups: lookup } : {}),
  });
}

describe("computeEffectiveEnabled with site groups", () => {
  it("allowlist: a host in a listed group is on", () => {
    expect(enabled("allowlist", ["geosite:google"], "https://www.youtube.com/watch")).toBe(true);
    expect(enabled("allowlist", ["geosite:google"], "https://bing.com/")).toBe(false);
  });

  it("denylist: a host in a listed group is off", () => {
    expect(enabled("denylist", ["geosite:google"], "https://www.youtube.com/watch")).toBe(false);
    expect(enabled("denylist", ["geosite:google"], "https://bing.com/")).toBe(true);
  });

  it("a link's full entry matches that host only", () => {
    const list = ["list:https://example.org/a.txt"];
    expect(enabled("allowlist", list, "https://exact.example.net/")).toBe(true);
    expect(enabled("allowlist", list, "https://www.exact.example.net/")).toBe(false);
  });

  it("typed and group entries mix as a union", () => {
    const list = ["bing.com", "geosite:google", "=mail.example.com"];
    expect(enabled("allowlist", list, "https://www.bing.com/")).toBe(true);
    expect(enabled("allowlist", list, "https://google.com/")).toBe(true);
    expect(enabled("allowlist", list, "https://mail.example.com/")).toBe(true);
    expect(enabled("allowlist", list, "https://www.mail.example.com/")).toBe(false);
    expect(enabled("allowlist", list, "https://duckduckgo.com/")).toBe(false);
    expect(enabled("denylist", list, "https://www.bing.com/")).toBe(false);
    expect(enabled("denylist", list, "https://google.com/")).toBe(false);
    expect(enabled("denylist", list, "https://duckduckgo.com/")).toBe(true);
  });

  it("an unknown token matches nothing", () => {
    expect(enabled("allowlist", ["geosite:netflix"], "https://netflix.com/")).toBe(false);
    expect(enabled("denylist", ["geosite:netflix"], "https://netflix.com/")).toBe(true);
  });

  it("without a lookup, every token matches nothing", () => {
    expect(enabled("allowlist", ["geosite:google"], "https://google.com/", false)).toBe(false);
    expect(enabled("denylist", ["geosite:google"], "https://google.com/", false)).toBe(true);
    expect(enabled("allowlist", ["google.com"], "https://google.com/", false)).toBe(true);
  });

  it("all mode ignores the lists", () => {
    expect(enabled("all", ["geosite:google"], "https://google.com/")).toBe(true);
  });

  it("a trailing-dot host matches no group", () => {
    expect(enabled("allowlist", ["geosite:google"], "https://google.com./")).toBe(false);
  });
});
