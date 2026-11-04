import { describe, it, expect } from "vitest";
import type { SiteLocation } from "@/shared/types/settings";
import {
  createSiteGroupLookup,
  frameEntries,
  hostInGroupStrings,
  type SiteGroupData,
} from "@/shared/site-groups/matcher";
import { parseDomainList } from "@/shared/site-groups/list-formats";
import {
  parseFilterEntry,
  parseSiteLocationEntry,
  type EntryInputKind,
} from "@/shared/utils/filter-entries";
import { parsePattern } from "@/shared/utils/scope";
import { matchSiteLocation } from "@/shared/utils/site-locations";
import { makeSiteLocation } from "../../helpers/site-locations";
import vectors from "../../fixtures/site-group-vectors.json";

/**
 * Cross-language parity: the entry parsers, group lookups, per-site location
 * precedence and the link-list parser must match every vector in the shared
 * fixture. A future geospoof-ios Swift test reads the same file.
 */

interface EntryVector {
  input: string;
  kind?: EntryInputKind;
  expected: string | null;
}

interface PrecedenceCase {
  name: string;
  url: string;
  entries: { id: string; updatedAt: number; patterns: string[] }[];
  expected: string | null;
}

interface ListFormatCase {
  name: string;
  text: string;
  domains: string[];
  full: string[];
  skipped: { regexp: number; keyword: number; other: number };
}

const entriesValid = vectors.entries.valid as EntryVector[];
const entriesInvalid = vectors.entries.invalid as EntryVector[];
const siteValid = vectors.siteLocationEntries.valid as EntryVector[];
const siteInvalid = vectors.siteLocationEntries.invalid as EntryVector[];
const fixtureGroups = vectors.lookup.groups as Record<
  string,
  { domains: string[]; full: string[] }
>;
const precedenceCases = vectors.precedence.cases as PrecedenceCase[];
const listFormatCases = vectors.listFormats as ListFormatCase[];

const groupData: Record<string, SiteGroupData> = Object.fromEntries(
  Object.entries(fixtureGroups).map(([token, g]) => [
    token,
    { d: frameEntries(g.domains), f: frameEntries(g.full), n: g.domains.length + g.full.length },
  ])
);

describe("site-group vectors: entries", () => {
  it.each(entriesValid)(
    "parseFilterEntry($input, $kind) === $expected",
    ({ input, kind, expected }) => {
      expect(parseFilterEntry(input, kind)).toBe(expected);
    }
  );

  it.each(entriesValid)("$expected is idempotent", ({ expected }) => {
    expect(parseFilterEntry(expected!)).toBe(expected);
  });

  it.each(entriesInvalid)(
    "parseFilterEntry($input, $kind) === null",
    ({ input, kind, expected }) => {
      expect(expected).toBeNull();
      expect(parseFilterEntry(input, kind)).toBeNull();
    }
  );

  it.each(entriesValid.filter((v) => /^(=|geosite:|list:)/.test(v.expected!)))(
    "parsePattern rejects the new form $expected",
    ({ expected }) => {
      expect(parsePattern(expected!)).toBeNull();
    }
  );
});

describe("site-group vectors: per-site location entries", () => {
  it.each(siteValid)(
    "parseSiteLocationEntry($input, $kind) === $expected",
    ({ input, kind, expected }) => {
      expect(parseSiteLocationEntry(input, kind)).toBe(expected);
    }
  );

  it.each(siteInvalid)("parseSiteLocationEntry($input) === null", ({ input, kind, expected }) => {
    expect(expected).toBeNull();
    expect(parseSiteLocationEntry(input, kind)).toBeNull();
  });
});

describe("site-group vectors: lookup", () => {
  const lookup = createSiteGroupLookup(groupData);

  it.each(vectors.lookup.cases)("$token has $host → $expected", ({ token, host, expected }) => {
    const data = groupData[token];
    const viaStrings = data === undefined ? false : hostInGroupStrings(data.d, data.f, host);
    expect(viaStrings).toBe(expected);
    expect(lookup.has(token, host)).toBe(expected);
  });
});

describe("site-group vectors: precedence", () => {
  const lookup = createSiteGroupLookup(groupData);

  it.each(precedenceCases)("$name", ({ url, entries, expected }) => {
    const siteLocations: SiteLocation[] = entries.map((e) => makeSiteLocation(e));
    expect(matchSiteLocation(url, siteLocations, lookup)?.entry.id ?? null).toBe(expected);
    // The result doesn't depend on list order.
    expect(matchSiteLocation(url, [...siteLocations].reverse(), lookup)?.entry.id ?? null).toBe(
      expected
    );
  });
});

describe("site-group vectors: list formats", () => {
  it.each(listFormatCases)("$name", ({ text, domains, full, skipped }) => {
    const result = parseDomainList(text);
    if ("error" in result) {
      throw new Error(`unexpected ${result.error}`);
    }
    expect([...result.domains].sort()).toEqual([...domains].sort());
    expect([...result.fulls].sort()).toEqual([...full].sort());
    expect(result.skipped).toEqual(skipped);
  });
});
