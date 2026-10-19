/**
 * Firefox-only `webRequest.filterResponseData` worker script patcher.
 *
 * ## Problem
 *
 * Content scripts cannot inject into Web Worker, SharedWorker, or
 * ServiceWorker contexts. The content-script-level worker-patching
 * module wraps `new Worker(url)` for inline (blob / data) workers by
 * prepending a bootstrap, but URL-based workers, module workers, and
 * service workers all need bytes intercepted at the network layer.
 *
 * ## Solution
 *
 * Firefox still exposes `webRequest.filterResponseData` in MV3, a
 * Chromium-discontinued API that lets an extension pipe the raw bytes
 * of an HTTP response through a transformation. We use it to prepend
 * the timezone spoofing payload to any worker script response, leaving
 * the URL / origin / CSP / import-resolution behaviour untouched — from
 * the browser's perspective nothing unusual happened, it just fetched
 * a script that happens to contain our payload at the top.
 *
 * ## How we identify worker scripts
 *
 * Firefox reports ALL worker script loads (dedicated, shared, service,
 * classic, module) under `details.type === "script"` — the same bucket
 * as every `<script src="...">` on the page. Blindly patching every
 * script would obviously break the web.
 *
 * The reliable distinguisher is the `Sec-Fetch-Dest` HTTP request
 * header, which the browser sets according to the Fetch spec:
 *
 *   - `Sec-Fetch-Dest: worker`        — `new Worker(url)` (classic or module)
 *   - `Sec-Fetch-Dest: sharedworker`  — `new SharedWorker(url)`
 *   - `Sec-Fetch-Dest: serviceworker` — `navigator.serviceWorker.register(url)`
 *   - `Sec-Fetch-Dest: script`        — plain `<script src="...">` tags
 *
 * Headers are available in `onBeforeSendHeaders`, which fires after
 * `onBeforeRequest` but before the request hits the network — and
 * well before any response body arrives. So the classification is
 * always available by the time `filter.ondata` starts firing.
 *
 * ## Two-stage filter flow
 *
 *   1. `onBeforeRequest` — attach a `filterResponseData` filter to
 *      every script request, park state keyed by `requestId`, mark
 *      decision as "pending". This is required because Firefox's
 *      optimized script byte cache only honours filters attached in
 *      `onBeforeRequest`; attaching later silently no-ops for scripts.
 *
 *   2. `onBeforeSendHeaders` — read `Sec-Fetch-Dest`, set the state's
 *      decision to either "patch" (worker / sharedworker /
 *      serviceworker) or "pass" (anything else, including regular
 *      `<script>` tags). Falls back to the URL allowlist (populated
 *      by the content-script `ANNOUNCE_WORKER_FETCH` handshake) when
 *      the header is absent — defensive belt-and-braces.
 *
 *   3. `filter.ondata` / `filter.onstop`
 *      - "patch": buffer all chunks, then emit payload + body + close
 *      - "pass":  write each chunk straight through, close at stop
 *      - "pending" (never arrived): default to pass-through
 *
 * ## Why this replaced the announce-only approach
 *
 * The old design was handshake-only: the injected script fires a
 * CustomEvent → content script → `browser.runtime.sendMessage` →
 * background adds URL to a short-lived allowlist → listener checks
 * allowlist. On a cold MV3 background (post-idle or just-woken), the
 * round-trip could take 50-500ms — and meanwhile `onBeforeRequest`
 * fired synchronously from the worker constructor, found an empty
 * allowlist, and passed the URL through unpatched. Classic race.
 *
 * Moving the signal into `Sec-Fetch-Dest` eliminates the race: the
 * header arrives in the same I/O flow as the request itself, so
 * there's nothing to race against. The allowlist stays in place as
 * a fallback for engines / edge cases where `Sec-Fetch-Dest` is
 * missing (e.g. proxied requests, some redirects).
 *
 * ## Scope of URLs we touch
 *
 * Every http(s) request with `type: "script"`. The filter attaches
 * to all of them but only prepends bytes for the ones tagged as
 * worker-like. Buffer memory is released on `close()` / `disconnect()`.
 *
 * ## Limitations
 *
 *   1. **Subresource Integrity** — Sites that ship `integrity="sha384-..."`
 *      on their worker scripts will fail the hash check after our
 *      modification. The browser refuses to load the worker and the
 *      site's worker-dependent functionality stops working. We catch
 *      the filter-pipeline error in our `onerror` handler and call
 *      `disconnect()` so the original unmodified response falls
 *      through; the site works, the leak remains on that origin.
 *
 *   2. **ServiceWorker persistence** — The browser caches the modified
 *      bytes as the registered SW script. Once registered, it continues
 *      running with our payload until the site updates the script
 *      (byte comparison triggers reinstall, which re-pipes through our
 *      filter) or the user clears site data. Disabling the extension
 *      does not retroactively un-patch already-installed SWs.
 *
 *   3. **Feature detection** — `filterResponseData` may not exist on
 *      every engine. We feature-detect at listener install time and
 *      silently no-op if the API is absent. This also covers Chrome
 *      (polyfill returns undefined), Safari (not implemented), and
 *      future Firefox policy changes.
 *
 *   4. **Source maps** — Prepending shifts line numbers, so dev tools
 *      will show wrong positions when debugging an affected worker.
 *      Doesn't affect end-users, visible to devs only.
 *
 *   5. **Full-response buffering for patched scripts** — We hold the
 *      entire body in memory before writing it back out, because the
 *      payload has to come first. Worker scripts are usually small
 *      (< 1 MB) so the RSS hit is bounded. Pass-through scripts are
 *      streamed chunk-by-chunk with no buffering.
 */

