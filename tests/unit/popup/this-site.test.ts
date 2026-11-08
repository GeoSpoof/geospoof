/**
 * The THIS SITE card model, row by row (direction.md 6.1, option a), with
 * Scenarios S, S0 and D of direction.md 5.0, plus the list screens' status
 * line, the own-location check and the mark keys.
 */
import { describe, it, expect } from "vitest";
import type { Settings, SiteLocation } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import { createSiteGroupLookup, frameEntries } from "@/shared/site-groups/matcher";
import { isRestrictedUrl } from "@/background/restricted-url";
import {
  computeThisSiteCard,
  isOwnFilterEntry,
  listScreenSiteStatus,
  ownSiteLocationExists,
  siteLocationMarkText,
  type CardUndo,
  type ThisSiteCard,
} from "@/popup/this-site";
import { TOKYO, TOKYO_NAME, TOKYO_TZ, makeSiteLocation } from "../../helpers/site-locations";

const GROUPS = createSiteGroupLookup({
  "geosite:google": {
    d: frameEntries(["google.com", "youtube.com"]),
    f: frameEntries([]),
    n: 964,
  },
});

const PARIS: SiteLocation = makeSiteLocation({
  id: "paris",
  patterns: ["example.com"],
  location: { latitude: 48.8566, longitude: 2.3522, accuracy: 45 },
  locationName: { city: "Paris", country: "France", displayName: "Paris, France" },
});
const LOS_ANGELES: SiteLocation = makeSiteLocation({
  id: "los-angeles",
  patterns: ["twitch.tv"],
  location: { latitude: 34.0522, longitude: -118.2437, accuracy: 45 },
  locationName: {
    city: "Los Angeles",
    country: "United States",
    displayName: "Los Angeles, United States",
  },
});

const S_ALLOWLIST = ["example.com", "=mail.example.com", "geosite:google", "*.ru"];

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    location: TOKYO,
    timezone: TOKYO_TZ,
    locationName: TOKYO_NAME,
    ...overrides,
  };
}

/** Scenario S: the Allowlist, with Paris for example.com and Los Angeles for twitch.tv. */
const S = settings({
  scopeMode: "allowlist",
  allowlist: S_ALLOWLIST,
  denylist: [],
  siteLocations: [PARIS, LOS_ANGELES],
});
/** Scenario S0: All sites, empty lists, no per-site locations. */
const S0 = settings({ scopeMode: "all", allowlist: [], denylist: [], siteLocations: [] });
/** Scenario D: the Denylist `twitch.tv`, `*.ru`; the inactive allowlist and per-site locations as in S. */
const D = settings({
  scopeMode: "denylist",
  allowlist: S_ALLOWLIST,
  denylist: ["twitch.tv", "*.ru"],
  siteLocations: [PARIS, LOS_ANGELES],
});

function card(
  s: Settings,
  tabUrl: string | undefined,
  extra: { proLocked?: boolean; isOptionsPage?: boolean; undo?: CardUndo | null } = {}
): ThisSiteCard {
  return computeThisSiteCard({
    settings: s,
    tabUrl,
    proLocked: extra.proLocked ?? false,
    isOptionsPage: extra.isOptionsPage ?? false,
    isRestricted: isRestrictedUrl,
    siteGroups: GROUPS,
    undo: extra.undo ?? null,
  });
}

const tokyo = { kind: "place", name: "Tokyo" } as const;
const none = { kind: "none" } as const;

