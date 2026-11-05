/**
 * Relay for dedicated inline workers created before settings arrive (#101).
 *
 * The worker payload bakes in the spoofed zone, which isn't known until the
 * content script's settings event lands (50-250 ms on cold page loads). A
 * `blob:` or `data:` worker that the page created before then used to start
 * unpatched and keep the real zone for life. `worker-patching.ts` now hands
 * such a worker to this module instead:
 *
 *   - The page gets a real `Worker`, built by the native constructor, whose
 *     script is a small relay (`RELAY_SOURCE`) loaded from the same scheme
 *     the page passed, so the page's CSP allows it exactly when it allows the
 *     page's own worker.
 *   - The first message (init, posted before the page holds the worker) gives
 *     the relay the page's source and this document's key.
 *   - When settings arrive, the go message (an object with an own property
 *     named by the key) carries the payload. The relay starts the page's code
 *     in a nested worker with the payload in front and forwards messages both
 *     ways. Page messages posted in between are queued in order.
 *   - If settings never arrive, the give-up timer starts the held workers
 *     unpatched after `SETTINGS_WAIT_TIMEOUT`, and the relay's own timeout
 *     does the same 500 ms later if a go message was lost.
 *
 * Pages that use Trusted Types or have shared memory keep today's behavior,
 * and so does `SharedWorker`. Every failure leaves the page with a working,
 * unpatched worker or the error its own worker would have produced.
 *
 * The page side runs after page scripts may have replaced intrinsics, so
 * everything it calls is captured here at module evaluation, before any page
 * script runs: no `MessageChannel`, no transfer list, no array method.
 */

import {
  settingsReceived,
  spoofingEnabled,
  timezoneData,
  localeData,
  debugEnabled,
  SETTINGS_WAIT_TIMEOUT,
} from "./state";
import { onSettingsApplied } from "./settings-listener";
import { COMPOSE_DATA_SOURCE } from "./worker-data-url";
import { createLogger } from "@/shared/utils/debug-logger";

const logger = createLogger("INJ");

// ── Types ────────────────────────────────────────────────────────────

/** The page's inline source: the tracked `Blob` for `blob:`, the URL for `data:`. */
export type RelaySource = { kind: "blob"; blob: Blob } | { kind: "data"; url: string };

/** First in-band message; the relay identifies it by position. */
type RelayInit = { k: string; kind: "blob"; blob: Blob } | { k: string; kind: "data"; url: string };

/** Flush message; identified by an own property named RELAY_KEY (value 1). */
type RelayGo = { payload: string; debug: boolean } & Record<string, unknown>;

/** Null-prototype record held until the flush. */
interface PendingRelay {
  worker: Worker;
  baseUrl: string;
}

type PostMessageFn = (this: Worker, message: unknown) => void;
type TerminateFn = (this: Worker) => void;
type SetTimeoutFn = (handler: () => void, timeout: number) => unknown;
type ClearTimeoutFn = (id: unknown) => void;
type CreateObjectURLFn = (obj: Blob) => string;

/** The Trusted Types members read here; TypeScript's DOM lib doesn't declare them. */
interface TrustedTypesProtoLike {
  isScriptURL?: unknown;
}

// ── Natives, captured at module evaluation ───────────────────────────

/* eslint-disable @typescript-eslint/unbound-method */
const OriginalBlob: typeof Blob | null = typeof Blob === "function" ? Blob : null;
const NativeURL: typeof URL | null = typeof URL === "function" ? URL : null;
const nativeCreateObjectURL: CreateObjectURLFn | null =
  NativeURL && typeof NativeURL.createObjectURL === "function" ? NativeURL.createObjectURL : null;
const workerProto: { postMessage?: unknown; terminate?: unknown } | null =
  typeof Worker === "function" && Worker.prototype
    ? (Worker.prototype as { postMessage?: unknown; terminate?: unknown })
    : null;
const nativeWorkerPostMessage: PostMessageFn | null =
  workerProto && typeof workerProto.postMessage === "function"
    ? (workerProto.postMessage as PostMessageFn)
    : null;
const nativeWorkerTerminate: TerminateFn | null =
  workerProto && typeof workerProto.terminate === "function"
    ? (workerProto.terminate as TerminateFn)
    : null;
const reflectApply: typeof Reflect.apply | null =
  typeof Reflect === "object" && typeof Reflect.apply === "function" ? Reflect.apply : null;
const objectCreate: ((proto: null) => object) | null =
  typeof Object.create === "function" ? Object.create : null;
