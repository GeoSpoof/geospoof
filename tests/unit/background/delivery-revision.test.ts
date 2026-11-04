/**
 * F22: every page delivery carries the settings revision it was built from,
 * and the background's synchronous caches never move back to an older
 * snapshot.
 *
 * - Pushes carry it on the UPDATE_SETTINGS envelope (one owner,
 *   sendSettingsToTab, also used by the injection-check alarm and
 *   tabs.onCreated); the content-script GET_SETTINGS reply carries it next to
 *   the payload. The payload itself is unchanged.
 * - The worker-filter cache and the Accept-Language snapshot skip a snapshot
 *   older than the one they hold; a navigation re-plan uses the newer one.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { Location, Settings, Timezone } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import type { ContentSettingsReply, Message, UpdateSettingsMessage } from "@/shared/types/messages";
import { sendSettingsToTab } from "@/background/tabs";
import {
  _classifyRequestForTest,
  _resetWorkerFilterSettingsForTest,
  installWorkerRequestFilter,
  uninstallWorkerRequestFilter,
  updateWorkerFilterSettings,
  workerPayloadFor,
} from "@/background/worker-request-filter";
import {
  _resetAcceptLanguageStateForTest,
  installAcceptLanguageRewriter,
  refreshAcceptLanguageOnNavigation,
  resolveAcceptLanguageFor,
  uninstallAcceptLanguageRewriter,
  updateAcceptLanguageSettings,
} from "@/background/accept-language";
import { storageData } from "../../setup";
import { deferred, mocks } from "../../helpers/cadence";
import { importBackground } from "../../helpers/import-background";
import { ENTRY_DUBLIN, TOKYO, TOKYO_NAME, TOKYO_TZ } from "../../helpers/site-locations";

const R = 1_800_000_000_000;
const URL = "https://example.com/page";

const LA: Location = { latitude: 34.0522, longitude: -118.2437, accuracy: 45 };
const LA_TZ: Timezone = { identifier: "America/Los_Angeles", offset: 480, dstOffset: 60 };

/** The UpdateSettingsPayload keys every page builder emits, sorted. */
const PAYLOAD_KEYS = [
  "accuracySeed",
  "accuracySetting",
  "debugLogging",
  "enabled",
  "engineTimezone",
  "engineTimezoneSettled",
  "locale",
  "location",
  "preserveGeolocationPrompt",
  "timezone",
  "verbosityLevel",
  "webrtcProtection",
];

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    onboardingCompleted: true,
    location: TOKYO,
    timezone: TOKYO_TZ,
    locationName: TOKYO_NAME,
    localeSpoofing: { mode: "match" },
    accuracySeed: 777,
    precisionSeed: 123456789,
    ...overrides,
  };
}

/** The newer snapshot (Tokyo) and an older one (Los Angeles). */
const NEWER = makeSettings({ revision: R });
const OLDER = makeSettings({ revision: R - 1, location: LA, timezone: LA_TZ });

/** Record every tabs.sendMessage call; every send resolves (PING included). */
function captureSends(): Array<{ tabId: number; message: UpdateSettingsMessage }> {
  const sent: Array<{ tabId: number; message: UpdateSettingsMessage }> = [];
  browser.tabs.sendMessage = vi.fn((tabId: number, message: Message) => {
    if (message.type === "UPDATE_SETTINGS") {
      sent.push({ tabId, message: message as unknown as UpdateSettingsMessage });
    }
    return Promise.resolve();
  });
  return sent;
}

