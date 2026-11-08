/**
 * The add field's suggestions (K1, evaluation.md 6.6 and A-2): which readings
 * of the typed text are offered, which site groups, and when "Browse all site
 * groups…" follows. Pure: the index is passed in.
 */

import { describe, test, expect } from "vitest";
import { describeEntry, type SiteGroupIndexItem } from "@/popup/site-groups";
import { entrySuggestions, groupSearchTerm } from "@/popup/entry-suggestions";

function item(
  name: string,
  count: number,
  label = name,
  featured: number | null = null
): SiteGroupIndexItem {
  return { name, count, label, aliases: [], featured };
}

const INDEX: SiteGroupIndexItem[] = [
  item("google", 964, "Google", 0),
  item("youtube", 178, "YouTube", 1),
  item("twitch", 35, "Twitch", 18),
  item("google-cn", 12),
  item("google-scholar", 4),
  item("google-play", 30),
  item("category-ads-all", 6000),
];

type Options = Parameters<typeof entrySuggestions>[1];

const filters: Options = { context: "filters", groupsAvailable: true, index: INDEX };
const safari: Options = { context: "filters", groupsAvailable: false, index: INDEX };

function rows(text: string, opts: Options = filters): [string, string, string][] {
  return entrySuggestions(text, opts).items.map((s) => [s.title, s.meta, s.entry]);
}

describe("groupSearchTerm", () => {
  test.each([
    ["twitch.tv", "twitch"],
    ["www.google.com", "google"],
    ["google", "google"],
    ["  YouTube ", "youtube"],
    ["geosite:Google@cn", "google"],
    ["GeoSite:goo", "goo"],
    ["google@cn", "google"],
    ["twitch.tv.", "twitch"],
    ["a", ""],
    ["x.y", ""],
    ["geosite:", ""],
    ["", ""],
  ])("%j searches %j", (text, term) => {
    expect(groupSearchTerm(text)).toBe(term);
  });
});

describe("entrySuggestions", () => {
  test("twitch.tv: the three readings and the Twitch group, then Browse (A-2)", () => {
    expect(entrySuggestions("twitch.tv", filters)).toEqual({
      items: [
        { title: "twitch.tv", meta: "Site and its subdomains", entry: "twitch.tv", kind: "site" },
        { title: "twitch.tv", meta: "Exact address only", entry: "=twitch.tv", kind: "exact" },
        {
          title: "*.twitch.tv",
          meta: "Subdomains only",
          entry: "*.twitch.tv",
          kind: "subdomains",
        },
        { title: "Twitch", meta: "Site group · 35 sites", entry: "geosite:twitch", kind: "group" },
      ],
      browse: true,
    });
  });

  test("the per-site editor offers the same readings", () => {
    expect(rows("Twitch.TV", { ...filters, context: "siteLocation" })).toEqual([
      ["twitch.tv", "Site and its subdomains", "twitch.tv"],
      ["twitch.tv", "Exact address only", "=twitch.tv"],
      ["*.twitch.tv", "Subdomains only", "*.twitch.tv"],
      ["Twitch", "Site group · 35 sites", "geosite:twitch"],
    ]);
  });

  test("Safari: only the two typed readings, no groups and no Browse", () => {
    expect(entrySuggestions("twitch.tv", safari)).toEqual({
      items: [
        { title: "twitch.tv", meta: "Site and its subdomains", entry: "twitch.tv", kind: "site" },
        {
          title: "*.twitch.tv",
          meta: "Subdomains only",
          entry: "*.twitch.tv",
          kind: "subdomains",
        },
      ],
      browse: false,
    });
  });

  test("google: no typed rows, the Google groups first, then Browse", () => {
    const { items, browse } = entrySuggestions("google", filters);
    expect(items.map((s) => [s.title, s.meta, s.entry])).toEqual([
      ["Google", "Site group · 964 sites", "geosite:google"],
      ["google-cn", "Site group · 12 sites", "geosite:google-cn"],
      ["google-play", "Site group · 30 sites", "geosite:google-play"],
    ]);
    expect(browse).toBe(true);
  });

  test("at most maxGroups group rows", () => {
    expect(rows("google", { ...filters, maxGroups: 1 }).map(([title]) => title)).toEqual([
      "Google",
    ]);
  });

  test("a typed @tag carries over to the group rows, without a count", () => {
    expect(rows("google@cn").slice(0, 1)).toEqual([
      ["Google @cn", "Site group", "geosite:google@cn"],
    ]);
  });

  test("geosite: suggests groups only", () => {
    const { items, browse } = entrySuggestions("geosite:goo", filters);
    expect(items.every((s) => s.kind === "group")).toBe(true);
    expect(items[0]?.entry).toBe("geosite:google");
    expect(browse).toBe(true);
    expect(entrySuggestions("geosite:", filters)).toEqual({ items: [], browse: true });
  });

  test.each(["=mail.example.com", "*.ru"])("%s: a typed marker suggests nothing", (text) => {
    expect(entrySuggestions(text, filters)).toEqual({ items: [], browse: false });
  });

  test.each(["site.com/app/*", "https://example.com", "example.com:8080", "*.example.com"])(
    "%s: no typed rows for a form Enter already adds as typed",
    (text) => {
      expect(entrySuggestions(text, filters).items.filter((s) => s.kind !== "group")).toEqual([]);
    }
  );

  test("a pasted list link: one row for that list", () => {
    const { items, browse } = entrySuggestions("https://example.com/list.txt", filters);
    expect(items).toEqual([
      {
        entry: "list:https://example.com/list.txt",
        title: describeEntry("list:https://example.com/list.txt", { unsaved: true }).title,
        meta: "List from a link",
        kind: "link",
      },
    ]);
    expect(browse).toBe(false);
  });

  test("the editor's comma list suggests nothing", () => {
    expect(entrySuggestions("a.com, b.com", { ...filters, context: "siteLocation" })).toEqual({
      items: [],
      browse: false,
    });
  });

  test("nothing typed, nothing suggested", () => {
    expect(entrySuggestions("   ", filters)).toEqual({ items: [], browse: false });
  });

  test("while the index loads: the typed readings and Browse", () => {
    expect(rows("twitch.tv", { ...filters, index: null }).map(([, meta]) => meta)).toEqual([
      "Site and its subdomains",
      "Exact address only",
      "Subdomains only",
    ]);
    expect(entrySuggestions("twitch.tv", { ...filters, index: null }).browse).toBe(true);
  });

  test("an address that is already exact gets one row per entry", () => {
    const entries = entrySuggestions("192.168.1.1", filters).items.map((s) => s.entry);
    expect(entries[0]).toBe("192.168.1.1");
    expect(new Set(entries).size).toBe(entries.length);
  });

  test("text that isn't a site and matches no group: Browse only", () => {
    expect(entrySuggestions("qqqq", filters)).toEqual({ items: [], browse: true });
    expect(entrySuggestions("qqqq", safari)).toEqual({ items: [], browse: false });
  });
});