const nativeSetTimeout: SetTimeoutFn | null = typeof setTimeout === "function" ? setTimeout : null;
const nativeClearTimeout: ClearTimeoutFn | null =
  typeof clearTimeout === "function" ? (clearTimeout as unknown as ClearTimeoutFn) : null;

// Trusted Types: the factory and the two members the per-construction check reads.
const ttFactory: object | null = (() => {
  const tt = (globalThis as { trustedTypes?: unknown }).trustedTypes;
  return typeof tt === "object" && tt !== null ? tt : null;
})();
const ttProto = ttFactory
  ? (Object.getPrototypeOf(ttFactory) as TrustedTypesProtoLike | null)
  : null;
const nativeIsScriptURL: ((value: unknown) => unknown) | null =
  ttProto && typeof ttProto.isScriptURL === "function"
    ? (ttProto.isScriptURL as (value: unknown) => unknown)
    : null;
const nativeDefaultPolicyGet: (() => unknown) | null = ttProto
  ? ((Object.getOwnPropertyDescriptor(ttProto, "defaultPolicy")?.get as
      (() => unknown) | undefined) ?? null)
  : null;
/* eslint-enable @typescript-eslint/unbound-method */

/**
 * True on a page that can busy-wait on its main thread for a worker to write
 * to a `SharedArrayBuffer`. A held worker's code can't start until the page's
 * main thread runs the flush, and in WebKit and Firefox the relay's child
 * can't start while that thread is blocked either, so such a page would hang
 * where a native worker answers at once. These pages keep today's behavior.
 *
 * `crossOriginIsolated` is fixed when the document is created, so one read is
 * exact. Without isolation every engine hides `SharedArrayBuffer`; the second
 * term only matters where a browser policy exposes it anyway.
 *
 * Coupling: geospoof.com/verify sends COOP but no COEP, so it isn't isolated
 * and isn't skipped. If `geospoof-site` adds COEP, /verify's early workers fall
 * back to today's behavior and #101 can return on Safari while the Chrome
 * /verify run still passes (its probes run after settings). Nothing checks this.
 */
const pageHasSharedMemory: boolean = (() => {
  try {
    return (
      (typeof crossOriginIsolated === "boolean" && crossOriginIsolated) ||
      typeof SharedArrayBuffer === "function"
    );
  } catch {
    return true;
  }
})();

/**
 * Per-document key that marks the go message. Generated before any page
 * script (the same reasoning as `safe-random.ts`), never part of
 * `RELAY_SOURCE` or a relay URL; the relay learns it from the init message.
 * Null if `crypto.getRandomValues` is missing, which turns the relay off.
 */
const RELAY_KEY: string | null = (() => {
  try {
    const c = globalThis.crypto;
    if (!c || typeof c.getRandomValues !== "function") return null;
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    const HEX = "0123456789abcdef";
    let key = "";
    for (let i = 0; i < bytes.length; i++) {
      key += HEX.charAt(bytes[i] >> 4) + HEX.charAt(bytes[i] & 15);
    }
    return key;
  } catch {
    return null;
  }
})();

// ── The relay (worker side) ──────────────────────────────────────────

/** The relay starts its child unpatched if no go message arrives in this time. */
const SELF_TIMEOUT = SETTINGS_WAIT_TIMEOUT + 500;

/**
 * `Object.prototype.toString` tags of transferables the relay can't transfer a
 * second time. A message carrying one is dropped (it can't be delivered).
 * Empty unless a real-browser run shows such a type.
 */
const TRANSFER_ONCE: readonly string[] = [];

/**
 * ES5 source of the relay worker. It runs in a worker no page code shares, so
 * its intrinsics are clean. It uses `self`, `Worker`, `URL`, `Blob`,
 * `setTimeout`, `clearTimeout`, `ErrorEvent`, `structuredClone`, `atob`, and
 * `console` (debug only), and keeps nothing on `self`.
 *
 * Errors: the child's runtime errors are `ErrorEvent`s that the engine
 * re-reports on the page's `Worker` when nobody cancels them, so the relay
 * never calls `preventDefault`. A child failure that isn't an `ErrorEvent`
 * (a load failure, a parse failure in WebKit and Firefox) isn't propagated,
 * so `surface()` throws from a timer instead; that is the only intended
 * throw. Every other listener and timer body is wrapped in `try/catch`.
 */
