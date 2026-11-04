import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  classifyFilterEntry,
  detectEntryKind,
  isTypedEntry,
  normalizeInputForKind,
  parseFilterEntry,
  parseSiteLocationEntry,
  type EntryInputKind,
} from "@/shared/utils/filter-entries";
import {
  matchesPattern,
  matchesPatternList,
  parsePattern,
  patternToInit,
} from "@/shared/utils/scope";
import { parseSiteLocationPattern, siteLocationEntryKey } from "@/shared/utils/site-locations";
import patternVectors from "../../fixtures/pattern-vectors.json";

describe("parseFilterEntry with no kind", () => {
  it.each([
    ["geosite:Google@CN", "geosite:google@cn"],
    ["list:https://example.org/a.txt", "list:https://example.org/a.txt"],
    ["=Example.com", "=example.com"],
    ["= example.com", "=example.com"],
    ["=1.2.3.4", "1.2.3.4"],
    ["=https://example.com/a/*", "=https://example.com/a/*"],
    ["=*://example.com", "=*://example.com"],
    ["example.com", "example.com"],
    ["https://example.org/a.txt", "https://example.org/a.txt"],
  ])("%s → %s", (input, expected) => {
    expect(parseFilterEntry(input)).toBe(expected);
  });

  it.each([
    "=*",
    "=*.example.com",
    "=https://*.example.com",
    "=",
    "==example.com",
    "geosite:",
    "list:",
  ])("rejects %s", (input) => {
    expect(parseFilterEntry(input)).toBeNull();
  });

  it("agrees with parsePattern on every typed pattern vector", () => {
    const all = [...patternVectors.valid, ...patternVectors.invalid] as {
      input: string;
      expected: string | null;
    }[];
    for (const { input } of all) {
      if (/^\s*(=|geosite:|list:)/i.test(input)) continue;
      expect(parseFilterEntry(input)).toBe(parsePattern(input));
    }
  });
});

describe("parseFilterEntry with a kind", () => {
  it.each<[string, EntryInputKind, string | null]>([
    ["example.com", "site", "example.com"],
    ["*.example.com", "site", "example.com"],
    ["=example.com", "site", "example.com"],
    ["https://*.example.com", "site", "https://*.example.com"],
    ["example.com", "subdomains", "*.example.com"],
    ["*.example.com", "subdomains", "*.example.com"],
    ["=example.com", "subdomains", "*.example.com"],
    ["https://example.com:8080/a", "subdomains", "https://*.example.com:8080/a"],
    ["*", "subdomains", null],
    ["1.2.3.4", "subdomains", null],
    ["example.com", "exact", "=example.com"],
    ["=example.com", "exact", "=example.com"],
    ["*.example.com", "exact", "=example.com"],
    ["1.2.3.4", "exact", "1.2.3.4"],
    ["*", "exact", null],
    ["google", "group", "geosite:google"],
    ["geosite:google", "group", "geosite:google"],
    ["=google", "group", "geosite:google"],
    ["Google@CN", "group", "geosite:google@cn"],
    ["https://example.org/a.txt", "link", "list:https://example.org/a.txt"],
    ["list:https://example.org/a.txt", "link", "list:https://example.org/a.txt"],
    ["example.org/a.txt", "link", null],
  ])("%s as %s → %s", (input, kind, expected) => {
    expect(parseFilterEntry(input, kind)).toBe(expected);
  });

  it("is idempotent: every result parses to itself with no kind", () => {
    const kinds: EntryInputKind[] = ["site", "exact", "subdomains", "group", "link"];
    const inputs = [
      "example.com",
      "*.example.com",
      "https://example.com:8080/a",
      "MÜNCHEN.de",
      "localhost",
      "127.0.0.1",
      "google@cn",
      "https://example.org/a.txt",
    ];
    for (const input of inputs) {
      for (const kind of kinds) {
        const once = parseFilterEntry(input, kind);
        if (once !== null) {
          expect(parseFilterEntry(once)).toBe(once);
        }
      }
    }
  });

  it("is idempotent on random typed patterns (property)", () => {
    const label = fc.stringMatching(/^[a-z0-9]{1,8}$/);
    const host = fc.array(label, { minLength: 2, maxLength: 4 }).map((l) => l.join("."));
    const input = fc.tuple(
      fc.constantFrom("", "http://", "https://", "*://"),
      fc.constantFrom("", "=", "*."),
      host,
      fc.constantFrom("", ":8080", ":*"),
      fc.constantFrom("", "/", "/a", "/a/*")
    );
    fc.assert(
      fc.property(input, ([scheme, marker, h, port, path]) => {
        const raw =
          marker === "=" ? `=${scheme}${h}${port}${path}` : `${scheme}${marker}${h}${port}${path}`;
        const once = parseFilterEntry(raw);
        return once === null || parseFilterEntry(once) === once;
      })
    );
  });
});

