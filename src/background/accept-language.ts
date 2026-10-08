/**
 * `Accept-Language` header alignment for the Reported Language feature.
 *
 * Most sites pick their language SERVER-side from this header, so overriding the
 * JS surfaces alone would leave the feature half-working. Worse, it would leave
 * it half-*consistent*: a browser claiming `fr-FR` from `navigator.language`
 * while sending `Accept-Language: en-US` is visibly tampered with, which is a
 * stronger fingerprinting signal than simply not spoofing. This module closes
 * that gap, and it derives its value from the same `resolvePageLocale` the page
 * world is fed, so the two cannot disagree.
 *
 * ── Per-engine mechanism ────────────────────────────────────────────────────
 *
 * **Firefox** uses blocking `webRequest.onBeforeSendHeaders`. This is the
 * accurate path: the listener sees `details.tabId` and `details.type`, so scope
 * is evaluated exactly per request. No new permission is needed — `webRequest`
 * and `webRequestBlocking` are already required for the worker script filter.
 *
 * **Chromium / Safari** use `declarativeNetRequest`, since MV3 removed blocking
 * `webRequest`. The permission is deliberately
 * `declarativeNetRequestWithHostAccess` rather than plain `declarativeNetRequest`:
 * both grant identical capabilities, but the former adds no install-time warning
 * (it leans on the `<all_urls>` host permission we already hold). That is not
 * cosmetic — Chrome disables an extension until the user manually re-accepts
 * whenever an update introduces a new permission warning, so shipping plain
 * `declarativeNetRequest` would have silently disabled GeoSpoof for every
 * existing Chrome user.
 *
 * Safari's `modifyHeaders` support has historically been unreliable; the same
 * code path is attempted and simply degrades to JS-only coverage where the
 * engine ignores it (disclosed in the popup and README per Req 5.3).
 *
 * ── Scope fidelity ─────────────────────────────────────────────────────────
 *
 * GeoSpoof decides scope from a tab's TOP-LEVEL url, but DNR conditions match
 * the request. Deriving domain conditions from the scope patterns is not a safe
 * approximation: patterns may carry paths (`example.com/shop`) while DNR matches
 * domains, so the header would apply across all of `example.com` while the JS
 * overrides correctly applied only under `/shop` — reintroducing exactly the
 * mismatch this module exists to prevent. So:
 *
 *   - `scopeMode: "all"` (the default) → one global rule. Exact, and no
 *     cold-start race because the rule is already in place for a tab's first
 *     request.
 *   - `allowlist` / `denylist` → a single SESSION rule whose `tabIds` lists the
 *     in-scope tabs, refreshed on navigation and settings changes. The header
 *     then rides on the same per-tab decision the payload builders use, rather
 *     than a second approximation of it.
 *
 * Known, accepted limits of the scoped variant (neither applies in `all` mode):
 * a tab's first document request can race the refresh, and requests with no tab
 * (`tabId === -1`, e.g. a service-worker fetch) are unmatched.
 */

import type { Settings } from "@/shared/types/settings";
import { resolveLocale, computeEffectiveLocaleSpoofing } from "@/shared/locale/resolver";
import { computeEffectiveEnabled } from "@/shared/utils/scope";
import { createLogger } from "@/shared/utils/debug-logger";
import { isRestrictedUrl } from "./tabs";
import { tabPageUrlCache } from "./worker-request-filter";

const logger = createLogger("BG");

/** Stable id for the single dynamic/session rule this module owns. */
const RULE_ID = 8801;

/**
 * Synchronously-readable settings snapshot.
 *
 * The Firefox listener is blocking and cannot await, so it needs the current
 * settings without a storage round-trip. Same approach (and same lifecycle) as
 * `worker-request-filter`'s cached snapshot.
 */
let cachedSettings: Settings | null = null;

let beforeSendHeadersListener:
  ((details: AcceptLanguageRequestDetails) => BlockingResponse | undefined) | null = null;

/** The slice of the webRequest details object this module uses. */
interface AcceptLanguageRequestDetails {
  requestId: string;
  url: string;
  tabId: number;
  type: string;
  requestHeaders?: { name: string; value?: string }[];
}

interface BlockingResponse {
  requestHeaders?: { name: string; value?: string }[];
}

