/**
 * Tab Management
 * Broadcasting settings to tabs, content script injection, and URL checks.
 */

import type { Settings } from "@/shared/types/settings";
import type { UpdateSettingsPayload, InjectionStatus } from "@/shared/types/messages";
import { createLogger } from "@/shared/utils/debug-logger";
import { computeEffectiveEnabled, computeEffectivePreserveGeoPrompt } from "@/shared/utils/scope";
import { computeEffectiveAccuracySetting } from "@/shared/accuracy/resolver";
import { resolvePageLocale } from "@/shared/locale/resolver";
import { updateWorkerFilterSettings } from "./worker-request-filter";
import { updateAcceptLanguageSettings } from "./accept-language";
import { resolveCurrentPageLocation } from "./precision-cadence";

const logger = createLogger("BG");

/**
 * Build and deliver the per-tab `UPDATE_SETTINGS` payload for a single tab.
 *
 * The background is the sole gatekeeper for the per-tab spoofing decision: the
 * `enabled` field is that tab's `Effective_Enabled` value, computed from its
 * top-level URL via the shared `computeEffectiveEnabled` source of truth (Req
 * 8.1, 8.2). The non-scope fields are equal to the persisted Settings (Req
 * 8.3). The allowlist/denylist arrays are never included — `UpdateSettingsPayload`
 * has no list keys, so the lists cannot leak (privacy invariant). One value per
 * tab is sent; `tabs.sendMessage` fans it out to every frame (Req 7.2).
 *
 * Shared by `broadcastSettingsToTabs` (settings/list/mode changes) and the
 * navigation re-evaluation path in `index.ts` (full and same-document/SPA
 * navigations), so both build an identical payload (Req 9.1, 9.2). Returns
 * `true` when the message was delivered, `false` on a send failure (e.g. no
 * content script in the tab yet) or a missing tab id.
 */
export async function sendSettingsToTab(
  tab: { id?: number; url?: string },
  settings: Settings
): Promise<boolean> {
  if (tab.id == null) {
    return false;
  }

  // Resolve Effective_Enabled for this tab against its top-level URL (Req 8.1,
  // 8.2). Restricted or undeterminable URLs resolve to false (Req 8.6).
  const enabled = computeEffectiveEnabled({
    masterEnabled: settings.enabled,
    scopeMode: settings.scopeMode,
    allowlist: settings.allowlist,
    denylist: settings.denylist,
    proFeaturesBlocked: settings.proFeaturesBlocked,
    topLevelUrl: tab.url,
    isRestricted: isRestrictedUrl,
  });

  // When browser-level (chrome.debugger) spoofing is active on Chromium, CDP
  // owns the TIMEZONE (it covers every frame/worker before first script).
  // Withhold the timezone from the injected path so its Date/Intl overrides
  // no-op (they gate on having timezone data) — but keep `enabled` and
  // `location` so the injected GEOLOCATION override still runs (CDP can't make
  // geolocation reliably prompt-free). WebRTC is independent. Compiled out on
  // Firefox/Safari.
  const debuggerActive = __CHROMIUM__ && settings.debuggerModeEnabled;

  const payload: UpdateSettingsPayload = {
    enabled,
    // Approximate-location precision, when enabled, offsets the reported point
    // within its radius; `exact` (the default) returns the anchor unchanged.
    // The anchor in storage is never mutated. On iOS Safari a non-Pro user is
    // gated back to exact (fail-open elsewhere). `resolveCurrentPageLocation`
    // is the shared resolver every page-bound builder uses, so all of them
    // agree on the point for the current cadence period.
    location: await resolveCurrentPageLocation(settings),
    timezone: debuggerActive ? null : settings.timezone,
    debugLogging: settings.debugLogging,
    verbosityLevel: settings.verbosityLevel,
    webrtcProtection: settings.webrtcProtection,
    preserveGeolocationPrompt: computeEffectivePreserveGeoPrompt(
      settings.preserveGeolocationPrompt,
      settings.proFeaturesBlocked
    ),
    // Custom accuracy is Pro-gated on iOS Safari: force Realistic ("auto") for a
    // free user so the page can't receive a pinned accuracy. Fail-open +
    // Safari-only (no effect on macOS / Chrome / Firefox).
    accuracySetting: computeEffectiveAccuracySetting(
      settings.accuracySetting,
      settings.proFeaturesBlocked
    ),
    accuracySeed: settings.accuracySeed,
    // Reported Language, resolved here so the page world receives only the
    // outcome — never the mode or the zone/country mapping data. Pro-gated back
    // to "off" for a non-entitled Safari user. `null` means "leave the real
    // locale alone", which is also the default. Shares one entry point with the
    // GET_SETTINGS branch so both builders always agree (Req 12.4).
    locale: resolvePageLocale(
      settings.localeSpoofing,
      settings.timezone?.identifier ?? null,
      settings.proFeaturesBlocked
    ),
  };

  try {
    await browser.tabs.sendMessage(tab.id, { type: "UPDATE_SETTINGS", payload });
    return true;
  } catch (error) {
    // "Receiving end does not exist" is an EXPECTED outcome, not a fault: the
    // tab may have no content script yet (mid-navigation), be a restricted page
    // we can't inject into, or have closed between the query and the send. It is
    // logged at TRACE — the highest, explicitly-opt-in verbosity — because the
    // volume is O(tabs) and a caller broadcasting to a large window would
    // otherwise emit a log line per tab on every settings change. The bounded
    // per-broadcast summary in `broadcastSettingsToTabs` is the default-visible
    // signal; this line is for narrowing down a single misbehaving tab.
    //
    // Do NOT reintroduce a `console.*` call here. A bare console call bypasses
    // the debug-logging toggle entirely, so it prints for every user, and it was
    // the visible half of the log storm in issue #75.
    const message = error instanceof Error ? error.message : String(error);
    logger.trace(`No receiver in tab ${tab.id} (${tab.url}):`, message);
    return false;
  }
}

