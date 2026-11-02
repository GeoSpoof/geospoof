/**
 * Which top-level URL a content script's GET_SETTINGS is judged against
 * (`topLevelUrlForSender`). A top-level document is judged by its own URL, a
 * subframe by its tab's. Covers each engine's sender shape: Chromium adds
 * `documentLifecycle`; Firefox and Safari don't.
 */
import { describe, test, expect } from "vitest";
import { topLevelUrlForSender, type PageSender } from "@/background/sender-page-url";

const A = "https://a.test/";
const B = "https://b.test/";

const cases: Array<
  [label: string, sender: PageSender, claimsTopFrame: boolean, expected: string | undefined]
> = [
  ["(a) active top frame resolves its own URL", { frameId: 0, url: B, tab: { url: A } }, true, B],
  [
    "(b) prerendered page on site B while tab.url is site A resolves B",
    { frameId: 7, documentLifecycle: "prerender", url: B, tab: { url: A } },
    true,
    B,
  ],
  [
    "(c) prerendered subframe follows the tab",
    { frameId: 7, documentLifecycle: "prerender", url: B, tab: { url: A } },
    false,
    A,
  ],
  [
    "(d) active subframe follows the tab",
    { frameId: 3, documentLifecycle: "active", url: B, tab: { url: A } },
    false,
    A,
  ],
  [
    "(e) active non-zero frame claiming top (fenced-frame shape) follows the tab",
    { frameId: 9, documentLifecycle: "active", url: B, tab: { url: A } },
    true,
    A,
  ],
  ["(f) top frame with no url falls back to the tab", { frameId: 0, tab: { url: A } }, true, A],
  [
    "(f) top frame with an empty url falls back to the tab",
    { frameId: 0, url: "", tab: { url: A } },
    true,
    A,
  ],
  [
    "(g) Firefox/Safari shape (no documentLifecycle), top frame resolves its own URL",
    { frameId: 0, url: B, tab: { url: "about:blank" } },
    true,
    B,
  ],
  [
    "(g) Firefox/Safari shape: a non-zero frame's claim is ignored without a prerender lifecycle",
    { frameId: 4, url: B, tab: { url: A } },
    true,
    A,
  ],
  ["(h) undefined frameId follows the tab", { url: B, tab: { url: A } }, true, A],
  ["(i) no tab and no claim resolves nothing", { url: B }, false, undefined],
  [
    "(j) active top frame after a History API navigation keeps the tab's same-origin URL",
    { frameId: 0, url: "https://a.test/start", tab: { url: "https://a.test/after-push" } },
    true,
    "https://a.test/after-push",
  ],
  [
    "(k) active top frame whose tab has no URL resolves its own URL",
    { frameId: 0, url: B, tab: {} },
    true,
    B,
  ],
];

describe("topLevelUrlForSender", () => {
  test.each(cases)("%s", (_label, sender, claimsTopFrame, expected) => {
    expect(topLevelUrlForSender(sender, claimsTopFrame)).toBe(expected);
  });

  test("a real MessageSender is accepted as a PageSender", () => {
    const sender: browser.runtime.MessageSender = {
      frameId: 0,
      url: B,
      tab: { url: A } as browser.tabs.Tab,
    };
    expect(topLevelUrlForSender(sender, true)).toBe(B);
  });
});
