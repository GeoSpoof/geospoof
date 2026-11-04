import { describe, it, expect } from "vitest";
import {
  buildCatalogGroupData,
  catalogIndex,
  isNewerRelease,
  validateCatalog,
  type SiteGroupCatalog,
} from "@/shared/site-groups/catalog";
import { hostInGroupStrings } from "@/shared/site-groups/matcher";

function makeCatalog(overrides: Partial<SiteGroupCatalog> = {}): SiteGroupCatalog {
  return {
    format: 1,
    source: "https://github.com/v2fly/domain-list-community",
    license: "MIT",
    release: "20261104112839",
    releasedAt: "2026-11-04T11:28:50Z",
    upstreamSha256: "cd21da98a2a7fd1b65a7620ed47c70570fe4466b3e18a43aa71160ffef6c78cb",
    lists: {
      google: {
        rules: [
          "google.com",
          "google.cn@cn",
          "googleadservices.com@ads",
          "gads.cn@ads@cn",
          "=dl.google.com",
          "google.com",
        ].join("\n"),
        skipped: ["", "cn", "ads@cn"],
      },
      cn: { rules: "cn", skipped: [] },
      "only-regexp": { rules: "", skipped: [""] },
      "geolocation-!cn": { rules: "google.com@!cn\nyoutube.com", skipped: [] },
    },
    ...overrides,
  };
}

describe("validateCatalog", () => {
  it("accepts a well-formed catalog and copies only known fields", () => {
    const raw = { ...makeCatalog(), extra: "ignored" };
    const valid = validateCatalog(raw);
    expect(valid).toEqual(makeCatalog());
    expect(valid).not.toHaveProperty("extra");
  });

  it.each<[string, unknown]>([
    ["a non-object", "catalog"],
    ["null", null],
    ["an array", []],
    ["format 2", { ...makeCatalog(), format: 2 }],
    ["an empty source", { ...makeCatalog(), source: "" }],
    ["a non-string license", { ...makeCatalog(), license: 1 }],
    ["a short release", { ...makeCatalog(), release: "2026110411283" }],
    ["a non-digit release", { ...makeCatalog(), release: "2026110411283x" }],
    ["a non-ISO releasedAt", { ...makeCatalog(), releasedAt: "Nov 4 2026" }],
    ["an invalid releasedAt", { ...makeCatalog(), releasedAt: "2026-13-45T99:99:99Z" }],
    ["an uppercase sha256", { ...makeCatalog(), upstreamSha256: "CD21".padEnd(64, "0") }],
    ["lists as an array", { ...makeCatalog(), lists: [] }],
    ["an uppercase list name", { ...makeCatalog(), lists: { Google: { rules: "", skipped: [] } } }],
    ["an underscore list name", { ...makeCatalog(), lists: { a_b: { rules: "", skipped: [] } } }],
    ["a list without rules", { ...makeCatalog(), lists: { a: { skipped: [] } } }],
    ["a list without skipped", { ...makeCatalog(), lists: { a: { rules: "" } } }],
    ["an uppercase host", { ...makeCatalog(), lists: { a: { rules: "Google.com", skipped: [] } } }],
    ["a leading hyphen", { ...makeCatalog(), lists: { a: { rules: "-a.com", skipped: [] } } }],
    ["a trailing dot", { ...makeCatalog(), lists: { a: { rules: "a.com.", skipped: [] } } }],
    ["an empty line", { ...makeCatalog(), lists: { a: { rules: "a.com\n\nb.com", skipped: [] } } }],
    ["a regexp line", { ...makeCatalog(), lists: { a: { rules: "^a\\.com$", skipped: [] } } }],
    ["a wildcard", { ...makeCatalog(), lists: { a: { rules: "*.a.com", skipped: [] } } }],
    ["an empty attr", { ...makeCatalog(), lists: { a: { rules: "a.com@", skipped: [] } } }],
    [
      "a label over 63",
      { ...makeCatalog(), lists: { a: { rules: `${"a".repeat(64)}.com`, skipped: [] } } },
    ],
    [
      "a host over 253",
      { ...makeCatalog(), lists: { a: { rules: Array(64).fill("abc").join("."), skipped: [] } } },
    ],
    ["a bad skipped item", { ...makeCatalog(), lists: { a: { rules: "", skipped: ["@cn"] } } }],
    ["a non-string skipped item", { ...makeCatalog(), lists: { a: { rules: "", skipped: [1] } } }],
  ])("rejects %s", (_name, raw) => {
    expect(validateCatalog(raw)).toBeNull();
  });

  it("enforces the list cap", () => {
    const lists: SiteGroupCatalog["lists"] = {};
    for (let i = 0; i <= 5_000; i++) lists[`l${i}`] = { rules: "", skipped: [] };
    expect(validateCatalog(makeCatalog({ lists }))).toBeNull();
    delete lists.l0;
    expect(validateCatalog(makeCatalog({ lists }))).not.toBeNull();
  });

  it("enforces the total line cap", () => {
    const rules = Array(200_001).fill("a.com").join("\n");
    const lists = { a: { rules, skipped: [] }, b: { rules, skipped: [] } };
    expect(validateCatalog(makeCatalog({ lists }))).toBeNull();
  });

  it("enforces the skipped cap", () => {
    const skipped = Array(5_001).fill("");
    const lists = { a: { rules: "", skipped }, b: { rules: "", skipped } };
    expect(validateCatalog(makeCatalog({ lists }))).toBeNull();
  });
});