/**
 * Broadcast settings to all open tabs via content scripts, computing each tab's
 * per-tab decision through {@link sendSettingsToTab}.
 */
export async function broadcastSettingsToTabs(settings: Settings): Promise<void> {
  // Refresh the webRequest listener's cached settings snapshot. The
  // listener reads this synchronously on every request (Firefox doesn't
  // allow async listeners when using blocking / filterResponseData), so
  // keeping it fresh here covers every settings-change code path —
  // every mutation flows through broadcastSettingsToTabs.
  updateWorkerFilterSettings(settings);

  // Keep the Accept-Language header in step with the page payload. Piggybacking
  // on this function (rather than each settings handler remembering) is what
  // guarantees the header and the JS-reported locale never drift apart, since
  // every settings mutation already funnels through here.
  updateAcceptLanguageSettings(settings);

  const allTabs = await browser.tabs.query({});

  // Skip discarded (unloaded) tabs. Firefox restores a session — and populates
  // tab groups — with tabs that have no document and no content script until the
  // user actually selects them; `tabs.query({})` still returns every one of
  // them. Messaging a discarded tab therefore CANNOT succeed, and at ~100
  // background tabs those guaranteed failures were the trigger for the message
  // storm in issue #75.
  //
  // Nothing is lost by skipping them: the content script is registered
  // statically at `document_start` for `<all_urls>` and requests its own
  // settings via `GET_SETTINGS` on load, so a tab that is later restored is
  // configured by its own fetch, not by this broadcast.
  //
  // The filter is deliberately limited to `discarded` and does NOT extend to the
  // tab's URL. Every *loaded* tab must still receive a payload even when it is
  // restricted or its URL is undeterminable, because `enabled` is then resolved
  // to false and that message is what turns spoofing OFF in a tab that just went
  // out of scope. Filtering on URL would convert this noise bug into a silent
  // leak. See Req 8.1 and tests/property/per-tab-broadcast.property.test.ts.
  //
  // `discarded` is optional in the WebExtension tab model; where an engine does
  // not report it the value is undefined, which is falsy, so the tab is sent to
  // exactly as before. The filter fails open.
  const tabs = allTabs.filter((tab) => !tab.discarded);
  const skipped = allTabs.length - tabs.length;

  logger.info("Broadcasting settings to tabs:", {
    tabCount: tabs.length,
    skippedDiscarded: skipped,
  });

  const results = await Promise.all(tabs.map((tab) => sendSettingsToTab(tab, settings)));
  const failCount = results.filter((delivered) => !delivered).length;
  if (failCount > 0) {
    // One bounded summary per broadcast, never one line per tab.
    logger.debug("Broadcast complete:", {
      sent: results.length - failCount,
      failed: failCount,
      skippedDiscarded: skipped,
    });
  }
}

