/**
 * F22 end to end: the real background and the real content script in one
 * jsdom realm. The content script's runtime.sendMessage goes to the
 * background's handleMessage with a tab sender (tab 1 on a.test), and the
 * background's tabs.sendMessage(1, …) goes to the content script's listener.
 *
 * Each case builds a delivery from settings that a later write replaced, holds
 * it until the later write's push has been applied, then releases it. The
 * page must drop it, because it carries an older settings revision; without
 * the revision it would put the moved site location back.
 *
 * a.test starts with a site location (Tokyo); the main location is Los
 * Angeles. "The move" re-points that entry at b.test, so a.test gets the main
 * location.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { Location, LocationName, Settings, Timezone } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import type { Message, UpdateSettingsMessage } from "@/shared/types/messages";
import { workerPayloadFor } from "@/background/worker-request-filter";
import { resolveAcceptLanguageFor } from "@/background/accept-language";
import { deferred, mocks, type Deferred } from "../helpers/cadence";
import {
  MEXICO_CITY,
  MEXICO_CITY_NAME,
  MEXICO_CITY_TZ,
  TOKYO,
  TOKYO_NAME,
  TOKYO_TZ,
  makeSiteLocation,
} from "../helpers/site-locations";

const lookups = vi.hoisted(() => ({
  timezone: vi.fn<(lat: number, lon: number, hint?: string) => Promise<Timezone>>(),
}));

vi.mock("@/background/timezone", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/background/timezone")>()),
  getTimezoneForCoordinates: lookups.timezone,
}));

// Must match `EVENT_NAME` in src/content/index.ts (process.env.EVENT_NAME || "__x_evt").
const EVENT_NAME = "__x_evt";
const PAGE = "https://a.test/";
const SESSION_KEY = "cache:precisionCadence:session";
const BODY = "/*worker body*/";

const LA: Location = { latitude: 34.0522, longitude: -118.2437, accuracy: 45 };
const LA_TZ: Timezone = { identifier: "America/Los_Angeles", offset: 480, dstOffset: 60 };
const LA_NAME: LocationName = {
  city: "Los Angeles",
  country: "United States",
  displayName: "Los Angeles, United States",
};

const ENTRY = makeSiteLocation({
  id: "1700000000001",
  patterns: ["a.test"],
  location: TOKYO,
  timezone: TOKYO_TZ,
  locationName: TOKYO_NAME,
});

/** Re-point the entry at b.test, same coordinates (no lookups). */
const MOVE = {
  id: ENTRY.id,
  patterns: ["b.test"],
  latitude: TOKYO.latitude,
  longitude: TOKYO.longitude,
};

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    onboardingCompleted: true,
    location: LA,
    timezone: LA_TZ,
    locationName: LA_NAME,
    accuracySeed: 777,
    precisionSeed: 123456789,
    siteLocations: [ENTRY],
    revision: Date.now() - 60_000,
    ...overrides,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface Hold extends Deferred<void> {
  called: boolean;
}

function hold(): Hold {
  const d = deferred<void>() as Hold;
  d.called = false;
  return d;
}

type ContentListener = (message: Message & { revision?: unknown }) => unknown;
type RequestListener = (details: Record<string, unknown>) => unknown;