import type { Settings } from "@/shared/types/settings";
import { buildStandaloneWorkerPayload } from "@/shared/worker-payload";
import { resolvePageLocale } from "@/shared/locale/resolver";
import { loadSettings } from "./settings";
import { isRestrictedUrl } from "./tabs";
import { computeEffectiveEnabled, computeEffectiveSiteLocations } from "@/shared/utils/scope";
import { resolveSiteSettings } from "@/shared/utils/site-locations";
import { createLogger } from "@/shared/utils/debug-logger";

const logger = createLogger("BG");

/**
 * Firefox's `webRequest.filterResponseData` returns a `StreamFilter`
 * object. The `browser` polyfill's types mark this API as Firefox-only
 * so we declare a minimal interface to avoid type errors on other
 * build targets.
 */
interface StreamFilter {
  ondata: ((event: { data: ArrayBuffer }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  write(data: ArrayBuffer | Uint8Array): void;
  close(): void;
  disconnect(): void;
  error?: string;
}

/**
 * HTTP request headers as reported by webRequest. Names are case-
 * insensitive per the HTTP spec but Firefox preserves whatever case
 * the browser emitted, so consumers lowercase before comparing.
 */
interface HttpHeader {
  name: string;
  value?: string;
  binaryValue?: number[];
}

/** Shape of `browser.webRequest` that we touch. */
interface WebRequestWithFilter {
  filterResponseData?: (requestId: string) => StreamFilter;
  onBeforeRequest?: {
    addListener: (
      listener: (details: WebRequestDetails) => void | Promise<void>,
      filter: { urls: string[]; types: string[] },
      extraInfoSpec?: string[]
    ) => void;
    removeListener: (listener: (details: WebRequestDetails) => void | Promise<void>) => void;
  };
  onBeforeSendHeaders?: {
    addListener: (
      listener: (details: WebRequestDetailsWithHeaders) => void,
      filter: { urls: string[]; types: string[] },
      extraInfoSpec?: string[]
    ) => void;
    removeListener: (listener: (details: WebRequestDetailsWithHeaders) => void) => void;
  };
}

interface WebRequestDetails {
  requestId: string;
  url: string;
  type: string;
  method: string;
  tabId: number;
  frameId: number;
  /**
   * Firefox-only: the URL of the document that initiated the request. For a
   * worker script fetch this is the document that constructed the worker —
   * the reliable origin signal for tab-less SharedWorker requests where
   * `tabId === -1`. Absent on engines without `filterResponseData` (which
   * never reach this code) and on some redirected/proxied requests.
   */
  documentUrl?: string;
  /**
   * Firefox-only: the origin URL that triggered the request. Fallback origin
   * signal when `documentUrl` is absent.
   */
  originUrl?: string;
}

interface WebRequestDetailsWithHeaders extends WebRequestDetails {
  requestHeaders?: HttpHeader[];
}

// ── State ────────────────────────────────────────────────────────────

/**
 * Decision state for a single in-flight script request.
 *
 *   - "pending": filter attached, header classification not yet known.
 *     Buffers any ondata chunks that arrive in this window (rare —
 *     onBeforeSendHeaders normally fires before response body).
 *   - "patch": `Sec-Fetch-Dest` identified as a worker variant (or the
 *     URL was on the announce allowlist). Accumulate body, emit
 *     payload + body + close at onstop.
 *   - "pass": Identified as a regular `<script>` tag. Write each
 *     chunk straight through on ondata, close at onstop.
 */
type Decision = "pending" | "patch" | "pass";

interface PendingRequest {
  filter: StreamFilter;
  url: string;
  decision: Decision;
  chunks: Uint8Array[];
  /**
   * The initiating document's URL, recorded at classification. `onstop` builds
   * the payload against it so a worker on a site-location page gets that
   * site's zone, not the main one.
   */
  pageUrl?: string;
}

/** Map from requestId to the active filter + decision state. */
const pending = new Map<string, PendingRequest>();

/**
 * Cache of the current top-level page URL for each open tab, keyed by tabId.
 * Populated by `onTabUpdated` and seeded from existing tabs in
 * `installWorkerRequestFilter`. Read synchronously inside `classifyRequest`
 * to perform the same-origin gate without an async `browser.tabs.get` call.
 * Exported so `messages.ts` can read it for the `ANNOUNCE_WORKER_FETCH` gate.
 */
export const tabPageUrlCache = new Map<number, string>();

let beforeRequestListener: ((details: WebRequestDetails) => void) | null = null;
let beforeSendHeadersListener: ((details: WebRequestDetailsWithHeaders) => void) | null = null;

/**
 * Cached settings snapshot. Refreshed on every settings change and
 * read synchronously inside the webRequest listeners (listeners
 * can't be async on Firefox). When undefined, the listeners are in
 * their "before-first-load" state and short-circuit to a no-op.
 */
let cachedSettings: Settings | undefined;

/**
 * Short-lived allowlist of worker script URLs the content script has
 * announced it's about to fetch. Retained as a secondary classifier
 * for requests where `Sec-Fetch-Dest` is missing for any reason
 * (some proxy configurations, historical Firefox edge cases).
 *
 * Entries auto-expire after ALLOWLIST_TTL_MS so a stale entry can
 * never match an unrelated future request.
 */
const ALLOWLIST_TTL_MS = 10_000;
const workerUrlAllowlist = new Map<string, number>();

/**
 * Add a URL to the worker-script allowlist. Called by the message
 * handler when the content script announces `new Worker(url)` or
 * `navigator.serviceWorker.register(url)`.
 */
export function allowlistWorkerUrl(url: string): void {
  workerUrlAllowlist.set(url, Date.now() + ALLOWLIST_TTL_MS);
  // Opportunistic cleanup of expired entries so the map doesn't grow
  // unbounded on long-lived tabs that spawn many workers.
  if (workerUrlAllowlist.size > 128) {
    const now = Date.now();
    for (const [u, expiry] of workerUrlAllowlist) {
      if (expiry < now) workerUrlAllowlist.delete(u);
    }
  }
}

/**
 * Check whether a URL is currently on the allowlist. Does NOT remove
 * the entry on match — service workers can be re-fetched by the
 * browser's update-check cycle and need the same ruling applied,
 * and module workers can trigger multiple sub-requests under the
 * same parent announce.
 */
function isAllowlisted(url: string): boolean {
  const expiry = workerUrlAllowlist.get(url);
  if (!expiry) return false;
  if (expiry < Date.now()) {
    workerUrlAllowlist.delete(url);
    return false;
  }
  return true;
}

/**
 * Update the cached settings snapshot that the listeners read.
 * Called from background/tabs.ts → broadcastSettingsToTabs on every
 * settings change, and from the initialize() path at startup.
 */
export function updateWorkerFilterSettings(settings: Settings): void {
  cachedSettings = settings;
}

/**
 * Whether any timezone could apply to a worker: the main one, or an effective
 * site location's. Lets the attach short-circuit skip work when neither
 * exists, without missing a site-location page whose main location is unset.
 */
export function hasWorkerTimezoneSource(settings: Settings): boolean {
  return (
    !!settings.timezone?.identifier ||
    computeEffectiveSiteLocations(settings.siteLocations, settings.proFeaturesBlocked).length > 0
  );
}

/**
 * Build the worker payload for a worker created by the document at `pageUrl`.
 * The timezone and locale come from the same per-site resolution the page
 * payload uses, so a worker and its page agree. Returns "" when there is
 * neither a timezone nor a locale to apply (leave the script unmodified).
 */
export function workerPayloadFor(settings: Settings, pageUrl: string | undefined): string {
  const effective = resolveSiteSettings(settings, pageUrl, isRestrictedUrl).settings;
  const identifier = effective.timezone?.identifier;
  // Either axis alone is enough to warrant a payload — a user can spoof a
  // locale with no location (hence no timezone), or a timezone with no locale.
  const locale = resolvePageLocale(
    effective.localeSpoofing,
    identifier ?? null,
    effective.proFeaturesBlocked
  );
  return identifier || locale ? buildStandaloneWorkerPayload(identifier, locale) : "";
}

/**
 * The URL of the document that initiated a request.
 *
 *   - Dedicated / module workers carry the spawning page's tabId, so the
 *     per-tab cache answers directly.
 *   - SharedWorkers are NOT bound to a tab (Firefox reports tabId === -1), so
 *     the cache can't help. Firefox does, however, populate `documentUrl` /
 *     `originUrl` on the request with the document that created the worker.
 *     Using that is race-free — no dependency on the ANNOUNCE_WORKER_FETCH
 *     handshake winning against the worker fetch — and gives a reliable
 *     origin for the same-origin and scope gates.
 */
function resolveInitiatorUrl(details: WebRequestDetails): string | undefined {
  return tabPageUrlCache.get(details.tabId) ?? details.documentUrl ?? details.originUrl;
}

/**
 * Exposed for unit testing only. Calls the internal `classifyRequest`
 * function with the given details so tests can assert classification
 * decisions without going through the full webRequest listener stack.
 *
 * @internal
 */
export function _classifyRequestForTest(details: {
  requestId: string;
  url: string;
  type: string;
  method: string;
  tabId: number;
  frameId: number;
  documentUrl?: string;
  originUrl?: string;
  requestHeaders?: { name: string; value?: string }[];
}): Decision {
  return classifyRequest(details);
}

/**
 * Return true when `workerUrl` is same-site as `tabPageUrl`. Used by the
 * `ANNOUNCE_WORKER_FETCH` message handler and the `classifyRequest` origin
 * gate to restrict patching to first-party workers.
 *
 * Two ways to qualify as same-site:
 *   1. Exact same origin (scheme + host + port). This is the fallback that
 *      makes `localhost`, bare IPs, and other single-label hosts work —
 *      `getRegistrableDomain` returns null for those, but a worker loaded
 *      from the page's own origin is unambiguously first-party.
 *   2. Same registrable domain (eTLD+1), so a worker served from a sibling
 *      sub-domain (e.g. `api.example.com` on `app.example.com`) still matches.
 *
 * Returns false when `tabPageUrl` is undefined (unknown tab) or either URL
 * is unparseable.
 */
export function isSameOriginWorker(workerUrl: string, tabPageUrl: string | undefined): boolean {
  if (!tabPageUrl) return false;

  // Exact-origin match: covers localhost / IP / single-label hosts where
  // registrable-domain extraction can't produce a comparable value.
  let workerOrigin: string;
  let pageOrigin: string;
  try {
    workerOrigin = new URL(workerUrl).origin;
    pageOrigin = new URL(tabPageUrl).origin;
  } catch {
    return false;
  }
  if (workerOrigin === pageOrigin && workerOrigin !== "null") return true;

  // Otherwise fall back to same registrable domain (eTLD+1) for sub-domains.
  const workerDomain = getRegistrableDomain(workerUrl);
  const pageDomain = getRegistrableDomain(tabPageUrl);
  return workerDomain !== null && pageDomain !== null && workerDomain === pageDomain;
}

// ── Feature detection ────────────────────────────────────────────────
/**
 * Return true when the current engine exposes the
 * `webRequest.filterResponseData` API. Firefox (all MV3 versions
 * the extension targets) returns true; Chromium and Safari return
 * false and the worker filter becomes a no-op at install time.
 */
export function isWorkerFilterSupported(): boolean {
  try {
    const wr = (browser.webRequest as unknown as WebRequestWithFilter) || {};
    return typeof wr.filterResponseData === "function";
  } catch {
    return false;
  }
}

// ── Classification ───────────────────────────────────────────────────

/**
 * Known two-label eTLDs that need special handling when extracting
 * the registrable domain (eTLD+1). This list covers the most common
 * cases; it is not exhaustive.
 */
const TWO_PART_ETLDS = new Set([
  "co.uk",
  "co.jp",
  "co.nz",
  "co.za",
  "co.in",
  "co.kr",
  "com.au",
  "com.br",
  "com.mx",
  "com.ar",
  "com.sg",
  "com.hk",
  "org.uk",
  "net.au",
  "gov.uk",
  "ac.uk",
  "me.uk",
]);

/**
 * Extract the registrable domain (eTLD+1) from a URL string.
 *
 * Returns `null` for:
 *   - Non-HTTP(S) URLs or invalid URLs
 *   - Bare IPv4 addresses (e.g. `192.168.1.1`)
 *   - IPv6 bracket notation (e.g. `[::1]`)
 *   - Single-label hostnames (e.g. `localhost`)
 *
 * Handles known two-part eTLDs (e.g. `co.uk`, `com.au`) so that
 * `example.co.uk` returns `"example.co.uk"` rather than `"co.uk"`.
 *
 * @example
 *   getRegistrableDomain("https://app.example.com/path") // "example.com"
 *   getRegistrableDomain("https://api.example.co.uk/")   // "example.co.uk"
 *   getRegistrableDomain("https://192.168.1.1/")         // null
 */
export function getRegistrableDomain(url: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  // Reject bare IPv4 addresses and IPv6 bracket notation.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith("[")) return null;

  const parts = hostname.split(".");
  if (parts.length < 2) return null;

  // Check for known two-part eTLD (e.g. "co.uk").
  if (parts.length >= 3) {
    const candidate = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (TWO_PART_ETLDS.has(candidate)) {
      return `${parts[parts.length - 3]}.${candidate}`;
    }
  }
  // Default: last two labels.
  return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
}

/**
 * Worker-like `Sec-Fetch-Dest` values. A request bearing any of
 * these is a worker script load and gets the spoofing payload
 * prepended; anything else is a regular script and passes through.
 */
const WORKER_FETCH_DESTS = new Set(["worker", "sharedworker", "serviceworker"]);

/**
 * Extract the `Sec-Fetch-Dest` value from a headers array. Lowercased
 * comparison for case-insensitive header matching per HTTP spec.
 * Returns null when the header is absent (legacy / proxied requests).
 */
function readSecFetchDest(headers: HttpHeader[] | undefined): string | null {
  if (!headers) return null;
  for (const h of headers) {
    if (h.name.toLowerCase() === "sec-fetch-dest") {
      return (h.value ?? "").toLowerCase();
    }
  }
  return null;
}

/**
 * Decide whether this request should have the spoofing payload
 * prepended. Authoritative signal is `Sec-Fetch-Dest`; the URL
 * allowlist is a fallback for the rare case where the header is
 * stripped or absent.
 *
 * Same-origin gate: only patch workers whose registrable domain
 * (eTLD+1) matches the tab's page origin. Cross-origin workers
 * (e.g. Cloudflare Turnstile, Stripe) are classified as "pass"
 * and left completely unmodified. When the tab's page URL is
 * unknown, defaults to "pass" (safe fallback).
 *
 * Scope gate (Req 11): a candidate "patch" is additionally gated on
 * `computeEffectiveEnabled` for the tab's top-level URL so the filter
 * agrees with the background's per-tab decision. Out-of-scope tabs
 * (allowlist miss, denylist hit, restricted URL, or master off) and
 * unknown tabs (`tabId === -1`, no cached URL) classify as "pass".
 */
function classifyRequest(details: WebRequestDetailsWithHeaders): Decision {
  const dest = readSecFetchDest(details.requestHeaders);
  const baseDecision: Decision =
    dest !== null
      ? WORKER_FETCH_DESTS.has(dest)
        ? "patch"
        : "pass"
      : isAllowlisted(details.url)
        ? "patch"
        : "pass";

  // Already a pass — no origin check needed.
  if (baseDecision === "pass") return "pass";

  // Never patch service workers. `filterResponseData` *can* prepend our
  // payload to the SW script on first install, but the browser then caches the
  // modified bytes and the registered SW keeps running our payload across page
  // loads — even after the extension is disabled — until the site ships a new
  // script or the user clears site data. That persistence is a footgun, and SW
  // spoofing is unreliable anyway: an already-installed SW is served from the
  // browser's cache and never re-fetched through the filter. Leave SW scripts
  // untouched (documented known limitation).
  if (dest === "serviceworker") return "pass";

  // Resolve the URL of the document that initiated this worker fetch (see
  // resolveInitiatorUrl for the per-tab cache vs SharedWorker fallback).
  const pageUrl = resolveInitiatorUrl(details);
  if (!pageUrl) return "pass"; // unknown initiator → safe fallback

  // Scope gate (Req 11): consult the single source of truth so the worker
  // filter agrees with the background's per-tab decision for this initiating
  // document. Out-of-scope (allowlist miss / denylist hit / restricted / master
  // off) ⇒ leave the worker script unmodified. When settings haven't loaded
  // yet, fall back to "pass".
  if (!cachedSettings) return "pass";
  const effective = computeEffectiveEnabled({
    masterEnabled: cachedSettings.enabled,
    scopeMode: cachedSettings.scopeMode,
    allowlist: cachedSettings.allowlist,
    denylist: cachedSettings.denylist,
    proFeaturesBlocked: cachedSettings.proFeaturesBlocked,
    topLevelUrl: pageUrl,
    isRestricted: isRestrictedUrl,
  });
  if (!effective) return "pass"; // out-of-scope → unmodified

  // Same-site gate: exact origin (covers localhost / IP / single-label hosts)
  // or same registrable domain (covers sibling sub-domains).
  if (!isSameOriginWorker(details.url, pageUrl)) return "pass";

  return "patch";
}

// ── Listeners ────────────────────────────────────────────────────────

/**
 * onBeforeRequest: attach a filter to every script request so it's
 * in place before Firefox's optimized script byte cache kicks in.
 * The decision to actually modify bytes is deferred to
 * onBeforeSendHeaders where Sec-Fetch-Dest is visible.
 */
function onBeforeWorkerRequest(details: WebRequestDetails): void {
  // Short-circuits in order of cheapness.

  // 1. Settings not yet loaded.
  if (!cachedSettings) return;

  // 2. Spoofing disabled — nothing to prepend, don't bother attaching.
  if (!cachedSettings.enabled) return;

  // 3. No timezone configured, neither main nor any site location's.
  if (!hasWorkerTimezoneSource(cachedSettings)) return;

  // 4. Only http(s) scripts — data:/blob: are handled by the content-
  //    script constructor wrapper, webRequest doesn't see them.
  if (details.type !== "script") return;
  if (!/^https?:\/\//.test(details.url)) return;

  if (cachedSettings.debugLogging) {
    logger.debug(
      `[worker-filter] attach filter: url=${details.url} requestId=${details.requestId}`
    );
  }

  let filter: StreamFilter;
  try {
    const wr = browser.webRequest as unknown as WebRequestWithFilter;
    if (!wr.filterResponseData) return;
    filter = wr.filterResponseData(details.requestId);
  } catch (err) {
    logger.warn(
      `[worker-filter] filterResponseData threw for ${details.url}:`,
      err instanceof Error ? err.message : String(err)
    );
    return;
  }

  const state: PendingRequest = {
    filter,
    url: details.url,
    decision: "pending",
    chunks: [],
  };
  pending.set(details.requestId, state);

  filter.ondata = (event) => {
    try {
      if (state.decision === "pass") {
        // Pass-through path: stream chunks straight to the browser
        // with zero buffering.
        filter.write(event.data);
        return;
      }
      // "patch" or "pending" — hold bytes until we're sure. onstop
      // will flush in the correct order once the decision is final.
      state.chunks.push(new Uint8Array(event.data));
    } catch (err) {
      logger.warn(
        `[worker-filter] ondata threw for ${state.url}:`,
        err instanceof Error ? err.message : String(err)
      );
      try {
        filter.disconnect();
      } catch {
        /* cleanup never masks primary failure */
      }
      pending.delete(details.requestId);
    }
  };

  filter.onstop = () => {
    try {
      if (state.decision === "patch") {
        // Build payload fresh so any concurrent timezone change
        // (rare, but possible mid-flight) is reflected in the next
        // completed worker script. The timezone and locale are resolved
        // for the initiating page from the same snapshot, so a worker
        // script gets the identical zone and Reported Language its page
        // realm does (including a site location's).
        const payload = cachedSettings ? workerPayloadFor(cachedSettings, state.pageUrl) : "";
        if (payload) {
          if (cachedSettings?.debugLogging) {
            logger.info(`[worker-filter] patching worker script: ${state.url}`);
          }
          filter.write(new TextEncoder().encode(payload));
        }
        for (const chunk of state.chunks) {
          filter.write(chunk);
        }
        filter.close();
      } else if (state.decision === "pass") {
        // ondata already wrote chunks through; just close.
        filter.close();
      } else {
        // Decision never arrived — treat as pass-through. Flush any
        // buffered chunks so the browser sees the original response.
        for (const chunk of state.chunks) {
          filter.write(chunk);
        }
        filter.close();
      }
    } catch (err) {
      logger.warn(
        `[worker-filter] onstop threw for ${state.url}:`,
        err instanceof Error ? err.message : String(err)
      );
      try {
        filter.disconnect();
      } catch {
        /* cleanup never masks primary failure */
      }
    } finally {
      // Release buffer memory as soon as the request is done.
      state.chunks.length = 0;
      pending.delete(details.requestId);
    }
  };

  filter.onerror = () => {
    // Browser-side failure (e.g. SRI hash mismatch, request aborted,
    // tab closed). The browser falls through to its default handling
    // of the request — if bytes have already been flushed we can't
    // un-flush, but the filter infrastructure stops waiting on us.
    const reason = filter.error || "(no reason reported)";
    logger.warn(`[worker-filter] filter error for ${state.url}: ${reason}`);
    state.chunks.length = 0;
    pending.delete(details.requestId);
  };
}

/**
 * onBeforeSendHeaders: classify the request via `Sec-Fetch-Dest` (or
 * the allowlist fallback) and record the decision so `ondata` /
 * `onstop` know what to do. Non-blocking — we only read headers.
 */
function onBeforeWorkerSendHeaders(details: WebRequestDetailsWithHeaders): void {
  const state = pending.get(details.requestId);
  if (!state) return;

  const decision = classifyRequest(details);
  state.decision = decision;
  state.pageUrl = resolveInitiatorUrl(details);

  if (cachedSettings?.debugLogging) {
    const dest = readSecFetchDest(details.requestHeaders) ?? "(absent)";
    logger.debug(
      `[worker-filter] classify: requestId=${details.requestId} sec-fetch-dest=${dest} decision=${decision} url=${details.url}`
    );
  }

  // If classification flipped to "pass" after data already started
  // buffering (rare corner case when response body races the header
  // event), flush the buffered chunks through so the browser doesn't
  // see a truncated script.
  if (decision === "pass" && state.chunks.length > 0) {
    try {
      for (const chunk of state.chunks) {
        state.filter.write(chunk);
      }
    } catch (err) {
      logger.warn(
        `[worker-filter] pass-through flush threw for ${state.url}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
    state.chunks.length = 0;
  }
}

// ── Tab lifecycle listeners ──────────────────────────────────────────

/**
 * Update the tab URL cache whenever a tab navigates. Called by
 * `browser.tabs.onUpdated`. Stores the URL when it is an http(s) URL;
 * removes a stale entry when the tab navigates away to a non-HTTP URL.
 */
function onTabUpdated(tabId: number, changeInfo: { url?: string }, tab: { url?: string }): void {
  if (tab.url && (tab.url.startsWith("http://") || tab.url.startsWith("https://"))) {
    tabPageUrlCache.set(tabId, tab.url);
  } else if (changeInfo.url === undefined && tab.url) {
    // Tab navigated to a non-HTTP URL — remove stale entry.
    tabPageUrlCache.delete(tabId);
  }
}

/**
 * Remove the tab's URL cache entry when the tab is closed.
 * Called by `browser.tabs.onRemoved`.
 */
function onTabRemoved(tabId: number): void {
  tabPageUrlCache.delete(tabId);
}

// ── Install / uninstall ──────────────────────────────────────────────

/**
 * Install both webRequest listeners. Idempotent — subsequent calls
 * are no-ops. Feature-detects `filterResponseData` at install time
 * and silently skips installation on engines that don't support it
 * (all non-Firefox engines).
 *
 * ## Respawn safety (why listeners register BEFORE any await)
 *
 * MV3 backgrounds are non-persistent: Firefox tears down the event page (and
 * Chromium the service worker) when idle and respawns it on the next event.
 * Only listeners registered SYNCHRONOUSLY during the top-level module run are
 * re-registered on respawn and able to wake the background for their event.
 * If we awaited `loadSettings()` / `browser.tabs.query()` before calling
 * `addListener`, the webRequest listeners would be registered a microtask too
 * late and would be lost on the first idle respawn — which is exactly how
 * URL-based worker patching silently stopped working once the background went
 * idle (the constructor still fired ANNOUNCE_WORKER_FETCH, but no filter was
 * attached). So we register the listeners first, then prime the caches
 * asynchronously; until priming lands the listeners short-circuit on
 * `!cachedSettings` and pass requests through unpatched (the same safe
 * fallback as a cold start). This function must therefore also be invoked
 * synchronously at the top level of the background entry point, not only from
 * `initialize()`.
 */
export async function installWorkerRequestFilter(): Promise<void> {
  if (beforeRequestListener) return;

  if (!isWorkerFilterSupported()) {
    logger.debug("[worker-filter] filterResponseData not supported, skipping install");
    return;
  }

  // ── Synchronous: register the wake-critical listeners before any await ──
  try {
    const wr = browser.webRequest as unknown as WebRequestWithFilter;
    if (!wr.onBeforeRequest || !wr.onBeforeSendHeaders) {
      logger.debug("[worker-filter] required webRequest events not available");
      return;
    }

    beforeRequestListener = onBeforeWorkerRequest;
    wr.onBeforeRequest.addListener(
      beforeRequestListener,
      {
        urls: ["http://*/*", "https://*/*"],
        types: ["script"],
      },
      ["blocking"]
    );

    beforeSendHeadersListener = onBeforeWorkerSendHeaders;
    wr.onBeforeSendHeaders.addListener(
      beforeSendHeadersListener,
      {
        urls: ["http://*/*", "https://*/*"],
        types: ["script"],
      },
      ["requestHeaders"]
    );

    browser.tabs.onUpdated.addListener(onTabUpdated);
    browser.tabs.onRemoved.addListener(onTabRemoved);

    logger.info(
      "[worker-filter] installed webRequest listeners (onBeforeRequest + onBeforeSendHeaders)"
    );
  } catch (err) {
    beforeRequestListener = null;
    beforeSendHeadersListener = null;
    logger.warn(
      "[worker-filter] install failed:",
      err instanceof Error ? err.message : String(err)
    );
    return;
  }

  // ── Asynchronous priming (NOT on the wake path) ──
  //
  // Prime the settings cache. Until this lands the listeners short-circuit on
  // `!cachedSettings` and pass through. broadcastSettingsToTabs also refreshes
  // this on every settings change, so a missed prime self-heals.
  try {
    cachedSettings = await loadSettings();
  } catch (err) {
    logger.warn(
      "[worker-filter] failed to prime settings cache:",
      err instanceof Error ? err.message : String(err)
    );
  }

  // Seed the tab URL cache from existing tabs. Misses self-heal via
  // onTabUpdated, and tab-less SharedWorker requests fall back to
  // documentUrl/originUrl in classifyRequest, so a slow seed only delays
  // dedicated-worker coverage briefly.
  try {
    const existingTabs = await browser.tabs.query({});
    for (const tab of existingTabs) {
      if (
        tab.id != null &&
        tab.url &&
        (tab.url.startsWith("http://") || tab.url.startsWith("https://"))
      ) {
        tabPageUrlCache.set(tab.id, tab.url);
      }
    }
  } catch (err) {
    logger.warn(
      "[worker-filter] failed to seed tab URL cache:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Remove both webRequest listeners. Idempotent. Used for tests and,
 * in principle, for runtime shutdown on unsupported engines.
 */
export function uninstallWorkerRequestFilter(): void {
  try {
    const wr = browser.webRequest as unknown as WebRequestWithFilter;
    if (beforeRequestListener) {
      wr.onBeforeRequest?.removeListener(beforeRequestListener);
    }
    if (beforeSendHeadersListener) {
      wr.onBeforeSendHeaders?.removeListener(beforeSendHeadersListener);
    }
  } catch (err) {
    logger.warn(
      "[worker-filter] uninstall failed:",
      err instanceof Error ? err.message : String(err)
    );
  }
  try {
    browser.tabs.onUpdated.removeListener(onTabUpdated);
    browser.tabs.onRemoved.removeListener(onTabRemoved);
  } catch {
    /* ignore — listeners may not have been registered (e.g. unsupported engine) */
  }
  tabPageUrlCache.clear();
  beforeRequestListener = null;
  beforeSendHeadersListener = null;
}