export const RELAY_SOURCE = `(function () {
  "use strict";
  var SELF_TIMEOUT = ${SELF_TIMEOUT};
  var TRANSFER_ONCE = ${JSON.stringify(TRANSFER_ONCE)};
  var TRANSFERABLE = {
    "[object ArrayBuffer]": 1,
    "[object MessagePort]": 1,
    "[object ImageBitmap]": 1,
    "[object OffscreenCanvas]": 1,
    "[object ReadableStream]": 1,
    "[object WritableStream]": 1,
    "[object TransformStream]": 1,
    "[object VideoFrame]": 1,
    "[object AudioData]": 1,
    "[object RTCDataChannel]": 1,
    "[object MediaSourceHandle]": 1,
    "[object MediaStreamTrack]": 1,
    "[object WebTransportReceiveStream]": 1,
    "[object WebTransportSendStream]": 1
  };
  var toStr = Object.prototype.toString;
  var hasOwn = Object.prototype.hasOwnProperty;
  var inited = false, key = null, src = null, child = null, started = false;
  var queue = [], timer = 0, debug = false;
${COMPOSE_DATA_SOURCE}
  function note(what, e) {
    if (debug) {
      try { console.debug("[relay] " + what, e); } catch (x) {}
    }
  }

  function surface() {
    // The only intended throw. Uncaught in the relay, so the page's Worker
    // gets an ErrorEvent, as for a worker script that failed to load.
    setTimeout(function () {
      throw new Error("Worker script failed to load");
    }, 0);
  }

  // Transfer list for one message: its ports plus every transferable found by
  // an iterative walk (explicit stack, visited set). Object.values costs
  // O(values present), so sparse arrays stay cheap. With probe set, a leaf
  // that structuredClone rejects is added too (it arrived by transfer).
  function collect(data, ports, probe) {
    var list = [], stack = [], seen = new Set(), once = null;
    function visit(v) {
      if (v !== null && (typeof v === "object" || typeof v === "function") && !seen.has(v)) {
        seen.add(v);
        stack.push(v);
      }
    }
    if (ports) {
      for (var i = 0; i < ports.length; i++) visit(ports[i]);
    }
    visit(data);
    while (stack.length > 0) {
      var v = stack.pop();
      var tag = toStr.call(v);
      if (TRANSFER_ONCE.indexOf(tag) !== -1) {
        once = tag;
        break;
      }
      if (hasOwn.call(TRANSFERABLE, tag)) {
        list.push(v);
        continue;
      }
      if (tag === "[object SharedArrayBuffer]") continue;
      if (ArrayBuffer.isView(v)) {
        if (toStr.call(v.buffer) === "[object ArrayBuffer]") visit(v.buffer);
        continue;
      }
      if (Array.isArray(v) || tag === "[object Object]") {
        var values = Object.values(v);
        for (var j = 0; j < values.length; j++) visit(values[j]);
        continue;
      }
      if (tag === "[object Map]") {
        v.forEach(function (value, k) { visit(k); visit(value); });
        continue;
      }
      if (tag === "[object Set]") {
        v.forEach(function (value) { visit(value); });
        continue;
      }
      if (probe) {
        try { structuredClone(v); } catch (x) { list.push(v); }
      }
    }
    return { list: list, once: once };
  }

  function forward(target, data, ports) {
    var walked = null;
    try {
      walked = collect(data, ports, false);
    } catch (e) {
      note("transfer walk failed, posting with ports only", e);
    }
    if (walked === null) {
      try { target.postMessage(data, ports || []); } catch (e) { note("message dropped", e); }
      return;
    }
    if (walked.once !== null) {
      note("message dropped: " + walked.once + " can't be transferred twice");
      return;
    }
    try {
      target.postMessage(data, walked.list);
      return;
    } catch (e) {
      if (!(e && e.name === "DataCloneError") || typeof structuredClone !== "function") {
        note("message dropped", e);
        return;
      }
    }
    try {
      target.postMessage(data, collect(data, ports, true).list);
    } catch (e) {
      note("message dropped after retry", e);
    }
  }

  function childUrl(payload) {
    if (src.kind === "blob") {
      return URL.createObjectURL(
        payload
          ? new Blob([payload + "\\n", src.blob], { type: "application/javascript" })
          : src.blob
      );
    }
    if (payload) {
      var composed = __gsComposeData(src.url, payload);
      if (composed !== null) return composed;
      note("payload not composed into the data: URL, starting unpatched");
    }
    return src.url;
  }

  function launch(payload) {
    try {
      child = new Worker(childUrl(payload), { name: self.name });
      return true;
    } catch (e) {
      child = null;
      note("child construction failed", e);
      return false;
    }
  }

  function start(payload) {
    if (started) return;
    started = true;
    clearTimeout(timer);
    if (!src || (!launch(payload) && !(payload && launch("")))) {
      surface();
      queue = null;
      src = null;
      return;
    }
    child.addEventListener("message", function (e) {
      try {
        forward(self, e.data, e.ports);
      } catch (x) {
        note("forward to page failed", x);
      }
    });
    child.addEventListener("error", function (e) {
      try {
        if (typeof ErrorEvent === "function" && e instanceof ErrorEvent) return;
        surface();
      } catch (x) {
        note("error listener failed", x);
      }
    });
    for (var i = 0; i < queue.length; i++) {
      try {
        forward(child, queue[i].data, queue[i].ports);
      } catch (x) {
        note("forward of a queued message failed", x);
      }
    }
    queue = null;
    src = null;
  }

  self.addEventListener("message", function (e) {
    try {
      var d = e.data;
      if (!inited) {
        // init: always first, posted before the page held the worker. inited
        // is set before reading it, so a malformed init can't turn the next
        // page message into the init.
        inited = true;
        if (d !== null && typeof d === "object" && typeof d.k === "string") {
          key = d.k;
          src = d;
        }
        timer = setTimeout(function () {
          try {
            start("");
          } catch (x) {
            note("self-timeout start failed", x);
          }
        }, SELF_TIMEOUT);
        return;
      }
      if (key !== null && d !== null && typeof d === "object" && hasOwn.call(d, key)) {
        debug = d.debug === true;
        start(typeof d.payload === "string" ? d.payload : "");
        return;
      }
      if (child) forward(child, d, e.ports);
      else if (queue) queue.push({ data: d, ports: e.ports });
      // else the start failed: drop, as messages to a worker that failed to load vanish
    } catch (x) {
      note("message handler failed", x);
    }
  });
})();
`;