interface FakeFilter {
  ondata: ((event: { data: ArrayBuffer }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  written: string[];
  write: (data: ArrayBuffer | Uint8Array) => void;
  close: () => void;
  disconnect: () => void;
}

interface Detail {
  enabled: boolean;
  location: { latitude: number; longitude: number } | null;
  timezone: { identifier: string } | null;
}

/** The stored settings slot and the holds a test can arm. */
let stored: Settings;
let localGetHolds: Hold[];
let tabsQueryHolds: Hold[];
let sessionGetHolds: Map<string, Hold>;
let sessionData: Record<string, unknown>;

/** Content side. */
let contentListener: ContentListener | undefined;
let dispatches: Detail[];
let onDispatch: ((event: Event) => void) | undefined;
/** Every UPDATE_SETTINGS delivered to tab 1, in delivery order. */
let envelopes: UpdateSettingsMessage[];
/** Every GET_SETTINGS reply the background returned, in order. */
let replies: Array<Record<string, unknown>>;

/** Firefox webRequest listeners the background registered. */
let workerRequest: RequestListener | undefined;
let workerHeaders: RequestListener | undefined;
let acceptLanguageListener: RequestListener | undefined;
let filters: FakeFilter[];
let workerRuns = 0;

function makeFilter(): FakeFilter {
  const written: string[] = [];
  return {
    ondata: null,
    onstop: null,
    onerror: null,
    written,
    write: (data) => written.push(new TextDecoder().decode(data)),
    close: () => undefined,
    disconnect: () => undefined,
  };
}

function installBrowser(): void {
  browser.storage.local.get = vi.fn(() => {
    const snapshot = structuredClone(stored);
    const h = localGetHolds.shift();
    if (h) {
      h.called = true;
      return h.promise.then(() => ({ settings: snapshot }));
    }
    return Promise.resolve({ settings: snapshot });
  });
  browser.storage.local.set = vi.fn((obj: { settings?: Settings }) => {
    if (obj.settings) stored = structuredClone(obj.settings);
    return Promise.resolve();
  });
  browser.storage.session.get = vi.fn((key: string | null) => {
    const answer = (): Record<string, unknown> =>
      key === null ? { ...sessionData } : key in sessionData ? { [key]: sessionData[key] } : {};
    const h = key === null ? undefined : sessionGetHolds.get(key);
    if (h) {
      sessionGetHolds.delete(key!);
      h.called = true;
      return h.promise.then(answer);
    }
    return Promise.resolve(answer());
  });
  browser.storage.session.set = vi.fn((obj: Record<string, unknown>) => {
    Object.assign(sessionData, obj);
    return Promise.resolve();
  });

  browser.tabs.query = vi.fn(() => {
    const tabs = [{ id: 1, url: PAGE }];
    const h = tabsQueryHolds.shift();
    if (h) {
      h.called = true;
      return h.promise.then(() => tabs);
    }
    return Promise.resolve(tabs);
  }) as unknown as typeof browser.tabs.query;
  browser.tabs.sendMessage = vi.fn((tabId: number, message: Message) => {
    if (tabId !== 1 || !contentListener) {
      return Promise.reject(new Error("Receiving end does not exist."));
    }
    if (message.type === "UPDATE_SETTINGS") {
      envelopes.push(structuredClone(message) as unknown as UpdateSettingsMessage);
    }
    return Promise.resolve(contentListener(message));
  });
  (browser.tabs as unknown as Record<string, unknown>).onRemoved = {
    addListener: () => undefined,
    removeListener: () => undefined,
  };

  (browser as unknown as { webRequest?: unknown }).webRequest = {
    filterResponseData: () => {
      const f = makeFilter();
      filters.push(f);
      return f;
    },
    onBeforeRequest: {
      addListener: (fn: RequestListener) => (workerRequest = fn),
      removeListener: () => undefined,
    },
    onBeforeSendHeaders: {
      addListener: (fn: RequestListener, _filter: unknown, extra: string[]) => {
        if (extra.includes("blocking")) acceptLanguageListener = fn;
        else workerHeaders = fn;
      },
      removeListener: () => undefined,
    },
  };
}

/** Import a fresh background over `settings`, then let its spawn-time reads settle. */
async function boot(settings: Settings) {
  vi.resetModules();
  stored = structuredClone(settings);
  localGetHolds = [];
  tabsQueryHolds = [];
  sessionGetHolds = new Map();
  sessionData = {};
  contentListener = undefined;
  dispatches = [];
  envelopes = [];
  replies = [];
  filters = [];
  workerRequest = workerHeaders = acceptLanguageListener = undefined;
  installBrowser();

  const bg = await import("@/background");
  browser.runtime.sendMessage = vi.fn(async (message: Message) => {
    if (message.type !== "GET_SETTINGS") return undefined;
    const reply = (await bg.handleMessage(message, {
      tab: { id: 1, url: PAGE } as browser.tabs.Tab,
    })) as Record<string, unknown>;
    replies.push(structuredClone(reply));
    return reply;
  }) as unknown as typeof browser.runtime.sendMessage;
  await sleep(20);
  return bg;
}

/** Load the content script on tab 1. Its GET_SETTINGS goes out during the import. */
async function loadContent(): Promise<void> {
  onDispatch = (event: Event) => dispatches.push((event as CustomEvent<Detail>).detail);
  window.addEventListener(EVENT_NAME, onDispatch);
  const spy = vi.spyOn(browser.runtime.onMessage, "addListener");
  spy.mockClear();
  await import("@/content/index");
  contentListener = spy.mock.calls.at(-1)?.[0] as ContentListener | undefined;
  spy.mockRestore();
  expect(contentListener, "the content script registered no onMessage listener").toBeDefined();
}

/** Load the content script and wait until its first reply is applied and its retries ran. */
async function loadContentAndApply(): Promise<void> {
  await loadContent();
  await until(() => dispatches.length > 0, "the first dispatch");
  await sleep(150);
}

function lastZone(): string | null {
  return dispatches.at(-1)?.timezone?.identifier ?? null;
}

/** Run a SharedWorker that the top-level page on a.test started, through the response filter. */
function workerOutput(): string {
  const details = {
    requestId: `p5-${++workerRuns}`,
    url: "https://a.test/shared.js",
    type: "script",
    method: "GET",
    tabId: -1,
    frameId: -1,
    documentUrl: PAGE,
    thirdParty: false,
    requestHeaders: [{ name: "Sec-Fetch-Dest", value: "sharedworker" }],
  };
  const before = filters.length;
  workerRequest!(details);
  const filter = filters[before];
  expect(filter, "a filter is attached").toBeDefined();
  workerHeaders!(details);
  filter.ondata!({ data: new TextEncoder().encode(BODY).buffer });
  filter.onstop!();
  return filter.written.join("");
}

/** The Accept-Language the Firefox blocking listener sends for a top-level load of a.test. */
function acceptLanguage(): string | undefined {
  const out = acceptLanguageListener!({
    requestId: "p5-header",
    url: PAGE,
    tabId: 1,
    type: "main_frame",
    requestHeaders: [{ name: "Accept-Language", value: "de-DE" }],
  }) as { requestHeaders?: Array<{ name: string; value?: string }> } | undefined;
  return out?.requestHeaders?.find((h) => h.name.toLowerCase() === "accept-language")?.value;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (onDispatch) window.removeEventListener(EVENT_NAME, onDispatch);
  onDispatch = undefined;
  delete (browser as unknown as { webRequest?: unknown }).webRequest;
  delete (browser.tabs as unknown as Record<string, unknown>).onRemoved;
  // Let this test's content script and background timers finish before the next one.
  await sleep(150);
  vi.restoreAllMocks();
});

describe("a delivery built before a write can't undo it", () => {
  test("P1: a GET_SETTINGS reply read before the move lands after the move's push and is dropped", async () => {
    const bg = await boot(makeSettings());
    const read = hold();
    localGetHolds.push(read);
    await loadContent();
    expect(read.called, "the page's GET_SETTINGS read is held").toBe(true);

    expect(await bg.handleSaveSiteLocation(MOVE)).toEqual({ success: true, id: ENTRY.id });
    await until(() => dispatches.length > 0, "the move's push");
    expect(lastZone()).toBe(LA_TZ.identifier);

    read.resolve();
    await until(() => replies.length === 1, "the held reply");
    await sleep(150);
    // The reply was built from the old list and carries the older revision.
    expect(replies[0].timezone).toEqual(TOKYO_TZ);
    expect(replies[0].revision as number).toBeLessThan(envelopes.at(-1)!.revision!);
    expect(lastZone()).toBe(LA_TZ.identifier);
  });

  test("P2: a VPN location broadcast held in tabs.query lands after the move's and is dropped", async () => {
    const bg = await boot(makeSettings({ vpnSyncEnabled: true }));
    await loadContentAndApply();
    expect(lastZone()).toBe(TOKYO_TZ.identifier);

    lookups.timezone.mockResolvedValue(MEXICO_CITY_TZ);
    const query = hold();
    tabsQueryHolds.push(query);
    const vpn = bg.handleSetLocation(
      { latitude: MEXICO_CITY.latitude, longitude: MEXICO_CITY.longitude },
      { fromVpnSync: true, locationName: MEXICO_CITY_NAME }
    );
    await until(() => query.called, "the VPN broadcast's tabs.query");

    expect(await bg.handleSaveSiteLocation(MOVE)).toEqual({ success: true, id: ENTRY.id });
    await sleep(20);
    expect(lastZone()).toBe(MEXICO_CITY_TZ.identifier);
    const moveRevision = envelopes.at(-1)!.revision!;

    query.resolve();
    await expect(vpn).resolves.toBe(true);
    await sleep(20);
    // The held push went out last, built from the list that still had a.test.
    const late = envelopes.at(-1)!;
    expect(late.payload.timezone).toEqual(TOKYO_TZ);
    expect(late.revision!).toBeLessThan(moveRevision);
    expect(lastZone()).toBe(MEXICO_CITY_TZ.identifier);
  });

  // The precision switch, not a VPN set: concurrent payload builds share one
  // in-flight storage.session read, so the move's build must not read the
  // period while this one is held. With no main location, a.test's payload
  // after the move has no point to offset and reads nothing.
  test("P3: a broadcast held in its payload build (approximate, held storage.session read) is dropped", async () => {
    const bg = await boot(
      makeSettings({
        location: null,
        timezone: null,
        locationName: null,
        precisionCadence: "session",
      })
    );
    await loadContentAndApply();
    expect(lastZone()).toBe(TOKYO_TZ.identifier);

    const read = hold();
    sessionGetHolds.set(SESSION_KEY, read);
    const precision = bg.handleMessage(
      {
        type: "SET_PRECISION",
        payload: { precision: { mode: "approximate", radiusMeters: 2000 } },
      },
      {}
    );
    await until(() => read.called, "the precision broadcast's period read");

    expect(await bg.handleSaveSiteLocation(MOVE)).toEqual({ success: true, id: ENTRY.id });
    await sleep(20);
    expect(dispatches.at(-1)?.timezone).toBeNull();
    expect(dispatches.at(-1)?.location).toBeNull();
    const moveRevision = envelopes.at(-1)!.revision!;

    read.resolve();
    await expect(precision).resolves.toEqual({ success: true });
    await sleep(20);
    const late = envelopes.at(-1)!;
    expect(late.payload.timezone).toEqual(TOKYO_TZ);
    expect(late.revision!).toBeLessThan(moveRevision);
    expect(dispatches.at(-1)?.timezone).toBeNull();
    expect(dispatches.at(-1)?.location).toBeNull();
  });

  test("P4: a tabs.onCreated push built before a write and delivered after its push is dropped", async () => {
    const bg = await boot(makeSettings());
    await loadContentAndApply();
    expect(lastZone()).toBe(TOKYO_TZ.identifier);

    const onCreated = mocks.onCreatedAddListener().mock.calls.at(-1)?.[0] as
      ((tab: { id?: number; url?: string; discarded?: boolean }) => void) | undefined;
    expect(onCreated, "tabs.onCreated listener was not registered").toBeDefined();
    browser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: PAGE });
    onCreated!({ id: 1, url: PAGE, discarded: false });
    // Its settings are loaded now; the push goes out 100 ms later.
    await sleep(10);

    expect(await bg.handleSaveSiteLocation(MOVE)).toEqual({ success: true, id: ENTRY.id });
    await sleep(10);
    expect(lastZone()).toBe(LA_TZ.identifier);
    const moveIndex = envelopes.length - 1;
    const moveRevision = envelopes[moveIndex].revision!;

    await until(() => envelopes.length > moveIndex + 1, "the tabs.onCreated push");
    await sleep(20);
    const late = envelopes.at(-1)!;
    expect(late.payload.timezone).toEqual(TOKYO_TZ);
    expect(late.revision!).toBeLessThan(moveRevision);
    expect(lastZone()).toBe(LA_TZ.identifier);
  });