describe("computeThisSiteCard: the rows of 6.1", () => {
  describe.each([
    ["Allowlist", S],
    ["Denylist", D],
  ])("in the %s", (_mode, scenario) => {
    it("row 1: hidden on restricted pages, the options tab, and without a site", () => {
      expect(card(scenario, undefined)).toEqual({ kind: "hidden" });
      expect(card(scenario, "about:blank")).toEqual({ kind: "hidden" });
      expect(card(scenario, "chrome://extensions/")).toEqual({ kind: "hidden" });
      expect(card(scenario, "https://addons.mozilla.org/")).toEqual({ kind: "hidden" });
      expect(card(scenario, "https://example.com/", { isOptionsPage: true })).toEqual({
        kind: "hidden",
      });
      // A single-label host has no site pattern.
      expect(card(scenario, "http://intranet/")).toEqual({ kind: "hidden" });
    });

    it("row 2: Location Protection off is plain and offers Turn On Location Protection", () => {
      expect(card({ ...scenario, enabled: false }, "https://example.com/")).toEqual({
        kind: "shown",
        row: 2,
        site: "example.com",
        tabUrl: "https://example.com/",
        value: { kind: "off" },
        source: "protection",
        opens: none,
        reason: none,
        button: { action: "turnOn" },
      });
    });

    it("row 3: Safari without Pro shows the main location as plain text", () => {
      expect(card(scenario, "https://www.twitch.tv/", { proLocked: true })).toEqual({
        kind: "shown",
        row: 3,
        site: "twitch.tv",
        tabUrl: "https://www.twitch.tv/",
        value: tokyo,
        source: "main",
        opens: none,
        reason: none,
        button: null,
      });
    });

    it("row 3: Not set is plain and offers Set Location", () => {
      const c = card({ ...scenario, location: null, locationName: null }, "https://example.com/", {
        proLocked: true,
      });
      expect(c).toMatchObject({
        row: 3,
        value: { kind: "notSet" },
        source: "main",
        opens: none,
        button: { action: "setLocation" },
      });
    });
  });

  it("row 4: All sites with the main location opens a new entry (S0)", () => {
    expect(card(S0, "https://chatgpt.com/")).toEqual({
      kind: "shown",
      row: 4,
      site: "chatgpt.com",
      tabUrl: "https://chatgpt.com/",
      value: tokyo,
      source: "main",
      opens: { kind: "new" },
      reason: none,
      button: null,
    });
  });

  it("row 4: a per-site location opens its editor; Not set is plain and offers Set Location", () => {
    expect(card({ ...S0, siteLocations: [LOS_ANGELES] }, "https://www.twitch.tv/")).toMatchObject({
      row: 4,
      value: { kind: "place", name: "Los Angeles" },
      source: "site",
      opens: { kind: "edit", entryId: "los-angeles" },
    });
    expect(
      card({ ...S0, location: null, locationName: null }, "https://chatgpt.com/")
    ).toMatchObject({
      row: 4,
      value: { kind: "notSet" },
      source: "main",
      opens: none,
      button: { action: "setLocation" },
    });
  });

  it("Not set: a list change keeps the button; Set Location takes it where none shows", () => {
    const unset = { location: null, locationName: null };
    // Row 5: the own entry's Remove stays.
    expect(card({ ...S, ...unset, siteLocations: [] }, "https://example.com/")).toMatchObject({
      row: 5,
      value: { kind: "notSet" },
      opens: none,
      button: { action: "remove", list: "allowlist", pattern: "example.com" },
    });
    // Row 6: covered by *.ru, no list change, so Set Location.
    expect(card({ ...S, ...unset }, "https://example.ru/")).toMatchObject({
      row: 6,
      value: { kind: "notSet" },
      opens: none,
      button: { action: "setLocation" },
    });
    // Row 12: Add to Denylist stays.
    expect(card({ ...D, ...unset }, "https://chatgpt.com/")).toMatchObject({
      row: 12,
      value: { kind: "notSet" },
      opens: none,
      button: { action: "add", list: "denylist", pattern: "chatgpt.com" },
    });
  });

  it("row 5: the Allowlist's own entry decides and flips (S, example.com)", () => {
    expect(card(S, "https://example.com/")).toEqual({
      kind: "shown",
      row: 5,
      site: "example.com",
      tabUrl: "https://example.com/",
      value: { kind: "place", name: "Paris" },
      source: "site",
      opens: { kind: "edit", entryId: "paris" },
      reason: none,
      button: { action: "remove", list: "allowlist", pattern: "example.com" },
    });
  });

  it("row 6: covered by a broader entry (S, yandex.ru)", () => {
    expect(card(S, "https://yandex.ru/")).toEqual({
      kind: "shown",
      row: 6,
      site: "yandex.ru",
      tabUrl: "https://yandex.ru/",
      value: tokyo,
      source: "main",
      opens: { kind: "new" },
      reason: { kind: "coveredBy", entry: "*.ru" },
      button: null,
    });
  });

  it("row 6: covered by a site group (S, www.google.com)", () => {
    expect(card(S, "https://www.google.com/")).toMatchObject({
      row: 6,
      site: "google.com",
      reason: { kind: "coveredBy", entry: "geosite:google" },
      button: null,
    });
  });

  it("row 7: off, with a typed entry covering some pages", () => {
    const s = settings({ scopeMode: "allowlist", allowlist: ["twitch.tv/videos/*"] });
    expect(card(s, "https://twitch.tv/")).toEqual({
      kind: "shown",
      row: 7,
      site: "twitch.tv",
      tabUrl: "https://twitch.tv/",
      value: { kind: "off" },
      source: "none",
      opens: none,
      reason: { kind: "somePages" },
      button: { action: "add", list: "allowlist", pattern: "twitch.tv" },
    });
  });

  it("row 8: off and not listed (S, www.twitch.tv adds twitch.tv)", () => {
    expect(card(S, "https://www.twitch.tv/")).toEqual({
      kind: "shown",
      row: 8,
      site: "twitch.tv",
      tabUrl: "https://www.twitch.tv/",
      value: { kind: "off" },
      source: "none",
      opens: none,
      reason: none,
      button: { action: "add", list: "allowlist", pattern: "twitch.tv" },
    });
  });

  it("row 9: the Denylist's own entry decides and flips (D, www.twitch.tv)", () => {
    expect(card(D, "https://www.twitch.tv/")).toEqual({
      kind: "shown",
      row: 9,
      site: "twitch.tv",
      tabUrl: "https://www.twitch.tv/",
      value: { kind: "off" },
      source: "none",
      opens: none,
      reason: none,
      button: { action: "remove", list: "denylist", pattern: "twitch.tv" },
    });
  });

  it("row 10: off, covered by a broader entry (D, yandex.ru)", () => {
    expect(card(D, "https://yandex.ru/")).toEqual({
      kind: "shown",
      row: 10,
      site: "yandex.ru",
      tabUrl: "https://yandex.ru/",
      value: { kind: "off" },
      source: "none",
      opens: none,
      reason: { kind: "coveredBy", entry: "*.ru" },
      button: null,
    });
  });

  it("row 11: on, with a typed Denylist entry covering some pages", () => {
    const s = settings({
      scopeMode: "denylist",
      denylist: ["twitch.tv/videos/*"],
      siteLocations: [LOS_ANGELES],
    });
    expect(card(s, "https://twitch.tv/")).toEqual({
      kind: "shown",
      row: 11,
      site: "twitch.tv",
      tabUrl: "https://twitch.tv/",
      value: { kind: "place", name: "Los Angeles" },
      source: "site",
      opens: { kind: "edit", entryId: "los-angeles" },
      reason: { kind: "somePages" },
      button: { action: "add", list: "denylist", pattern: "twitch.tv" },
    });
  });

  it("row 12: on and not listed (D, chatgpt.com)", () => {
    expect(card(D, "https://chatgpt.com/")).toEqual({
      kind: "shown",
      row: 12,
      site: "chatgpt.com",
      tabUrl: "https://chatgpt.com/",
      value: tokyo,
      source: "main",
      opens: { kind: "new" },
      reason: none,
      button: { action: "add", list: "denylist", pattern: "chatgpt.com" },
    });
  });
});