describe("parsePattern rejects the three new forms", () => {
  it.each([
    "=example.com",
    "geosite:google",
    "geosite:google@cn",
    "list:https://example.org/a.txt",
  ])("%s", (entry) => {
    expect(parsePattern(entry)).toBeNull();
    expect(parseSiteLocationPattern(entry)).toBeNull();
  });
});

describe("classifyFilterEntry", () => {
  it.each([
    ["example.com", { type: "pattern", pattern: "example.com" }],
    ["=example.com", { type: "exact", pattern: "example.com" }],
    [
      "geosite:google@ads@cn",
      { type: "group", token: "geosite:google@ads@cn", name: "google", attrs: ["ads", "cn"] },
    ],
    [
      "list:https://example.org/a.txt",
      { type: "link", token: "list:https://example.org/a.txt", url: "https://example.org/a.txt" },
    ],
  ])("%s", (canonical, expected) => {
    expect(classifyFilterEntry(canonical)).toEqual(expected);
  });

  it("is null for a malformed token", () => {
    expect(classifyFilterEntry("geosite:")).toBeNull();
    expect(classifyFilterEntry("list:http://example.org/")).toBeNull();
  });
});

describe("detectEntryKind", () => {
  it.each<[string, EntryInputKind | null]>([
    ["geosite:google", "group"],
    ["  GeoSite:goo", "group"],
    ["list:", "link"],
    ["list:https://example.org/x", "link"],
    ["https://example.org/direct-list.txt", "link"],
    ["https://example.org/rules.LIST", "link"],
    ["https://example.org/rules.yaml?x=1", "link"],
    ["https://example.org/a/", null],
    ["https://example.org/a.html", null],
    ["http://example.org/a.txt", null],
    ["=mail.example.com", "exact"],
    ["*.example.com", "subdomains"],
    ["example.com", null],
    ["", null],
  ])("%s → %s", (input, kind) => {
    expect(detectEntryKind(input)).toBe(kind);
  });
});

describe("normalizeInputForKind", () => {
  it.each<[string, EntryInputKind, string]>([
    ["=example.com", "site", "example.com"],
    ["*.example.com", "site", "example.com"],
    ["geosite:google", "site", "google"],
    ["list:https://x.org/a.txt", "site", "https://x.org/a.txt"],
    ["*.example.com", "exact", "example.com"],
    ["=example.com", "exact", "=example.com"],
    ["=example.com", "subdomains", "example.com"],
    ["*.example.com", "subdomains", "*.example.com"],
    ["=*.google", "group", "google"],
    ["geosite:google", "group", "geosite:google"],
    ["geosite:https://x.org/a.txt", "link", "https://x.org/a.txt"],
    ["  example.com", "site", "example.com"],
  ])("%s for %s → %s", (input, kind, expected) => {
    expect(normalizeInputForKind(input, kind)).toBe(expected);
  });
});

