/**
 * The Safari background-spawn hook: `runtime.onStartup` is unreliable on iOS
 * Safari and `onInstalled` doesn't fire on a respawn, so the top-level Safari
 * block runs `onSafariBackgroundSpawn` once the app's settings are adopted.
 * Each case imports the background fresh; the startup listeners never fire.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  SITE_GROUPS_REFRESH_ALARM,
  SITE_GROUP_STATUS_KEY,
  type onSafariBackgroundSpawn,
  type onSiteGroupsStartup,
} from "@/background/site-groups";
import {
  BUNDLED_URL,
  CATALOG_A,
  POINTER_URL,
  cdnRoutes,
  fetchedUrls,
  routeFetch,
} from "../helpers/site-groups";
import { flush } from "../helpers/cadence";
import { DAY, GOOGLE, bootSafari, installNative, settingsWith } from "./helpers";

const access = vi.hoisted(() => ({ reject: false }));
vi.mock("@/background/website-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/background/website-access")>();
  return {
    ...actual,
    collectAccessReport: () =>
      access.reject ? Promise.reject(new Error("access probe failed")) : Promise.resolve({}),
  };
});

/** The site-groups module of the background instance `bootSafari` imported. */
const siteGroups = () =>
  import("@/background/site-groups") as Promise<{
    onSafariBackgroundSpawn: typeof onSafariBackgroundSpawn;
    onSiteGroupsStartup: typeof onSiteGroupsStartup;
  }>;

const pointerFetches = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchedUrls(fetchMock).filter((u) => u === POINTER_URL).length;

const alarmCreates = () =>
  vi
    .mocked(browser.alarms.create)
    .mock.calls.filter(([name]) => (name as unknown) === SITE_GROUPS_REFRESH_ALARM).length;

beforeEach(() => {
  access.reject = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the Safari background-spawn hook", () => {
  test("with a token, the refresh alarm is created once adoption settles", async () => {
    let answer!: (value: unknown) => void;
    const adoption = new Promise((resolve) => (answer = resolve));
    const native = installNative();
    native.mockImplementation(() => adoption);
    routeFetch(await cdnRoutes(CATALOG_A));
    await bootSafari(settingsWith({ allowlist: [GOOGLE] }), {
      [SITE_GROUP_STATUS_KEY]: { checkedAt: Date.now() - DAY, lastError: null },
    });
    await flush();
    expect(alarmCreates()).toBe(0);

    answer({ pending: null });
    await vi.waitFor(() => expect(alarmCreates()).toBe(1));
    await flush();
    expect(alarmCreates()).toBe(1);
  });

  test("with no token, nothing is created and no request is made", async () => {
    installNative();
    const fetchMock = routeFetch();
    await bootSafari(settingsWith({ allowlist: ["example.com"] }));
    await flush();
    await flush();
    expect(browser.alarms.create).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a check 8 days old runs the refresh once", async () => {
    installNative();
    const fetchMock = routeFetch(await cdnRoutes(CATALOG_A));
    await bootSafari(settingsWith({ allowlist: [GOOGLE] }), {
      [SITE_GROUP_STATUS_KEY]: { checkedAt: Date.now() - 8 * DAY, lastError: null },
    });
    await vi.waitFor(() => expect(pointerFetches(fetchMock)).toBe(1));
    const { onSafariBackgroundSpawn: spawn } = await siteGroups();
    await spawn();
    expect(pointerFetches(fetchMock)).toBe(1);
  });

  test("a check 1 day old doesn't refresh", async () => {
    installNative();
    const fetchMock = routeFetch(await cdnRoutes(CATALOG_A));
    await bootSafari(settingsWith({ allowlist: [GOOGLE] }), {
      [SITE_GROUP_STATUS_KEY]: { checkedAt: Date.now() - DAY, lastError: null },
    });
    await vi.waitFor(() => expect(alarmCreates()).toBe(1));
    await flush();
    expect(pointerFetches(fetchMock)).toBe(0);
  });

  test("a refresh that leaves no status behind runs once across two spawns in one lifetime", async () => {
    installNative();
    const fetchMock = routeFetch({});
    const { store } = await bootSafari(settingsWith({ allowlist: [GOOGLE] }));
    // The status write fails, so the check still looks due afterwards.
    const set = store.set.getMockImplementation()!;
    store.set.mockImplementation((obj: Record<string, unknown>) =>
      SITE_GROUP_STATUS_KEY in obj ? Promise.reject(new Error("quota")) : set(obj)
    );
    await vi.waitFor(() => expect(pointerFetches(fetchMock)).toBe(1));
    const { onSafariBackgroundSpawn: spawn } = await siteGroups();
    await spawn();
    await spawn();
    expect(pointerFetches(fetchMock)).toBe(1);
    expect(store.data[SITE_GROUP_STATUS_KEY]).toBeUndefined();
  });

  test("onSiteGroupsStartup on Safari doesn't run a refresh", async () => {
    installNative();
    const fetchMock = routeFetch(await cdnRoutes(CATALOG_A));
    const settings = settingsWith({ allowlist: [GOOGLE] });
    const { store } = await bootSafari(settings, {
      [SITE_GROUP_STATUS_KEY]: { checkedAt: Date.now() - DAY, lastError: null },
    });
    await vi.waitFor(() => expect(alarmCreates()).toBe(1));
    const { onSiteGroupsStartup: startup } = await siteGroups();
    // Now overdue: only the spawn hook refreshes an overdue check.
    store.data[SITE_GROUP_STATUS_KEY] = { checkedAt: Date.now() - 8 * DAY, lastError: null };
    await startup(settings);
    expect(pointerFetches(fetchMock)).toBe(0);
    expect(fetchedUrls(fetchMock).every((u) => u === BUNDLED_URL)).toBe(true);
  });

  test("when adoption rejects, the hook still runs and nothing is left unhandled", async () => {
    access.reject = true;
    const native = installNative();
    routeFetch(await cdnRoutes(CATALOG_A));
    await bootSafari(settingsWith({ allowlist: [GOOGLE] }), {
      [SITE_GROUP_STATUS_KEY]: { checkedAt: Date.now() - DAY, lastError: null },
    });
    await vi.waitFor(() => expect(alarmCreates()).toBe(1));
    // Adoption failed before its native call.
    expect(native).not.toHaveBeenCalled();
  });
});