describe("computeThisSiteCard: which entry rows 6 and 10 name (M12)", () => {
  it("Allowlist [twitch.tv, *.tv] on twitch.tv: covered by *.tv, no button", () => {
    const s = settings({ scopeMode: "allowlist", allowlist: ["twitch.tv", "*.tv"] });
    expect(card(s, "https://twitch.tv/")).toMatchObject({
      row: 6,
      reason: { kind: "coveredBy", entry: "*.tv" },
      button: null,
    });
  });

  it("Denylist [twitch.tv, *.tv] on twitch.tv: covered by *.tv, no button", () => {
    const s = settings({ scopeMode: "denylist", denylist: ["twitch.tv", "*.tv"] });
    expect(card(s, "https://twitch.tv/")).toMatchObject({
      row: 10,
      reason: { kind: "coveredBy", entry: "*.tv" },
      button: null,
    });
  });

  it("Allowlist [twitch.tv, www.twitch.tv] on www.twitch.tv: covered by twitch.tv", () => {
    const s = settings({ scopeMode: "allowlist", allowlist: ["twitch.tv", "www.twitch.tv"] });
    expect(card(s, "https://www.twitch.tv/")).toMatchObject({
      row: 6,
      site: "twitch.tv",
      reason: { kind: "coveredBy", entry: "twitch.tv" },
      button: null,
    });
  });

  it("Allowlist [*.tv] on twitch.tv: covered by *.tv", () => {
    const s = settings({ scopeMode: "allowlist", allowlist: ["*.tv"] });
    expect(card(s, "https://twitch.tv/")).toMatchObject({
      row: 6,
      reason: { kind: "coveredBy", entry: "*.tv" },
      button: null,
    });
  });
});