describe("isTypedEntry", () => {
  it.each([
    ["example.com", true],
    ["=example.com", true],
    ["geosite:google", false],
    ["list:https://example.org/a.txt", false],
  ])("%s → %s", (entry, expected) => {
    expect(isTypedEntry(entry)).toBe(expected);
  });
});

describe("parseSiteLocationEntry", () => {
  it("accepts every valid site-location pattern unchanged", () => {
    for (const input of ["twitch.tv", "*.ru", "localhost:3000", "MÜNCHEN.de", "*://example.com"]) {
      expect(parseSiteLocationEntry(input)).toBe(parseSiteLocationPattern(input));
    }
  });

  it.each([
    ["=mail.example.com", "=mail.example.com"],
    ["geosite:google", "geosite:google"],
    ["list:https://example.org/a.txt", "list:https://example.org/a.txt"],
    ["=example.com/a", null],
    ["example.com/a", null],
    ["*", null],
    ["https://*", null],
  ])("%s → %s", (input, expected) => {
    expect(parseSiteLocationEntry(input)).toBe(expected);
  });
});

describe("siteLocationEntryKey", () => {
  it.each([
    ["münchen.de", "xn--mnchen-3ya.de"],
    ["=münchen.de", "=xn--mnchen-3ya.de"],
    ["=https://münchen.de:8080", "=https://xn--mnchen-3ya.de:8080"],
    ["geosite:google@cn", "geosite:google@cn"],
    ["list:https://example.org/a.txt", "list:https://example.org/a.txt"],
  ])("%s → %s", (canonical, key) => {
    expect(siteLocationEntryKey(canonical)).toBe(key);
  });

  it("keeps an exact address distinct from the bare host", () => {
    expect(siteLocationEntryKey("=example.com")).not.toBe(siteLocationEntryKey("example.com"));
  });

  it("is null for an exact host with no A-label form", () => {
    expect(siteLocationEntryKey("=xn--zz.com")).toBeNull();
  });
});

describe("exact entries through the matcher", () => {
  it("=example.com matches the host only", () => {
    expect(matchesPattern("https://example.com/x", "=example.com")).toBe(true);
    expect(matchesPattern("http://example.com:8080/", "=example.com")).toBe(true);
    expect(matchesPattern("https://www.example.com/", "=example.com")).toBe(false);
    expect(matchesPattern("https://notexample.com/", "=example.com")).toBe(false);
  });

  it("=münchen.de matches the punycode host", () => {
    const entry = parseFilterEntry("=MÜNCHEN.de")!;
    expect(entry).toBe("=münchen.de");
    expect(matchesPattern("https://xn--mnchen-3ya.de/", entry)).toBe(true);
    expect(matchesPattern("https://www.xn--mnchen-3ya.de/", entry)).toBe(false);
  });

  it("keeps scheme, port and path", () => {
    expect(matchesPattern("https://example.com:8443/a/b", "=https://example.com:8443/a/*")).toBe(
      true
    );
    expect(matchesPattern("http://example.com:8443/a/b", "=https://example.com:8443/a/*")).toBe(
      false
    );
    expect(matchesPattern("https://example.com/a/b", "=https://example.com:8443/a/*")).toBe(false);
  });

  it("compiles to a plain hostname with no {*.}? group", () => {
    expect(patternToInit("=example.com")?.hostname).toBe("example.com");
    expect(patternToInit("=localhost")?.hostname).toBe("localhost");
    expect(patternToInit("=*.example.com")).toBeNull();
    expect(patternToInit("=xn--zz.com")).toBeNull();
  });

  it("tokens never compile, and matchesPatternList skips them", () => {
    expect(patternToInit("geosite:google")).toBeNull();
    expect(patternToInit("list:https://example.org/a.txt")).toBeNull();
    expect(matchesPatternList("https://example.org/", ["list:https://example.org/a.txt"])).toBe(
      false
    );
    expect(matchesPatternList("https://example.org/", ["geosite:google", "example.org"])).toBe(
      true
    );
  });
});
