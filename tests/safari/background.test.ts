/**
 * Safari's background after the flip.
 *
 *   - The bridge stub: a GET_PENDING_SETTINGS answer carrying all three forms
 *     in allowlist, denylist and siteLocations is stored, and the REGION_UPDATE
 *     that follows carries them unchanged, with no new key.
 *   - Standalone (decision 7): with no app data and a native host that answers
 *     nothing, Filters and Per-site locations add a site group, an exact
 *     address and a list from a link; the link is downloaded at add time and
 *     its counts come back through GET_SITE_GROUPS; a failed, empty or too
 *     large link is refused; the refresh alarm downloads it again; and the
 *     page payload the content script gets applies all three.
 */
import { describe, test, expect, vi, beforeEach, type Mock } from "vitest";
import type { LocationName, Settings, Timezone } from "@/shared/types/settings";
import type {
  ScopeResponse,
  SiteGroupsResponse,
  SiteLocationResponse,
} from "@/shared/types/messages";
import { SITE_GROUPS_REFRESH_ALARM } from "@/background/site-groups";
import {
  CATALOG_A,
  cdnRoutes,
  fetchedUrls,
  responseAt,
  routeFetch,
  storedGroups,
  type LocalStore,
  type Route,
} from "../helpers/site-groups";
import { DUBLIN, DUBLIN_NAME, DUBLIN_TZ, makeSiteLocation } from "../helpers/site-locations";
import {
  EXACT,
  GOOGLE,
  LINK,
  LINK_URL,
  bootSafari,
  installNative,
  nativeMessages,
  send,
  settingsWith,
  type Background,
  type NativeMock,
} from "./helpers";

const lookups = vi.hoisted(() => ({
  timezone: vi.fn<(lat: number, lon: number, hint?: string) => Promise<Timezone>>(),
}));
vi.mock("@/background/timezone", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/background/timezone")>()),
  getTimezoneForCoordinates: lookups.timezone,
}));

const YOUTUBE = "geosite:youtube";
const EXACT_SITE = "=www.example.net";
const SITE_LINK_URL = "https://lists.example.org/rules/site-list.txt";
const SITE_LINK = `list:${SITE_LINK_URL}`;
const NAME: LocationName = DUBLIN_NAME;

interface Alarm {
  name: string;
  scheduledTime: number;
}

/** The fields every REGION_UPDATE carries; PR 2 adds none. */
const REGION_UPDATE_KEYS = [
  "accuracySetting",
  "allowlist",
  "denylist",
  "enabled",
  "favorites",
  "ip",
  "localeSpoofing",
  "location",
  "locationName",
  "locationPrecision",
  "precisionCadence",
  "preserveGeolocationPrompt",
  "scopeMode",
  "siteLocations",
  "timezone",
  "type",
  "vpnSyncEnabled",
  "webrtcProtection",
];

let native: NativeMock;

const stored = (store: LocalStore) => store.data.settings as Settings;

function lists(routes: Record<string, string>): Record<string, Route> {
  const out: Record<string, Route> = {};
  for (const [url, body] of Object.entries(routes)) out[url] = (u) => responseAt(u, body);
  return out;
}

