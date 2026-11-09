/**
 * Site groups in the background (plan item 10): building data from the
 * bundled catalog, downloading lists from links, the weekly refresh with its
 * pointer and sha256 check, last-known-good data, pruning, the alarm, and the
 * Safari gate.
 *
 * `fetch` is routed per test; `crypto.subtle` is Node's; `storage.local` is a
 * multi-key stand-in, because the global mock only persists `settings`.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import type { Settings } from "@/shared/types/settings";
import { updateBootstrapRegistration } from "@/background/bootstrap-register";
import { loadSettings } from "@/background/settings";
import {
  BUNDLED_CATALOG_PATH,
  MAX_LINK_BYTES,
  SITE_GROUPS_REFRESH_ALARM,
  SITE_GROUPS_REFRESH_PERIOD_MINUTES,
  SITE_GROUP_CATALOG_KEY,
  SITE_GROUP_FULL_KEY,
  SITE_GROUP_STATUS_KEY,
  __resetSiteGroupsForTest,
  currentCatalog,
  ensureSiteGroupRefreshAlarm,
  fetchLinkList,
  handleGetSiteGroups,
  loadBundledCatalog,
  onSiteGroupsStartup,
  pruneSiteGroupDataSoon,
  refreshSiteGroups,
  repairSiteGroupDataSoon,
  safariRefreshDue,
  siteGroupRefreshDelayMinutes,
  withSiteGroupData,
} from "@/background/site-groups";
import {
  SITE_GROUP_DATA_KEY,
  __resetSiteGroupStoreForTest,
  currentSiteGroups,
  type StoredSiteGroup,
} from "@/background/site-groups-store";
import {
  BUNDLED_URL,
  CATALOG_A,
  CATALOG_B,
  POINTER_URL,
  cdnRoutes,
  fetchedUrls,
  installLocalStore,
  responseAt,
  routeFetch,
  storedGroup,
  storedGroups,
  type LocalStore,
  type Route,
} from "../../helpers/site-groups";
import { flush, installUserScriptsMock, until, type UserScriptsMock } from "../../helpers/cadence";
import { TOKYO, TOKYO_NAME, TOKYO_TZ } from "../../helpers/site-locations";

const gate = vi.hoisted(() => ({ available: true }));
vi.mock("@/shared/site-groups/availability", () => ({
  siteGroupsAvailable: () => gate.available,
}));

const GOOGLE = "geosite:google";
const YOUTUBE = "geosite:youtube";
const LINK_URL = "https://lists.example.org/rules/direct-list.txt";
const LINK = `list:${LINK_URL}`;

let store: LocalStore;

function settingsWith(overrides: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, enabled: true, ...overrides };
}

/** Store `settings` (validated on load, like the real one). */
function storeSettings(overrides: Partial<Settings>): void {
  store.data.settings = settingsWith(overrides);
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  gate.available = true;
  __resetSiteGroupsForTest();
  __resetSiteGroupStoreForTest();
  store = installLocalStore();
  routeFetch();
  vi.mocked(browser.alarms.get).mockResolvedValue(undefined);
  vi.mocked(browser.tabs.query).mockResolvedValue([]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the bundled catalog", () => {
  test("is fetched from the package and validated, once", async () => {
    const fetchMock = routeFetch();
    expect(browser.runtime.getURL(BUNDLED_CATALOG_PATH)).toBe(BUNDLED_URL);
    const [a, b] = await Promise.all([loadBundledCatalog(), loadBundledCatalog()]);
    expect(a?.release).toBe(CATALOG_A.release);
    expect(b).toBe(a);
    expect(fetchedUrls(fetchMock)).toEqual([BUNDLED_URL]);
  });

  test("an invalid bundled file gives null and is retried next time", async () => {
    routeFetch({}, { ...CATALOG_A, release: "nope" });
    expect(await loadBundledCatalog()).toBeNull();
    routeFetch();
    expect((await loadBundledCatalog())?.release).toBe(CATALOG_A.release);
  });

  test("a newer stored catalog wins over the bundled one", async () => {
    store.data[SITE_GROUP_CATALOG_KEY] = CATALOG_B;
    expect((await currentCatalog())?.release).toBe(CATALOG_B.release);
    __resetSiteGroupsForTest();
    store.data[SITE_GROUP_CATALOG_KEY] = { ...CATALOG_B, release: "20250101000000" };
    expect((await currentCatalog())?.release).toBe(CATALOG_A.release);
  });
});

