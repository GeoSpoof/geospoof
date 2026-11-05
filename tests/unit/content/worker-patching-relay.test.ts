/**
 * The relay gate in the `Worker` wrapper (worker-patching.ts) and the page side
 * of the relay (worker-relay.ts), in jsdom.
 *
 * jsdom has no `Worker`, `URL.createObjectURL`, `navigator.geolocation`, or
 * `trustedTypes`, and the modules capture natives when they're evaluated, so
 * native-shaped stubs are installed before every (fresh) import:
 *
 *   - `Worker`: records each construction (URL, options) and every
 *     `postMessage` call's arguments; `length` 1, `postMessage` and
 *     `terminate` on its prototype.
 *   - `URL.createObjectURL` / `revokeObjectURL`: mint a unique URL per call
 *     and record the Blob behind it.
 *   - `TrustedTypePolicyFactory` + `trustedTypes`: `isScriptURL` and the
 *     `defaultPolicy` getter read the mutable `ttState`.
 *   - `SharedArrayBuffer` is deleted and `crossOriginIsolated` set to false
 *     around each import (Node exposes `SharedArrayBuffer`, which would make
 *     every case take the shared-memory skip), then both are restored.
 *
 * Each fresh import adds another settings listener to the shared jsdom
 * `window`, so the tests assert on the stub instances they created, never on
 * global counts.
 */
import { describe, test, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import vm from "node:vm";
import { Blob as NodeBlob, atob as nodeAtob } from "node:buffer";
import { URL as NodeURL } from "node:url";

type StateModule = typeof import("@/content/injected/state");
type SettingsModule = typeof import("@/content/injected/settings-listener");
type RelayModule = typeof import("@/content/injected/worker-relay");
type PayloadModule = typeof import("@/shared/worker-payload");

// ── Stubs ────────────────────────────────────────────────────────────

const stubState: {
  postThrows: boolean;
  constructError: ((url: string) => Error | null) | null;
} = { postThrows: false, constructError: null };

const workerInstances: StubWorker[] = [];

class StubWorker {
  url: string;
  options: unknown;
  posts: unknown[][] = [];
  terminated = false;
  constructor(url: string | URL, ...rest: unknown[]) {
    const options = rest[0] as { type?: unknown } | undefined;
    const injected = stubState.constructError?.(String(url));
    if (injected) throw injected;
    if (
      options &&
      options.type !== undefined &&
      options.type !== "classic" &&
      options.type !== "module"
    ) {
      throw new TypeError(
        `Failed to construct 'Worker': The provided value '${JSON.stringify(options.type)}' is not a valid enum value of type WorkerType.`
      );
    }
    this.url = String(url);
    this.options = options;
    workerInstances.push(this);
  }
  postMessage(...args: unknown[]): void {
    if (stubState.postThrows) throw new Error("postMessage failed");
    this.posts.push(args);
  }
  terminate(): void {
    this.terminated = true;
  }
}

const minted = new Map<string, Blob>();
let mintCounter = 0;
function createObjectURL(obj: Blob): string {
  const url = `blob:http://localhost:3000/stub-${++mintCounter}`;
  minted.set(url, obj);
  return url;
}
function revokeObjectURL(url: string): void {
  minted.delete(url);
}

const ttState: { trusted: unknown; defaultPolicy: unknown; throwOnGet: boolean } = {
  trusted: undefined,
  defaultPolicy: null,
  throwOnGet: false,
};
class TrustedTypePolicyFactory {
  isScriptURL(value: unknown): boolean {
    return ttState.trusted !== undefined && value === ttState.trusted;
  }
  get defaultPolicy(): unknown {
    if (ttState.throwOnGet) throw new Error("defaultPolicy getter threw");
    return ttState.defaultPolicy;
  }
}

const g = globalThis as unknown as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/unbound-method -- restored as-is, never called detached
const pristineToString = Function.prototype.toString;
const savedTrustedTypes = Object.getOwnPropertyDescriptor(globalThis, "trustedTypes");
const savedTTFactory = Object.getOwnPropertyDescriptor(globalThis, "TrustedTypePolicyFactory");
const savedWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
const savedCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const savedRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
const PAGE_URL = window.location.href;

beforeAll(() => {
  if (!("geolocation" in navigator)) {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: () => undefined,
        watchPosition: () => 0,
        clearWatch: () => undefined,
      },
      configurable: true,
    });
  }
  Object.defineProperty(globalThis, "TrustedTypePolicyFactory", {
    value: TrustedTypePolicyFactory,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "trustedTypes", {
    value: new TrustedTypePolicyFactory(),
    writable: true,
    configurable: true,
  });
});

