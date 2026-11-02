/**
 * Worker constructor interception for timezone spoofing inside Workers.
 *
 * Web Workers run in a separate global scope where content-script overrides
 * don't apply. This module wraps `window.Worker`, `window.SharedWorker`, and
 * `navigator.serviceWorker.register` so every worker the page spawns gets
 * our timezone-spoofing payload prepended before its real code executes.
 *
 * ## Strategy: do nothing at the URL layer that the site didn't already commit to
 *
 * Our top priority is NOT breaking pages. Blob-URL wrapping is the only way
 * to inject into a Worker whose source we can't reach as bytes, but it
 * carries real cost: on strict-CSP origins `blob:` is refused in
 * `worker-src`, and even when allowed, `self.location` inside the worker
 * shifts from the real URL to `blob:...` — which can break relative
 * `fetch`, relative `import`, and any code that reads its own URL. So:
 *
 *   - **URL-based workers** (`new Worker("/path/worker.js")`,
 *     `new Worker(new URL(...))`, module workers, SharedWorker with a URL,
 *     `navigator.serviceWorker.register(url)`) — we do NOT rewrite to a
 *     blob. We announce the URL to the background script's
 *     `webRequest.filterResponseData` listener (Firefox only) and pass the
 *     original URL through to the real constructor. On Firefox the filter
 *     prepends our payload to the response bytes; on Chromium/Safari the
 *     announce is a no-op (no listener) and the worker runs unpatched —
 *     a documented engine limit, not a site-break risk.
 *
 *   - **Inline workers** (`new Worker(URL.createObjectURL(blob))` or
 *     `new Worker("data:application/javascript,...")`) — the site itself
 *     already chose blob/data URLs, so its CSP necessarily allows them.
 *     We can safely blob-wrap these because the site's existing blob was
 *     going to load fine; our replacement blob inherits the same CSP
 *     allowance.
 *
 * This split is strictly better than the prior "always blob-wrap" design:
 * URL-based workers stop triggering CSP violations on strict-CSP origins
 * entirely, and inline workers stay covered on every engine.
 *
 * ## Supported construction patterns (inline blob-wrap):
 *
 *   - `new Worker(URL.createObjectURL(new Blob([...])))`
 *   - `new Worker("data:application/javascript,...")`
 *   - Same for `new SharedWorker(...)`
 *
 * ## Coverage by engine:
 *
 *   | Pattern               | Firefox | Chromium | Safari |
 *   |-----------------------|---------|----------|--------|
 *   | URL classic Worker    | ✓ (filter) | –     | –      |
 *   | URL module Worker     | ✓ (filter) | –     | –      |
 *   | URL SharedWorker      | ✓ (filter) | –     | –      |
 *   | ServiceWorker register| ✓ (filter) | –     | –      |
 *   | blob URL Worker       | ✓ (wrap)   | ✓ (wrap) | ✓ (wrap) |
 *   | data URL Worker       | ✓ (wrap)   | ✓ (wrap) | ✓ (wrap) |
 *
 *   "–" means the worker runs unpatched — we do nothing that could break
 *   the site. The leak is documented as an engine-level limitation.
 *
 * ## Settings delivery
 *
 * The payload bakes in the current timezone at construction time. If the
 * user changes timezone mid-session, already-running workers keep the old
 * timezone (inherent to worker process isolation — we can't reach them).
 */

import {
  timezoneData,
  localeData,
  spoofingEnabled,
  nativeFractionalOffset,
  ANNOUNCE_EVENT_NAME,
} from "./state";
import {
  registerOverride,
  disguiseAsNative,
  stripConstruct,
  stripExtensionFramesFromStack,
} from "./function-masking";
import { seedFromBootstrap } from "./bootstrap";
import { buildWorkerSpoofCore } from "@/shared/worker-payload";
import { createLogger } from "@/shared/utils/debug-logger";

const logger = createLogger("INJ");

