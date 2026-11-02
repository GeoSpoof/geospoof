/**
 * Which top-level URL a content script's request is judged against.
 *
 * Page-bound decisions (Filters, the per-site location, the Reported Language)
 * follow the tab's top-level page. For a subframe that's `sender.tab.url`. A
 * top-level document is judged by its own URL, `sender.url`, because the tab
 * can be showing a different page:
 *
 * - Chrome prerenders a page (speculation rules, the omnibox) inside the tab
 *   the user is still looking at, so `tab.url` is the page being left. A
 *   prerendered outermost frame has a non-zero `frameId`, so the sender alone
 *   can't tell it from a prerendered subframe. The content script reports
 *   whether `window.top === window`, and that claim counts only while
 *   `documentLifecycle` is `"prerender"`. A fenced frame is also its own top,
 *   but it's `"active"`, so it keeps following the tab.
 * - The active top frame (`frameId === 0`) is the tab's page. When its own URL
 *   and `tab.url` name different origins, `tab.url` belongs to another
 *   document. When they share an origin, `tab.url` wins: Firefox fixes
 *   `sender.url` when the content script starts, so after a History API
 *   navigation (which can't leave the origin) only `tab.url` is current.
 *
 * Pure and engine-agnostic: it feature-detects rather than reading build
 * flags. `documentLifecycle` is Chromium-only (106+); `url` and `frameId` exist
 * on every engine we ship (MDN: Chrome 28/41, Firefox 45, Safari 14). A missing
 * or empty `sender.url` falls back to `tab.url`.
 */

/** The parts of `runtime.MessageSender` this reads. `documentLifecycle` is Chromium 106+ only. */
export interface PageSender {
  url?: string;
  frameId?: number;
  documentLifecycle?: string;
  tab?: { url?: string };
}

/** Same origin, with opaque origins (`about:blank`, `data:`) never equal. */
function sameOrigin(a: string, b: string): boolean {
  try {
    const origin = new URL(a).origin;
    return origin !== "null" && origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * The top-level page URL for a content script's request.
 *
 * @param claimsTopFrame The content script's own `window.top === window`.
 *   Honored only for a prerendering document.
 */
export function topLevelUrlForSender(
  sender: PageSender,
  claimsTopFrame: boolean
): string | undefined {
  const tabUrl = sender.tab?.url;
  const ownUrl = typeof sender.url === "string" && sender.url.length > 0 ? sender.url : undefined;
  if (ownUrl === undefined) return tabUrl;

  if (sender.frameId === 0) {
    return tabUrl !== undefined && sameOrigin(ownUrl, tabUrl) ? tabUrl : ownUrl;
  }
  if (claimsTopFrame && sender.documentLifecycle === "prerender") {
    return ownUrl;
  }
  return tabUrl;
}