describe("computeThisSiteCard: the subtitle", () => {
  it("names a per-site pattern that isn't the site's own", () => {
    const google = makeSiteLocation({
      id: "google",
      patterns: ["geosite:google", "*.google.com"],
    });
    const s = { ...S, siteLocations: [PARIS, LOS_ANGELES, google] };
    expect(card(s, "https://www.google.com/")).toMatchObject({
      value: { kind: "place", name: "Dublin" },
      source: { entry: "*.google.com" },
      opens: { kind: "edit", entryId: "google" },
    });
  });
});

describe("computeThisSiteCard: undo of a card Remove", () => {
  const tab = "https://mail.example.com/";
  const before = settings({ scopeMode: "allowlist", allowlist: ["=mail.example.com"] });
  const after = settings({ scopeMode: "allowlist", allowlist: [] });

  it("offers to remove the exact entry", () => {
    expect(card(before, tab)).toMatchObject({
      row: 5,
      button: { action: "remove", list: "allowlist", pattern: "=mail.example.com" },
    });
  });

  it("adds the removed entry back exactly", () => {
    const undo: CardUndo = { tabUrl: tab, list: "allowlist", entry: "=mail.example.com" };
    expect(card(after, tab, { undo })).toMatchObject({
      row: 8,
      button: { action: "add", list: "allowlist", pattern: "=mail.example.com" },
    });
  });

  it("adds the site on another tab or without a record", () => {
    const undo: CardUndo = {
      tabUrl: "https://mail.example.com/inbox",
      list: "allowlist",
      entry: "=mail.example.com",
    };
    expect(card(after, tab, { undo })).toMatchObject({
      button: { action: "add", list: "allowlist", pattern: "mail.example.com" },
    });
    expect(card(after, tab)).toMatchObject({
      button: { action: "add", list: "allowlist", pattern: "mail.example.com" },
    });
  });

  it("round-trips in the Denylist too", () => {
    const undo: CardUndo = { tabUrl: tab, list: "denylist", entry: "=mail.example.com" };
    const denied = settings({ scopeMode: "denylist", denylist: ["=mail.example.com"] });
    expect(card(denied, tab)).toMatchObject({
      row: 9,
      button: { action: "remove", list: "denylist", pattern: "=mail.example.com" },
    });
    expect(card({ ...denied, denylist: [] }, tab, { undo })).toMatchObject({
      row: 12,
      button: { action: "add", list: "denylist", pattern: "=mail.example.com" },
    });
  });
});