describe("catalogIndex", () => {
  it("lists every name with its unfiltered unique count, sorted", () => {
    expect(catalogIndex(makeCatalog())).toEqual([
      { name: "cn", count: 1 },
      { name: "geolocation-!cn", count: 2 },
      { name: "google", count: 5 },
      { name: "only-regexp", count: 0 },
    ]);
  });
});

describe("buildCatalogGroupData", () => {
  const catalog = makeCatalog();

  it("builds the whole list with no attrs, deduped", () => {
    const result = buildCatalogGroupData(catalog, "geosite:google");
    expect(result).toEqual({
      ok: true,
      data: {
        d: "\ngoogle.com\ngoogle.cn\ngoogleadservices.com\ngads.cn\n",
        f: "\ndl.google.com\n",
        n: 5,
        skipped: 3,
      },
    });
  });

  it("filters by one attr", () => {
    const result = buildCatalogGroupData(catalog, "geosite:google@cn");
    expect(result).toEqual({
      ok: true,
      data: { d: "\ngoogle.cn\ngads.cn\n", f: "\n", n: 2, skipped: 2 },
    });
  });

  it("combines several attrs with AND", () => {
    const result = buildCatalogGroupData(catalog, "geosite:google@ads@cn");
    expect(result).toEqual({ ok: true, data: { d: "\ngads.cn\n", f: "\n", n: 1, skipped: 1 } });
  });

  it("handles the ! attr", () => {
    const result = buildCatalogGroupData(catalog, "geosite:geolocation-!cn@!cn");
    expect(result.ok && result.data.d).toBe("\ngoogle.com\n");
  });

  it("builds data the matcher reads", () => {
    const result = buildCatalogGroupData(catalog, "geosite:cn");
    if (!result.ok) throw new Error(result.error);
    expect(hostInGroupStrings(result.data.d, result.data.f, "www.gov.cn")).toBe(true);
  });

  it.each([
    ["geosite:netflix", "UNKNOWN_GROUP"],
    ["geosite:constructor", "UNKNOWN_GROUP"],
    ["geosite:", "UNKNOWN_GROUP"],
    ["google", "UNKNOWN_GROUP"],
    ["geosite:google@telemetry", "EMPTY_GROUP"],
    ["geosite:only-regexp", "EMPTY_GROUP"],
  ])("%s → %s", (token, error) => {
    expect(buildCatalogGroupData(catalog, token)).toEqual({ ok: false, error });
  });
});

describe("isNewerRelease", () => {
  it.each<[string, string | null | undefined, boolean]>([
    ["20261104112839", "20261028000000", true],
    ["20261028000000", "20261104112839", false],
    ["20261104112839", "20261104112839", false],
    ["20261104112839", null, true],
    ["20261104112839", undefined, true],
    ["20261104112839", "garbage", true],
    ["garbage", "20261104112839", false],
  ])("%s vs %s → %s", (a, b, expected) => {
    expect(isNewerRelease(a, b)).toBe(expected);
  });
});