/**
 * Resolve the `Accept-Language` value for a given top-level URL, or `null` when
 * the header should be left alone.
 *
 * Goes through the same Pro gate and the same resolver as the page payload, so
 * the header and `navigator.languages` are always two projections of one
 * decision.
 */
export function resolveAcceptLanguageFor(
  settings: Settings,
  topLevelUrl: string | undefined
): string | null {
  const enabled = computeEffectiveEnabled({
    masterEnabled: settings.enabled,
    scopeMode: settings.scopeMode,
    allowlist: settings.allowlist,
    denylist: settings.denylist,
    proFeaturesBlocked: settings.proFeaturesBlocked,
    topLevelUrl,
    isRestricted: isRestrictedUrl,
  });
  if (!enabled) return null;

  const effective = computeEffectiveLocaleSpoofing(
    settings.localeSpoofing,
    settings.proFeaturesBlocked
  );
  const resolved = resolveLocale(effective, settings.timezone?.identifier ?? null);
  return resolved?.acceptLanguage ?? null;
}

// ── Firefox: blocking webRequest ─────────────────────────────────────────────

/**
 * Rewrite `Accept-Language` on an outgoing request (Firefox).
 *
 * A `main_frame` request is judged by its own URL — it *is* the top-level
 * navigation. Any other type is judged by its tab's cached top-level URL, which
 * is what GeoSpoof's scope decision is defined against.
 */
function onBeforeSendHeaders(details: AcceptLanguageRequestDetails): BlockingResponse | undefined {
  const settings = cachedSettings;
  if (!settings) return undefined;

  const topLevelUrl =
    details.type === "main_frame" ? details.url : tabPageUrlCache.get(details.tabId);

  const value = resolveAcceptLanguageFor(settings, topLevelUrl);
  if (!value) return undefined;

  const headers = details.requestHeaders;
  if (!headers) return undefined;

  // Replace in place when present so header ORDER is preserved. Order is itself
  // a fingerprinting surface; appending instead of replacing would move
  // Accept-Language to the end of the list and stand out.
  let replaced = false;
  for (const header of headers) {
    if (header.name.toLowerCase() === "accept-language") {
      header.value = value;
      replaced = true;
      break;
    }
  }
  if (!replaced) headers.push({ name: "Accept-Language", value });

  return { requestHeaders: headers };
}

/**
 * Minimal structural type for the blocking `onBeforeSendHeaders` registration.
 * `webextension-polyfill` types the listener as non-blocking, so the blocking
 * overload is declared locally rather than casting at each use.
 */
interface BlockingWebRequest {
  onBeforeSendHeaders?: {
    addListener: (
      listener: (details: AcceptLanguageRequestDetails) => BlockingResponse | undefined,
      filter: { urls: string[] },
      extra: string[]
    ) => void;
    removeListener: (
      listener: (details: AcceptLanguageRequestDetails) => BlockingResponse | undefined
    ) => void;
  };
}

// ── Chromium / Safari: declarativeNetRequest ────────────────────────────────

/** Minimal structural type for the DNR surface we use. */
interface DnrApi {
  updateSessionRules?: (options: {
    removeRuleIds?: number[];
    addRules?: unknown[];
  }) => Promise<void>;
}

function getDnr(): DnrApi | null {
  try {
    const api = (browser as unknown as { declarativeNetRequest?: DnrApi }).declarativeNetRequest;
    if (api && typeof api.updateSessionRules === "function") return api;
  } catch {
    /* namespace absent */
  }
  return null;
}

/**
 * Collect the ids of tabs currently in scope for spoofing.
 *
 * Only needed for allowlist/denylist mode; `all` mode uses an unconditioned
 * rule instead, which avoids both the refresh race and this query.
 */
async function inScopeTabIds(settings: Settings): Promise<number[]> {
  const tabs = await browser.tabs.query({});
  const ids: number[] = [];
  for (const tab of tabs) {
    if (tab.id == null) continue;
    const enabled = computeEffectiveEnabled({
      masterEnabled: settings.enabled,
      scopeMode: settings.scopeMode,
      allowlist: settings.allowlist,
      denylist: settings.denylist,
      proFeaturesBlocked: settings.proFeaturesBlocked,
      topLevelUrl: tab.url,
      isRestricted: isRestrictedUrl,
    });
    if (enabled) ids.push(tab.id);
  }
  return ids;
}