describe("isOwnFilterEntry", () => {
  it("accepts the site's and the tab's host in any typed spelling", () => {
    expect(
      isOwnFilterEntry("=mail.example.com", "mail.example.com", "https://mail.example.com/")
    ).toBe(true);
    expect(isOwnFilterEntry("https://example.com", "example.com", "https://example.com/")).toBe(
      true
    );
    expect(isOwnFilterEntry("localhost:3000", "localhost", "http://localhost:3000/")).toBe(true);
    expect(isOwnFilterEntry("www.twitch.tv", "twitch.tv", "https://www.twitch.tv/")).toBe(true);
    expect(isOwnFilterEntry("münchen.de", "xn--mnchen-3ya.de", "https://xn--mnchen-3ya.de/")).toBe(
      true
    );
  });

  it("rejects tokens, paths, wildcards and other hosts", () => {
    expect(isOwnFilterEntry("geosite:google", "google.com", "https://google.com/")).toBe(false);
    expect(isOwnFilterEntry("twitch.tv/videos/*", "twitch.tv", "https://twitch.tv/")).toBe(false);
    expect(isOwnFilterEntry("*.twitch.tv", "twitch.tv", "https://www.twitch.tv/")).toBe(false);
    expect(isOwnFilterEntry("*", "twitch.tv", "https://twitch.tv/")).toBe(false);
    expect(isOwnFilterEntry("*.tv", "twitch.tv", "https://twitch.tv/")).toBe(false);
    expect(isOwnFilterEntry("example.com", "mail.example.com", "https://mail.example.com/")).toBe(
      false
    );
  });
});

describe("listScreenSiteStatus", () => {
  const status = (
    s: Settings,
    list: "allowlist" | "denylist",
    tabUrl?: string,
    isOptionsPage = false
  ) =>
    listScreenSiteStatus({
      settings: s,
      list,
      tabUrl,
      isOptionsPage,
      isRestricted: isRestrictedUrl,
      siteGroups: GROUPS,
    });

  it("offers to add, shows listed, or names the covering entry", () => {
    expect(status(S, "allowlist", "https://www.twitch.tv/")).toEqual({
      kind: "add",
      site: "twitch.tv",
    });
    expect(status(S, "allowlist", "https://example.com/")).toEqual({
      kind: "listed",
      site: "example.com",
    });
    expect(status(S, "allowlist", "https://yandex.ru/")).toEqual({
      kind: "coveredBy",
      site: "yandex.ru",
      entry: "*.ru",
    });
    // The inactive list's screen reads that list.
    expect(status(S, "denylist", "https://example.com/")).toEqual({
      kind: "add",
      site: "example.com",
    });
    expect(status(D, "denylist", "https://www.twitch.tv/")).toEqual({
      kind: "listed",
      site: "twitch.tv",
    });
  });

  it("is none without a usable site", () => {
    expect(status(S, "allowlist", undefined)).toEqual({ kind: "none" });
    expect(status(S, "allowlist", "about:blank")).toEqual({ kind: "none" });
    expect(status(S, "allowlist", "http://intranet/")).toEqual({ kind: "none" });
    expect(status(S, "allowlist", "https://example.com/", true)).toEqual({ kind: "none" });
  });
});

describe("ownSiteLocationExists", () => {
  it("finds an entry with the site's own pattern", () => {
    expect(ownSiteLocationExists([PARIS, LOS_ANGELES], "twitch.tv", "https://www.twitch.tv/")).toBe(
      true
    );
    expect(ownSiteLocationExists([PARIS, LOS_ANGELES], "chatgpt.com", "https://chatgpt.com/")).toBe(
      false
    );
    const wildcard = makeSiteLocation({ patterns: ["*.twitch.tv"] });
    expect(ownSiteLocationExists([wildcard], "twitch.tv", "https://www.twitch.tv/")).toBe(false);
  });
});

describe("siteLocationMarkText", () => {
  it("uses the plain key only for a one-site entry (M13)", () => {
    expect(siteLocationMarkText({ kind: "none" })).toBeNull();
    expect(siteLocationMarkText({ kind: "off", hosts: ["twitch.tv"], single: true })).toEqual({
      key: "siteLocation_notUsed",
    });
    expect(siteLocationMarkText({ kind: "off", hosts: ["twitch.tv"], single: false })).toEqual({
      key: "siteLocation_notUsedOn",
      hosts: ["twitch.tv"],
    });
    expect(siteLocationMarkText({ kind: "somePages", hosts: ["a.com"], single: true })).toEqual({
      key: "siteLocation_somePages",
    });
    expect(
      siteLocationMarkText({ kind: "somePages", hosts: ["a.com", "b.com"], single: false })
    ).toEqual({ key: "siteLocation_somePagesOn", hosts: ["a.com", "b.com"] });
  });
});