beforeEach(() => {
  lookups.timezone.mockReset().mockResolvedValue(DUBLIN_TZ);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the bridge stub", () => {
  test("adopted forms are stored and pushed back unchanged, with no new key", async () => {
    native = installNative((message) =>
      message.type === "GET_PENDING_SETTINGS" ? { pending: null } : undefined
    );
    routeFetch(lists({ [LINK_URL]: "listed.example\n" }));
    const { store } = await bootSafari(settingsWith({ scopeMode: "allowlist" }));
    const bridge = await import("@/background/app-bridge");
    native.mockClear();

    const allowlist = [GOOGLE, EXACT, LINK, "example.com"];
    const denylist = ["geosite:google@cn", "=a.example.com", LINK];
    const entry = makeSiteLocation({ id: "e1", patterns: [YOUTUBE, EXACT_SITE, LINK] });
    await bridge.adoptPendingResponse({
      pending: {
        updatedAt: Date.now() / 1000 + 60,
        allowlist: JSON.stringify(allowlist),
        denylist: JSON.stringify(denylist),
        siteLocations: JSON.stringify([entry]),
      },
    });

    expect(stored(store).allowlist).toEqual(allowlist);
    expect(stored(store).denylist).toEqual(denylist);
    expect(stored(store).siteLocations.map((e) => e.patterns)).toEqual([entry.patterns]);

    await vi.waitFor(() =>
      expect(nativeMessages(native, "REGION_UPDATE").length).toBeGreaterThan(0)
    );
    const push = nativeMessages(native, "REGION_UPDATE").at(-1)!;
    expect(Object.keys(push).sort()).toEqual(REGION_UPDATE_KEYS);
    expect(JSON.parse(push.allowlist as string)).toEqual(allowlist);
    expect(JSON.parse(push.denylist as string)).toEqual(denylist);
    const pushed = JSON.parse(push.siteLocations as string) as Array<{ patterns: string[] }>;
    expect(pushed.map((e) => e.patterns)).toEqual([entry.patterns]);
    // The adopted link gets its data without the app (repair after adoption).
    await vi.waitFor(() => expect(storedGroups(store)[LINK]).toBeDefined());
  });
});