/**
 * Announce an imminent worker-script fetch to the content script, which
 * forwards it to the background. The background adds `url` to a short-
 * lived allowlist so its webRequest.filterResponseData listener knows
 * to modify the next HTTP response for that URL.
 *
 * On Chromium/Safari nothing is listening on the background side, so
 * this is a harmless no-op there. We send it unconditionally rather
 * than gating on engine detection because (a) it's cheap and (b) it
 * keeps the code-paths symmetric across engines.
 *
 * The dispatch is a CustomEvent on window (synchronous) which the
 * content script catches and forwards via `browser.runtime.sendMessage`.
 * That sendMessage is async, so there's a tiny window where the worker
 * fetch can race ahead of the allowlist being populated — the background
 * listener short-circuits cleanly on a miss, so the failure mode is
 * "worker runs unpatched" (site works, leak on that one load) rather
 * than "site broken."
 */
function announceWorkerFetch(url: string): void {
  try {
    const event = new CustomEvent(ANNOUNCE_EVENT_NAME, { detail: { url } });
    window.dispatchEvent(event);
  } catch (err) {
    logger.debug("[worker-patching] announceWorkerFetch failed:", err);
  }
}

/**
 * Resolve a scriptURL argument to an absolute http(s) URL against the
 * current document, or return null if the argument is a blob/data URL
 * (which never hits the network and therefore can't be announced to the
 * webRequest filter).
 */
function resolveAnnounceableUrl(scriptURL: string | URL): string | null {
  const raw = scriptURL instanceof URL ? scriptURL.href : String(scriptURL);
  if (raw.startsWith("blob:") || raw.startsWith("data:")) return null;
  try {
    return new URL(raw, window.location.href).href;
  } catch {
    return null;
  }
}

// ── Original constructors ────────────────────────────────────────────

const OriginalWorker: typeof Worker | undefined =
  typeof Worker !== "undefined" ? Worker : undefined;

const OriginalSharedWorker: typeof SharedWorker | undefined =
  typeof SharedWorker !== "undefined" ? SharedWorker : undefined;

// ── Blob-URL tracking ────────────────────────────────────────────────
//
// Strict-CSP origins (like geospoof.com) may allow `worker-src blob:`
// but forbid `blob:` under `connect-src`, `script-src`, and
// `script-src-elem`. Every technique for reading a blob URL's bytes
// at runtime hits one of those directives:
//
//   - `fetch(blobUrl)` / `XMLHttpRequest` → `connect-src`
//   - `importScripts(blobUrl)` inside a worker → `script-src-elem`
//   - `<script src="blob:...">` → `script-src-elem`
//
// The one path CSP does NOT gate is holding a reference to the `Blob`
// object itself. `URL.createObjectURL(blob)` runs synchronously in the
// page context and merely mints an opaque URL handle — by shimming it
// we can capture each Blob before it's anonymized, keyed by the
// returned URL string. When the page later calls `new Worker(blobUrl)`
// we look up the original Blob, compose `new Blob([payload, origBlob])`
// (an in-memory operation, no CSP involvement), and hand the resulting
// URL to the real Worker constructor.
//
// `new Blob([string, Blob])` is well-specified and works in every
// browser we support — the Blob spec accepts both BlobPart types and
// concatenates them in order.
//
// We use a WeakRef-based map to avoid preventing the page's Blobs from
// being garbage-collected — `URL.revokeObjectURL` is the page's signal
// that it's done with the URL, at which point we drop our reference.

interface BlobTrackingEntry {
  ref: WeakRef<Blob>;
}

const trackedBlobs = new Map<string, BlobTrackingEntry>();

/**
 * Install overrides on `URL.createObjectURL` / `URL.revokeObjectURL`
 * so we can intercept inline Worker construction without going through
 * any CSP-gated fetch path.
 *
 * Called at `document_start` before any page script runs. Safe to call
 * more than once (idempotent) but there's no reason to.
 */