/** Relay URL for `data:` sources. Never touches `URL.createObjectURL`. */
export const DATA_RELAY_URL: string | null =
  typeof encodeURIComponent === "function"
    ? "data:application/javascript," + encodeURIComponent(RELAY_SOURCE)
    : null;

// ── Page side ────────────────────────────────────────────────────────

/** Blob relay URL, minted once per document by installWorkerRelay. Never revoked. */
let blobRelayUrl: string | null = null;

/** Builds the payload for a base URL (generateInlineWorkerPayload). */
let payloadBuilder: ((baseUrl: string) => string) | null = null;

const pending = Object.create(null) as Record<number, PendingRelay>;
let pendingCount = 0;
let giveUpTimer: unknown = null;

/** Per-document latch: settings didn't arrive in time, so later early workers aren't held. */
let relayGaveUp = false;

/** True when the page passed a TrustedScriptURL or has a default policy. */
function pageUsesTrustedTypes(scriptURL: unknown): boolean {
  if (!ttFactory) return false;
  try {
    if (
      nativeIsScriptURL &&
      reflectApply &&
      reflectApply(nativeIsScriptURL, ttFactory, [scriptURL]) === true
    ) {
      return true;
    }
    return (
      nativeDefaultPolicyGet !== null &&
      reflectApply !== null &&
      reflectApply(nativeDefaultPolicyGet, ttFactory, []) !== null
    );
  } catch {
    return true;
  }
}

/**
 * Whether a dedicated inline classic worker created now should be held: no
 * settings yet, the give-up latch isn't set, and the payload isn't already
 * known. Before the settings event, only the Firefox bootstrap seed can set
 * the state in the third term, and a seed's values are safe to bake into a
 * worker, so those pages keep the direct, patched path.
 */
export function relayApplies(): boolean {
  return (
    !settingsReceived &&
    !relayGaveUp &&
    !(spoofingEnabled && (timezoneData !== null || localeData !== null))
  );
}

/**
 * Construct a held worker: a native `Worker` running the relay, with the init
 * message posted and the worker recorded for the flush. Returns null (the
 * caller takes today's path) when the relay can't be used here or anything
 * fails; a relay that was already constructed is terminated first, so the
 * page never ends up with two workers.
 */