describe("pushes and replies carry the revision", () => {
  test("sendSettingsToTab stamps the snapshot's revision on the envelope; the payload keys are unchanged", async () => {
    const sent = captureSends();
    await sendSettingsToTab({ id: 1, url: URL }, NEWER);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0].message).sort()).toEqual(["payload", "revision", "type"]);
    expect(sent[0].message.revision).toBe(R);
    expect(Object.keys(sent[0].message.payload).sort()).toEqual(PAYLOAD_KEYS);
  });

  test.each([
    ["absent", undefined],
    ["NaN", NaN],
    ["negative", -1],
  ])("sendSettingsToTab omits the field when the snapshot's revision is %s", async (_l, v) => {
    const sent = captureSends();
    await sendSettingsToTab({ id: 1, url: URL }, { ...NEWER, revision: v });
    expect(sent).toHaveLength(1);
    expect("revision" in sent[0].message).toBe(false);
    expect(Object.keys(sent[0].message.payload).sort()).toEqual(PAYLOAD_KEYS);
  });

  test("the content-script GET_SETTINGS reply is the payload plus revision, with no list keys", async () => {
    storageData.settings = makeSettings({
      revision: R,
      allowlist: ["a.test"],
      denylist: ["b.test"],
      siteLocations: [ENTRY_DUBLIN],
    });
    const bg = await importBackground();
    const reply = (await bg.handleMessage(
      { type: "GET_SETTINGS" },
      { tab: { id: 2, url: URL } as browser.tabs.Tab }
    )) as ContentSettingsReply;

    expect(reply.revision).toBe(R);
    expect(Object.keys(reply).sort()).toEqual([...PAYLOAD_KEYS, "revision"].sort());
    for (const key of ["allowlist", "denylist", "siteLocations", "lastUpdated"]) {
      expect(reply).not.toHaveProperty(key);
    }
  });

  test("the injection-check alarm and the tabs.onCreated push send stamped envelopes", async () => {
    storageData.settings = makeSettings({ revision: R });
    const bg = await importBackground();
    const sent = captureSends();

    // The alarm: PING resolves, so the tab counts as injected.
    browser.tabs.get = vi.fn().mockResolvedValue({ id: 7, url: URL });
    await bg.onAlarm({ name: "injection-check:7:0", scheduledTime: Date.now() });
    const alarm = sent.find((m) => m.tabId === 7);
    expect(alarm, "the injection-check alarm sent no UPDATE_SETTINGS").toBeDefined();
    expect(alarm!.message.revision).toBe(R);
    expect(Object.keys(alarm!.message.payload).sort()).toEqual(PAYLOAD_KEYS);

    // tabs.onCreated, sent after its 100 ms delay.
    const onCreated = mocks.onCreatedAddListener().mock.calls.at(-1)?.[0] as
      ((tab: { id?: number; url?: string }) => void) | undefined;
    expect(onCreated, "tabs.onCreated listener was not registered").toBeDefined();
    browser.tabs.get = vi.fn().mockResolvedValue({ id: 42, url: URL });
    vi.useFakeTimers();
    try {
      onCreated!({ id: 42, url: URL });
      await vi.waitFor(() => expect(sent.some((m) => m.tabId === 42)).toBe(true), {
        timeout: 2000,
      });
    } finally {
      vi.useRealTimers();
    }
    const created = sent.find((m) => m.tabId === 42)!;
    expect(created.message.revision).toBe(R);
    expect(Object.keys(created.message.payload).sort()).toEqual(PAYLOAD_KEYS);
  });
});

describe("the worker-filter cache keeps the newer snapshot", () => {
  interface FakeFilter {
    ondata: ((event: { data: ArrayBuffer }) => void) | null;
    onstop: (() => void) | null;
    onerror: (() => void) | null;
    written: string[];
    write: (data: ArrayBuffer | Uint8Array) => void;
    close: () => void;
    disconnect: () => void;
  }
  type Details = Parameters<typeof _classifyRequestForTest>[0] & { thirdParty?: boolean };
  type Listener = (details: Details) => void;

  const PAGE = "https://example.org/";
  const BODY = "/*worker body*/";
  const listeners: { request?: Listener; headers?: Listener } = {};
  let filters: FakeFilter[] = [];
  let n = 0;
  const tabs = browser.tabs as unknown as Record<string, unknown> & {
    onUpdated: Record<string, unknown>;
  };

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

  /** A SharedWorker the top-level page on PAGE started, through both listeners and onstop. */
  function runSharedWorker(): string {
    const details: Details = {
      requestId: `revision-${++n}`,
      url: "https://example.org/shared.js",
      type: "script",
      method: "GET",
      tabId: -1,
      frameId: -1,
      documentUrl: PAGE,
      thirdParty: false,
      requestHeaders: [{ name: "Sec-Fetch-Dest", value: "sharedworker" }],
    };
    const before = filters.length;
    listeners.request!(details);
    const filter = filters[before];
    expect(filter, "a filter is attached").toBeDefined();
    listeners.headers!(details);
    filter.ondata!({ data: new TextEncoder().encode(BODY).buffer });
    filter.onstop!();
    return filter.written.join("");
  }

  beforeEach(() => {
    _resetWorkerFilterSettingsForTest();
    filters = [];
    (browser as unknown as { webRequest?: unknown }).webRequest = {
      filterResponseData: () => {
        const f = makeFilter();
        filters.push(f);
        return f;
      },
      onBeforeRequest: {
        addListener: (fn: Listener) => (listeners.request = fn),
        removeListener: () => undefined,
      },
      onBeforeSendHeaders: {
        addListener: (fn: Listener) => (listeners.headers = fn),
        removeListener: () => undefined,
      },
    };
    tabs.onRemoved = { addListener: () => undefined, removeListener: () => undefined };
    tabs.onUpdated.removeListener = () => undefined;
    vi.mocked(browser.tabs.query).mockResolvedValue([{ id: 1, url: PAGE }] as never);
  });

  afterEach(() => {
    uninstallWorkerRequestFilter();
    delete (browser as unknown as { webRequest?: unknown }).webRequest;
    delete tabs.onRemoved;
    delete tabs.onUpdated.removeListener;
    vi.mocked(browser.tabs.query).mockResolvedValue([]);
    _resetWorkerFilterSettingsForTest();
  });

  test("the two snapshots give different worker payloads", () => {
    expect(workerPayloadFor(NEWER, PAGE)).not.toBe(workerPayloadFor(OLDER, PAGE));
  });

  test("newer, then older: the worker gets the newer snapshot's values", async () => {
    await installWorkerRequestFilter();
    updateWorkerFilterSettings(NEWER);
    updateWorkerFilterSettings(OLDER);
    expect(runSharedWorker()).toBe(workerPayloadFor(NEWER, PAGE) + BODY);
  });

  test("an equal revision replaces the snapshot", async () => {
    const sameRevision = { ...OLDER, revision: R };
    await installWorkerRequestFilter();
    updateWorkerFilterSettings(NEWER);
    updateWorkerFilterSettings(sameRevision);
    expect(runSharedWorker()).toBe(workerPayloadFor(sameRevision, PAGE) + BODY);
  });

  test("a prime that resolves after a broadcast keeps the broadcast's snapshot", async () => {
    const read = deferred<{ settings: Settings }>();
    const originalGet = mocks.localGet();
    browser.storage.local.get = vi.fn(() => read.promise);
    try {
      const installing = installWorkerRequestFilter();
      // The broadcast lands while the prime's read is still pending.
      updateWorkerFilterSettings(NEWER);
      read.resolve({ settings: structuredClone(OLDER) });
      await installing;
    } finally {
      browser.storage.local.get = originalGet;
    }
    expect(runSharedWorker()).toBe(workerPayloadFor(NEWER, PAGE) + BODY);
  });
});