function installBlobUrlTracking(): void {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;

  const OriginalCreateObjectURL = URL.createObjectURL.bind(URL);
  const OriginalRevokeObjectURL = URL.revokeObjectURL.bind(URL);

  const spoofedCreateObjectURL = function createObjectURL(obj: Blob | MediaSource): string {
    const url = OriginalCreateObjectURL(obj);
    try {
      // Only track Blobs — MediaSource URLs aren't worker-eligible and
      // hoarding their references would leak memory for `<video>`
      // pages that churn through streams.
      if (typeof Blob !== "undefined" && obj instanceof Blob) {
        trackedBlobs.set(url, { ref: new WeakRef(obj) });
      }
    } catch {
      /* instanceof can throw in pathological cross-realm cases */
    }
    return url;
  };

  const spoofedRevokeObjectURL = function revokeObjectURL(url: string): void {
    trackedBlobs.delete(url);
    return OriginalRevokeObjectURL(url);
  };

  // Wrap in method-shorthand (via stripConstruct) before disguising so the
  // installed functions have NO own `prototype` and NO `[[Construct]]` slot —
  // matching native static methods. `disguiseAsNative` alone can't achieve this
  // for a `function` expression, whose `prototype` is non-configurable and so
  // survives the delete; a page reading `hasOwnProperty(URL.createObjectURL,
  // "prototype")` would otherwise flag the override as non-native. This mirrors
  // the treatment `installOverride` gives every method override.
  const finalCreateObjectURL = stripConstruct(spoofedCreateObjectURL);
  registerOverride(finalCreateObjectURL, "createObjectURL");
  disguiseAsNative(finalCreateObjectURL, "createObjectURL", 1);
  const finalRevokeObjectURL = stripConstruct(spoofedRevokeObjectURL);
  registerOverride(finalRevokeObjectURL, "revokeObjectURL");
  disguiseAsNative(finalRevokeObjectURL, "revokeObjectURL", 1);

  try {
    Object.defineProperty(URL, "createObjectURL", {
      value: finalCreateObjectURL,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: finalRevokeObjectURL,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch (err) {
    logger.warn("[worker-patching] URL.createObjectURL override install failed:", err);
  }
}

/**
 * Return the Blob that was handed to `URL.createObjectURL` to mint the
 * given URL, or null if we don't have a live reference (URL not minted
 * through our override, revoked, or the blob was GC'd).
 */
function lookupTrackedBlob(url: string): Blob | null {
  const entry = trackedBlobs.get(url);
  if (!entry) return null;
  const blob = entry.ref.deref();
  if (!blob) {
    trackedBlobs.delete(url);
    return null;
  }
  return blob;
}

// ── Inline worker payload (blob/data URL wrapping only) ──────────────

// The core spoofing payload is imported from `@/shared/worker-payload`
// so the content-script Worker wrapper and the Firefox-only
// `webRequest.filterResponseData` listener share exactly one source
// of truth. Any change to timezone overrides automatically applies
// to both paths.

/**
 * Wrapper that runs inside a blob-wrapped inline Worker to:
 *   1. Resolve `importScripts` relative paths against the original
 *      script URL (not the blob URL the Worker was instantiated from).
 *   2. Intercept `self.Worker` for nested Worker recursion — child
 *      workers spawned from within this Worker get the same spoofing
 *      core prepended if they are themselves inline.
 *
 * Only used when the original construction was inline (blob/data URL) —
 * URL-based workers are handled by the background network filter, which
 * leaves `self.location` intact and requires no wrapper.
 *
 * ## CSP note
 *
 * The wrapper never tries to load a blob URL over the network (no
 * `importScripts(blob:)`, no `fetch(blob:)`, no sync XHR). Strict-CSP
 * origins can allow `worker-src blob:` while forbidding `blob:` under
 * `connect-src` and `script-src`, which would block every such route.
 * Instead the wrapper shims `URL.createObjectURL` inside the worker
 * realm, captures each Blob the page hands to the URL API, and
 * composes a new `Blob([payload, origBlob])` at nested-Worker
 * construction time — pure in-memory concatenation, no CSP gate.
 */
const WORKER_WRAPPER = `
// --- Global-install helper (stealth) ---
//
// CreepJS's getClientCode() enumerates Object.getOwnPropertyNames(self)
// and flags any function-valued own property whose toString() doesn't
// match the native "[native code]" mould. We walk up self's prototype
// chain to find where the native lived, and install the replacement
// there — preserving native layout where self itself has no own
// property for the global.
var __installWorkerGlobal = function(name, value) {
  var target = self;
  var descriptor = Object.getOwnPropertyDescriptor(target, name);
  while (!descriptor) {
    target = Object.getPrototypeOf(target);
    if (!target) break;
    descriptor = Object.getOwnPropertyDescriptor(target, name);
  }
  if (!target) {
    try {
      Object.defineProperty(self, name, {
        value: value, writable: true, configurable: true, enumerable: false
      });
    } catch(e) {
      try { self[name] = value; } catch(e2) { /* non-writable */ }
    }
    return;
  }
  try {
    Object.defineProperty(target, name, {
      value: value,
      writable: descriptor.writable !== false,
      configurable: descriptor.configurable !== false,
      enumerable: !!descriptor.enumerable
    });
  } catch(e) {
    try {
      Object.defineProperty(self, name, {
        value: value, writable: true, configurable: true, enumerable: false
      });
    } catch(e2) {
      try { self[name] = value; } catch(e3) { /* non-writable */ }
    }
  }
};

// --- importScripts relative-path resolution ---
(function() {
  if (typeof self.importScripts !== "function") return;
  var origImportScripts = self.importScripts;
  var scriptBase = __ORIGINAL_SCRIPT_URL__;
  var spoofedImportScripts = function importScripts() {
    var resolved = [];
    for (var i = 0; i < arguments.length; i++) {
      try {
        resolved.push(new URL(arguments[i], scriptBase).href);
      } catch(e) {
        resolved.push(arguments[i]);
      }
    }
    return origImportScripts.apply(self, resolved);
  };
  if (typeof __register === "function") __register(spoofedImportScripts, "importScripts");
  __installWorkerGlobal("importScripts", spoofedImportScripts);
})();

// --- URL.createObjectURL tracking (inside the worker) ---
//
// Workers can call URL.createObjectURL(blob) the same way windows can.
// To intercept a nested Worker spawned from inside this worker we need
// to capture the Blob before it's anonymized by the URL API — same
// strategy as the top-level content script. Without this, sites that
// do 'new Worker(URL.createObjectURL(childBlob))' inside a worker
// would leak the real timezone in the grandchild, because we'd have
// no bytes to read without hitting a CSP-gated fetch path.
var __nestedTrackedBlobs = new Map();
(function() {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
  var OrigCreate = URL.createObjectURL.bind(URL);
  var OrigRevoke = URL.revokeObjectURL.bind(URL);
  var WeakRefCtor = typeof WeakRef === "function" ? WeakRef : null;
  var spoofedCreate = function createObjectURL(obj) {
    var url = OrigCreate(obj);
    try {
      if (typeof Blob !== "undefined" && obj instanceof Blob) {
        __nestedTrackedBlobs.set(
          url,
          WeakRefCtor
            ? new WeakRefCtor(obj)
            : { deref: (function(b){ return function(){ return b; }; })(obj) }
        );
      }
    } catch(e) { /* cross-realm instanceof edge cases */ }
    return url;
  };
  var spoofedRevoke = function revokeObjectURL(url) {
    __nestedTrackedBlobs.delete(url);
    return OrigRevoke(url);
  };
  if (typeof __register === "function") {
    __register(spoofedCreate, "createObjectURL");
    __register(spoofedRevoke, "revokeObjectURL");
  }
  try {
    Object.defineProperty(URL, "createObjectURL", {
      value: spoofedCreate, writable: true, configurable: true, enumerable: true
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: spoofedRevoke, writable: true, configurable: true, enumerable: true
    });
  } catch(e) { /* non-configurable host URL prototype — best-effort */ }
})();

function lookupNestedBlob(url) {
  var ref = __nestedTrackedBlobs.get(url);
  if (!ref) return null;
  var blob = ref.deref();
  if (!blob) { __nestedTrackedBlobs.delete(url); return null; }
  return blob;
}

// --- Nested Worker interception (inline-only) ---
//
// A child worker spawned from inside this blob-wrapped worker is given
// the same treatment: if it's inline (blob/data URL) we wrap it; if it's
// a URL-based worker we can't easily announce it to the background
// (we're running in worker context, no access to CustomEvent on window)
// so it passes through unpatched. On Firefox the background filter
// won't see it either because nested worker fetches don't always fire
// webRequest. This is a documented edge case — nested URL-based workers
// inside blob-wrapped workers leak on all engines.
(function() {
  if (typeof self.Worker === "undefined") return;
  var OrigW = self.Worker;
  var nestedCore = __SPOOF_CORE__;
  var nestedWrapperTemplate = __NESTED_WRAPPER_TEMPLATE__;

  function buildNestedPayload(originalUrl) {
    // Use callback form so $$, $&, etc. in the large code blobs
    // aren't interpreted as backreference sequences.
    var originalUrlJson = JSON.stringify(originalUrl);
    var coreJson = JSON.stringify(nestedCore);
    var wrapperJson = JSON.stringify(nestedWrapperTemplate);
    var wrapper = nestedWrapperTemplate
      .replace("__ORIGINAL_SCRIPT_URL__", function() { return originalUrlJson; })
      .replace("__SPOOF_CORE__", function() { return coreJson; })
      .replace("__NESTED_WRAPPER_TEMPLATE__", function() { return wrapperJson; });
    return "(function(){" + nestedCore + wrapper + "})();";
  }

  var spoofedNestedWorker = function Worker(url, opts) {
    if (opts && opts.type === "module") {
      return new OrigW(url, opts);
    }
    try {
      var urlStr = url instanceof URL ? url.href : String(url);
      if (urlStr.indexOf("blob:") === 0) {
        // Compose a new Blob from [payload, originalBlob] using the
        // worker-realm URL.createObjectURL tracker installed above.
        // No fetch, no XHR, no importScripts — strictly in-memory
        // concatenation, which no CSP directive gates.
        var origBlob = lookupNestedBlob(urlStr);
        if (!origBlob) return new OrigW(url, opts);
        var payload = buildNestedPayload(urlStr);
        var blob = new Blob([payload + "\\n", origBlob], { type: "application/javascript" });
        return new OrigW(URL.createObjectURL(blob), opts);
      }
      if (urlStr.indexOf("data:") === 0) {
        var commaIdx = urlStr.indexOf(",");
        var meta = urlStr.substring(5, commaIdx);
        var encoded = urlStr.substring(commaIdx + 1);
        var decoded = meta.indexOf(";base64") !== -1
          ? atob(encoded)
          : decodeURIComponent(encoded);
        var payload2 = buildNestedPayload(self.location.href);
        var newBlob = new Blob([payload2 + "\\n" + decoded], { type: "application/javascript" });
        return new OrigW(URL.createObjectURL(newBlob), opts);
      }
      // URL-based nested worker: pass through unpatched. We can't
      // announce from worker context to the background.
      return new OrigW(url, opts);
    } catch(e) {
      return new OrigW(url, opts);
    }
  };
  spoofedNestedWorker.prototype = OrigW.prototype;
  if (typeof __register === "function") __register(spoofedNestedWorker, "Worker");
  __installWorkerGlobal("Worker", spoofedNestedWorker);
})();
`;

/**
 * Build the full inline-worker payload by composing the spoofing core
 * with the wrapper. `originalScriptUrl` is baked into the wrapper so
 * relative `importScripts` calls inside the worker resolve correctly.
 *
 * Returns an empty string when spoofing is disabled or no timezone data
 * is available — the caller then falls back to an unpatched worker.
 */
function generateInlineWorkerPayload(originalScriptUrl: string): string {
  // Either spoofed axis alone justifies patching the worker: a locale with no
  // spoofed location (hence no timezone) still has to reach worker scope, or the
  // worker would report the real language while the page realm reports the
  // spoofed one — an internal mismatch a page can read directly.
  if (!spoofingEnabled || (!timezoneData && !localeData)) {
    return "";
  }

  // `buildWorkerSpoofCore` handles placeholder substitution with the callback
  // form of .replace(), so backreference patterns ($&, $$, $', $1-$9) inside
  // these large code blobs — or inside a user-supplied timezone id / locale tag
  // — are passed through literally. WORKER_WRAPPER needs the same treatment
  // below for the same reason.
  //
  // The worker gets this realm's getTimezoneOffset precision as a literal
  // rather than probing its own, so it can't disagree with the page. Nested
  // workers reuse this core and carry the same value.
  const core = buildWorkerSpoofCore(
    timezoneData?.identifier ?? null,
    localeData,
    nativeFractionalOffset
  );
  const originalUrlJson = JSON.stringify(originalScriptUrl);
  const coreJson = JSON.stringify(core);
  const wrapperJson = JSON.stringify(WORKER_WRAPPER);
  const wrapper = WORKER_WRAPPER.replace("__ORIGINAL_SCRIPT_URL__", () => originalUrlJson)
    .replace("__SPOOF_CORE__", () => coreJson)
    .replace("__NESTED_WRAPPER_TEMPLATE__", () => wrapperJson);

  return `(function(){\n"use strict";\n${core}\n${wrapper}\n})();`;
}

// ── Inline URL helpers ───────────────────────────────────────────────

/**
 * Decode a `data:` URL into its source text. Returns null if the URL
 * doesn't look like a valid data URL.
 */
function decodeDataUrl(url: string): string | null {
  const commaIndex = url.indexOf(",");
  if (commaIndex === -1) return null;
  const meta = url.substring(5, commaIndex);
  const encoded = url.substring(commaIndex + 1);
  if (meta.includes(";base64")) {
    try {
      return atob(encoded);
    } catch {
      return null;
    }
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/**
 * Create a blob URL whose contents are the spoofing payload followed
 * by the original inline source text.
 */
function createPatchedBlobUrl(source: string, payload: string): string {
  const combined = payload + "\n" + source;
  const blob = new Blob([combined], { type: "application/javascript" });
  return URL.createObjectURL(blob);
}

/**
 * Compose a new Blob URL whose contents are the spoofing payload
 * followed by the bytes of the original Blob. No network/XHR/fetch
 * round-trip — `new Blob([string, Blob])` concatenates in-process,
 * so no CSP directive applies. Returns null when we don't hold a
 * live reference to the original Blob (URL minted before our
 * override loaded, or already revoked/GC'd), in which case the
 * caller must fall through to an unpatched construction.
 */
function createInlinedBlobWorkerUrl(originalBlobUrl: string, payload: string): string | null {
  const originalBlob = lookupTrackedBlob(originalBlobUrl);
  if (!originalBlob) return null;
  try {
    const patchedBlob = new Blob([payload + "\n", originalBlob], {
      type: "application/javascript",
    });
    return URL.createObjectURL(patchedBlob);
  } catch (err) {
    logger.debug("[worker-patching] Blob composition failed:", err);
    return null;
  }
}

// ── Worker constructor wrapper ───────────────────────────────────────

/**
 * Install the `Worker`, `SharedWorker`, and `navigator.serviceWorker
 * .register` interceptions.
 *
 * On Firefox the background script's `webRequest.filterResponseData`
 * listener is the primary spoofing path for URL-based workers — all we
 * do here is announce the URL so the listener knows to patch that
 * response. On Chromium/Safari nothing listens on the background side
 * and URL-based workers run unpatched (documented limit).
 *
 * Inline (blob/data URL) workers get blob-wrapped on every engine
 * because the site already opted into an inline URL and its CSP
 * already allows it.
 */
export function installWorkerPatching(): void {
  installBlobUrlTracking();
  if (OriginalWorker) installWorkerOverride();
  if (OriginalSharedWorker) installSharedWorkerOverride();
  installServiceWorkerAnnouncer();
  logger.debug("[worker-patching] Worker constructor interception installed");
}

/**
 * Wrap `navigator.serviceWorker.register` so the script URL is
 * announced to the background's webRequest listener just before the
 * browser fetches it. Service workers require a stable URL the browser
 * manages, so we can't swap in a blob — we just tell the filter "this
 * next request is a service worker script, please prepend the payload."
 */
function installServiceWorkerAnnouncer(): void {
  try {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    const container = navigator.serviceWorker;

    // Native `register` is a WebIDL operation that lives on
    // `ServiceWorkerContainer.prototype`, NOT as an own property of the
    // container instance. Installing our override on the instance (as this used
    // to) makes `Object.prototype.hasOwnProperty.call(navigator.serviceWorker,
    // "register")` return `true`, where a clean browser returns `false` — a
    // detectable tell on its own. Install on the prototype instead, mirroring
    // how the geolocation methods are installed on `Geolocation.prototype`.
    // Resolve the prototype via `getPrototypeOf` rather than the global
    // `ServiceWorkerContainer` so we don't depend on that name being exposed.
    const proto = Object.getPrototypeOf(container) as object | null;
    if (!proto) return;
    const originalDescriptor = Object.getOwnPropertyDescriptor(proto, "register");
    if (!originalDescriptor || typeof originalDescriptor.value !== "function") return;
    const originalRegister = originalDescriptor.value as ServiceWorkerContainer["register"];

    const wrappedRegister = function register(
      this: ServiceWorkerContainer,
      scriptURL: string | URL,
      options?: RegistrationOptions
    ): Promise<ServiceWorkerRegistration> {
      try {
        const announceUrl = resolveAnnounceableUrl(scriptURL);
        if (announceUrl) announceWorkerFetch(announceUrl);
      } catch (err) {
        logger.debug("[worker-patching] SW announce failed:", err);
      }

      return originalRegister.call(this, scriptURL, options);
    };

    // Method-shorthand wrap (see installBlobUrlTracking) so the installed
    // `register` has no own `prototype` / `[[Construct]]`, matching the native
    // WebIDL method shape. Descriptor flags are copied from the native
    // descriptor so the property shape on the prototype is unchanged.
    const finalRegister = stripConstruct(wrappedRegister);
    registerOverride(finalRegister, "register");
    disguiseAsNative(finalRegister, "register", 1);
    Object.defineProperty(proto, "register", {
      value: finalRegister,
      writable: originalDescriptor.writable ?? true,
      configurable: originalDescriptor.configurable ?? true,
      enumerable: originalDescriptor.enumerable ?? true,
    });
  } catch (err) {
    logger.warn("[worker-patching] installServiceWorkerAnnouncer failed:", err);
  }
}

function installWorkerOverride(): void {
  if (!OriginalWorker) return;
  const RealWorker = OriginalWorker;

  const SpoofedWorker = function Worker(
    this: unknown,
    scriptURL: string | URL,
    options?: WorkerOptions
  ): Worker {
    // Scrub injected frames from any native throw (e.g. String(Symbol) coercion
    // on the scriptURL, or a native constructor rejection) so the extension id
    // can't be read off the stack. Raw constructor — bypasses stripConstruct.
    try {
      seedFromBootstrap();
      const urlStr = scriptURL instanceof URL ? scriptURL.href : String(scriptURL);
      const isInline = urlStr.startsWith("blob:") || urlStr.startsWith("data:");

      // URL-based workers (http/https/relative): announce so Firefox's
      // webRequest filter patches the response, then pass through. Do
      // NOT rewrite to a blob — that would break `self.location` drift,
      // hit CSP worker-src restrictions, and make module imports fail.
      if (!isInline) {
        const announceUrl = resolveAnnounceableUrl(scriptURL);
        if (announceUrl) announceWorkerFetch(announceUrl);
        return new RealWorker(scriptURL, options);
      }

      // Module workers with inline URLs: blob-wrapping breaks relative
      // `import` resolution. Pass through unpatched. In practice module
      // workers with blob/data URLs are rare — bundlers ship module
      // workers as http URLs which hit the announce path above.
      if (options?.type === "module") {
        return new RealWorker(scriptURL, options);
      }

      // Inline classic workers: blob-wrap. The site's CSP already allows
      // blob/data URLs (it just constructed one), so our wrapped blob
      // stays within the same allowance.
      const payload = generateInlineWorkerPayload(window.location.href);
      if (!payload) return new RealWorker(scriptURL, options);

      try {
        if (urlStr.startsWith("blob:")) {
          const blobUrl = createInlinedBlobWorkerUrl(urlStr, payload);
          if (blobUrl) return new RealWorker(blobUrl, options);
          // Couldn't read the source (revoked, cross-origin, etc.) —
          // fall through to unpatched rather than re-injecting an
          // `importScripts(blob:)` bootstrap that would be blocked
          // under strict `script-src` CSPs.
          return new RealWorker(scriptURL, options);
        }

        // data: URL — decode inline, prepend payload, create fresh blob.
        const source = decodeDataUrl(urlStr);
        if (source !== null) {
          const patchedUrl = createPatchedBlobUrl(source, payload);
          return new RealWorker(patchedUrl, options);
        }
        // Couldn't decode — fall through to unpatched.
        return new RealWorker(scriptURL, options);
      } catch (err) {
        logger.debug("[worker-patching] inline Worker wrap failed, falling back:", err);
        return new RealWorker(scriptURL, options);
      }
    } catch (err) {
      stripExtensionFramesFromStack(err);
      throw err;
    }
  } as unknown as typeof Worker;

  SpoofedWorker.prototype = RealWorker.prototype;
  Object.defineProperty(SpoofedWorker, "prototype", {
    value: RealWorker.prototype,
    writable: false,
    configurable: false,
    enumerable: false,
  });

  registerOverride(SpoofedWorker as unknown as (...args: unknown[]) => unknown, "Worker");
  disguiseAsNative(SpoofedWorker as unknown as (...args: unknown[]) => unknown, "Worker", 1);

  Object.defineProperty(window, "Worker", {
    value: SpoofedWorker,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

function installSharedWorkerOverride(): void {
  if (!OriginalSharedWorker) return;
  const RealSharedWorker = OriginalSharedWorker;

  const SpoofedSharedWorker = function SharedWorker(
    this: unknown,
    scriptURL: string | URL,
    options?: string | WorkerOptions
  ): SharedWorker {
    // Scrub injected frames from any native throw (see SpoofedWorker above).
    try {
      seedFromBootstrap();
      const opts: WorkerOptions | undefined =
        typeof options === "string" ? { name: options } : options;

      const urlStr = scriptURL instanceof URL ? scriptURL.href : String(scriptURL);
      const isInline = urlStr.startsWith("blob:") || urlStr.startsWith("data:");

      // URL-based: announce + pass through. Same rationale as Worker.
      if (!isInline) {
        const announceUrl = resolveAnnounceableUrl(scriptURL);
        if (announceUrl) announceWorkerFetch(announceUrl);
        return new RealSharedWorker(scriptURL, options);
      }

      if (opts?.type === "module") {
        return new RealSharedWorker(scriptURL, options);
      }

      const payload = generateInlineWorkerPayload(window.location.href);
      if (!payload) return new RealSharedWorker(scriptURL, options);

      try {
        if (urlStr.startsWith("blob:")) {
          const blobUrl = createInlinedBlobWorkerUrl(urlStr, payload);
          if (blobUrl) return new RealSharedWorker(blobUrl, options);
          return new RealSharedWorker(scriptURL, options);
        }
        const source = decodeDataUrl(urlStr);
        if (source !== null) {
          const patchedUrl = createPatchedBlobUrl(source, payload);
          return new RealSharedWorker(patchedUrl, options);
        }
        return new RealSharedWorker(scriptURL, options);
      } catch (err) {
        logger.debug("[worker-patching] inline SharedWorker wrap failed, falling back:", err);
        return new RealSharedWorker(scriptURL, options);
      }
    } catch (err) {
      stripExtensionFramesFromStack(err);
      throw err;
    }
  } as unknown as typeof SharedWorker;

  SpoofedSharedWorker.prototype = RealSharedWorker.prototype;
  Object.defineProperty(SpoofedSharedWorker, "prototype", {
    value: RealSharedWorker.prototype,
    writable: false,
    configurable: false,
    enumerable: false,
  });

  registerOverride(
    SpoofedSharedWorker as unknown as (...args: unknown[]) => unknown,
    "SharedWorker"
  );
  disguiseAsNative(
    SpoofedSharedWorker as unknown as (...args: unknown[]) => unknown,
    "SharedWorker",
    1
  );

  Object.defineProperty(window, "SharedWorker", {
    value: SpoofedSharedWorker,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}
