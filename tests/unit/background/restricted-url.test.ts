/**
 * Restricted pages: hosts where the browser forbids extension scripts. The
 * background and the popup each keep a copy of the list; the parity case keeps
 * them from drifting apart.
 */
import { describe, test, expect } from "vitest";
import { isRestrictedUrl as backgroundIsRestricted } from "@/background/restricted-url";
import { isRestrictedUrl as popupIsRestricted } from "@/popup/settings";

const RESTRICTED: string[] = [
  // Added: the current Chrome Web Store host and Mozilla support.
  "https://chromewebstore.google.com/detail/x/abc",
  "https://chromewebstore.google.com/",
  "https://support.mozilla.org/kb/x",
  "https://en-US.support.mozilla.org/kb/x",
  // Existing hosts stay restricted.
  "https://addons.mozilla.org/en-US/firefox/",
  "https://discovery.addons.mozilla.org/",
  "https://accounts.firefox.com/",
  "https://testpilot.firefox.com/",
  "https://chrome.google.com/webstore/detail/x",
  // Prefixes and unparseable URLs.
  "about:blank",
  "chrome://settings",
  "file:///tmp/x.html",
  "not a url",
  "",
];

const NOT_RESTRICTED: string[] = [
  "https://notchromewebstore.google.com/",
  "https://chromewebstore.google.com.evil.test/",
  "https://support.mozilla.org.example/",
  "https://mozilla.org/",
  "https://www.google.com/",
  "https://example.com/",
];

describe("isRestrictedUrl", () => {
  test.each(RESTRICTED)("background: %s is restricted", (url) => {
    expect(backgroundIsRestricted(url)).toBe(true);
  });

  test.each(NOT_RESTRICTED)("background: %s is not restricted", (url) => {
    expect(backgroundIsRestricted(url)).toBe(false);
  });

  test("the popup and the background agree on every case", () => {
    for (const url of [...RESTRICTED, ...NOT_RESTRICTED]) {
      expect({ url, restricted: popupIsRestricted(url) }).toEqual({
        url,
        restricted: backgroundIsRestricted(url),
      });
    }
  });

  test("the popup treats a missing URL as restricted", () => {
    expect(popupIsRestricted(undefined)).toBe(true);
  });
});
