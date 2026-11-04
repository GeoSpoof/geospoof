/**
 * The background's site group data store: validation of the stored value, the
 * token scan, the in-memory cache that `loadSettings` loads, and the write.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import type { Settings } from "@/shared/types/settings";
import { NO_SITE_GROUPS } from "@/shared/site-groups/matcher";
import {
  SITE_GROUP_DATA_KEY,
  __resetSiteGroupStoreForTest,
  currentSiteGroupData,
  currentSiteGroups,
  ensureSiteGroupCache,
  loadSiteGroupCache,
  referencedSiteGroupTokens,
  validateStoredSiteGroupData,
  writeSiteGroupData,
} from "@/background/site-groups-store";
import { loadSettings } from "@/background/settings";
import { installLocalStore, storedGroup, type LocalStore } from "../../helpers/site-groups";
import { makeSiteLocation } from "../../helpers/site-locations";

const T = "geosite:t";
const LINK = "list:https://example.org/direct-list.txt";

function settingsWith(overrides: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

let store: LocalStore;

beforeEach(() => {
  __resetSiteGroupStoreForTest();
  store = installLocalStore();
});

describe("validateStoredSiteGroupData", () => {
  test("keeps well-formed entries and repairs optional fields", () => {
    const groups = validateStoredSiteGroupData({
      v: 1,
      groups: {
        [T]: { d: "\nexample.com\n", f: "\n", n: 1, source: "catalog", materializedAt: 5 },
        [LINK]: {
          d: "\n",
          f: "\nmail.example.org\n",
          n: 1,
          skipped: 3,
          source: "bogus",
          fetchedAt: 9,
          lastError: "LINK_FAILED",
          missingUpstream: "yes",
        },
      },
    });
    expect(groups[T]).toEqual({
      d: "\nexample.com\n",
      f: "\n",
      n: 1,
      skipped: 0,
      source: "catalog",
      materializedAt: 5,
    });
    // An unknown source is derived from the token; a non-boolean flag is dropped.
    expect(groups[LINK]).toEqual({
      d: "\n",
      f: "\nmail.example.org\n",
      n: 1,
      skipped: 3,
      source: "link",
      fetchedAt: 9,
      lastError: "LINK_FAILED",
      materializedAt: 0,
    });
  });

  test("drops malformed entries", () => {
    const groups = validateStoredSiteGroupData({
      v: 1,
      groups: {
        "example.com": { d: "\nexample.com\n", f: "\n", n: 1 },
        "geosite:unframed": { d: "example.com", f: "\n", n: 1 },
        "geosite:nof": { d: "\nexample.com\n", n: 1 },
        "geosite:negative": { d: "\nexample.com\n", f: "\n", n: -1 },
        "geosite:nan": { d: "\nexample.com\n", f: "\n", n: Number.NaN },
        "geosite:array": [],
        "geosite:ok": { d: "\nexample.com\n", f: "\n", n: 1 },
      },
    });
    expect(Object.keys(groups)).toEqual(["geosite:ok"]);
  });

  test("anything but { v: 1, groups } gives {}", () => {
    for (const raw of [undefined, null, 42, "x", [], {}, { v: 2, groups: {} }, { v: 1 }]) {
      expect(validateStoredSiteGroupData(raw)).toEqual({});
    }
  });
});

describe("referencedSiteGroupTokens", () => {
  test("scans the allowlist, the denylist and every site location, deduped in order", () => {
    const settings = settingsWith({
      allowlist: ["example.com", "geosite:google", "=mail.example.com"],
      denylist: [LINK, "geosite:google"],
      siteLocations: [
        makeSiteLocation({ id: "a", patterns: ["chatgpt.com", "geosite:openai"] }),
        makeSiteLocation({ id: "b", patterns: [LINK, "geosite:youtube"] }),
      ],
    });
    expect(referencedSiteGroupTokens(settings)).toEqual([
      "geosite:google",
      LINK,
      "geosite:openai",
      "geosite:youtube",
    ]);
  });

  test("typed and exact entries are not tokens", () => {
    expect(
      referencedSiteGroupTokens(settingsWith({ allowlist: ["*.ru", "=example.com"] }))
    ).toEqual([]);
  });
});

describe("the cache", () => {
  test("nothing referenced: no read, and every token matches nothing", () => {
    expect(ensureSiteGroupCache(settingsWith({ allowlist: ["example.com"] }))).toBeNull();
    expect(store.get).not.toHaveBeenCalled();
    expect(currentSiteGroups()).toBe(NO_SITE_GROUPS);
    expect(currentSiteGroupData()).toEqual({});
  });

  test("a referenced token loads the stored data once", async () => {
    store.data[SITE_GROUP_DATA_KEY] = { v: 1, groups: { [T]: storedGroup(["example.com"]) } };
    const settings = settingsWith({ allowlist: [T] });

    await Promise.all([ensureSiteGroupCache(settings), ensureSiteGroupCache(settings)]);
    expect(store.get).toHaveBeenCalledTimes(1);
    expect(store.get).toHaveBeenCalledWith(SITE_GROUP_DATA_KEY);
    expect(currentSiteGroups().has(T, "www.example.com")).toBe(true);
    expect(currentSiteGroups().size(T)).toBe(1);

    // Loaded: no further reads.
    expect(ensureSiteGroupCache(settings)).toBeNull();
    expect(store.get).toHaveBeenCalledTimes(1);
  });

  test("malformed stored data loads as empty", async () => {
    store.data[SITE_GROUP_DATA_KEY] = { v: 1, groups: { [T]: { d: "nope" } } };
    await ensureSiteGroupCache(settingsWith({ allowlist: [T] }));
    expect(currentSiteGroupData()).toEqual({});
    expect(currentSiteGroups().has(T, "example.com")).toBe(false);
  });

  test("a failed read never rejects, and the next load retries", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.get.mockRejectedValueOnce(new Error("storage down"));
    const settings = settingsWith({ allowlist: [T] });
    await expect(ensureSiteGroupCache(settings)).resolves.toBeUndefined();
    expect(currentSiteGroups()).toBe(NO_SITE_GROUPS);

    store.data[SITE_GROUP_DATA_KEY] = { v: 1, groups: { [T]: storedGroup(["example.com"]) } };
    await ensureSiteGroupCache(settings);
    expect(currentSiteGroups().has(T, "example.com")).toBe(true);
  });

  test("currentSiteGroups is memoized until the data changes", async () => {
    await writeSiteGroupData({ [T]: storedGroup(["example.com"]) });
    const first = currentSiteGroups();
    expect(currentSiteGroups()).toBe(first);
    await writeSiteGroupData({ [T]: storedGroup(["example.org"]) });
    const second = currentSiteGroups();
    expect(second).not.toBe(first);
    expect(second.has(T, "example.org")).toBe(true);
    expect(second.has(T, "example.com")).toBe(false);
  });

  test("loadSettings loads the cache before it resolves when a token is referenced", async () => {
    store.data.settings = settingsWith({ scopeMode: "allowlist", allowlist: [T] });
    store.data[SITE_GROUP_DATA_KEY] = { v: 1, groups: { [T]: storedGroup(["example.com"]) } };
    const settings = await loadSettings();
    expect(settings.allowlist).toEqual([T]);
    expect(currentSiteGroups().has(T, "example.com")).toBe(true);
  });

  test("loadSiteGroupCache rejects on a failed read (writers must not overwrite with {})", async () => {
    store.get.mockRejectedValueOnce(new Error("storage down"));
    await expect(loadSiteGroupCache()).rejects.toThrow("storage down");
  });
});

describe("writeSiteGroupData", () => {
  test("stores { v: 1, groups } and replaces the cache", async () => {
    const groups = { [T]: storedGroup(["example.com"]) };
    await writeSiteGroupData(groups);
    expect(store.data[SITE_GROUP_DATA_KEY]).toEqual({ v: 1, groups });
    expect(currentSiteGroupData()).toEqual(groups);
  });

  test("a quota error is retried once as remove + set", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.set.mockRejectedValueOnce(new Error("QuotaExceededError: Exceeded storage quota"));
    const groups = { [T]: storedGroup(["example.com"]) };
    await writeSiteGroupData(groups);
    expect(store.remove).toHaveBeenCalledWith(SITE_GROUP_DATA_KEY);
    expect(store.data[SITE_GROUP_DATA_KEY]).toEqual({ v: 1, groups });
    expect(currentSiteGroups().has(T, "example.com")).toBe(true);
  });

  test("any other error rejects and leaves the cache unchanged", async () => {
    await writeSiteGroupData({ [T]: storedGroup(["example.com"]) });
    store.set.mockRejectedValueOnce(new Error("disk on fire"));
    await expect(writeSiteGroupData({ [T]: storedGroup(["example.org"]) })).rejects.toThrow(
      "disk on fire"
    );
    expect(store.remove).not.toHaveBeenCalled();
    expect(currentSiteGroups().has(T, "example.com")).toBe(true);
  });
});
