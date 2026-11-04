/**
 * The content script asks for settings again when its page is shown after
 * being hidden: a back/forward cache restore (`pageshow` with `persisted`) or
 * a Chrome prerender activation (`prerenderingchange`). Each request carries
 * the `topFrame` claim the background uses to judge a prerendered page by its
 * own URL.
 *
 * These load the REAL content script (`src/content/index.ts`). Re-imports pile
 * listeners onto the shared jsdom window, so each test captures the newest
 * module's own `pageshow` / `prerenderingchange` handlers through spies and
 * calls them directly.
 */
import { describe, test, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Must match `EVENT_NAME` in src/content/index.ts (process.env.EVENT_NAME || "__x_evt").
const EVENT_NAME = "__x_evt";

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function reply(timezoneId: string): Record<string, unknown> {
  return {
    enabled: true,
    location: { latitude: 35.6762, longitude: 139.6503, accuracy: 10 },
    timezone: { identifier: timezoneId, offset: 0, dstOffset: 0 },
    debugLogging: false,
    verbosityLevel: "INFO",
    webrtcProtection: false,
    accuracySetting: { mode: "auto" },
    accuracySeed: 1,
    locale: null,
  };
}

const runtime = browser.runtime as unknown as { sendMessage: Mock };

/** A reply or push payload stamped with a settings revision (any value, to test the reader). */
function stamped(timezoneId: string, revision: unknown): Record<string, unknown> {
  return { ...reply(timezoneId), revision };
}

type MessageListener = (message: {
  type: string;
  payload?: Record<string, unknown>;
  revision?: unknown;
}) => unknown;

interface Loaded {
  /** Pending GET_SETTINGS replies, oldest first. */
  replies: Deferred[];
  pageshow: EventListener | undefined;
  prerenderingchange: EventListener | undefined;
  /** This module's runtime.onMessage listener (UPDATE_SETTINGS pushes, PING). */
  onMessage: MessageListener;
}

/** GET_SETTINGS requests sent since the last mockClear. */
function getSettingsCalls(): unknown[] {
  return runtime.sendMessage.mock.calls
    .map((c) => c[0] as { type: string })
    .filter((m) => m.type === "GET_SETTINGS");
}

async function loadContentScript(): Promise<Loaded> {
  vi.resetModules();
  const replies: Deferred[] = [];
  runtime.sendMessage.mockReset();
  runtime.sendMessage.mockImplementation((message: { type: string }) => {
    if (message.type !== "GET_SETTINGS") return Promise.resolve(undefined);
    const d = deferred();
    replies.push(d);
    return d.promise;
  });

  const windowSpy = vi.spyOn(window, "addEventListener");
  const documentSpy = vi.spyOn(document, "addEventListener");
  const onMessageSpy = vi.spyOn(browser.runtime.onMessage, "addListener");
  windowSpy.mockClear();
  documentSpy.mockClear();
  onMessageSpy.mockClear();
  await import("@/content/index");

  const find = (spy: typeof windowSpy, type: string): EventListener | undefined =>
    spy.mock.calls.find((c) => c[0] === type)?.[1] as EventListener | undefined;
  const onMessage = onMessageSpy.mock.calls.at(-1)?.[0] as MessageListener | undefined;
  expect(onMessage, "the content script registered no runtime.onMessage listener").toBeDefined();
  const loaded: Loaded = {
    replies,
    pageshow: find(windowSpy, "pageshow"),
    prerenderingchange: find(documentSpy, "prerenderingchange"),
    onMessage: onMessage!,
  };
  windowSpy.mockRestore();
  documentSpy.mockRestore();
  onMessageSpy.mockRestore();
  return loaded;
}

/** Deliver an UPDATE_SETTINGS push to the loaded module. */
function push(loaded: Loaded, timezoneId: string, revision?: unknown): void {
  const message: Parameters<MessageListener>[0] = {
    type: "UPDATE_SETTINGS",
    payload: reply(timezoneId),
  };
  if (revision !== undefined) message.revision = revision;
  loaded.onMessage(message);
}

function pageshowEvent(persisted: boolean): Event {
  return Object.defineProperty(new Event("pageshow"), "persisted", { value: persisted });
}

/** Collect the settings details the content script hands the MAIN world. */
function captureDispatches(): {
  details: Array<{ timezone: { identifier: string } | null }>;
  stop: () => void;
} {
  const details: Array<{ timezone: { identifier: string } | null }> = [];
  const handler = (event: Event): void => {
    details.push((event as CustomEvent<{ timezone: { identifier: string } | null }>).detail);
  };
  window.addEventListener(EVENT_NAME, handler);
  return { details, stop: () => window.removeEventListener(EVENT_NAME, handler) };
}

/** Settle microtasks and the first dispatch's document_start retries. */
async function settle(): Promise<void> {
  await vi.runAllTimersAsync();
}

describe("content script settings refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  test("the initial request carries the top-frame claim", async () => {
    await loadContentScript();
    expect(getSettingsCalls()).toEqual([{ type: "GET_SETTINGS", payload: { topFrame: true } }]);
  });

  test("a bfcache restore re-requests and dispatches the new values once", async () => {
    const loaded = await loadContentScript();
    const captured = captureDispatches();
    loaded.replies[0].resolve(reply("Asia/Tokyo"));
    await settle();
    const afterLoad = captured.details.length;
    expect(captured.details.at(-1)?.timezone?.identifier).toBe("Asia/Tokyo");

    expect(loaded.pageshow).toBeTypeOf("function");
    loaded.pageshow!(pageshowEvent(true));
    expect(getSettingsCalls()).toHaveLength(2);
    expect(getSettingsCalls()[1]).toEqual({ type: "GET_SETTINGS", payload: { topFrame: true } });

    loaded.replies[1].resolve(reply("Europe/Paris"));
    await settle();
    // One dispatch on the existing event: the document_start retries ran once.
    expect(captured.details.length).toBe(afterLoad + 1);
    expect(captured.details.at(-1)?.timezone?.identifier).toBe("Europe/Paris");
    captured.stop();
  });

  test("a refresh with unchanged settings re-applies identical state", async () => {
    const loaded = await loadContentScript();
    const captured = captureDispatches();
    loaded.replies[0].resolve(reply("Asia/Tokyo"));
    await settle();
    const before = captured.details.at(-1);

    loaded.pageshow!(pageshowEvent(true));
    loaded.replies[1].resolve(reply("Asia/Tokyo"));
    await settle();
    expect(captured.details.at(-1)).toEqual(before);
    captured.stop();
  });

  test("engineTimezone is forwarded to the MAIN world, and defaults to false", async () => {
    const loaded = await loadContentScript();
    const captured = captureDispatches();
    loaded.replies[0].resolve({ ...reply("Asia/Tokyo"), engineTimezone: true });
    await settle();
    const last = captured.details.at(-1) as { engineTimezone?: boolean } | undefined;
    expect(last?.engineTimezone).toBe(true);

    loaded.pageshow!(pageshowEvent(true));
    loaded.replies[1].resolve(reply("Asia/Tokyo"));
    await settle();
    const refreshed = captured.details.at(-1) as { engineTimezone?: boolean } | undefined;
    expect(refreshed?.engineTimezone).toBe(false);
    captured.stop();
  });

  test("a non-persisted pageshow (ordinary load) sends nothing", async () => {
    const loaded = await loadContentScript();
    loaded.pageshow!(pageshowEvent(false));
    expect(getSettingsCalls()).toHaveLength(1);
  });

  test("two refreshes resolved out of order dispatch only the newer values", async () => {
    const loaded = await loadContentScript();
    const captured = captureDispatches();
    loaded.replies[0].resolve(reply("Asia/Tokyo"));
    await settle();

    loaded.pageshow!(pageshowEvent(true));
    loaded.pageshow!(pageshowEvent(true));
    expect(loaded.replies).toHaveLength(3);

    const before = captured.details.length;
    loaded.replies[2].resolve(reply("Europe/Paris"));
    await settle();
    loaded.replies[1].resolve(reply("America/Mexico_City"));
    await settle();

    expect(captured.details.length).toBe(before + 1);
    expect(captured.details.at(-1)?.timezone?.identifier).toBe("Europe/Paris");
    captured.stop();
  });

  test("no prerenderingchange listener outside a prerendering document", async () => {
    const loaded = await loadContentScript();
    expect(loaded.prerenderingchange).toBeUndefined();
  });

  describe("in a prerendering document (Chrome)", () => {
    beforeEach(() => {
      Object.defineProperty(document, "prerendering", { value: true, configurable: true });
    });
    afterEach(() => {
      delete (document as { prerendering?: boolean }).prerendering;
    });

    test("activation re-requests once", async () => {
      const loaded = await loadContentScript();
      const captured = captureDispatches();
      loaded.replies[0].resolve(reply("Asia/Tokyo"));
      await settle();

      expect(loaded.prerenderingchange).toBeTypeOf("function");
      loaded.prerenderingchange!(new Event("prerenderingchange"));
      expect(getSettingsCalls()).toHaveLength(2);
      loaded.replies[1].resolve(reply("Europe/Paris"));
      await settle();
      expect(captured.details.at(-1)?.timezone?.identifier).toBe("Europe/Paris");
      captured.stop();
    });

    test("the listener is registered with once", async () => {
      vi.resetModules();
      const spy = vi.spyOn(document, "addEventListener");
      spy.mockClear();
      runtime.sendMessage.mockReturnValue(new Promise<never>(() => {}));
      await import("@/content/index");
      const call = spy.mock.calls.find((c) => c[0] === "prerenderingchange");
      spy.mockRestore();
      expect(call?.[2]).toEqual({ once: true });
    });
  });

  test("no event-handler property is assigned on the page's window", async () => {
    await loadContentScript();
    expect(window.onpageshow).toBeNull();
  });
});

