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
 *   - `scopeMode: "all"` (the default), with no site location able to change
 *     the locale → one global rule. Exact, and no cold-start race because the
 *     rule is already in place for a tab's first request.
 *   - `scopeMode: "all"` in Match mode with site locations (Chromium) → the
 *     same global rule at priority 1, layered under priority-2 per-tab SESSION
 *     rules for the tabs whose site location changes the value. New tabs and
 *     unmatched sites keep the race-free global rule.
 *   - `scopeMode: "all"` on Safari → always the one global rule, from the main
 *     zone, site locations or not. Safari's compat data lists no `tabIds`
 *     condition and its handling of overlapping priorities is unconfirmed, so
 *     it keeps the rule known to work there. The header on a site-location
 *     site then names the main location's language.
 *   - `allowlist` / `denylist` → per-tab SESSION rules only: open tabs grouped
 *     by their own resolved value, one rule per value with that group's
 *     `tabIds`.
 *
 * Per-tab rules (`planAcceptLanguageRules`) are rebuilt on settings changes and
 * on every top-level navigation (`refreshAcceptLanguageOnNavigation`),
 * serialized through one queue. The header then rides on the same per-tab
 * decision the payload builders use, rather than a second approximation of it.
 *
 * Known, accepted limits of per-tab rules (neither applies to the global rule):
 * a tab's first document request can race the refresh, and requests with no
 * tab (`tabId === -1`, e.g. a service-worker fetch) are unmatched. In the
 * layered variant that race is limited to a navigation into or out of a
 * site-location site.
 */

import type { Settings } from "@/shared/types/settings";
import { MAX_SITE_LOCATIONS } from "@/shared/types/settings";
import { resolveLocale, computeEffectiveLocaleSpoofing } from "@/shared/locale/resolver";
import { computeEffectiveSiteLocations } from "@/shared/utils/scope";
import { resolveSiteSettings } from "@/shared/utils/site-locations";
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
  // The same per-site resolution the page payload uses: Filters decide whether,
  // a site location decides which zone (and so, in Match mode, which locale).
  const r = resolveSiteSettings(settings, topLevelUrl, isRestrictedUrl);
  if (!r.enabled) return null;

  const effective = computeEffectiveLocaleSpoofing(
    settings.localeSpoofing,
    settings.proFeaturesBlocked
  );
  const resolved = resolveLocale(effective, r.settings.timezone?.identifier ?? null);
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
 * Every session-rule id this module may own: `RULE_ID` for the global rule or
 * the first per-tab group, then one more per possible distinct value. A
 * value comes from the main zone or one site location's, so there are at most
 * `MAX_SITE_LOCATIONS + 1` groups. Each refresh removes all of them.
 */
export const ACCEPT_LANGUAGE_RULE_IDS: readonly number[] = Array.from(
  { length: MAX_SITE_LOCATIONS + 1 },
  (_, i) => RULE_ID + i
);

/** One planned header rule, before the DNR action and resource types are attached. */
export interface AcceptLanguageRulePlan {
  id: number;
  /**
   * DNR priority. Chromium applies the highest-priority `set` on a header and
   * ignores lower ones, so a priority-2 per-tab rule overrides the priority-1
   * global rule for the tabs it names.
   */
  priority: 1 | 2;
  value: string;
  condition: { urlFilter: "*"; excludedTabIds?: number[] } | { tabIds: number[] };
}

/** Engine capabilities the planner depends on. */
export interface AcceptLanguagePlanOptions {
  /**
   * Whether priority-2 per-tab rules may be layered over the global rule in
   * "all" mode. False on Safari, which then keeps the single global rule.
   */
  layered: boolean;
}

/** This build's engine: Chromium layers, Safari doesn't. Tests pass their own. */
const ENGINE_PLAN_OPTIONS: AcceptLanguagePlanOptions = { layered: !__SAFARI__ };

/**
 * Whether the header needs per-tab rules rather than one global rule: Filters
 * narrow scope, or (where rules can be layered) the locale follows the zone
 * (Match mode) and some site location can change that zone for one tab.
 */
export function usesPerTabRules(
  settings: Settings,
  options: AcceptLanguagePlanOptions = ENGINE_PLAN_OPTIONS
): boolean {
  if (settings.scopeMode !== "all") return true;
  if (!options.layered) return false;
  const effective = computeEffectiveLocaleSpoofing(
    settings.localeSpoofing,
    settings.proFeaturesBlocked
  );
  return (
    effective.mode === "match" &&
    computeEffectiveSiteLocations(settings.siteLocations, settings.proFeaturesBlocked).length > 0
  );
}

/**
 * Plan the DNR rules for `settings` and the open `tabs`. Pure.
 *
 *   - Master off → no rules.
 *   - Global variant (`usesPerTabRules` false, which includes every "all"-mode
 *     plan when `options.layered` is false, i.e. Safari) → one unconditioned
 *     rule from the main zone, or none when no locale applies. Exact, with no
 *     first-request race.
 *   - Layered variant (`scopeMode: "all"` with site locations in Match mode,
 *     Chromium) → the same global rule at priority 1, plus priority-2 `tabIds`
 *     rules (ids `RULE_ID + 1 + i`) only for groups whose value differs from
 *     it. New tabs and unmatched sites are covered by the global rule from
 *     their first request. An in-scope tab whose site location yields no
 *     locale is excluded from the global rule, so it keeps the real header
 *     that matches its real `navigator.languages`.
 *   - Per-tab variant (allowlist/denylist) → tabs grouped by their own
 *     `resolveAcceptLanguageFor` value (null values dropped), groups sorted by
 *     value, ids `RULE_ID + i`.
 */