afterAll(() => {
  Function.prototype.toString = pristineToString;
  for (const [name, desc] of [
    ["trustedTypes", savedTrustedTypes],
    ["TrustedTypePolicyFactory", savedTTFactory],
    ["Worker", savedWorker],
  ] as const) {
    if (desc) Object.defineProperty(globalThis, name, desc);
    else delete g[name];
  }
  if (savedCreate) Object.defineProperty(URL, "createObjectURL", savedCreate);
  else delete (URL as unknown as Record<string, unknown>).createObjectURL;
  if (savedRevoke) Object.defineProperty(URL, "revokeObjectURL", savedRevoke);
  else delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
});

afterEach(() => {
  stubState.postThrows = false;
  stubState.constructError = null;
  ttState.trusted = undefined;
  ttState.defaultPolicy = null;
  ttState.throwOnGet = false;
  vi.useRealTimers();
  window.history.replaceState(null, "", PAGE_URL);
});

// ── Fresh import ─────────────────────────────────────────────────────

interface Loaded {
  state: StateModule;
  settings: SettingsModule;
  relay: RelayModule;
  payload: PayloadModule;
  /** The blob relay URL, minted during installWorkerPatching. */
  relayBlobUrl: string;
}

interface LoadOptions {
  crossOriginIsolated?: boolean;
  keepSharedArrayBuffer?: boolean;
  /** Runs right before the imports (natives are captured during them). */
  beforeImport?: () => void;
  /** Runs right after the imports. */
  afterImport?: () => void;
  /** Runs after installSettingsListener, before installWorkerPatching. */
  beforePatching?: (mods: { settings: SettingsModule }) => void;
}

async function load(opts: LoadOptions = {}): Promise<Loaded> {
  // Undo the previous load's installs, so the new modules capture the stubs.
  Function.prototype.toString = pristineToString;
  Object.defineProperty(globalThis, "Worker", {
    value: StubWorker,
    writable: true,
    configurable: true,
  });
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  vi.resetModules();

  const sabDesc = Object.getOwnPropertyDescriptor(globalThis, "SharedArrayBuffer");
  const coiDesc = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  if (!opts.keepSharedArrayBuffer) delete g.SharedArrayBuffer;
  Object.defineProperty(globalThis, "crossOriginIsolated", {
    value: opts.crossOriginIsolated ?? false,
    writable: true,
    configurable: true,
  });
  opts.beforeImport?.();
  let mods: Omit<Loaded, "relayBlobUrl"> & {
    masking: typeof import("@/content/injected/function-masking");
    patching: typeof import("@/content/injected/worker-patching");
  };
  try {
    mods = {
      state: await import("@/content/injected/state"),
      settings: await import("@/content/injected/settings-listener"),
      masking: await import("@/content/injected/function-masking"),
      relay: await import("@/content/injected/worker-relay"),
      payload: await import("@/shared/worker-payload"),
      patching: await import("@/content/injected/worker-patching"),
    };
  } finally {
    opts.afterImport?.();
    if (sabDesc) Object.defineProperty(globalThis, "SharedArrayBuffer", sabDesc);
    if (coiDesc) Object.defineProperty(globalThis, "crossOriginIsolated", coiDesc);
    else delete g.crossOriginIsolated;
  }

  mods.masking.initFunctionMasking();
  mods.settings.installSettingsListener();
  opts.beforePatching?.({ settings: mods.settings });
  const before = mintCounter;
  mods.patching.installWorkerPatching();
  const relayBlobUrl = mintCounter > before ? `blob:http://localhost:3000/stub-${before + 1}` : "";
  return {
    state: mods.state,
    settings: mods.settings,
    relay: mods.relay,
    payload: mods.payload,
    relayBlobUrl,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

const SRC = "postMessage('page code');";

type WorkerCtor = new (url: string | URL | object, options?: WorkerOptions) => StubWorker;
const PageWorker = (): WorkerCtor => window.Worker as unknown as WorkerCtor;

function trackedBlobUrl(source = SRC): string {
  return URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
}

function settingsDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    location: null,
    timezone: { identifier: "Asia/Tokyo", offset: -540, dstOffset: 0 },
    debugLogging: false,
    verbosityLevel: "INFO",
    webrtcProtection: false,
    preserveGeolocationPrompt: false,
    locale: null,
    ...overrides,
  };
}

function dispatchSettings(state: StateModule, overrides: Record<string, unknown> = {}): void {
  window.dispatchEvent(new CustomEvent(state.EVENT_NAME, { detail: settingsDetail(overrides) }));
}