/**
 * Rebuild the DNR rule to match the current settings, or remove it when no
 * locale applies.
 *
 * Always removes first, so "no locale" and "changed locale" share one code path
 * and a stale rule can never survive a settings change.
 */
async function refreshDnrRule(settings: Settings): Promise<void> {
  const dnr = getDnr();
  if (!dnr?.updateSessionRules) return;

  try {
    // Resolve with no URL to answer "is a locale active at all". Scope is applied
    // by the rule condition below, not here.
    const effective = computeEffectiveLocaleSpoofing(
      settings.localeSpoofing,
      settings.proFeaturesBlocked
    );
    const resolved = resolveLocale(effective, settings.timezone?.identifier ?? null);

    if (!settings.enabled || !resolved) {
      await dnr.updateSessionRules({ removeRuleIds: [RULE_ID] });
      return;
    }

    const action = {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Accept-Language", operation: "set", value: resolved.acceptLanguage },
      ],
    };

    const condition: Record<string, unknown> =
      settings.scopeMode === "all"
        ? { urlFilter: "*", resourceTypes: RESOURCE_TYPES }
        : { tabIds: await inScopeTabIds(settings), resourceTypes: RESOURCE_TYPES };

    // An empty tabIds list is not a valid condition (and would mean "no tab is
    // in scope"), so drop the rule entirely instead.
    if (settings.scopeMode !== "all" && (condition.tabIds as number[] | undefined)?.length === 0) {
      await dnr.updateSessionRules({ removeRuleIds: [RULE_ID] });
      return;
    }

    await dnr.updateSessionRules({
      removeRuleIds: [RULE_ID],
      addRules: [{ id: RULE_ID, priority: 1, action, condition }],
    });
  } catch (error) {
    // Never let header alignment break settings flow. The JS overrides still
    // apply; only the header stays unmodified.
    logger.warn(
      "[accept-language] DNR rule refresh failed (continuing with JS-only coverage):",
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Resource types the rule applies to.
 *
 * `main_frame` and `sub_frame` are what actually drive server-side language
 * negotiation; the subresource types are included so a page's own fetches stay
 * consistent with its document rather than advertising two different languages
 * from the same tab.
 */
const RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "xmlhttprequest",
  "script",
  "stylesheet",
  "image",
  "font",
  "media",
  "websocket",
  "other",
];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Refresh the synchronous settings snapshot and the DNR rule.
 *
 * Called from `broadcastSettingsToTabs`, which every settings mutation already
 * flows through, so the header stays in step with the page payload without each
 * call site having to remember this module exists.
 */
export function updateAcceptLanguageSettings(settings: Settings): void {
  cachedSettings = settings;
  if (!__FIREFOX__) {
    void refreshDnrRule(settings);
  }
}

/**
 * Install the Firefox blocking header listener. No-op on other engines, which
 * use the DNR path instead. Idempotent.
 */
export function installAcceptLanguageRewriter(): void {
  if (!__FIREFOX__) return;
  if (beforeSendHeadersListener) return;

  try {
    const wr = browser.webRequest as unknown as BlockingWebRequest;
    if (!wr.onBeforeSendHeaders) {
      logger.debug("[accept-language] onBeforeSendHeaders unavailable; skipping install");
      return;
    }
    beforeSendHeadersListener = onBeforeSendHeaders;
    wr.onBeforeSendHeaders.addListener(
      beforeSendHeadersListener,
      { urls: ["http://*/*", "https://*/*"] },
      ["blocking", "requestHeaders"]
    );
    logger.info("[accept-language] installed blocking onBeforeSendHeaders listener");
  } catch (error) {
    beforeSendHeadersListener = null;
    logger.warn(
      "[accept-language] install failed:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

/** Remove the Firefox listener. Used by tests and teardown. */
export function uninstallAcceptLanguageRewriter(): void {
  if (!beforeSendHeadersListener) return;
  try {
    const wr = browser.webRequest as unknown as BlockingWebRequest;
    wr.onBeforeSendHeaders?.removeListener(beforeSendHeadersListener);
  } catch {
    /* already gone */
  }
  beforeSendHeadersListener = null;
}

/** Test seam: reset the cached snapshot. */
export function _resetAcceptLanguageStateForTest(): void {
  cachedSettings = null;
  beforeSendHeadersListener = null;
}