export function planAcceptLanguageRules(
  settings: Settings,
  tabs: readonly { id?: number; url?: string }[],
  options: AcceptLanguagePlanOptions = ENGINE_PLAN_OPTIONS
): AcceptLanguageRulePlan[] {
  if (!settings.enabled) return [];

  const effective = computeEffectiveLocaleSpoofing(
    settings.localeSpoofing,
    settings.proFeaturesBlocked
  );
  const globalValue =
    resolveLocale(effective, settings.timezone?.identifier ?? null)?.acceptLanguage ?? null;

  if (!usesPerTabRules(settings, options)) {
    if (globalValue === null) return [];
    return [{ id: RULE_ID, priority: 1, value: globalValue, condition: { urlFilter: "*" } }];
  }

  // Reaching here in "all" mode implies `options.layered`.
  const layered = settings.scopeMode === "all";

  const groups = new Map<string, number[]>();
  const noLocaleTabIds: number[] = [];
  for (const tab of tabs) {
    if (tab.id == null) continue;
    const value = resolveAcceptLanguageFor(settings, tab.url);
    if (value === null) {
      // Only an in-scope tab is excluded: a restricted tab (a new tab's blank
      // page) stays under the global rule so its first navigation is covered.
      if (layered && resolveSiteSettings(settings, tab.url, isRestrictedUrl).enabled) {
        noLocaleTabIds.push(tab.id);
      }
      continue;
    }
    if (layered && value === globalValue) continue;
    const ids = groups.get(value);
    if (ids) ids.push(tab.id);
    else groups.set(value, [tab.id]);
  }

  const perTab = (offset: number, priority: 1 | 2): AcceptLanguageRulePlan[] =>
    [...groups.keys()]
      .sort()
      .slice(0, ACCEPT_LANGUAGE_RULE_IDS.length - offset)
      .map((value, i) => ({
        id: RULE_ID + offset + i,
        priority,
        value,
        condition: { tabIds: groups.get(value)!.sort((a, b) => a - b) },
      }));

  if (!layered) return perTab(0, 1);

  const rules: AcceptLanguageRulePlan[] = [];
  if (globalValue !== null) {
    rules.push({
      id: RULE_ID,
      priority: 1,
      value: globalValue,
      condition:
        noLocaleTabIds.length > 0
          ? { urlFilter: "*", excludedTabIds: noLocaleTabIds.sort((a, b) => a - b) }
          : { urlFilter: "*" },
    });
  }
  return [...rules, ...perTab(1, 2)];
}

/**
 * Rebuild the DNR rules to match the current settings and tabs.
 *
 * One `updateSessionRules` call removes every id this module owns and adds the
 * new plan, so "no locale", "changed locale", and "fewer groups" share one code
 * path and a stale rule can never survive.
 */
async function refreshDnrRule(settings: Settings): Promise<void> {
  const dnr = getDnr();
  if (!dnr?.updateSessionRules) return;

  try {
    // Only the per-tab variant needs to know which tabs are open.
    const tabs = settings.enabled && usesPerTabRules(settings) ? await browser.tabs.query({}) : [];
    const addRules = planAcceptLanguageRules(settings, tabs).map((rule) => ({
      id: rule.id,
      priority: rule.priority,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "Accept-Language", operation: "set", value: rule.value }],
      },
      condition: { ...rule.condition, resourceTypes: RESOURCE_TYPES },
    }));

    await dnr.updateSessionRules({ removeRuleIds: [...ACCEPT_LANGUAGE_RULE_IDS], addRules });
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
 * Serialize and coalesce DNR refreshes. Navigations and settings changes can
 * fire in bursts; overlapping remove-then-add calls could interleave and leave
 * an older plan in place. One promise chain runs refreshes in order, and any
 * number of requests made while one is waiting collapse into a single run with
 * the latest settings.
 */
let dnrChain: Promise<void> = Promise.resolve();
let dnrPendingSettings: Settings | null = null;

function queueDnrRefresh(settings: Settings): void {
  const alreadyQueued = dnrPendingSettings !== null;
  dnrPendingSettings = settings;
  if (alreadyQueued) return;
  dnrChain = dnrChain.then(async () => {
    const latest = dnrPendingSettings;
    dnrPendingSettings = null;
    if (latest) await refreshDnrRule(latest);
  });
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
    queueDnrRefresh(settings);
  }
}

/**
 * Keep the header in step with a tab that just navigated. The per-tab DNR
 * variant keys rules on tab ids, so a tab that moves to another site needs its
 * group recomputed; the global variant (and Firefox, which resolves per
 * request) needs only the snapshot. Called from both `tabs.onUpdated` branches
 * in `index.ts` (same-document URL change and `status === "loading"`).
 */
export function refreshAcceptLanguageOnNavigation(settings: Settings): void {
  cachedSettings = settings;
  if (!__FIREFOX__ && usesPerTabRules(settings)) {
    queueDnrRefresh(settings);
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
  dnrPendingSettings = null;
  dnrChain = Promise.resolve();
  beforeSendHeadersListener = null;
}