interface InitMessage {
  k: string;
  kind: string;
  blob?: Blob;
  url?: string;
}

function initOf(w: StubWorker): InitMessage {
  return w.posts[0][0] as InitMessage;
}

function goOf(w: StubWorker): { payload: string; debug: boolean } & Record<string, unknown> {
  return w.posts[1][0] as { payload: string; debug: boolean } & Record<string, unknown>;
}

const PAYLOAD_START = '(function(){\n"use strict";\n';

/** A direct construction: the stub got the page's URL and no message. */
function expectDirectUnpatched(w: StubWorker, url: string): void {
  expect(w.url).toBe(url);
  expect(w.posts).toEqual([]);
}

/** A direct, patched construction: a freshly minted blob holding payload + source. */
async function expectDirectPatched(w: StubWorker, loaded: Loaded, source = SRC): Promise<string> {
  expect(w.url).not.toBe(loaded.relayBlobUrl);
  expect(w.posts).toEqual([]);
  const blob = minted.get(w.url);
  expect(blob).toBeDefined();
  const text = await (blob as Blob).text();
  expect(text.startsWith(PAYLOAD_START)).toBe(true);
  expect(text.endsWith("\n" + source)).toBe(true);
  return text;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Worker wrapper: early inline workers are relayed", () => {
  test("1. a tracked blob worker before settings runs the blob relay and posts one init", async () => {
    const loaded = await load();
    expect(await (minted.get(loaded.relayBlobUrl) as Blob).text()).toBe(loaded.relay.RELAY_SOURCE);
    const url = trackedBlobUrl();
    const opts = { name: "early" };
    const w = new (PageWorker())(url, opts);
    expect(w).toBeInstanceOf(StubWorker);
    expect(w.url).toBe(loaded.relayBlobUrl);
    expect(w.options).toBe(opts);
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0]).toHaveLength(1);
    const init = initOf(w);
    expect(Object.keys(init).sort()).toEqual(["blob", "k", "kind"]);
    expect(init.kind).toBe("blob");
    expect(init.k).toMatch(/^[0-9a-f]{32}$/);
    expect(await (init.blob as Blob).text()).toBe(SRC);
    expect(loaded.relay.RELAY_SOURCE).not.toContain(init.k);
  });

  test("2. a data: worker before settings runs DATA_RELAY_URL and posts {k, kind: data, url}", async () => {
    const loaded = await load();
    const mintedBefore = mintCounter;
    const url = "data:application/javascript,postMessage(1)";
    const w = new (PageWorker())(url);
    expect(w.url).toBe(loaded.relay.DATA_RELAY_URL);
    expect(mintCounter).toBe(mintedBefore);
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0]).toHaveLength(1);
    const init = initOf(w);
    expect(Object.keys(init).sort()).toEqual(["k", "kind", "url"]);
    expect(init).toMatchObject({ kind: "data", url });
    expect(loaded.relay.DATA_RELAY_URL).not.toContain(init.k);
  });

  test("3. settings post one go per worker, keyed like the init, with the spoof core", async () => {
    let coreCalls = 0;
    vi.doMock("@/shared/worker-payload", async (importOriginal) => {
      const mod = await importOriginal<PayloadModule>();
      return {
        ...mod,
        buildWorkerSpoofCore: (...args: Parameters<PayloadModule["buildWorkerSpoofCore"]>) => {
          coreCalls++;
          return mod.buildWorkerSpoofCore(...args);
        },
      };
    });
    try {
      const loaded = await load();
      const url = trackedBlobUrl();
      const w1 = new (PageWorker())(url);
      const w2 = new (PageWorker())("data:application/javascript,postMessage(2)");
      coreCalls = 0;
      dispatchSettings(loaded.state);
      expect(coreCalls).toBe(1);
      for (const w of [w1, w2]) {
        expect(w.posts).toHaveLength(2);
        expect(w.posts[1]).toHaveLength(1);
        const go = goOf(w);
        const key = initOf(w).k;
        expect(Object.prototype.hasOwnProperty.call(go, key)).toBe(true);
        expect(go[key]).toBe(1);
        expect(go.debug).toBe(false);
        expect(go.payload.startsWith(PAYLOAD_START + loaded.payload.SPOOF_MASK_HELPERS)).toBe(true);
        expect(go.payload).toContain('"Asia/Tokyo"');
        expect(go.payload).toContain(`var __gsScriptBase = ${JSON.stringify(PAGE_URL)};`);
      }
      expect(goOf(w1).payload).toBe(goOf(w2).payload);
      // Recorded for the change report: the Tokyo payload without a locale.
      expect(goOf(w1).payload.length).toBeGreaterThan(80_000);
    } finally {
      vi.doUnmock("@/shared/worker-payload");
    }
  });

  test("3. a pushState between workers: one payload per construction-time URL", async () => {
    let coreCalls = 0;
    vi.doMock("@/shared/worker-payload", async (importOriginal) => {
      const mod = await importOriginal<PayloadModule>();
      return {
        ...mod,
        buildWorkerSpoofCore: (...args: Parameters<PayloadModule["buildWorkerSpoofCore"]>) => {
          coreCalls++;
          return mod.buildWorkerSpoofCore(...args);
        },
      };
    });
    try {
      const loaded = await load();
      const w1 = new (PageWorker())(trackedBlobUrl());
      window.history.pushState(null, "", "/moved-page");
      const movedUrl = window.location.href;
      const w2 = new (PageWorker())(trackedBlobUrl());
      // The base is captured at construction, so a later move doesn't change it.
      window.history.pushState(null, "", "/moved-again");
      coreCalls = 0;
      dispatchSettings(loaded.state);
      expect(coreCalls).toBe(2);
      expect(goOf(w1).payload).toContain(`var __gsScriptBase = ${JSON.stringify(PAGE_URL)};`);
      expect(goOf(w2).payload).toContain(`var __gsScriptBase = ${JSON.stringify(movedUrl)};`);
    } finally {
      vi.doUnmock("@/shared/worker-payload");
    }
  });

  test("4. settings with enabled: false post go with an empty payload", async () => {
    const loaded = await load();
    const w = new (PageWorker())(trackedBlobUrl());
    dispatchSettings(loaded.state, { enabled: false });
    expect(goOf(w).payload).toBe("");
  });

  test("5. no settings: go with an empty payload at 3000 ms, then the direct path", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await load();
    const w = new (PageWorker())(trackedBlobUrl());
    vi.advanceTimersByTime(2999);
    expect(w.posts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(w.posts).toHaveLength(2);
    expect(goOf(w).payload).toBe("");
    const url = trackedBlobUrl();
    const later = new (PageWorker())(url);
    expectDirectUnpatched(later, url);
  });

  test("6. after settings, the direct path (no relay)", async () => {
    const loaded = await load();
    dispatchSettings(loaded.state);
    const w = new (PageWorker())(trackedBlobUrl());
    await expectDirectPatched(w, loaded);
  });

  test("7. module workers, URL workers, and untracked blob URLs are unchanged", async () => {
    await load();
    const blobUrl = trackedBlobUrl();
    const moduleOpts = { type: "module" as const };
    const moduleWorker = new (PageWorker())(blobUrl, moduleOpts);
    expectDirectUnpatched(moduleWorker, blobUrl);
    expect(moduleWorker.options).toBe(moduleOpts);
    expectDirectUnpatched(new (PageWorker())("/worker.js"), "/worker.js");
    const untracked = "blob:http://localhost:3000/not-tracked";
    expectDirectUnpatched(new (PageWorker())(untracked), untracked);
  });

  test("8. a valid bootstrap seed keeps the direct, patched path; an empty one is relayed", async () => {
    const seeded = await load();
    seeded.state.setSpoofingEnabled(true);
    seeded.state.setTimezoneData({ identifier: "Asia/Tokyo", offset: -540, dstOffset: 0 });
    const text = await expectDirectPatched(new (PageWorker())(trackedBlobUrl()), seeded);
    expect(text).toContain('"Asia/Tokyo"');

    const empty = await load();
    empty.state.setSpoofingEnabled(true);
    const w = new (PageWorker())(trackedBlobUrl());
    expect(w.url).toBe(empty.relayBlobUrl);
  });

  test("9. Trusted Types: a default policy, a TrustedScriptURL, or a throwing check skip the relay", async () => {
    const loaded = await load();
    const url = trackedBlobUrl();

    ttState.defaultPolicy = { name: "default" };
    expectDirectUnpatched(new (PageWorker())(url), url);
    ttState.defaultPolicy = null;

    const trustedUrl = { toString: () => url };
    ttState.trusted = trustedUrl;
    expectDirectUnpatched(new (PageWorker())(trustedUrl), url);
    ttState.trusted = undefined;

    ttState.throwOnGet = true;
    expectDirectUnpatched(new (PageWorker())(url), url);
    ttState.throwOnGet = false;

    expect(new (PageWorker())(url).url).toBe(loaded.relayBlobUrl);
  });

  test("10. a relay constructor that throws falls back to new Worker(scriptURL, options)", async () => {
    const loaded = await load();
    const url = trackedBlobUrl();
    stubState.constructError = (u) =>
      u === loaded.relayBlobUrl ? new TypeError("This document requires 'TrustedScriptURL'") : null;
    const opts = { name: "x" };
    const w = new (PageWorker())(url, opts);
    expectDirectUnpatched(w, url);
    expect(w.options).toBe(opts);
  });

  test("10. options the native rejects surface the native error", async () => {
    await load();
    const url = trackedBlobUrl();
    const bogus = { type: "bogus" } as unknown as WorkerOptions;
    let nativeError: unknown;
    try {
      new StubWorker(url, bogus);
    } catch (err) {
      nativeError = err;
    }
    const created = workerInstances.length;
    let thrown: unknown;
    try {
      new (PageWorker())(url, bogus);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toBe((nativeError as Error).message);
    expect(workerInstances.length).toBe(created);
  });

  test("11. an init postMessage that throws terminates the relay and falls back", async () => {
    await load();
    const url = trackedBlobUrl();
    stubState.postThrows = true;
    const created = workerInstances.length;
    const w = new (PageWorker())(url);
    stubState.postThrows = false;
    const relay = workerInstances[created];
    expect(relay.terminated).toBe(true);
    expect(w).not.toBe(relay);
    expect(w).toBe(workerInstances[created + 1]);
    expectDirectUnpatched(w, url);
  });

  test("11. a throw later in createRelayedWorker (arming the timer) does the same", async () => {
    const timerState = { throwNext: false };
    const realSetTimeout = globalThis.setTimeout;
    const loaded = await load({
      beforeImport: () => {
        globalThis.setTimeout = function setTimeout(...args: unknown[]): unknown {
          if (timerState.throwNext) {
            timerState.throwNext = false;
            throw new Error("setTimeout failed");
          }
          return (realSetTimeout as unknown as (...a: unknown[]) => unknown).apply(
            globalThis,
            args
          );
        } as unknown as typeof globalThis.setTimeout;
      },
      afterImport: () => {
        globalThis.setTimeout = realSetTimeout;
      },
    });
    const url = trackedBlobUrl();
    const created = workerInstances.length;
    timerState.throwNext = true;
    const w = new (PageWorker())(url);
    const relay = workerInstances[created];
    expect(relay.terminated).toBe(true);
    expectDirectUnpatched(w, url);

    // The failed entry was removed: the next early worker is held, and only it gets a go.
    const next = new (PageWorker())(url);
    expect(next.url).toBe(loaded.relayBlobUrl);
    dispatchSettings(loaded.state);
    expect(relay.posts).toHaveLength(1);
    expect(next.posts).toHaveLength(2);
  });

  test("11. an unexpected throw escaping createRelayedWorker is caught by the gate", async () => {
    vi.doMock("@/content/injected/worker-relay", async (importOriginal) => {
      const mod = await importOriginal<RelayModule>();
      return {
        ...mod,
        createRelayedWorker: () => {
          throw new Error("unexpected");
        },
      };
    });
    try {
      await load();
      const url = trackedBlobUrl();
      expectDirectUnpatched(new (PageWorker())(url), url);
    } finally {
      vi.doUnmock("@/content/injected/worker-relay");
    }
  });

  test("17. Firefox holds a document's first 8 early workers; the 9th takes today's path", async () => {
    expect(__FIREFOX__).toBe(true);
    const loaded = await load();
    expect(loaded.relay.FIREFOX_HELD_WORKER_CAP).toBe(8);
    const held: StubWorker[] = [];
    for (let i = 0; i < 4; i++) held.push(new (PageWorker())(trackedBlobUrl()));
    for (let i = 0; i < 4; i++) {
      held.push(new (PageWorker())(`data:application/javascript,postMessage(${i})`));
    }
    for (const w of held) expect(w.posts).toHaveLength(1);
    const blobUrl = trackedBlobUrl();
    const ninth = new (PageWorker())(blobUrl);
    expectDirectUnpatched(ninth, blobUrl);
    const dataUrl = "data:application/javascript,postMessage(9)";
    expectDirectUnpatched(new (PageWorker())(dataUrl), dataUrl);

    dispatchSettings(loaded.state);
    for (const w of held) expect(goOf(w).payload).toContain('"Asia/Tokyo"');
    expect(ninth.posts).toEqual([]);
  });

  test("17. other engines hold every early worker", async () => {
    vi.stubGlobal("__FIREFOX__", false);
    try {
      const loaded = await load();
      const workers: StubWorker[] = [];
      for (let i = 0; i < 30; i++) workers.push(new (PageWorker())(trackedBlobUrl()));
      for (const w of workers) expect(w.url).toBe(loaded.relayBlobUrl);
      dispatchSettings(loaded.state);
      for (const w of workers) expect(goOf(w).payload).toContain('"Asia/Tokyo"');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Worker wrapper: what the page can observe", () => {
  /** True when the nearest caller frame with a file location is GeoSpoof source. */
  const GEOSPOOF_FRAME = /[\\/]src[\\/](content|shared)[\\/]/;
  function calledFromGeoSpoof(): boolean {
    const lines = String(new Error().stack).split("\n");
    // [0] "Error", [1] this function, [2] record, [3] the hook, [4...] its callers.
    for (let i = 4; i < lines.length; i++) {
      const line = lines[i];
      if (!/\.(ts|js|mjs|cjs):\d+:\d+\)?$/.test(line) || /node:/.test(line)) continue;
      return GEOSPOOF_FRAME.test(line);
    }
    return false;
  }

  test("12. page patches of the natives see no GeoSpoof call during construction or the flush", async () => {
    const loaded = await load();
    const blobUrl = trackedBlobUrl();
    const dataUrl = "data:application/javascript,postMessage(1)";
    const ttProto = TrustedTypePolicyFactory.prototype as unknown as Record<string, unknown>;

    let armed = false;
    let inHook = false;
    const hits: string[] = [];
    const strings: string[] = [];
    const record = (name: string, self: unknown, args: ArrayLike<unknown>): void => {
      if (!armed || inHook) return;
      inHook = true;
      try {
        if (calledFromGeoSpoof()) hits[hits.length] = name;
        for (let i = 0; i < args.length; i++) {
          if (typeof args[i] === "string") strings[strings.length] = args[i] as string;
        }
        if (Array.isArray(self)) {
          for (let i = 0; i < self.length; i++) {
            if (typeof self[i] === "string") strings[strings.length] = self[i] as string;
          }
        }
      } finally {
        inHook = false;
      }
    };
    const hookFn = (name: string, orig: (...a: unknown[]) => unknown) =>
      function (this: unknown, ...args: unknown[]): unknown {
        record(name, this, args);
        return orig.apply(this, args);
      };
    const hookCtor = (name: string, Orig: new (...a: unknown[]) => unknown) =>
      function (this: unknown, ...args: unknown[]): unknown {
        record(name, this, args);
        const made: unknown = Reflect.construct(
          Orig,
          args,
          (new.target ?? Orig) as unknown as new (...a: unknown[]) => unknown
        );
        return made;
      };

    const restores: Array<() => void> = [];
    const patch = (target: object, prop: PropertyKey, make: (orig: never) => unknown): void => {
      const desc = Object.getOwnPropertyDescriptor(target, prop);
      Object.defineProperty(target, prop, {
        value: make((desc?.value ?? (target as Record<PropertyKey, unknown>)[prop]) as never),
        writable: true,
        configurable: true,
      });
      restores.push(() => {
        if (desc) Object.defineProperty(target, prop, desc);
        else delete (target as Record<PropertyKey, unknown>)[prop];
      });
    };
    const defaultPolicyDesc = Object.getOwnPropertyDescriptor(ttProto, "defaultPolicy");

    /* eslint-disable @typescript-eslint/unbound-method */
    const ops = {
      init: [] as StubWorker[],
    };
    try {
      patch(globalThis, "Blob", (orig: new (...a: unknown[]) => unknown) => hookCtor("Blob", orig));
      patch(URL, "createObjectURL", (orig: (...a: unknown[]) => unknown) =>
        hookFn("createObjectURL", orig)
      );
      patch(StubWorker.prototype, "postMessage", (orig: (...a: unknown[]) => unknown) =>
        hookFn("postMessage", orig)
      );
      patch(StubWorker.prototype, "terminate", (orig: (...a: unknown[]) => unknown) =>
        hookFn("terminate", orig)
      );
      patch(Reflect, "apply", (orig: (...a: unknown[]) => unknown) =>
        hookFn("Reflect.apply", orig)
      );
      patch(Object, "create", (orig: (...a: unknown[]) => unknown) =>
        hookFn("Object.create", orig)
      );
      patch(globalThis, "setTimeout", (orig: (...a: unknown[]) => unknown) =>
        hookFn("setTimeout", orig)
      );
      patch(globalThis, "clearTimeout", (orig: (...a: unknown[]) => unknown) =>
        hookFn("clearTimeout", orig)
      );
      patch(globalThis.crypto, "getRandomValues", (orig: (...a: unknown[]) => unknown) =>
        hookFn("getRandomValues", orig)
      );
      patch(ttProto, "isScriptURL", (orig: (...a: unknown[]) => unknown) =>
        hookFn("isScriptURL", orig)
      );
      const origDefaultGet = defaultPolicyDesc?.get as () => unknown;
      Object.defineProperty(ttProto, "defaultPolicy", {
        get: hookFn("defaultPolicy", origDefaultGet),
        configurable: true,
      });
      restores.push(() => {
        if (defaultPolicyDesc) Object.defineProperty(ttProto, "defaultPolicy", defaultPolicyDesc);
      });
      patch(Array.prototype, "push", (orig: (...a: unknown[]) => unknown) => hookFn("push", orig));
      patch(Array.prototype, "join", (orig: (...a: unknown[]) => unknown) => hookFn("join", orig));
      patch(Array.prototype, "forEach", (orig: (...a: unknown[]) => unknown) =>
        hookFn("forEach", orig)
      );
      patch(Array.prototype, Symbol.iterator, (orig: (...a: unknown[]) => unknown) =>
        hookFn("Symbol.iterator", orig)
      );

      // Positive control: a GeoSpoof function that iterates an array is caught.
      const { getVerbosityLevel } = await import("@/shared/utils/debug-logger");
      armed = true;
      getVerbosityLevel();
      armed = false;
      expect(hits.length).toBeGreaterThan(0);
      expect(new Set(hits)).toEqual(new Set(["Symbol.iterator"]));
      hits.length = 0;
      strings.length = 0;

      armed = true;
      ops.init[0] = new (PageWorker())(blobUrl);
      ops.init[1] = new (PageWorker())(dataUrl);
      dispatchSettings(loaded.state);
      armed = false;
    } finally {
      armed = false;
      for (let i = restores.length - 1; i >= 0; i--) restores[i]();
    }
    /* eslint-enable @typescript-eslint/unbound-method */

    expect(hits).toEqual([]);
    const [blobWorker, dataWorker] = ops.init;
    // Held and flushed through the captured natives, minted before the patches.
    expect(blobWorker.url).toBe(loaded.relayBlobUrl);
    expect(dataWorker.url).toBe(loaded.relay.DATA_RELAY_URL);
    expect(blobWorker.posts).toHaveLength(2);
    expect(dataWorker.posts).toHaveLength(2);
    const key = initOf(blobWorker).k;
    const payload = goOf(blobWorker).payload;
    expect(payload.length).toBeGreaterThan(0);
    for (const s of strings) {
      expect(s.includes(key)).toBe(false);
      expect(s === loaded.relay.RELAY_SOURCE).toBe(false);
      expect(s.includes(loaded.payload.SPOOF_MASK_HELPERS.slice(0, 200))).toBe(false);
    }
  });

  test("13. window.Worker keeps the native shape, and instances pass instanceof", async () => {
    const loaded = await load();
    const W = window.Worker;
    expect(Function.prototype.toString.call(W)).toBe("function Worker() { [native code] }");
    expect(W.name).toBe("Worker");
    expect(W.length).toBe(1);
    expect(Object.getOwnPropertyDescriptor(W, "prototype")).toEqual({
      value: StubWorker.prototype,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    const desc = Object.getOwnPropertyDescriptor(window, "Worker");
    expect(desc).toMatchObject({ writable: true, enumerable: false, configurable: true });
    const early = new (PageWorker())(trackedBlobUrl());
    expect(early.url).toBe(loaded.relayBlobUrl);
    expect(early instanceof W).toBe(true);
    dispatchSettings(loaded.state);
    expect(new (PageWorker())(trackedBlobUrl()) instanceof W).toBe(true);
  });

  test("14. shared memory: cross-origin isolation or a SharedArrayBuffer global skip the relay", async () => {
    await load({ crossOriginIsolated: true });
    const url = trackedBlobUrl();
    expectDirectUnpatched(new (PageWorker())(url), url);

    await load({ keepSharedArrayBuffer: true, crossOriginIsolated: false });
    const url2 = trackedBlobUrl();
    expectDirectUnpatched(new (PageWorker())(url2), url2);
  });

  test("15. onSettingsApplied: listeners run in order after the state is complete; a throw doesn't stop the rest", async () => {
    const order: string[] = [];
    const loaded = await load({
      beforePatching: ({ settings }) => {
        settings.onSettingsApplied(() => {
          order.push("throws");
          throw new Error("listener bug");
        });
      },
    });
    let seenZone: string | undefined;
    loaded.settings.onSettingsApplied(() => {
      order.push("reads");
      seenZone = loaded.state.timezoneData?.identifier;
    });
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      errors.push(e.error);
    };
    window.addEventListener("error", onError);
    try {
      // Registered by installWorkerPatching, after the throwing listener.
      const w = new (PageWorker())(trackedBlobUrl());
      dispatchSettings(loaded.state);
      expect(order).toEqual(["throws", "reads"]);
      expect(seenZone).toBe("Asia/Tokyo");
      expect(goOf(w).payload).toContain('"Asia/Tokyo"');
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener("error", onError);
    }
  });
});

describe("Nested data: workers inside held data: workers", () => {
  const PARENT_MARK = "PARENT_HREF_MARK";
  const PARENT_HREF = "data:application/javascript," + PARENT_MARK.repeat(2000);

  interface Realm {
    run: (code: string) => unknown;
    nested: Array<{ url: string; opts: unknown }>;
    mintedNested: number;
  }

  function realm(payload: string, protocol: string, href: string): Realm {
    const nested: Array<{ url: string; opts: unknown }> = [];
    const state = { minted: 0 };
    class WorkerURL extends NodeURL {}
    Object.defineProperty(WorkerURL, "createObjectURL", {
      value: () => `blob:worker/${++state.minted}`,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(WorkerURL, "revokeObjectURL", {
      value: () => undefined,
      writable: true,
      configurable: true,
    });
    function RecordingWorker(url: unknown, opts: unknown): void {
      nested.push({ url: String(url), opts });
    }
    const self = { location: { protocol, href }, Worker: RecordingWorker, name: "" };
    const context = vm.createContext({ self, URL: WorkerURL, Blob: NodeBlob, atob: nodeAtob });
    vm.runInContext(payload, context);
    return {
      run: (code: string) => vm.runInContext(code, context) as unknown,
      nested,
      get mintedNested() {
        return state.minted;
      },
    };
  }

  /** Decode a composed URL whose page body holds no percent escapes. */
  function decodeComposed(url: string): string {
    return decodeURIComponent(url.slice(url.indexOf(",") + 1));
  }

  async function heldDataPayload(): Promise<string> {
    const loaded = await load();
    const w = new (PageWorker())("data:application/javascript,postMessage(0)");
    expect(w.url).toBe(loaded.relay.DATA_RELAY_URL);
    dispatchSettings(loaded.state);
    return goOf(w).payload;
  }

  test("16. a nested data: worker stays on data:, with the page URL as its base", async () => {
    const payload = await heldDataPayload();
    const r = realm(payload, "data:", PARENT_HREF);
    r.run('new self.Worker("data:application/javascript,postMessage(1)")');
    expect(r.nested).toHaveLength(1);
    expect(r.mintedNested).toBe(0);
    const composed = r.nested[0].url;
    expect(composed.startsWith("data:application/javascript,")).toBe(true);
    const decoded = decodeComposed(composed);
    expect(decoded.endsWith("\npostMessage(1)")).toBe(true);
    expect(decoded).toContain(`var __gsScriptBase = ${JSON.stringify(PAGE_URL)};`);
    expect(decoded).not.toContain(PARENT_MARK);

    // One level down: the nested payload runs (every placeholder was
    // substituted at its code position) and composes its own data: child.
    const nestedPayload = decoded.slice(0, decoded.length - "\npostMessage(1)".length);
    const r2 = realm(nestedPayload, "data:", composed);
    r2.run('new self.Worker("data:application/javascript,postMessage(2)")');
    expect(r2.nested).toHaveLength(1);
    expect(r2.mintedNested).toBe(0);
    const decoded2 = decodeComposed(r2.nested[0].url);
    expect(r2.nested[0].url.startsWith("data:application/javascript,")).toBe(true);
    expect(decoded2.endsWith("\npostMessage(2)")).toBe(true);
    expect(decoded2).toContain(`var __gsScriptBase = ${JSON.stringify(PAGE_URL)};`);
  });

  test("16. inside a blob: worker the nested data: worker still becomes blob:", async () => {
    const payload = await heldDataPayload();
    const r = realm(payload, "blob:", "blob:http://localhost:3000/parent");
    r.run('new self.Worker("data:application/javascript,postMessage(1)")');
    expect(r.nested).toHaveLength(1);
    expect(r.nested[0].url).toBe("blob:worker/1");
    expect(r.mintedNested).toBe(1);
  });

  test("16. a nested URL the composer rejects starts from the original URL", async () => {
    const payload = await heldDataPayload();
    const r = realm(payload, "data:", PARENT_HREF);
    r.run('new self.Worker("data:application/javascript")');
    expect(r.nested).toEqual([{ url: "data:application/javascript", opts: undefined }]);
  });
});