describe("standalone Safari (no app)", () => {
  let bg: Background;
  let store: LocalStore;
  let fetchMock: ReturnType<typeof vi.fn>;

  async function boot(settings: Partial<Settings> = {}): Promise<void> {
    // No pending_* data, and a native host that answers nothing.
    native = installNative(() => undefined);
    fetchMock = routeFetch(
      lists({
        [LINK_URL]: "listed.example\nfull:only.example.org\nregexp:^ads\n",
        [SITE_LINK_URL]: "site-listed.example\n",
      })
    );
    ({ bg, store } = await bootSafari(settingsWith({ scopeMode: "allowlist", ...settings })));
  }

  const addScope = (pattern: string, list: "allowlist" | "denylist" = "allowlist") =>
    send<ScopeResponse>(bg, "ADD_SCOPE_SITE", { list, pattern });

  async function payloadFor(url: string) {
    const { buildPagePayload } = await import("@/background/page-payload");
    const { loadSettings } = await import("@/background/settings");
    return buildPagePayload(await loadSettings(), url);
  }

  test("Filters add a site group, an exact address and a list from a link", async () => {
    await boot();
    expect(await addScope("GeoSite:Google")).toEqual({
      success: true,
      siteGroup: { count: 3, skipped: 2 },
    });
    expect(await addScope("=Mail.Example.com")).toEqual({ success: true });
    expect(await addScope(LINK)).toEqual({ success: true, siteGroup: { count: 2, skipped: 1 } });
    expect(stored(store).allowlist).toEqual([GOOGLE, EXACT, LINK]);
    // Downloaded at add time, once.
    expect(fetchedUrls(fetchMock).filter((u) => u === LINK_URL)).toHaveLength(1);

    const groups = await send<SiteGroupsResponse>(bg, "GET_SITE_GROUPS");
    expect(groups.available).toBe(true);
    expect(groups.groups[LINK]).toMatchObject({ kind: "link", count: 2, skipped: 1 });
    expect(groups.groups[GOOGLE]).toMatchObject({ kind: "group", count: 3, skipped: 2 });
    // The refresh alarm was scheduled by the add.
    expect(browser.alarms.create).toHaveBeenCalledWith(
      SITE_GROUPS_REFRESH_ALARM,
      expect.objectContaining({ periodInMinutes: 10_080 })
    );
  });

  test("Per-site locations save a site group, an exact address and a list from a link", async () => {
    await boot();
    const res = await send<SiteLocationResponse>(bg, "SAVE_SITE_LOCATION", {
      patterns: [YOUTUBE, EXACT_SITE, SITE_LINK],
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
      locationName: NAME,
    });
    expect(res).toMatchObject({ success: true });
    expect(stored(store).siteLocations.map((e) => e.patterns)).toEqual([
      [YOUTUBE, EXACT_SITE, SITE_LINK],
    ]);
    expect(Object.keys(storedGroups(store)).sort()).toEqual([SITE_LINK, YOUTUBE].sort());
    const groups = await send<SiteGroupsResponse>(bg, "GET_SITE_GROUPS");
    expect(groups.groups[SITE_LINK]).toMatchObject({ count: 1, skipped: 0 });
  });

  test.each<[string, Route, string]>([
    ["a failed download", (u) => responseAt(u, "", { status: 500 }), "LINK_FAILED"],
    ["an empty list", (u) => responseAt(u, "regexp:^a\n"), "LINK_EMPTY"],
    [
      "a list past 10 MB",
      (u) => responseAt(u, "a.example", { headers: { "content-length": "20000000" } }),
      "LINK_TOO_LARGE",
    ],
  ])("%s is refused with %s and adds nothing", async (_name, route, error) => {
    await boot();
    routeFetch({ [LINK_URL]: route });
    expect(await addScope(LINK)).toMatchObject({ error, token: LINK });
    expect(stored(store).allowlist).toEqual([]);
    expect(storedGroups(store)).toEqual({});
  });

  test("the refresh alarm downloads the link again", async () => {
    await boot();
    await addScope(LINK);
    fetchMock = routeFetch({
      ...(await cdnRoutes(CATALOG_A)),
      ...lists({ [LINK_URL]: "listed.example\nnew.example\n" }),
    });
    // The listener the background registered, as the alarm fires it.
    const { alarms } = browser as unknown as {
      alarms: { onAlarm: { addListener: Mock<(listener: (alarm: Alarm) => void) => void> } };
    };
    const [listener] = alarms.onAlarm.addListener.mock.calls.at(-1)!;
    listener({ name: SITE_GROUPS_REFRESH_ALARM, scheduledTime: Date.now() });
    await vi.waitFor(() =>
      expect(storedGroups(store)[LINK]).toMatchObject({
        n: 2,
        d: "\nlisted.example\nnew.example\n",
      })
    );
    expect(fetchedUrls(fetchMock)).toContain(LINK_URL);
  });

  test("the page payload applies the group, the exact address and the link", async () => {
    await boot();
    await addScope(GOOGLE);
    await addScope(EXACT);
    await addScope(LINK);
    const enabled = async (url: string) => (await payloadFor(url)).enabled;
    expect(await enabled("https://mail.google.com/")).toBe(true);
    expect(await enabled("https://mail.example.com/")).toBe(true);
    expect(await enabled("https://sub.mail.example.com/")).toBe(false);
    expect(await enabled("https://www.listed.example/")).toBe(true);
    expect(await enabled("https://only.example.org/")).toBe(true);
    expect(await enabled("https://x.only.example.org/")).toBe(false);
    expect(await enabled("https://unlisted.example/")).toBe(false);
  });

  test("a per-site location applies on its group, exact address and link", async () => {
    await boot({
      scopeMode: "all",
      timezone: { identifier: "Asia/Tokyo", offset: 540, dstOffset: 0 },
    });
    await send(bg, "SAVE_SITE_LOCATION", {
      patterns: [YOUTUBE, EXACT_SITE, SITE_LINK],
      latitude: DUBLIN.latitude,
      longitude: DUBLIN.longitude,
      locationName: NAME,
    });
    const zone = async (url: string) => (await payloadFor(url)).timezone?.identifier;
    expect(await zone("https://www.youtube.com/")).toBe(DUBLIN_TZ.identifier);
    expect(await zone("https://www.example.net/")).toBe(DUBLIN_TZ.identifier);
    expect(await zone("https://a.www.example.net/")).toBe("Asia/Tokyo");
    expect(await zone("https://site-listed.example/")).toBe(DUBLIN_TZ.identifier);
    expect(await zone("https://elsewhere.example/")).toBe("Asia/Tokyo");
  });

  test("the native host only ever sees the existing message types", async () => {
    await boot();
    await addScope(GOOGLE);
    await addScope(LINK);
    const types = new Set(native.mock.calls.map(([, m]) => m.type));
    for (const type of types) expect(["GET_PENDING_SETTINGS", "REGION_UPDATE"]).toContain(type);
  });
});
