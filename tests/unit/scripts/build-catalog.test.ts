import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  catalogGuard,
  catalogPointer,
  convertV2flyLists,
  parseV2flyPlainYaml,
  type Catalog,
} from "../../../scripts/site-groups/build-catalog";
import { buildCatalogGroupData, validateCatalog } from "@/shared/site-groups/catalog";
import { FEATURED_SITE_GROUPS } from "@/shared/site-groups/featured";

const META = {
  release: "20261104112839",
  releasedAt: "2026-11-04T11:28:50Z",
  upstreamSha256: "cd21da98a2a7fd1b65a7620ed47c70570fe4466b3e18a43aa71160ffef6c78cb",
};

const YAML = [
  "lists:",
  '  - name: "google"',
  "    length: 6",
  "    rules:",
  '      - "domain:google.com"',
  '      - "full:dl.google.com"',
  '      - "domain:google.cn:@cn"',
  '      - "domain:gads.cn:@cn,@ads"',
  '      - "regexp:^r[0-9]+\\\\.googlevideo\\\\.com$:@cn"',
  '      - "keyword:goog"',
  '  - name: "cn"',
  "    length: 1",
  "    rules:",
  '      - "domain:cn"',
  "",
].join("\n");

describe("parseV2flyPlainYaml", () => {
  it("parses the upstream shape", () => {
    expect(parseV2flyPlainYaml(YAML)).toEqual([
      {
        name: "google",
        rules: [
          "domain:google.com",
          "full:dl.google.com",
          "domain:google.cn:@cn",
          "domain:gads.cn:@cn,@ads",
          "regexp:^r[0-9]+\\.googlevideo\\.com$:@cn",
          "keyword:goog",
        ],
      },
      { name: "cn", rules: ["domain:cn"] },
    ]);
  });

  it.each([
    ["a missing lists: header", YAML.replace("lists:\n", "")],
    ["a length mismatch", YAML.replace("length: 6", "length: 7")],
    ["an unquoted rule", YAML.replace('- "domain:cn"', "- domain:cn")],
    [
      "a missing rules: line",
      YAML.replace('    rules:\n      - "domain:cn"', '      - "domain:cn"'),
    ],
    ["an unknown key", YAML.replace("    length: 1", "    size: 1")],
    ["a stray line", `${YAML}extra: true\n`],
    ["tab indentation", YAML.replace('  - name: "cn"', '\t- name: "cn"')],
  ])("throws on %s", (_name, text) => {
    expect(() => parseV2flyPlainYaml(text)).toThrow();
  });
});