export function createRelayedWorker(
  RealWorker: typeof Worker,
  scriptURL: unknown,
  source: RelaySource,
  options: WorkerOptions | undefined
): Worker | null {
  if (
    !nativeWorkerPostMessage ||
    !nativeWorkerTerminate ||
    !reflectApply ||
    !nativeSetTimeout ||
    !nativeClearTimeout ||
    !objectCreate ||
    RELAY_KEY === null ||
    pageHasSharedMemory ||
    pageUsesTrustedTypes(scriptURL)
  ) {
    return null;
  }
  const relayUrl = source.kind === "blob" ? blobRelayUrl : DATA_RELAY_URL;
  if (relayUrl === null) return null;

  let r: Worker;
  try {
    r = new RealWorker(relayUrl, options);
  } catch (err) {
    logger.debug("[worker-relay] relay construction failed, falling back:", err);
    return null;
  }

  let stored = false;
  try {
    const init: RelayInit =
      source.kind === "blob"
        ? { k: RELAY_KEY, kind: "blob", blob: source.blob }
        : { k: RELAY_KEY, kind: "data", url: source.url };
    reflectApply(nativeWorkerPostMessage, r, [init]);

    const entry = objectCreate(null) as PendingRelay;
    entry.worker = r;
    // Captured now, so a pushState before the flush doesn't move the
    // importScripts base.
    entry.baseUrl = window.location.href;
    pending[pendingCount++] = entry;
    stored = true;

    if (pendingCount === 1) {
      giveUpTimer = reflectApply(nativeSetTimeout, window, [giveUp, SETTINGS_WAIT_TIMEOUT]);
    }
  } catch (err) {
    if (stored) {
      pendingCount--;
      delete pending[pendingCount];
    }
    try {
      reflectApply(nativeWorkerTerminate, r, []);
    } catch {
      /* the relay may already be unusable */
    }
    logger.debug("[worker-relay] relay setup failed, falling back:", err);
    return null;
  }
  return r;
}

/** Give-up timer: settings didn't arrive in time. */
function giveUp(): void {
  giveUpTimer = null;
  relayGaveUp = true;
  logger.warn(
    `inline worker started unpatched: settings did not arrive within ${SETTINGS_WAIT_TIMEOUT} ms`
  );
  flush(false);
}

/**
 * Post the go message to every held worker. With `allowPayload`, each gets
 * the payload for its construction-time base URL (built once per distinct
 * base); otherwise, or when the builder returns "" (protection off, nothing
 * to spoof), the worker starts unpatched.
 */
function flush(allowPayload: boolean): void {
  if (giveUpTimer !== null) {
    try {
      if (reflectApply && nativeClearTimeout) {
        reflectApply(nativeClearTimeout, window, [giveUpTimer]);
      }
    } catch (err) {
      logger.debug("[worker-relay] clearing the give-up timer failed:", err);
    }
    giveUpTimer = null;
  }
  if (pendingCount === 0 || !objectCreate || !reflectApply || !nativeWorkerPostMessage) {
    return;
  }
  const key = RELAY_KEY as string;
  const payloads = objectCreate(null) as Record<string, string>;
  const debug = debugEnabled;
  for (let i = 0; i < pendingCount; i++) {
    const entry = pending[i];
    delete pending[i];
    let payload = "";
    if (allowPayload && payloadBuilder) {
      const base = entry.baseUrl;
      let built = payloads[base];
      if (built === undefined) {
        try {
          built = payloadBuilder(base);
        } catch (err) {
          logger.debug("[worker-relay] payload build failed, starting unpatched:", err);
          built = "";
        }
        payloads[base] = built;
      }
      payload = built;
    }
    const go: RelayGo = { [key]: 1, payload, debug };
    try {
      reflectApply(nativeWorkerPostMessage, entry.worker, [go]);
    } catch (err) {
      logger.debug("[worker-relay] go message failed to post:", err);
    }
  }
  pendingCount = 0;
}

/**
 * Mint the blob relay URL and register the flush. Called once, from
 * `installWorkerPatching`, before any page script. Minted now rather than at
 * the first worker because the `Blob` constructor reads its parts array with
 * the array iterator, which a page script could patch to read `RELAY_SOURCE`.
 * Minted with the captured natives, so it isn't tracked and a page that wraps
 * `URL.createObjectURL` never sees it.
 */
export function installWorkerRelay(buildPayload: (baseUrl: string) => string): void {
  payloadBuilder = buildPayload;
  if (OriginalBlob && NativeURL && nativeCreateObjectURL && reflectApply) {
    try {
      blobRelayUrl = reflectApply(nativeCreateObjectURL, NativeURL, [
        new OriginalBlob([RELAY_SOURCE], { type: "application/javascript" }),
      ]);
    } catch (err) {
      blobRelayUrl = null;
      logger.debug("[worker-relay] blob relay URL could not be minted:", err);
    }
  }
  onSettingsApplied(() => flush(true));
}
