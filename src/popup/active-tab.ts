/**
 * The active tab, as the popup sees it. `loadSettings` reads it once per
 * render and hands it to the Filters and Per-site locations renderers.
 */

/** The active tab's top-level URL, or undefined when it can't be read. */
export async function readActiveTabUrl(): Promise<string | undefined> {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.url;
  } catch (error: unknown) {
    console.error("Failed to read the current tab:", error);
    return undefined;
  }
}

/**
 * Whether `url` is one of this extension's own pages. The Chromium options
 * tab opens `popup/popup.html`, so the "active tab" is then the popup itself.
 */
export function isOwnExtensionPage(url: string): boolean {
  let base: string;
  try {
    base = browser.runtime.getURL("");
  } catch {
    return false;
  }
  return base.length > 0 && url.startsWith(base);
}
