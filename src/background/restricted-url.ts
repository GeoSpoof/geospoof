/**
 * Restricted-URL check for the background.
 *
 * Lives in its own module so both `tabs.ts` and `page-payload.ts` can import it
 * without a cycle. `tabs.ts` re-exports `isRestrictedUrl`, so existing
 * importers (and the `@/background` re-export) are unchanged.
 */

/** URL prefixes of pages where extensions cannot run. */
export const RESTRICTED_URL_PREFIXES = [
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

/** Hosts (and their subdomains) where the browser forbids extension scripts. */
export const RESTRICTED_DOMAINS = [
  "addons.mozilla.org",
  "accounts.firefox.com",
  "testpilot.firefox.com",
  "chrome.google.com",
];

/**
 * Check if a URL is a restricted page where extensions cannot run.
 */
export function isRestrictedUrl(url: string): boolean {
  if (!url) return true;

  for (const prefix of RESTRICTED_URL_PREFIXES) {
    if (url.startsWith(prefix)) {
      return true;
    }
  }

  try {
    const urlObj = new URL(url);
    for (const domain of RESTRICTED_DOMAINS) {
      if (urlObj.hostname === domain || urlObj.hostname.endsWith("." + domain)) {
        return true;
      }
    }
  } catch {
    return true;
  }

  return false;
}
