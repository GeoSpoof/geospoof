/**
 * GET_SITE_GROUPS, GET_SITE_GROUP_INDEX and UPDATE_SITE_GROUPS through the
 * background's message router, with and without the Safari gate.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import type {
  ScopeResponse,
  SiteGroupIndexResponse,
  SiteGroupsResponse,
  SiteGroupsUpdateResponse,
} from "@/shared/types/messages";
import {
  CATALOG_A,
  CATALOG_B,
  POINTER_URL,
  cdnRoutes,
  fetchedUrls,
  installLocalStore,
  responseAt,
  routeFetch,
  type LocalStore,
} from "../../helpers/site-groups";

const gate = vi.hoisted(() => ({ available: true }));
vi.mock("@/shared/site-groups/availability", () => ({
  siteGroupsAvailable: () => gate.available,
}));

const LINK_URL = "https://lists.example.org/rules/direct-list.txt";
const LINK = `list:${LINK_URL}`;

let store: LocalStore;

async function boot() {
  vi.resetModules();
  store = installLocalStore({
    settings: { ...DEFAULT_SETTINGS, enabled: true, scopeMode: "allowlist" },
  });
  vi.mocked(browser.tabs.query).mockResolvedValue([]);
  vi.mocked(browser.alarms.get).mockResolvedValue(undefined);
  const bg = await import("@/background");
  const send = <T>(type: string, payload?: unknown) =>
    bg.handleMessage({ type, payload } as never, {}) as Promise<T>;
  return { ...bg, send };
}

beforeEach(() => {
  gate.available = true;
  routeFetch();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("site group messages", () => {
  test("GET_SITE_GROUPS lists every stored token with its data and the status", async () => {
    const { send } = await boot();
    routeFetch({ [LINK_URL]: (url) => responseAt(url, "example.com\nregexp:^a\n") });
    expect(
      await send<ScopeResponse>("ADD_SCOPE_SITE", { list: "allowlist", pattern: "geosite:google" })
    ).toEqual({ success: true, siteGroup: { count: 3, skipped: 2 } });
    expect(
      await send<ScopeResponse>("ADD_SCOPE_SITE", { list: "allowlist", pattern: LINK })
    ).toEqual({ success: true, siteGroup: { count: 1, skipped: 1 } });

    const res = await send<SiteGroupsResponse>("GET_SITE_GROUPS");

    expect(res.available).toBe(true);
    expect(res.status).toEqual({
      release: CATALOG_A.release,
      releasedAt: CATALOG_A.releasedAt,
      checkedAt: null,
      lastError: null,
      updating: false,
    });
    expect(res.groups["geosite:google"]).toEqual({
      token: "geosite:google",
      kind: "group",
      name: "google",
      count: 3,
      skipped: 2,
      updatedAt: expect.any(Number) as number,
      d: "\ngoogle.com\ngoogle.cn\n",
      f: "\nwww.google.com\n",
    });
    expect(res.groups[LINK]).toMatchObject({
      token: LINK,
      kind: "link",
      name: "direct-list",
      count: 1,
      skipped: 1,
      lastError: null,
      d: "\nexample.com\n",
    });
  });

  test("GET_SITE_GROUP_INDEX lists every catalog list by name with its count", async () => {
    const { send } = await boot();
    expect(await send<SiteGroupIndexResponse>("GET_SITE_GROUP_INDEX")).toEqual({
      release: CATALOG_A.release,
      lists: [
        { name: "empty", count: 0 },
        { name: "google", count: 3 },
        { name: "youtube", count: 1 },
      ],
    });
  });

  test("UPDATE_SITE_GROUPS runs a manual refresh and answers its status", async () => {
    const { send } = await boot();
    const fetchMock = routeFetch(await cdnRoutes(CATALOG_B));
    const res = await send<SiteGroupsUpdateResponse>("UPDATE_SITE_GROUPS");
    expect(res).toEqual({
      success: true,
      status: {
        release: CATALOG_B.release,
        releasedAt: CATALOG_B.releasedAt,
        checkedAt: expect.any(Number) as number,
        lastError: null,
        updating: false,
      },
    });
    expect(fetchedUrls(fetchMock)).toContain(POINTER_URL);
    // The picker's index follows the newer catalog.
    const index = await send<SiteGroupIndexResponse>("GET_SITE_GROUP_INDEX");
    expect(index.release).toBe(CATALOG_B.release);
    expect(index.lists.map((l) => l.name)).toEqual(["empty", "google"]);
  });

  test("UPDATE_SITE_GROUPS reports a network failure", async () => {
    const { send } = await boot();
    routeFetch({});
    const res = await send<SiteGroupsUpdateResponse>("UPDATE_SITE_GROUPS");
    expect(res).toMatchObject({ error: "NETWORK", status: { lastError: "NETWORK" } });
  });

  describe("where site groups aren't available (Safari)", () => {
    beforeEach(() => {
      gate.available = false;
    });

    test("every message answers without a request", async () => {
      const { send } = await boot();
      const fetchMock = routeFetch(await cdnRoutes(CATALOG_B));
      const status = {
        release: null,
        releasedAt: null,
        checkedAt: null,
        lastError: null,
        updating: false,
      };
      expect(await send<SiteGroupsResponse>("GET_SITE_GROUPS")).toEqual({
        available: false,
        status,
        groups: {},
      });
      expect(await send<SiteGroupIndexResponse>("GET_SITE_GROUP_INDEX")).toEqual({
        release: null,
        lists: [],
      });
      expect(await send<SiteGroupsUpdateResponse>("UPDATE_SITE_GROUPS")).toEqual({
        error: "NOT_AVAILABLE",
        status,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.writes).toEqual([]);
    });
  });
});
