/**
 * Popup site group state and display helpers (GeoSpoof/geospoof#206): when the
 * popup asks the background for site group data, how it parses the reply,
 * picker search and ranking, and the strings each entry kind shows.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { Settings } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import { FEATURED_SITE_GROUPS } from "@/shared/site-groups/featured";
import { makeSiteLocation } from "../../helpers/site-locations";

const gate = vi.hoisted(() => ({ available: true }));
vi.mock("@/shared/site-groups/availability", () => ({
  siteGroupsAvailable: () => gate.available,
}));

import {
  __resetPopupSiteGroupsForTest,
  describeEntry,
  formatCatalogDate,
  formatCount,
  linkAddedText,
  loadCatalogIndex,
  loadPopupSiteGroups,
  MAX_SEARCH_RESULTS,
  popupSiteGroupLookup,
  requestSiteGroupUpdate,
  searchSiteGroups,
  siteGroupErrorText,
  siteGroupsStatus,
  siteGroupSummaries,
  type SiteGroupIndexItem,
} from "@/popup/site-groups";

const sendMessage = vi.mocked(browser.runtime.sendMessage);

const LINK_URL =
  "https://raw.githubusercontent.com/Loyalsoldier/v2ray-rules-dat/release/direct-list.txt";
const LINK_TOKEN = `list:${LINK_URL}`;

const STATUS = {
  release: "20261104112839",
  releasedAt: "2026-11-04T11:28:50Z",
  checkedAt: 1_700_000_000_000,
  lastError: null,
  updating: false,
};

function group(token: string, overrides: Record<string, unknown> = {}) {
  return {
    token,
    kind: token.startsWith("list:") ? "link" : "group",
    name: "google",
    count: 964,
    skipped: 2,
    updatedAt: 1,
    d: "\ngoogle.com\n",
    f: "\nmail.example.org\n",
    ...overrides,
  };
}

function reply(groups: Record<string, unknown>, status: unknown = STATUS) {
  return { available: true, status, groups };
}

function settingsWith(overrides: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

const WITH_GROUP = settingsWith({ allowlist: ["example.com", "geosite:google"] });

async function load(raw: unknown, settings = WITH_GROUP): Promise<void> {
  sendMessage.mockResolvedValueOnce(raw);
  await loadPopupSiteGroups(settings);
}

function typesSent(): string[] {
  return sendMessage.mock.calls.map(([message]) => (message as unknown as { type: string }).type);
}

beforeEach(() => {
  gate.available = true;
  __resetPopupSiteGroupsForTest();
  sendMessage.mockReset();
});

describe("loadPopupSiteGroups", () => {
  test("sends nothing when no entry is a site group or link", () => {
    const settings = settingsWith({
      scopeMode: "allowlist",
      allowlist: ["example.com", "=mail.example.com", "*.ru"],
      denylist: ["twitch.tv"],
    });
    expect(loadPopupSiteGroups(settings)).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(siteGroupsStatus()).toBeNull();
  });

  test.each<[string, Partial<Settings>]>([
    ["the allowlist", { allowlist: ["geosite:google"] }],
    ["the denylist", { denylist: [LINK_TOKEN] }],
    [
      "a site location",
      { siteLocations: [makeSiteLocation({ patterns: ["twitch.tv", "geosite:netflix"] })] },
    ],
  ])("asks once when %s holds a token", async (_name, overrides) => {
    await load(reply({}), settingsWith(overrides));
    expect(typesSent()).toEqual(["GET_SITE_GROUPS"]);
  });

  test("sends nothing where site groups are unavailable, even with tokens", () => {
    gate.available = false;
    expect(loadPopupSiteGroups(WITH_GROUP)).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("keeps the summaries, the status and a lookup over the framed strings", async () => {
    await load(reply({ "geosite:google": group("geosite:google") }));
    expect(siteGroupsStatus()).toEqual(STATUS);
    expect(Object.keys(siteGroupSummaries())).toEqual(["geosite:google"]);
    const lookup = popupSiteGroupLookup();
    expect(lookup.has("geosite:google", "www.google.com")).toBe(true);
    expect(lookup.has("geosite:google", "mail.example.org")).toBe(true);
    expect(lookup.has("geosite:google", "example.org")).toBe(false);
    expect(lookup.size("geosite:google")).toBe(964);
    expect(lookup.has("geosite:youtube", "youtube.com")).toBe(false);
  });

  test.each<[string, unknown]>([
    ["undefined", undefined],
    ["a string", "nope"],
    [
      "available: false",
      { ...reply({ "geosite:google": group("geosite:google") }), available: false },
    ],
    ["no status", { available: true, groups: { "geosite:google": group("geosite:google") } }],
    ["a bad status", reply({ "geosite:google": group("geosite:google") }, { release: 1 })],
    ["groups as an array", { available: true, status: STATUS, groups: [] }],
  ])("treats %s as empty", async (_name, raw) => {
    await load(raw);
    expect(siteGroupsStatus()).toBeNull();
    expect(siteGroupSummaries()).toEqual({});
    expect(popupSiteGroupLookup().has("geosite:google", "google.com")).toBe(false);
    expect(describeEntry("geosite:google").warning).toBe(true);
  });

  test("drops a malformed group and keeps the rest", async () => {
    await load(
      reply({
        "geosite:google": group("geosite:google"),
        "geosite:bad": group("geosite:bad", { count: "many" }),
        "not-a-token": group("not-a-token"),
      })
    );
    expect(Object.keys(siteGroupSummaries())).toEqual(["geosite:google"]);
  });

  test("a failed send counts as empty and never throws", async () => {
    sendMessage.mockRejectedValueOnce(new Error("disconnected"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(loadPopupSiteGroups(WITH_GROUP)).resolves.toBeUndefined();
    expect(siteGroupsStatus()).toBeNull();
    spy.mockRestore();
  });

  test("a later load with no tokens clears what an earlier one stored", async () => {
    await load(reply({ "geosite:google": group("geosite:google") }));
    expect(loadPopupSiteGroups(settingsWith({ allowlist: ["example.com"] }))).toBeNull();
    expect(siteGroupSummaries()).toEqual({});
    expect(siteGroupsStatus()).toBeNull();
  });

  test("only the newest reply is applied", async () => {
    let first: (value: unknown) => void = () => {};
    sendMessage.mockImplementationOnce(() => new Promise((resolve) => (first = resolve)));
    const older = loadPopupSiteGroups(WITH_GROUP);
    await load(reply({}));
    first(reply({ "geosite:google": group("geosite:google") }));
    await older;
    expect(siteGroupSummaries()).toEqual({});
  });
});

describe("requestSiteGroupUpdate", () => {
  test("reports success and the new status", async () => {
    sendMessage.mockResolvedValueOnce({ success: true, status: STATUS });
    await expect(requestSiteGroupUpdate()).resolves.toEqual({ ok: true, status: STATUS });
    expect(typesSent()).toEqual(["UPDATE_SITE_GROUPS"]);
  });

  test("reports a failed refresh with its status, and a failed send without one", async () => {
    const failed = { ...STATUS, lastError: "NETWORK" };
    sendMessage.mockResolvedValueOnce({ error: "NETWORK", status: failed });
    await expect(requestSiteGroupUpdate()).resolves.toEqual({ ok: false, status: failed });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendMessage.mockRejectedValueOnce(new Error("disconnected"));
    await expect(requestSiteGroupUpdate()).resolves.toEqual({ ok: false, status: null });
    spy.mockRestore();
  });
});

// ── The index and search ────────────────────────────────────────────────────

const EXTRA_LISTS = [
  { name: "category-ads-all", count: 6000 },
  { name: "google-cn", count: 12 },
  { name: "googlefcm", count: 3 },
  { name: "abc", count: 5 },
  { name: "zoom", count: 9 },
];

const INDEX_REPLY = {
  release: "20261104112839",
  lists: [
    ...FEATURED_SITE_GROUPS.map(({ name }, i) => ({ name, count: 100 + i })),
    ...EXTRA_LISTS,
  ].sort((a, b) => (a.name < b.name ? -1 : 1)),
};

async function loadIndex(): Promise<SiteGroupIndexItem[]> {
  sendMessage.mockResolvedValueOnce(INDEX_REPLY);
  return loadCatalogIndex();
}

describe("loadCatalogIndex", () => {
  test("merges the featured labels, ranks and aliases into the catalog index", async () => {
    const index = await loadIndex();
    expect(index).toHaveLength(INDEX_REPLY.lists.length);
    const byName = new Map(index.map((item) => [item.name, item]));
    expect(byName.get("openai")).toEqual({
      name: "openai",
      count: 103,
      label: "OpenAI",
      aliases: ["chatgpt"],
      featured: 3,
    });
    expect(byName.get("category-ai-!cn")?.label).toBe("AI services");
    expect(byName.get("cn")?.label).toBe("China sites");
    expect(byName.get("geolocation-!cn")?.label).toBe("Sites outside China");
    expect(byName.get("category-ads-all")).toEqual({
      name: "category-ads-all",
      count: 6000,
      label: "category-ads-all",
      aliases: [],
      featured: null,
    });
  });

  test("is memoized: one GET_SITE_GROUP_INDEX per session", async () => {
    await loadIndex();
    await loadCatalogIndex();
    expect(typesSent()).toEqual(["GET_SITE_GROUP_INDEX"]);
  });

  test("a failed or empty load is retried next time", async () => {
    sendMessage.mockResolvedValueOnce({ release: null, lists: [] });
    await expect(loadCatalogIndex()).resolves.toEqual([]);
    await loadIndex();
    expect(typesSent()).toEqual(["GET_SITE_GROUP_INDEX", "GET_SITE_GROUP_INDEX"]);
  });

  test("asks nothing where site groups are unavailable", async () => {
    gate.available = false;
    await expect(loadCatalogIndex()).resolves.toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("searchSiteGroups", () => {
  test("an empty query: the featured groups in table order, then every other list A-Z", async () => {
    const index = await loadIndex();
    const { popular, all } = searchSiteGroups(index, "  ");
    expect(popular.map((item) => item.name)).toEqual(FEATURED_SITE_GROUPS.map((f) => f.name));
    expect(all.map((item) => item.name)).toEqual([
      "abc",
      "category-ads-all",
      "google-cn",
      "googlefcm",
      "zoom",
    ]);
  });

  test("prefix matches come before substring matches", async () => {
    const index = await loadIndex();
    const { popular, all } = searchSiteGroups(index, "goo");
    expect(popular.map((item) => item.name)).toEqual(["google"]);
    expect(all.map((item) => item.name)).toEqual(["google-cn", "googlefcm"]);

    // "tube" is inside "youtube"; "o" starts "openai" but is inside many more.
    expect(searchSiteGroups(index, "tube").popular.map((item) => item.name)).toEqual(["youtube"]);
    const o = searchSiteGroups(index, "o");
    expect(o.popular[0].name).toBe("openai");
  });

  test.each([
    ["chatgpt", "openai"],
    ["claude", "anthropic"],
    ["twitter", "x"],
    ["facebook", "meta"],
    ["instagram", "meta"],
    ["iplayer", "bbc"],
    ["china", "cn"],
    ["outside", "geolocation-!cn"],
    ["AI SERV", "category-ai-!cn"],
  ])("finds %s through its alias or label", async (query, name) => {
    const index = await loadIndex();
    expect(searchSiteGroups(index, query).popular.map((item) => item.name)).toContain(name);
  });

  test("ignores a typed geosite: prefix and @tags", async () => {
    const index = await loadIndex();
    expect(searchSiteGroups(index, "GeoSite:Google@cn").popular.map((item) => item.name)).toEqual([
      "google",
    ]);
  });

  test("no match gives empty sections", async () => {
    const index = await loadIndex();
    expect(searchSiteGroups(index, "qqqq")).toEqual({ popular: [], all: [] });
  });

  test(`caps a typed search at ${MAX_SEARCH_RESULTS} results`, () => {
    const index: SiteGroupIndexItem[] = Array.from({ length: 80 }, (_, i) => ({
      name: `site-${String(i).padStart(2, "0")}`,
      count: 1,
      label: `site-${String(i).padStart(2, "0")}`,
      aliases: [],
      featured: null,
    }));
    const { all } = searchSiteGroups(index, "site");
    expect(all).toHaveLength(MAX_SEARCH_RESULTS);
    expect(all[0].name).toBe("site-00");
    // The empty query isn't capped.
    expect(searchSiteGroups(index, "").all).toHaveLength(80);
  });
});

// ── Display strings ──────────────────────────────────────────────────────────

describe("describeEntry", () => {
  test("a typed pattern shows as stored, with no meta", () => {
    expect(describeEntry("*.example.com")).toEqual({
      title: "*.example.com",
      meta: null,
      tooltip: "*.example.com",
      warning: false,
      kind: "typed",
    });
  });

  test("an exact address shows the address and 'Exact address only'", () => {
    expect(describeEntry("=https://mail.example.com:8443")).toEqual({
      title: "https://mail.example.com:8443",
      meta: "Exact address only",
      tooltip: "=https://mail.example.com:8443",
      warning: false,
      kind: "exact",
    });
  });

  test("a group shows its label and size, plus skipped rules", async () => {
    await load(reply({ "geosite:google": group("geosite:google") }));
    expect(describeEntry("geosite:google")).toEqual({
      title: "Google",
      meta: "964 sites · 2 rules skipped",
      tooltip: "geosite:google",
      warning: false,
      kind: "group",
    });
  });

  test("a tagged group shows each tag; a non-featured group shows its name", async () => {
    await load(
      reply({
        "geosite:google@ads@cn": group("geosite:google@ads@cn", { count: 4, skipped: 0 }),
        "geosite:category-ads-all": group("geosite:category-ads-all", {
          name: "category-ads-all",
          count: 6000,
          skipped: 0,
        }),
      })
    );
    expect(describeEntry("geosite:google@ads@cn")).toMatchObject({
      title: "Google @ads @cn",
      meta: "4 sites",
    });
    expect(describeEntry("geosite:category-ads-all")).toMatchObject({
      title: "category-ads-all",
      meta: `${formatCount(6000)} sites`,
    });
  });

  test("one site and one skipped rule read in the singular", async () => {
    await load(
      reply({
        "geosite:youtube@cn": group("geosite:youtube@cn", {
          name: "youtube",
          count: 1,
          skipped: 1,
        }),
      })
    );
    expect(describeEntry("geosite:youtube@cn")).toMatchObject({
      title: "YouTube @cn",
      meta: "1 site · 1 rule skipped",
    });
  });

  test("a group without data shows 'Not available' as a warning", () => {
    expect(describeEntry("geosite:netflix")).toEqual({
      title: "Netflix",
      meta: "Not available",
      tooltip: "geosite:netflix",
      warning: true,
      kind: "group",
    });
  });

  test("a link shows its name, size, host and skipped rules, with the URL as the tooltip", async () => {
    await load(
      reply({
        [LINK_TOKEN]: group(LINK_TOKEN, { name: "direct-list", count: 110_197, skipped: 8 }),
      }),
      settingsWith({ denylist: [LINK_TOKEN] })
    );
    expect(describeEntry(LINK_TOKEN)).toEqual({
      title: "direct-list",
      meta: `${formatCount(110_197)} sites · from raw.githubusercontent.com · 8 rules skipped`,
      tooltip: LINK_URL,
      warning: false,
      kind: "link",
    });
  });

  test("a link whose last refresh failed says so as a warning", async () => {
    await load(
      reply({ [LINK_TOKEN]: group(LINK_TOKEN, { name: "direct-list", lastError: "LINK_FAILED" }) }),
      settingsWith({ denylist: [LINK_TOKEN] })
    );
    expect(describeEntry(LINK_TOKEN)).toMatchObject({
      title: "direct-list",
      meta: "Couldn't update this list",
      warning: true,
    });
  });

  test("a link without data shows 'Not available'", () => {
    expect(describeEntry(LINK_TOKEN)).toMatchObject({
      title: "direct-list",
      meta: "Not available",
      tooltip: LINK_URL,
      warning: true,
      kind: "link",
    });
  });

  test("an unsaved entry without data isn't a warning: a group shows its catalog count", async () => {
    const unsaved = { unsaved: true };
    // Before the index loads there's no count to show.
    expect(describeEntry("geosite:netflix", unsaved)).toEqual({
      title: "Netflix",
      meta: null,
      tooltip: "geosite:netflix",
      warning: false,
      kind: "group",
    });
    await loadIndex();
    const netflix = INDEX_REPLY.lists.find((list) => list.name === "netflix")!;
    expect(describeEntry("geosite:netflix", unsaved)).toMatchObject({
      meta: `${netflix.count} sites`,
      warning: false,
    });
    // The index counts the whole list, not what a tag keeps.
    expect(describeEntry("geosite:netflix@us", unsaved)).toMatchObject({
      meta: null,
      warning: false,
    });
    expect(describeEntry(LINK_TOKEN, unsaved)).toEqual({
      title: "direct-list",
      meta: null,
      tooltip: LINK_URL,
      warning: false,
      kind: "link",
    });
    // Saved entries without data still say so.
    expect(describeEntry("geosite:netflix")).toMatchObject({ warning: true });
  });
});

describe("formatting in the popup's UI language", () => {
  afterEach(() => {
    Reflect.deleteProperty(browser, "i18n");
  });

  test("counts and dates follow the browser UI language", () => {
    Object.assign(browser, {
      i18n: { getUILanguage: () => "de", getMessage: () => "" },
    });
    expect(formatCount(110_197)).toBe("110.197");
    expect(formatCatalogDate(Date.parse(STATUS.releasedAt))).toBe(
      new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(STATUS.releasedAt))
    );
  });

  test("a Chrome locale code like pt_BR works", () => {
    Object.assign(browser, {
      i18n: { getUILanguage: () => "pt_BR", getMessage: () => "" },
    });
    expect(formatCount(1234)).toBe(new Intl.NumberFormat("pt-BR").format(1234));
  });

  test("with no known language, the defaults; a bad date is empty", () => {
    expect(formatCount(1234)).toBe(new Intl.NumberFormat().format(1234));
    expect(formatCatalogDate(Date.parse(STATUS.releasedAt))).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
        new Date(STATUS.releasedAt)
      )
    );
    expect(formatCatalogDate(Number.NaN)).toBe("");
  });
});

describe("messages", () => {
  test.each([
    ["UNKNOWN_GROUP", "geosite:googel", "No site group is called googel."],
    ["EMPTY_GROUP", "geosite:google@zz", "Google has no sites with that tag."],
    ["LINK_FAILED", LINK_TOKEN, "Couldn't download that list. Check the link and try again."],
    ["LINK_EMPTY", LINK_TOKEN, "That list has no sites GeoSpoof can use."],
    [
      "LINK_TOO_LARGE",
      LINK_TOKEN,
      `That list is too large. GeoSpoof supports up to ${formatCount(250_000)} sites per list.`,
    ],
    ["STORAGE_FULL", "geosite:google", "Site groups are out of space. Remove a large list first."],
  ] as const)("%s", (code, token, text) => {
    expect(siteGroupErrorText(code, token)).toBe(text);
  });

  test("the link-added announcement, with and without skipped rules", () => {
    expect(linkAddedText(LINK_TOKEN, { count: 110_197, skipped: 0 })).toBe(
      `Added direct-list: ${formatCount(110_197)} sites.`
    );
    expect(linkAddedText(LINK_TOKEN, { count: 5, skipped: 8 })).toBe(
      "Added direct-list: 5 sites, 8 rules skipped."
    );
  });

  test("one site and one skipped rule read in the singular", () => {
    expect(linkAddedText(LINK_TOKEN, { count: 1, skipped: 0 })).toBe("Added direct-list: 1 site.");
    expect(linkAddedText(LINK_TOKEN, { count: 1, skipped: 1 })).toBe(
      "Added direct-list: 1 site, 1 rule skipped."
    );
  });
});