/**
 * F22: every reply and push carries the settings revision it was built from.
 * One strictly older than the newest this page applied is dropped; an equal
 * or missing one applies, and a missing one doesn't move the mark.
 */
describe("content script settings revision", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  test("a push at 10, then a load reply at 9: the reply is dropped", async () => {
    const loaded = await loadContentScript();
    const captured = captureDispatches();
    push(loaded, "Asia/Tokyo", 10);
    await settle();
    const afterPush = captured.details.length;
    expect(captured.details.at(-1)?.timezone?.identifier).toBe("Asia/Tokyo");

    loaded.replies[0].resolve(stamped("Europe/Paris", 9));
    await settle();
    expect(captured.details.length).toBe(afterPush);
    expect(captured.details.at(-1)?.timezone?.identifier).toBe("Asia/Tokyo");
    captured.stop();
  });

  test("a reply at 9 and a push at 10 apply; a later push at 9 is dropped", async () => {
    const loaded = await loadContentScript();
    const captured = captureDispatches();
    loaded.replies[0].resolve(stamped("Europe/Paris", 9));
    await settle();
    expect(captured.details.at(-1)?.timezone?.identifier).toBe("Europe/Paris");

    push(loaded, "Asia/Tokyo", 10);
    await settle();
    expect(captured.details.at(-1)?.timezone?.identifier).toBe("Asia/Tokyo");
    const afterPush = captured.details.length;

    push(loaded, "America/Mexico_City", 9);
    await settle();
    expect(captured.details.length).toBe(afterPush);
    expect(captured.details.at(-1)?.timezone?.identifier).toBe("Asia/Tokyo");
    captured.stop();
  });

  test("a push equal to the applied revision applies (a rollover re-sends the same settings)", async () => {
    const loaded = await loadContentScript();
    const captured = captureDispatches();
    loaded.replies[0].resolve(stamped("Europe/Paris", 9));
    await settle();

    push(loaded, "Asia/Tokyo", 9);
    await settle();
    expect(captured.details.at(-1)?.timezone?.identifier).toBe("Asia/Tokyo");
    captured.stop();
  });

  test("a missing revision applies and doesn't move the mark", async () => {
    const loaded = await loadContentScript();
    const captured = captureDispatches();
    push(loaded, "Asia/Tokyo", 10);
    await settle();

    push(loaded, "Europe/Paris");
    await settle();
    expect(captured.details.at(-1)?.timezone?.identifier).toBe("Europe/Paris");
    const afterMissing = captured.details.length;

    push(loaded, "America/Mexico_City", 9);
    await settle();
    expect(captured.details.length).toBe(afterMissing);
    expect(captured.details.at(-1)?.timezone?.identifier).toBe("Europe/Paris");
    captured.stop();
  });

  test('Infinity, NaN, -1 and "10" apply as missing, and a later 5 still applies', async () => {
    const loaded = await loadContentScript();
    const captured = captureDispatches();
    loaded.replies[0].resolve(reply("Asia/Tokyo"));
    await settle();

    const unusable: Array<[unknown, string]> = [
      [Infinity, "Europe/Paris"],
      [NaN, "America/Mexico_City"],
      [-1, "Europe/Dublin"],
      ["10", "Australia/Sydney"],
    ];
    for (const [revision, zone] of unusable) {
      push(loaded, zone, revision);
      await settle();
      expect(captured.details.at(-1)?.timezone?.identifier, String(revision)).toBe(zone);
    }

    push(loaded, "Asia/Kolkata", 5);
    await settle();
    expect(captured.details.at(-1)?.timezone?.identifier).toBe("Asia/Kolkata");
    captured.stop();
  });

  test("the revision never reaches the page: every detail has exactly the nine keys", async () => {
    const loaded = await loadContentScript();
    const details: Array<Record<string, unknown>> = [];
    const handler = (event: Event): void => {
      details.push((event as CustomEvent<Record<string, unknown>>).detail);
    };
    window.addEventListener(EVENT_NAME, handler);
    try {
      loaded.replies[0].resolve(stamped("Asia/Tokyo", 9));
      await settle();
      push(loaded, "Europe/Paris", 10);
      await settle();
      push(loaded, "Europe/Dublin");
      await settle();

      expect(details.length).toBeGreaterThan(0);
      for (const detail of details) {
        expect(Object.keys(detail).sort()).toEqual([
          "debugLogging",
          "enabled",
          "engineTimezone",
          "locale",
          "location",
          "preserveGeolocationPrompt",
          "timezone",
          "verbosityLevel",
          "webrtcProtection",
        ]);
        expect(JSON.stringify(detail)).not.toContain("revision");
        expect(Object.keys(detail.location as Record<string, unknown>).sort()).toEqual([
          "accuracy",
          "accuracySeed",
          "accuracySetting",
          "latitude",
          "longitude",
        ]);
      }
    } finally {
      window.removeEventListener(EVENT_NAME, handler);
    }
  });
});