/**
 * Inject the content script into existing tabs that don't already have it.
 *
 * Only needed for tabs that finished loading BEFORE the extension was installed
 * or re-enabled — every tab loaded afterwards gets the script from the static
 * `document_start` manifest registration.
 *
 * Discarded (unloaded) tabs are skipped. They have no document to inject into,
 * and injecting is not merely useless there: on an engine that resolves the
 * target by waking the tab, a user enabling protection with a large restored
 * session could force a load of every one of those tabs at once. Skipping them
 * removes that risk, and costs nothing — a discarded tab runs the manifest
 * content script whenever it is eventually restored.
 *
 * Unlike `broadcastSettingsToTabs`, filtering by URL is correct here: this only
 * injects, and there is no "turn spoofing off" message whose delivery matters.
 * A non-http(s) page cannot host our content script at all.
 */
export async function injectContentScriptIntoExistingTabs(): Promise<void> {
  try {
    const allTabs = await browser.tabs.query({});

    const targets = allTabs.filter(
      (tab): tab is typeof tab & { id: number } =>
        tab.id != null &&
        !tab.discarded &&
        !!tab.url &&
        (tab.url.startsWith("http://") || tab.url.startsWith("https://"))
    );

    logger.info("Injecting content scripts into existing tabs:", {
      tabCount: targets.length,
      considered: allTabs.length,
    });

    // Per-tab work is independent, so run it concurrently. The previous
    // sequential `await` meant one full messaging round-trip per tab before the
    // next began, which at ~100 tabs left this pending for seconds.
    const outcomes = await Promise.all(
      targets.map(async (tab): Promise<"present" | "injected" | "failed"> => {
        try {
          const response: unknown = await browser.tabs.sendMessage(tab.id, { type: "PING" });
          if (response && (response as { pong?: boolean }).pong) {
            return "present";
          }
        } catch {
          // No content script yet — fall through and inject.
        }

        try {
          await browser.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content/content.js"],
          });
          return "injected";
        } catch (error) {
          // Expected for pages the engine forbids scripting (reader view,
          // view-source, PDF viewer, AMO) and for tabs closed mid-pass. Logged
          // at TRACE so the volume stays opt-in; see the note in
          // `sendSettingsToTab`.
          logger.trace(
            `Could not inject into tab ${tab.id}:`,
            error instanceof Error ? error.message : String(error)
          );
          return "failed";
        }
      })
    );

    // One bounded summary, never one line per tab.
    logger.debug("Content script injection pass complete:", {
      alreadyPresent: outcomes.filter((o) => o === "present").length,
      injected: outcomes.filter((o) => o === "injected").length,
      failed: outcomes.filter((o) => o === "failed").length,
      skipped: allTabs.length - targets.length,
    });
  } catch (error) {
    logger.error("Failed to inject content scripts:", error);
  }
}

/**
 * Check if content script is injected in a specific tab.
 */
export async function checkTabInjection(tabId: number): Promise<InjectionStatus> {
  try {
    await browser.tabs.sendMessage(tabId, { type: "PING" });
    return { injected: true, error: null };
  } catch (error) {
    logger.error(`Content script not responding in tab ${tabId}:`, error);
    return { injected: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Check if a URL is a restricted page where extensions cannot run.
 */
export function isRestrictedUrl(url: string): boolean {
  if (!url) return true;

  const restrictedPrefixes = [
    "about:",
    "moz-extension:",
    "chrome:",
    "chrome-extension:",
    "edge:",
    "resource:",
    "view-source:",
    "data:",
    "blob:",
    "file:",
  ];

  const restrictedDomains = [
    "addons.mozilla.org",
    "accounts.firefox.com",
    "testpilot.firefox.com",
    "chrome.google.com",
  ];

  for (const prefix of restrictedPrefixes) {
    if (url.startsWith(prefix)) {
      return true;
    }
  }

  try {
    const urlObj = new URL(url);
    for (const domain of restrictedDomains) {
      if (urlObj.hostname === domain || urlObj.hostname.endsWith("." + domain)) {
        return true;
      }
    }
  } catch {
    return true;
  }

  return false;
}