describe("withSiteGroupData: groups", () => {
  test("builds the data from the bundled catalog, stores it, then runs the write", async () => {
    storeSettings({});
    const order: string[] = [];
    store.set.mockImplementation((obj: Record<string, unknown>) => {
      order.push(...Object.keys(obj));
      Object.assign(store.data, structuredClone(obj));
      return Promise.resolve();
    });
    const write = vi.fn(() => {
      order.push("write");
      store.data.settings = settingsWith({ allowlist: [GOOGLE] });
      return Promise.resolve("written");
    });

    const result = await withSiteGroupData([GOOGLE], write);

    expect(result).toEqual({
      ok: true,
      value: "written",
      added: { [GOOGLE]: { count: 3, skipped: 2 } },
    });
    expect(order).toEqual([SITE_GROUP_DATA_KEY, "write"]);
    const group = storedGroups(store)[GOOGLE];
    expect(group).toMatchObject({
      n: 3,
      skipped: 2,
      source: "catalog",
      release: CATALOG_A.release,
    });
    expect(group.d).toBe("\ngoogle.com\ngoogle.cn\n");
    expect(group.f).toBe("\nwww.google.com\n");
    expect(currentSiteGroups().has(GOOGLE, "mail.google.com")).toBe(true);
  });

  test("attrs filter with AND and count their own skipped rules", async () => {
    storeSettings({});
    const result = await withSiteGroupData(["geosite:google@cn"], () => Promise.resolve(1));
    expect(result).toMatchObject({
      ok: true,
      added: { "geosite:google@cn": { count: 1, skipped: 1 } },
    });
    expect(storedGroups(store)["geosite:google@cn"].d).toBe("\ngoogle.cn\n");
  });

  test.each([
    ["geosite:nosuchlist", "UNKNOWN_GROUP"],
    ["geosite:google@ads", "EMPTY_GROUP"],
    ["geosite:empty", "EMPTY_GROUP"],
  ])("%s answers %s and writes nothing", async (token, error) => {
    storeSettings({});
    const write = vi.fn(() => Promise.resolve());
    const result = await withSiteGroupData([token], write);
    expect(result).toEqual({ ok: false, error, token });
    expect(write).not.toHaveBeenCalled();
    expect(store.writes).not.toContain(SITE_GROUP_DATA_KEY);
  });

  test("a token that already has data is not rebuilt or rewritten", async () => {
    store.data[SITE_GROUP_DATA_KEY] = { v: 1, groups: { [GOOGLE]: storedGroup(["google.com"]) } };
    storeSettings({ allowlist: [GOOGLE] });
    const fetchMock = routeFetch();
    const result = await withSiteGroupData([GOOGLE], () => Promise.resolve("ok"));
    expect(result).toEqual({
      ok: true,
      value: "ok",
      added: { [GOOGLE]: { count: 1, skipped: 0 } },
    });
    expect(store.writes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("STORAGE_FULL when the kept data would pass 5,000,000 chars", async () => {
    const big = "geosite:big";
    const bigGroup = {
      ...storedGroup([]),
      d: `\n${"a".repeat(4_999_990)}\n`,
      n: 1,
    };
    store.data[SITE_GROUP_DATA_KEY] = { v: 1, groups: { [big]: bigGroup } };
    storeSettings({ allowlist: [big] });
    const write = vi.fn(() => Promise.resolve());
    const result = await withSiteGroupData([GOOGLE], write);
    expect(result).toEqual({ ok: false, error: "STORAGE_FULL", token: GOOGLE });
    expect(write).not.toHaveBeenCalled();
    expect(Object.keys(storedGroups(store))).toEqual([big]);
  });

  test("unreferenced leftovers don't count toward the cap and are dropped", async () => {
    const big = "geosite:big";
    store.data[SITE_GROUP_DATA_KEY] = {
      v: 1,
      groups: { [big]: { ...storedGroup([]), d: `\n${"a".repeat(4_999_990)}\n`, n: 1 } },
    };
    storeSettings({});
    const result = await withSiteGroupData([GOOGLE], () => Promise.resolve());
    expect(result.ok).toBe(true);
    expect(Object.keys(storedGroups(store))).toEqual([GOOGLE]);
  });

  test("a failed data write answers STORAGE_ERROR and skips the settings write", async () => {
    storeSettings({});
    store.set.mockRejectedValueOnce(new Error("disk on fire"));
    const write = vi.fn(() => Promise.resolve());
    const result = await withSiteGroupData([GOOGLE], write);
    expect(result).toEqual({ ok: false, error: "STORAGE_ERROR", token: GOOGLE });
    expect(write).not.toHaveBeenCalled();
  });

  test("no tokens: the write runs alone", async () => {
    const fetchMock = routeFetch();
    const result = await withSiteGroupData(["example.com"], () => Promise.resolve(7));
    expect(result).toEqual({ ok: true, value: 7, added: {} });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
  });
});

describe("fetchLinkList and link adds", () => {
  test("downloads with no credentials and parses, counting skipped rules", async () => {
    const fetchMock = routeFetch({
      [LINK_URL]: (url) =>
        responseAt(url, "example.com\nfull:mail.example.net\nregexp:^a\nkeyword:ads\nbad_host!\n"),
    });
    const result = await fetchLinkList(LINK_URL);
    expect(result).toEqual({
      ok: true,
      data: { d: "\nexample.com\n", f: "\nmail.example.net\n", n: 2, skipped: 3 },
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init).toMatchObject({ credentials: "omit", cache: "no-cache", redirect: "follow" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("a redirect that ends on http fails", async () => {
    routeFetch({ [LINK_URL]: () => responseAt("http://lists.example.org/x.txt", "example.com") });
    expect(await fetchLinkList(LINK_URL)).toEqual({ ok: false, error: "LINK_FAILED" });
  });

  test("an http link is refused without a request", async () => {
    const fetchMock = routeFetch();
    expect(await fetchLinkList("http://lists.example.org/x.txt")).toEqual({
      ok: false,
      error: "LINK_FAILED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a non-ok status or a network error fails", async () => {
    routeFetch({ [LINK_URL]: (url) => responseAt(url, "nope", { status: 404 }) });
    expect(await fetchLinkList(LINK_URL)).toEqual({ ok: false, error: "LINK_FAILED" });
    routeFetch({});
    expect(await fetchLinkList(LINK_URL)).toEqual({ ok: false, error: "LINK_FAILED" });
  });

  test("a declared size over 10 MB is too large", async () => {
    routeFetch({
      [LINK_URL]: (url) =>
        responseAt(url, "example.com", {
          headers: { "content-length": String(MAX_LINK_BYTES + 1) },
        }),
    });
    expect(await fetchLinkList(LINK_URL)).toEqual({ ok: false, error: "LINK_TOO_LARGE" });
  });

  test("a body that streams past 10 MB is too large", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    routeFetch({
      [LINK_URL]: (url) => {
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= 11) controller.close();
            else {
              sent++;
              controller.enqueue(chunk);
            }
          },
        });
        return responseAt(url, body);
      },
    });
    expect(await fetchLinkList(LINK_URL)).toEqual({ ok: false, error: "LINK_TOO_LARGE" });
  });

  test("a list with nothing usable is empty, with its skipped count", async () => {
    routeFetch({
      [LINK_URL]: (url) => responseAt(url, "# comment\nregexp:^a\nDOMAIN-KEYWORD,ads\n"),
    });
    expect(await fetchLinkList(LINK_URL)).toEqual({ ok: false, error: "LINK_EMPTY", skipped: 2 });
  });

  test("a link add stores the downloaded data with its counts", async () => {
    storeSettings({});
    routeFetch({ [LINK_URL]: (url) => responseAt(url, "example.com\nregexp:^a\n") });
    const result = await withSiteGroupData([LINK], () => Promise.resolve());
    expect(result).toMatchObject({ ok: true, added: { [LINK]: { count: 1, skipped: 1 } } });
    expect(storedGroups(store)[LINK]).toMatchObject({
      d: "\nexample.com\n",
      source: "link",
      lastError: null,
      skipped: 1,
    });
  });

  test("a failed link add answers its error and writes nothing", async () => {
    storeSettings({});
    routeFetch({ [LINK_URL]: (url) => responseAt(url, "regexp:^a\n") });
    const write = vi.fn(() => Promise.resolve());
    expect(await withSiteGroupData([LINK], write)).toEqual({
      ok: false,
      error: "LINK_EMPTY",
      token: LINK,
      skipped: 1,
    });
    expect(write).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
  });
});

describe("refreshSiteGroups", () => {
  test("a newer pointer downloads, verifies and stores the catalog, then rebuilds", async () => {
    storeSettings({ allowlist: [GOOGLE] });
    store.data[SITE_GROUP_DATA_KEY] = {
      v: 1,
      groups: { [GOOGLE]: storedGroup(["google.com"], { release: CATALOG_A.release }) },
    };
    vi.mocked(browser.tabs.query).mockClear();
    const fetchMock = routeFetch(await cdnRoutes(CATALOG_B));

    const result = await refreshSiteGroups({ manual: false });

    expect(result).toMatchObject({
      success: true,
      status: { release: CATALOG_B.release, lastError: null, updating: false },
    });
    expect(fetchedUrls(fetchMock)).toEqual(
      expect.arrayContaining([
        POINTER_URL,
        `https://cdn.geospoof.com/site-groups/v1/catalog-${CATALOG_B.release}.json`,
      ])
    );
    const pointerInit = fetchMock.mock.calls.find((c) => c[0] === POINTER_URL)![1] as RequestInit;
    expect(pointerInit).toMatchObject({ cache: "no-cache", credentials: "omit" });
    expect((store.data[SITE_GROUP_CATALOG_KEY] as { release: string }).release).toBe(
      CATALOG_B.release
    );
    expect(storedGroups(store)[GOOGLE]).toMatchObject({ release: CATALOG_B.release, n: 4 });
    expect(store.data[SITE_GROUP_STATUS_KEY]).toEqual({
      checkedAt: expect.any(Number) as number,
      lastError: null,
    });
    // The entries changed, so tabs were told.
    expect(browser.tabs.query).toHaveBeenCalled();
  });

  test("the same release downloads only the pointer", async () => {
    storeSettings({ allowlist: [GOOGLE] });
    const fetchMock = routeFetch(await cdnRoutes(CATALOG_A));
    const result = await refreshSiteGroups({ manual: false });
    expect(result).toMatchObject({ success: true });
    expect(fetchedUrls(fetchMock).filter((u) => u !== BUNDLED_URL)).toEqual([POINTER_URL]);
    expect(store.data[SITE_GROUP_CATALOG_KEY]).toBeUndefined();
  });

  test("a sha256 mismatch stores nothing and reports INVALID", async () => {
    storeSettings({ allowlist: [GOOGLE] });
    store.data[SITE_GROUP_DATA_KEY] = { v: 1, groups: { [GOOGLE]: storedGroup(["google.com"]) } };
    routeFetch(await cdnRoutes(CATALOG_B, { sha256: "0".repeat(64) }));
    const result = await refreshSiteGroups({ manual: false });
    expect(result).toMatchObject({ error: "INVALID", status: { release: CATALOG_A.release } });
    expect(store.data[SITE_GROUP_CATALOG_KEY]).toBeUndefined();
    expect(storedGroups(store)[GOOGLE].d).toBe("\ngoogle.com\n");
    expect(store.data[SITE_GROUP_STATUS_KEY]).toMatchObject({ lastError: "INVALID" });
  });

  test("a catalog that matches its sha256 but fails validation is refused", async () => {
    storeSettings({ allowlist: [GOOGLE] });
    const bad = { ...CATALOG_B, lists: { "Bad Name": { rules: "x.com", skipped: [] } } };
    routeFetch(await cdnRoutes(CATALOG_B, {}, JSON.stringify(bad)));
    expect(await refreshSiteGroups({ manual: false })).toMatchObject({ error: "INVALID" });
    expect(store.data[SITE_GROUP_CATALOG_KEY]).toBeUndefined();
  });

  test("a catalog whose release differs from the pointer's is refused", async () => {
    storeSettings({ allowlist: [GOOGLE] });
    const routes = await cdnRoutes(
      CATALOG_B,
      {},
      JSON.stringify({ ...CATALOG_B, release: "20260301000000" })
    );
    routeFetch(routes);
    expect(await refreshSiteGroups({ manual: false })).toMatchObject({ error: "INVALID" });
    expect(store.data[SITE_GROUP_CATALOG_KEY]).toBeUndefined();
  });

  test.each([
    [
      "a malformed pointer",
      { [POINTER_URL]: (url: string) => responseAt(url, "{not json") },
      "INVALID",
    ],
    [
      "a pointer path outside site-groups/v1",
      {
        [POINTER_URL]: (url: string) =>
          responseAt(
            url,
            JSON.stringify({
              format: 1,
              release: CATALOG_B.release,
              path: "../x.json",
              sha256: "0".repeat(64),
              bytes: 10,
            })
          ),
      },
      "INVALID",
    ],
    ["an unreachable CDN", {}, "NETWORK"],
  ])("%s reports %s and keeps the data", async (_name, routes, error) => {
    storeSettings({ allowlist: [GOOGLE] });
    store.data[SITE_GROUP_DATA_KEY] = { v: 1, groups: { [GOOGLE]: storedGroup(["google.com"]) } };
    routeFetch(routes);
    expect(await refreshSiteGroups({ manual: false })).toMatchObject({ error });
    expect(storedGroups(store)[GOOGLE].d).toBe("\ngoogle.com\n");
  });

  test("a list missing upstream keeps its data, flagged", async () => {
    storeSettings({ allowlist: [GOOGLE, YOUTUBE] });
    store.data[SITE_GROUP_DATA_KEY] = {
      v: 1,
      groups: {
        [GOOGLE]: storedGroup(["google.com"]),
        [YOUTUBE]: storedGroup(["youtube.com"]),
      },
    };
    routeFetch(await cdnRoutes(CATALOG_B));
    await refreshSiteGroups({ manual: false });
    const groups = storedGroups(store);
    expect(groups[YOUTUBE]).toMatchObject({
      d: "\nyoutube.com\n",
      missingUpstream: true,
      release: CATALOG_A.release,
    });
    expect(groups[GOOGLE]).toMatchObject({ release: CATALOG_B.release });
    expect(currentSiteGroups().has(YOUTUBE, "www.youtube.com")).toBe(true);
  });

  test("a failed link refresh keeps the last good copy and records the error", async () => {
    storeSettings({ denylist: [LINK] });
    store.data[SITE_GROUP_DATA_KEY] = {
      v: 1,
      groups: { [LINK]: storedGroup(["example.com"], { source: "link", lastError: null }) },
    };
    routeFetch({
      ...(await cdnRoutes(CATALOG_A)),
      [LINK_URL]: (url) => responseAt(url, "", { status: 500 }),
    });
    const result = await refreshSiteGroups({ manual: false });
    expect(result).toMatchObject({ success: true });
    expect(storedGroups(store)[LINK]).toMatchObject({
      d: "\nexample.com\n",
      lastError: "LINK_FAILED",
    });
  });

  test("a successful link refresh replaces the data", async () => {
    storeSettings({ denylist: [LINK] });
    store.data[SITE_GROUP_DATA_KEY] = {
      v: 1,
      groups: {
        [LINK]: storedGroup(["old.example.com"], { source: "link", lastError: "LINK_FAILED" }),
      },
    };
    routeFetch({
      ...(await cdnRoutes(CATALOG_A)),
      [LINK_URL]: (url) => responseAt(url, "new.example.com"),
    });
    await refreshSiteGroups({ manual: false });
    expect(storedGroups(store)[LINK]).toMatchObject({ d: "\nnew.example.com\n", lastError: null });
  });

  test("no referenced token: a scheduled refresh makes no request and clears the alarm", async () => {
    storeSettings({ allowlist: ["example.com"] });
    store.data[SITE_GROUP_DATA_KEY] = { v: 1, groups: { [GOOGLE]: storedGroup(["google.com"]) } };
    const fetchMock = routeFetch(await cdnRoutes(CATALOG_B));
    const result = await refreshSiteGroups({ manual: false });
    expect(result).toMatchObject({ success: true });
    expect(fetchedUrls(fetchMock).filter((u) => u !== BUNDLED_URL)).toEqual([]);
    expect(browser.alarms.clear).toHaveBeenCalledWith(SITE_GROUPS_REFRESH_ALARM);
    // The unreferenced data is pruned.
    expect(storedGroups(store)).toEqual({});
  });

  test("no referenced token: a manual refresh still checks the CDN", async () => {
    storeSettings({});
    const fetchMock = routeFetch(await cdnRoutes(CATALOG_B));
    const result = await refreshSiteGroups({ manual: true });
    expect(result).toMatchObject({ success: true, status: { release: CATALOG_B.release } });
    expect(fetchedUrls(fetchMock)).toContain(POINTER_URL);
  });

  test("single-flight: overlapping calls share one run", async () => {
    storeSettings({ allowlist: [GOOGLE] });
    const fetchMock = routeFetch(await cdnRoutes(CATALOG_A));
    const [a, b] = await Promise.all([
      refreshSiteGroups({ manual: false }),
      refreshSiteGroups({ manual: true }),
    ]);
    expect(b).toBe(a);
    expect(fetchedUrls(fetchMock).filter((u) => u === POINTER_URL)).toHaveLength(1);
  });

  test("updating is reported while a refresh runs", async () => {
    storeSettings({ allowlist: [GOOGLE] });
    const pointer = deferred<Response>();
    routeFetch({ [POINTER_URL]: () => pointer.promise });
    const run = refreshSiteGroups({ manual: true });
    expect((await handleGetSiteGroups()).status.updating).toBe(true);
    pointer.resolve(responseAt(POINTER_URL, "{}"));
    await run;
    expect((await handleGetSiteGroups()).status.updating).toBe(false);
  });
});

describe("pruning", () => {
  test("drops tokens nothing references", async () => {
    storeSettings({ allowlist: [GOOGLE] });
    store.data[SITE_GROUP_DATA_KEY] = {
      v: 1,
      groups: { [GOOGLE]: storedGroup(["google.com"]), [YOUTUBE]: storedGroup(["youtube.com"]) },
    };
    await pruneSiteGroupDataSoon();
    expect(Object.keys(storedGroups(store))).toEqual([GOOGLE]);
  });

  test("never drops a token whose add is still writing its settings", async () => {
    storeSettings({});
    const settingsWrite = deferred<void>();
    const adding = withSiteGroupData([GOOGLE], async () => {
      await settingsWrite.promise;
      store.data.settings = settingsWith({ allowlist: [GOOGLE] });
    });
    // Let the add store its data and reach the settings write.
    await vi.waitFor(() => expect(storedGroups(store)[GOOGLE]).toBeDefined());

    await pruneSiteGroupDataSoon();
    expect(storedGroups(store)[GOOGLE]).toBeDefined();

    settingsWrite.resolve();
    expect(await adding).toMatchObject({ ok: true });
    await pruneSiteGroupDataSoon();
    expect(storedGroups(store)[GOOGLE]).toBeDefined();
  });

  test("an add whose settings write stored nothing has its data dropped", async () => {
    storeSettings({});
    expect(await withSiteGroupData([GOOGLE], () => Promise.resolve(null))).toMatchObject({
      ok: true,
    });
    await vi.waitFor(() => expect(storedGroups(store)[GOOGLE]).toBeUndefined());
  });
});

describe("startup and repair", () => {
  test("startup builds missing data, schedules the alarm, and delivers", async () => {
    const settings = settingsWith({ scopeMode: "allowlist", allowlist: [GOOGLE] });
    store.data.settings = settings;
    vi.mocked(browser.tabs.query).mockClear();
    await onSiteGroupsStartup(settings);
    expect(storedGroups(store)[GOOGLE]).toMatchObject({ n: 3, release: CATALOG_A.release });
    expect(browser.alarms.create).toHaveBeenCalledWith(SITE_GROUPS_REFRESH_ALARM, {
      delayInMinutes: expect.any(Number) as number,
      periodInMinutes: SITE_GROUPS_REFRESH_PERIOD_MINUTES,
    });
    expect(browser.tabs.query).toHaveBeenCalled();
  });

  test("startup rebuilds data built from an older catalog", async () => {
    const settings = settingsWith({ allowlist: [GOOGLE] });
    store.data.settings = settings;
    store.data[SITE_GROUP_CATALOG_KEY] = CATALOG_B;
    store.data[SITE_GROUP_DATA_KEY] = { v: 1, groups: { [GOOGLE]: storedGroup(["google.com"]) } };
    await onSiteGroupsStartup(settings);
    expect(storedGroups(store)[GOOGLE]).toMatchObject({ n: 4, release: CATALOG_B.release });
  });

  test("startup with no token does nothing", async () => {
    const fetchMock = routeFetch();
    await onSiteGroupsStartup(settingsWith({}));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser.alarms.create).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
  });

  test("repair builds data for a bridged token and downloads a bridged link", async () => {
    storeSettings({ allowlist: [GOOGLE], denylist: [LINK] });
    routeFetch({ [LINK_URL]: (url) => responseAt(url, "example.com") });
    await repairSiteGroupDataSoon();
    expect(Object.keys(storedGroups(store)).sort()).toEqual([GOOGLE, LINK].sort());
  });

  test("repair keeps a referenced link that can't be downloaded absent (it matches nothing)", async () => {
    storeSettings({ denylist: [LINK] });
    routeFetch({});
    await repairSiteGroupDataSoon();
    expect(storedGroups(store)).toEqual({});
    expect(currentSiteGroups().has(LINK, "example.com")).toBe(false);
  });
});

describe("the space cap in reconcile (every browser)", () => {
  // The same cases and numbers as geospoof-ios SiteGroupAdmissionTests, so the
  // app and Safari decide space the same way.
  const A = "list:https://a.example/a.txt";
  const B = "list:https://b.example/b.txt";
  const D = "list:https://d.example/d.txt";
  const N = "list:https://n.example/n.txt";
  const url = (token: string) => token.slice("list:".length);

  /** Stored link data of exactly `size` characters (`d.length + f.length`). */
  function copyOfSize(size: number, overrides: Partial<StoredSiteGroup> = {}): StoredSiteGroup {
    return {
      ...storedGroup([], { source: "link", lastError: null, fetchedAt: 1 }),
      d: `\n${"a".repeat(size - 3)}\n`,
      n: 1,
      ...overrides,
    };
  }

  /** A list body whose parsed data is exactly `size` characters (`size` ≥ 60). */
  function listOfSize(size: number): string {
    // Each `<20-char label>.example` entry adds 29 characters; the framing adds 2.
    const count = Math.floor((size - 2) / 29) - 1;
    const domains: string[] = [];
    for (let i = 0; i < count; i++) domains.push(`${String(i).padStart(20, "d")}.example`);
    const last = size - 2 - count * 29 - 1; // 28..56 characters
    domains.push(`${"z".repeat(last - 8)}.example`);
    return domains.join("\n");
  }

  function serve(sizes: Record<string, number | "fail">): Record<string, Route> {
    const routes: Record<string, Route> = {};
    for (const [token, size] of Object.entries(sizes)) {
      routes[url(token)] = (u) =>
        size === "fail" ? responseAt(u, "", { status: 500 }) : responseAt(u, listOfSize(size));
    }
    return routes;
  }

  function size(token: string): number | undefined {
    const group = storedGroups(store)[token];
    return group === undefined ? undefined : group.d.length + group.f.length;
  }

  function seed(groups: Record<string, StoredSiteGroup>, full?: string[]): void {
    store.data[SITE_GROUP_DATA_KEY] = { v: 1, groups };
    if (full !== undefined) store.data[SITE_GROUP_FULL_KEY] = full;
  }

  test("the test lists have the sizes they claim", async () => {
    routeFetch(serve({ [A]: 60 }));
    const result = await fetchLinkList(url(A));
    expect(result.ok && result.data.d.length + result.data.f.length).toBe(60);
  });

  test("existing data is kept", async () => {
    storeSettings({ allowlist: [A] });
    seed({ [A]: copyOfSize(100) });
    const fetchMock = routeFetch();
    await repairSiteGroupDataSoon();
    expect(size(A)).toBe(100);
    expect(store.data[SITE_GROUP_FULL_KEY]).toBeUndefined();
    expect(fetchedUrls(fetchMock).filter((u) => u !== BUNDLED_URL)).toEqual([]);
  });

  test("a new link that doesn't fit gets no data and is listed in siteGroupFull", async () => {
    storeSettings({ allowlist: [A, B] });
    seed({ [A]: copyOfSize(4_500_000) });
    routeFetch(serve({ [B]: 600_000 }));
    await repairSiteGroupDataSoon();
    expect(size(A)).toBe(4_500_000);
    expect(size(B)).toBeUndefined();
    expect(store.data[SITE_GROUP_FULL_KEY]).toEqual([B]);
  });

  test("siteGroupFull is cleared once the link fits again, and runRefresh's status write leaves it alone", async () => {
    storeSettings({ allowlist: [A, B] });
    seed({ [A]: copyOfSize(4_500_000) }, [B]);
    routeFetch({ ...(await cdnRoutes(CATALOG_A)), ...serve({ [A]: "fail", [B]: 600_000 }) });
    await refreshSiteGroups({ manual: false });
    // Still too big: the status write didn't wipe the list.
    expect(store.data[SITE_GROUP_FULL_KEY]).toEqual([B]);
    expect(store.data[SITE_GROUP_STATUS_KEY]).toMatchObject({ lastError: null });

    // A is removed, so B fits on its next download.
    storeSettings({ allowlist: [B] });
    await refreshSiteGroups({ manual: false });
    expect(size(B)).toBe(600_000);
    expect(size(A)).toBeUndefined();
    expect(SITE_GROUP_FULL_KEY in store.data).toBe(false);
  });

  test("a refreshed link that grows past the cap keeps the old copy", async () => {
    storeSettings({ allowlist: [A, B] });
    seed({ [A]: copyOfSize(1_000_000, { n: 1 }), [B]: copyOfSize(3_000_000) });
    routeFetch({ ...(await cdnRoutes(CATALOG_A)), ...serve({ [A]: 2_500_000, [B]: "fail" }) });
    await refreshSiteGroups({ manual: false });
    expect(storedGroups(store)[A]).toMatchObject({ n: 1, fetchedAt: 1 });
    expect(size(A)).toBe(1_000_000);
    expect(storedGroups(store)[B]).toMatchObject({ lastError: "LINK_FAILED" });
    expect(store.data[SITE_GROUP_FULL_KEY]).toBeUndefined();
  });

  test("a refreshed link that shrinks is taken", async () => {
    storeSettings({ allowlist: [A, B] });
    seed({ [A]: copyOfSize(4_000_000), [B]: copyOfSize(900_000) });
    routeFetch({ ...(await cdnRoutes(CATALOG_A)), ...serve({ [A]: 2_000_000, [B]: "fail" }) });
    await refreshSiteGroups({ manual: false });
    expect(size(A)).toBe(2_000_000);
    expect(storedGroups(store)[A].fetchedAt).not.toBe(1);
  });

  test("data already past the cap before the upgrade is kept", async () => {
    storeSettings({ allowlist: [A] });
    seed({ [A]: copyOfSize(6_000_000) });
    routeFetch({ ...(await cdnRoutes(CATALOG_A)), ...serve({ [A]: "fail" }) });
    await repairSiteGroupDataSoon();
    expect(size(A)).toBe(6_000_000);
    await refreshSiteGroups({ manual: false });
    expect(size(A)).toBe(6_000_000);
    expect(store.data[SITE_GROUP_FULL_KEY]).toBeUndefined();
  });

  test("step 1 counts kept tokens only: a dropped 4,000,000 token frees space for a new 2,000,000 one", async () => {
    storeSettings({ allowlist: [N] });
    seed({ [D]: copyOfSize(4_000_000) });
    routeFetch(serve({ [N]: 2_000_000 }));
    await repairSiteGroupDataSoon();
    expect(size(D)).toBeUndefined();
    expect(size(N)).toBe(2_000_000);
    expect(store.data[SITE_GROUP_FULL_KEY]).toBeUndefined();
  });

  test("step 2: A (too big) then B (fits): A goes to full and B gets data", async () => {
    storeSettings({ allowlist: [A, B] });
    routeFetch(serve({ [A]: 6_000_000, [B]: 100 }));
    await repairSiteGroupDataSoon();
    expect(store.data[SITE_GROUP_FULL_KEY]).toEqual([A]);
    expect(size(A)).toBeUndefined();
    expect(size(B)).toBe(100);
  });

  test("step 3: a repair doesn't download a full link and keeps it in full", async () => {
    storeSettings({ allowlist: [A] });
    seed({}, [A]);
    const fetchMock = routeFetch(serve({ [A]: 500 }));
    await repairSiteGroupDataSoon();
    expect(fetchedUrls(fetchMock)).not.toContain(url(A));
    expect(store.data[SITE_GROUP_FULL_KEY]).toEqual([A]);
    expect(size(A)).toBeUndefined();
  });

  test("step 3: a refresh whose download of a full link fails moves it out of full with no data", async () => {
    storeSettings({ allowlist: [A] });
    seed({}, [A]);
    const fetchMock = routeFetch({ ...(await cdnRoutes(CATALOG_A)), ...serve({ [A]: "fail" }) });
    await refreshSiteGroups({ manual: false });
    expect(fetchedUrls(fetchMock)).toContain(url(A));
    expect(SITE_GROUP_FULL_KEY in store.data).toBe(false);
    expect(size(A)).toBeUndefined();
  });

  test("step 3: a refresh whose download of a full link fits gives it data and leaves full", async () => {
    storeSettings({ allowlist: [A] });
    seed({}, [A]);
    routeFetch({ ...(await cdnRoutes(CATALOG_A)), ...serve({ [A]: 500 }) });
    await refreshSiteGroups({ manual: false });
    expect(size(A)).toBe(500);
    expect(SITE_GROUP_FULL_KEY in store.data).toBe(false);
  });

  test("pruning drops tokens that are no longer kept from siteGroupFull", async () => {
    storeSettings({ allowlist: [A] });
    seed({}, [A, B]);
    await pruneSiteGroupDataSoon();
    expect(store.data[SITE_GROUP_FULL_KEY]).toEqual([A]);
  });
});

describe("safariRefreshDue", () => {
  const NOW = 1_800_000_000_000;
  const HOUR = 60 * 60_000;

  test.each([
    ["never checked", null, true],
    ["6 days 23 hours ago", NOW - (6 * 24 + 23) * HOUR, false],
    ["exactly 7 days ago", NOW - 7 * 24 * HOUR, true],
  ])("%s → %s", (_name, checkedAt, due) => {
    expect(safariRefreshDue(checkedAt, NOW)).toBe(due);
  });
});

describe("the refresh alarm", () => {
  const NOW = 1_800_000_000_000;
  const DAY = 24 * 60 * 60_000;

  test("delay: the time left until a week after the last check, at least 1 minute, plus jitter", () => {
    expect(siteGroupRefreshDelayMinutes(null, NOW, 0)).toBe(1);
    expect(siteGroupRefreshDelayMinutes(NOW - DAY, NOW, 0)).toBe(6 * 24 * 60);
    expect(siteGroupRefreshDelayMinutes(NOW - 8 * DAY, NOW, 0)).toBe(1);
    expect(siteGroupRefreshDelayMinutes(NOW - DAY, NOW, 0.5)).toBe(6 * 24 * 60 + 180);
    // A check "in the future" (clock moved back) waits at most a week.
    expect(siteGroupRefreshDelayMinutes(NOW + 30 * DAY, NOW, 0)).toBe(10_080);
  });

  test("is created once when a token is referenced", async () => {
    store.data[SITE_GROUP_STATUS_KEY] = { checkedAt: Date.now() - DAY, lastError: null };
    await ensureSiteGroupRefreshAlarm(settingsWith({ allowlist: [GOOGLE] }));
    expect(browser.alarms.create).toHaveBeenCalledTimes(1);
    const [, info] = vi.mocked(browser.alarms.create).mock.calls[0] as unknown as [
      string,
      { delayInMinutes: number; periodInMinutes: number },
    ];
    expect(info.periodInMinutes).toBe(10_080);
    expect(info.delayInMinutes).toBeGreaterThan(6 * 24 * 60 - 1);
    expect(info.delayInMinutes).toBeLessThanOrEqual(6 * 24 * 60 + 360);

    vi.mocked(browser.alarms.get).mockResolvedValue({ name: SITE_GROUPS_REFRESH_ALARM } as never);
    await ensureSiteGroupRefreshAlarm(settingsWith({ allowlist: [GOOGLE] }));
    expect(browser.alarms.create).toHaveBeenCalledTimes(1);
  });

  test("is not created when nothing is referenced", async () => {
    await ensureSiteGroupRefreshAlarm(settingsWith({ allowlist: ["example.com"] }));
    expect(browser.alarms.create).not.toHaveBeenCalled();
  });
});

describe("the Firefox early scripts around a group data change", () => {
  let userScripts: UserScriptsMock;

  beforeEach(() => {
    userScripts = installUserScriptsMock();
    // Log each group data write in order with the userScripts calls.
    const set = store.set.getMockImplementation()!;
    store.set.mockImplementation((obj: Record<string, unknown>) => {
      if (SITE_GROUP_DATA_KEY in obj) userScripts.log.push("store group data");
      return set(obj);
    });
  });

  afterEach(() => {
    userScripts.restore();
  });

  function storeDenylist(denylist: string[]): void {
    storeSettings({
      scopeMode: "denylist",
      denylist,
      location: TOKYO,
      timezone: TOKYO_TZ,
      locationName: TOKYO_NAME,
    });
  }

  /** Register the early scripts for the stored settings, then clear the log. */
  async function registerStored(): Promise<void> {
    await updateBootstrapRegistration(await loadSettings());
    expect(userScripts.register).toHaveBeenCalledTimes(1);
    userScripts.log.length = 0;
  }

  /** The main script's code in the latest registration. */
  function mainScriptCode(): string {
    const calls = userScripts.register.mock.calls as Array<
      [Array<{ id: string; js: Array<{ code: string }> }>]
    >;
    return calls.at(-1)![0].find((r) => r.id === "gs-tz-bootstrap")!.js[0].code;
  }

  const REPLACED = ["unregister", "store group data", "unregister", "register"];

  test("a refresh that changes a deny group removes the old scripts before storing it", async () => {
    storeDenylist([GOOGLE]);
    store.data[SITE_GROUP_DATA_KEY] = { v: 1, groups: { [GOOGLE]: storedGroup(["google.com"]) } };
    await registerStored();
    expect(mainScriptCode()).not.toContain("google.de");
    routeFetch(await cdnRoutes(CATALOG_B));

    await refreshSiteGroups({ manual: false });
    await until(() => userScripts.register.mock.calls.length === 2, "the new early scripts");

    // A page that loads before the new scripts gets no seed, not the old gate's.
    expect(userScripts.log).toEqual(REPLACED);
    expect(mainScriptCode()).toContain("google.de");
  });

  test("an add that builds data for a token another entry already uses removes the old scripts first", async () => {
    storeDenylist([GOOGLE]);
    await registerStored();
    // Without data the deny group matches nothing, so the main script has no gate.
    expect(mainScriptCode().startsWith("try{")).toBe(true);

    expect(await withSiteGroupData([GOOGLE], () => Promise.resolve("ok"))).toMatchObject({
      ok: true,
    });
    await until(() => userScripts.register.mock.calls.length === 2, "the new early scripts");

    expect(userScripts.log).toEqual(REPLACED);
    expect(mainScriptCode()).toContain("google.com");
  });

  test("a refresh that changes no entries leaves the early scripts alone", async () => {
    storeDenylist([GOOGLE]);
    store.data[SITE_GROUP_DATA_KEY] = { v: 1, groups: { [GOOGLE]: storedGroup(["google.com"]) } };
    await registerStored();
    routeFetch(await cdnRoutes(CATALOG_A));

    await refreshSiteGroups({ manual: false });
    await flush();

    expect(userScripts.log).toEqual([]);
  });
});

describe("where site groups aren't available", () => {
  beforeEach(() => {
    gate.available = false;
  });

  test("no alarm, no request, nothing stored", async () => {
    const settings = settingsWith({ allowlist: [GOOGLE], denylist: [LINK] });
    store.data.settings = settings;
    const fetchMock = routeFetch(await cdnRoutes(CATALOG_B));

    await onSiteGroupsStartup(settings);
    await ensureSiteGroupRefreshAlarm(settings);
    expect(await refreshSiteGroups({ manual: true })).toMatchObject({ error: "NOT_AVAILABLE" });
    await refreshSiteGroups({ manual: false });
    await repairSiteGroupDataSoon();
    await pruneSiteGroupDataSoon();
    const write = vi.fn(() => Promise.resolve("w"));
    expect(await withSiteGroupData([GOOGLE, LINK], write)).toEqual({
      ok: true,
      value: "w",
      added: {},
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser.alarms.create).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
  });

  test("GET_SITE_GROUPS reports available: false", async () => {
    expect(await handleGetSiteGroups()).toEqual({
      available: false,
      status: {
        release: null,
        releasedAt: null,
        checkedAt: null,
        lastError: null,
        updating: false,
      },
      groups: {},
    });
  });
});