// Tests compile with __FIREFOX__ = true, so the DNR branch (queueDnrRefresh)
// isn't reachable from these functions here; it sits behind the same guard,
// and refreshDnrRule keeps its own direct tests in accept-language.test.ts.
describe("the Accept-Language snapshot keeps the newer settings", () => {
  type HeaderListener = (details: {
    requestId: string;
    url: string;
    tabId: number;
    type: string;
    requestHeaders?: { name: string; value?: string }[];
  }) => { requestHeaders?: { name: string; value?: string }[] } | undefined;

  let listener: HeaderListener | undefined;

  /** The Accept-Language the Firefox blocking listener sends for a top-level load of URL. */
  function header(): string | undefined {
    const out = listener!({
      requestId: "1",
      url: URL,
      tabId: 1,
      type: "main_frame",
      requestHeaders: [{ name: "Accept-Language", value: "de-DE" }],
    });
    return out?.requestHeaders?.find((h) => h.name.toLowerCase() === "accept-language")?.value;
  }

  beforeEach(() => {
    _resetAcceptLanguageStateForTest();
    listener = undefined;
    (browser as unknown as { webRequest?: unknown }).webRequest = {
      onBeforeSendHeaders: {
        addListener: (fn: HeaderListener) => (listener = fn),
        removeListener: () => undefined,
      },
    };
    installAcceptLanguageRewriter();
    expect(listener, "the Firefox header listener was not installed").toBeDefined();
  });

  afterEach(() => {
    uninstallAcceptLanguageRewriter();
    delete (browser as unknown as { webRequest?: unknown }).webRequest;
    _resetAcceptLanguageStateForTest();
  });

  test("the two snapshots give different headers", () => {
    expect(resolveAcceptLanguageFor(NEWER, URL)).not.toBe(resolveAcceptLanguageFor(OLDER, URL));
  });

  test("newer, then older: the header is the newer snapshot's", () => {
    updateAcceptLanguageSettings(NEWER);
    updateAcceptLanguageSettings(OLDER);
    expect(header()).toBe(resolveAcceptLanguageFor(NEWER, URL));
  });

  test("a navigation with an older snapshot keeps the newer one, and a newer navigation moves on", () => {
    updateAcceptLanguageSettings(NEWER);
    refreshAcceptLanguageOnNavigation(OLDER);
    expect(header()).toBe(resolveAcceptLanguageFor(NEWER, URL));

    const newest = { ...OLDER, revision: R + 1 };
    refreshAcceptLanguageOnNavigation(newest);
    expect(header()).toBe(resolveAcceptLanguageFor(newest, URL));
  });
});