  test("P5: a late SET_PROTECTION_STATUS broadcast leaves both caches and the page on the move", async () => {
    const bg = await boot(makeSettings({ enabled: false, localeSpoofing: { mode: "match" } }));
    await loadContentAndApply();
    expect(dispatches.at(-1)?.enabled).toBe(false);

    // Only the first tabs.query (the injection pass) is held.
    const query = hold();
    tabsQueryHolds.push(query);
    const enabling = bg.handleSetProtectionStatus({ enabled: true });
    await until(() => query.called, "the injection pass's tabs.query");

    expect(await bg.handleSaveSiteLocation(MOVE)).toEqual({ success: true, id: ENTRY.id });
    await sleep(20);
    expect(dispatches.at(-1)?.enabled).toBe(true);
    expect(lastZone()).toBe(LA_TZ.identifier);
    const moveRevision = envelopes.at(-1)!.revision!;

    query.resolve();
    await enabling;
    await sleep(20);
    const late = envelopes.at(-1)!;
    expect(late.payload.timezone).toEqual(TOKYO_TZ);
    expect(late.revision!).toBeLessThan(moveRevision);

    const moved = await bg.loadSettings();
    const unmoved: Settings = { ...moved, siteLocations: [ENTRY] };
    expect(moved.revision).toBe(moveRevision);
    // The two snapshots differ on a.test for both caches.
    expect(workerPayloadFor(unmoved, PAGE)).not.toBe(workerPayloadFor(moved, PAGE));
    expect(resolveAcceptLanguageFor(unmoved, PAGE)).not.toBe(resolveAcceptLanguageFor(moved, PAGE));

    expect(workerOutput()).toBe(workerPayloadFor(moved, PAGE) + BODY);
    expect(acceptLanguage()).toBe(resolveAcceptLanguageFor(moved, PAGE));
    expect(lastZone()).toBe(LA_TZ.identifier);
  });
});