describe("convertV2flyLists", () => {
  const catalog = convertV2flyLists(parseV2flyPlainYaml(YAML), META);

  it("converts rules to lines, keeps attrs sorted and skipped attr sets", () => {
    expect(catalog).toEqual({
      format: 1,
      source: "https://github.com/v2fly/domain-list-community",
      license: "MIT",
      ...META,
      lists: {
        cn: { rules: "cn", skipped: [] },
        google: {
          rules: "google.com\n=dl.google.com\ngoogle.cn@cn\ngads.cn@ads@cn",
          skipped: ["cn", ""],
        },
      },
    });
  });

  it("writes lists in name order", () => {
    expect(Object.keys(catalog.lists)).toEqual(["cn", "google"]);
  });

  it("produces a catalog validateCatalog accepts", () => {
    expect(validateCatalog(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog);
  });

  it.each([
    ["an include rule", [{ name: "a", rules: ["include:b"] }]],
    ["an unknown rule type", [{ name: "a", rules: ["ip:1.1.1.1"] }]],
    ["an invalid host", [{ name: "a", rules: ["domain:bad_host.com"] }]],
    ["an uppercase host", [{ name: "a", rules: ["domain:Google.com"] }]],
    ["an invalid list name", [{ name: "A_B", rules: [] }]],
    [
      "a duplicate list name",
      [
        { name: "a", rules: [] },
        { name: "a", rules: [] },
      ],
    ],
  ])("throws on %s", (_name, lists) => {
    expect(() => convertV2flyLists(lists, META)).toThrow();
  });

  it("throws on bad metadata", () => {
    expect(() => convertV2flyLists([], { ...META, release: "latest" })).toThrow();
    expect(() => convertV2flyLists([], { ...META, releasedAt: "soon" })).toThrow();
    expect(() => convertV2flyLists([], { ...META, upstreamSha256: "abc" })).toThrow();
  });
});

function listsOf(count: number, rulesEach: number): Pick<Catalog, "lists"> {
  const lists: Catalog["lists"] = {};
  for (let i = 0; i < count; i++) {
    lists[`l${i}`] = {
      rules: Array.from({ length: rulesEach }, (_, j) => `h${j}.com`).join("\n"),
      skipped: [],
    };
  }
  return { lists };
}

describe("catalogGuard", () => {
  it("passes a stable or growing release", () => {
    expect(catalogGuard(listsOf(100, 10), listsOf(100, 10))).toEqual({ ok: true });
    expect(catalogGuard(listsOf(100, 10), listsOf(120, 12))).toEqual({ ok: true });
  });

  it("allows up to 10% fewer lists and 20% fewer rules", () => {
    expect(catalogGuard(listsOf(100, 10), listsOf(90, 10)).ok).toBe(true);
    expect(catalogGuard(listsOf(100, 10), listsOf(100, 8)).ok).toBe(true);
  });

  it("fails on more than 10% fewer lists", () => {
    const result = catalogGuard(listsOf(100, 10), listsOf(89, 12));
    expect(result).toEqual({ ok: false, reason: "lists dropped from 100 to 89" });
  });

  it("fails on more than 20% fewer rules", () => {
    const result = catalogGuard(listsOf(100, 10), listsOf(100, 7));
    expect(result).toEqual({ ok: false, reason: "rules dropped from 1000 to 700" });
  });
});

describe("catalogPointer", () => {
  it("describes the written bytes", () => {
    const catalog = convertV2flyLists(parseV2flyPlainYaml(YAML), META);
    const bytes = new TextEncoder().encode(JSON.stringify(catalog));
    expect(catalogPointer(bytes, catalog)).toEqual({
      format: 1,
      release: META.release,
      releasedAt: META.releasedAt,
      path: "site-groups/v1/catalog-20261104112839.json",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      lists: 2,
      rules: 5,
    });
  });
});

describe("the committed catalog (assets/site-groups/catalog.json)", () => {
  const raw = readFileSync(resolve(__dirname, "../../../assets/site-groups/catalog.json"), "utf8");
  const catalog = validateCatalog(JSON.parse(raw));

  it("passes validateCatalog with the 20261104112839 release", () => {
    expect(catalog).not.toBeNull();
    expect(catalog!.release).toBe("20261104112839");
    expect(catalog!.releasedAt).toBe("2026-11-04T11:28:50Z");
    expect(catalog!.upstreamSha256).toBe(META.upstreamSha256);
    expect(catalog!.license).toBe("MIT");
  });

  it("holds 1,555 lists, 113,175 rules and 375 skipped", () => {
    const lists = Object.values(catalog!.lists);
    expect(lists).toHaveLength(1555);
    expect(lists.reduce((n, l) => n + (l.rules === "" ? 0 : l.rules.split("\n").length), 0)).toBe(
      113_175
    );
    expect(lists.reduce((n, l) => n + l.skipped.length, 0)).toBe(375);
  });

  it("is compact JSON (what the converter writes)", () => {
    expect(raw).toBe(JSON.stringify(JSON.parse(raw)));
  });

  it("contains every featured group", () => {
    for (const { name } of FEATURED_SITE_GROUPS) {
      expect(Object.hasOwn(catalog!.lists, name), name).toBe(true);
    }
  });

  it("builds geosite:google with 964 entries and 2 skipped", () => {
    const result = buildCatalogGroupData(catalog!, "geosite:google");
    expect(result.ok && { n: result.data.n, skipped: result.data.skipped }).toEqual({
      n: 964,
      skipped: 2,
    });
  });
});
