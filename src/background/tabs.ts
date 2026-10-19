/**
 * Tab Management
 * Broadcasting settings to tabs, content script injection, and URL checks.
 */

import type { Settings } from "@/shared/types/settings";
import type { InjectionStatus } from "@/shared/types/messages";
import { createLogger } from "@/shared/utils/debug-logger";
import { updateWorkerFilterSettings } from "./worker-request-filter";
import { updateAcceptLanguageSettings } from "./accept-language";
import { buildPagePayload } from "./page-payload";

export { isRestrictedUrl } from "./restricted-url";

const logger = createLogger("BG");

/**
 * Build and deliver the per-tab `UPDATE_SETTINGS` payload for a single tab.
 *
 * The payload comes from {@link buildPagePayload}, the one builder every
 * page-bound path shares; its `enabled` field is the tab's `Effective_Enabled`
 * value for its top-level URL (Req 8.1, 8.2). One value per tab is sent;
 * `tabs.sendMessage` fans it out to every frame (Req 7.2).
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

  const payload = await buildPagePayload(settings, tab.url);

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
