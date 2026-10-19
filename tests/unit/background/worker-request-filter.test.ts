/**
 * Tests for cross-origin worker classification — `worker-request-filter.ts`
 *
 * Covers the same-origin gate in `classifyRequest`: cross-origin workers
 * (e.g. Cloudflare Turnstile, Stripe) must be classified as "pass" and left
 * unmodified. Same-origin workers must still be classified as "patch".
 */

import {
  allowlistWorkerUrl,
  _classifyRequestForTest,
  getRegistrableDomain,
  isSameOriginWorker,
  tabPageUrlCache,
  updateWorkerFilterSettings,
  hasWorkerTimezoneSource,
  workerPayloadFor,
} from "@/background/worker-request-filter";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import { ENTRY_DUBLIN, TOKYO, TOKYO_TZ } from "../../helpers/site-locations";

/** In-scope settings snapshot so the scope gate passes through to the same-origin gate. */
const IN_SCOPE_SETTINGS = { ...DEFAULT_SETTINGS, enabled: true, scopeMode: "all" as const };

/** Helper to build a minimal WebRequestDetailsWithHeaders object. */
function makeDetails(opts: {
  url: string;
  tabId?: number;
  secFetchDest?: string;
}): Parameters<typeof _classifyRequestForTest>[0] {
  return {
    requestId: "test-req-1",
    url: opts.url,
    type: "script",
    method: "GET",
    tabId: opts.tabId ?? 42,
    frameId: 0,
    requestHeaders: opts.secFetchDest ? [{ name: "Sec-Fetch-Dest", value: opts.secFetchDest }] : [],
  };
}

describe("classifyRequest — cross-origin workers are classified as pass", () => {
  beforeEach(() => {
    tabPageUrlCache.clear();
  });

  test("Turnstile worker (cross-origin, Sec-Fetch-Dest: worker) is pass", () => {
    const details = makeDetails({
      url: "https://challenges.cloudflare.com/turnstile/v0/worker.js",
      tabId: 42,
      secFetchDest: "worker",
    });
    expect(_classifyRequestForTest(details)).toBe("pass");
  });

  test("Stripe worker (cross-origin, Sec-Fetch-Dest: serviceworker) is pass", () => {
    const details = makeDetails({
      url: "https://js.stripe.com/v3/worker.js",
      tabId: 42,
      secFetchDest: "serviceworker",
    });
    expect(_classifyRequestForTest(details)).toBe("pass");
  });

  test("cross-origin allowlisted URL (no Sec-Fetch-Dest) is pass", () => {
    const workerUrl = "https://cdn.third-party.com/worker.js";
    allowlistWorkerUrl(workerUrl);
    const details = makeDetails({ url: workerUrl, tabId: 42 });
    expect(_classifyRequestForTest(details)).toBe("pass");
  });

  test("unknown tab (tabId not in cache) is pass", () => {
    const details = makeDetails({
      url: "https://example.com/worker.js",
      tabId: 999,
      secFetchDest: "worker",
    });
    expect(_classifyRequestForTest(details)).toBe("pass");
  });
});

// ── getRegistrableDomain unit tests ──────────────────────────────────

describe("getRegistrableDomain", () => {
  test("standard domain returns last two labels", () => {
    expect(getRegistrableDomain("https://example.com/path")).toBe("example.com");
  });

  test("subdomain returns registrable domain", () => {
    expect(getRegistrableDomain("https://api.example.com/")).toBe("example.com");
  });

  test("deep subdomain returns registrable domain", () => {
    expect(getRegistrableDomain("https://a.b.c.example.com/")).toBe("example.com");
  });

  test("two-part eTLD co.uk returns three-label domain", () => {
    expect(getRegistrableDomain("https://www.example.co.uk/")).toBe("example.co.uk");
  });

  test("two-part eTLD com.au returns three-label domain", () => {
    expect(getRegistrableDomain("https://shop.example.com.au/")).toBe("example.com.au");
  });

  test("bare IPv4 address returns null", () => {
    expect(getRegistrableDomain("https://192.168.1.1/")).toBeNull();
  });

  test("IPv6 bracket notation returns null", () => {
    expect(getRegistrableDomain("https://[::1]/")).toBeNull();
  });

  test("localhost (single label) returns null", () => {
    expect(getRegistrableDomain("http://localhost/")).toBeNull();
  });

  test("non-HTTP URL returns null", () => {
    expect(getRegistrableDomain("blob:https://example.com/abc")).toBeNull();
  });

  test("malformed URL returns null", () => {
    expect(getRegistrableDomain("not-a-url")).toBeNull();
  });

  test("same hostname on two URLs returns same domain", () => {
    const a = getRegistrableDomain("https://app.example.com/foo");
    const b = getRegistrableDomain("https://app.example.com/bar");
    expect(a).toBe(b);
  });
});

// ── isSameOriginWorker unit tests ─────────────────────────────────────

describe("isSameOriginWorker", () => {
  test("same registrable domain returns true", () => {
    expect(
      isSameOriginWorker("https://api.example.com/worker.js", "https://app.example.com/")
    ).toBe(true);
  });

  test("exact same domain returns true", () => {
    expect(isSameOriginWorker("https://example.com/sw.js", "https://example.com/")).toBe(true);
  });

  test("different registrable domain returns false", () => {
    expect(
      isSameOriginWorker("https://challenges.cloudflare.com/worker.js", "https://example.com/")
    ).toBe(false);
  });

  test("undefined tabPageUrl returns false", () => {
    expect(isSameOriginWorker("https://example.com/worker.js", undefined)).toBe(false);
  });

  test("tabPageUrl with non-HTTP scheme returns false", () => {
    expect(isSameOriginWorker("https://example.com/worker.js", "about:blank")).toBe(false);
  });
});

// ── classifyRequest fix-checking tests ───────────────────────────────

describe("classifyRequest — fix checking (same-origin gate)", () => {
  beforeEach(() => {
    tabPageUrlCache.clear();
    // Seed in-scope settings (master on, scopeMode "all") so the scope gate
    // passes through to the same-origin gate under test.
    updateWorkerFilterSettings(IN_SCOPE_SETTINGS);
  });

  test("same-origin worker with Sec-Fetch-Dest: worker is patch", () => {
    tabPageUrlCache.set(1, "https://example.com/");
    expect(
      _classifyRequestForTest({
        requestId: "r1",
        url: "https://example.com/worker.js",
        type: "script",
        method: "GET",
        tabId: 1,
        frameId: 0,
        requestHeaders: [{ name: "Sec-Fetch-Dest", value: "worker" }],
      })
    ).toBe("patch");
  });

  test("same-origin subdomain worker is patch", () => {
    tabPageUrlCache.set(2, "https://app.example.com/");
    expect(
      _classifyRequestForTest({
        requestId: "r2",
        url: "https://api.example.com/worker.js",
        type: "script",
        method: "GET",
        tabId: 2,
        frameId: 0,
        requestHeaders: [{ name: "Sec-Fetch-Dest", value: "worker" }],
      })
    ).toBe("patch");
  });

  test("cross-origin worker with Sec-Fetch-Dest: worker is pass", () => {
    tabPageUrlCache.set(3, "https://example.com/");
    expect(
      _classifyRequestForTest({
        requestId: "r3",
        url: "https://challenges.cloudflare.com/worker.js",
        type: "script",
        method: "GET",
        tabId: 3,
        frameId: 0,
        requestHeaders: [{ name: "Sec-Fetch-Dest", value: "worker" }],
      })
    ).toBe("pass");
  });

  test("cross-origin worker with Sec-Fetch-Dest: sharedworker is pass", () => {
    tabPageUrlCache.set(4, "https://example.com/");
    expect(
      _classifyRequestForTest({
        requestId: "r4",
        url: "https://js.stripe.com/worker.js",
        type: "script",
        method: "GET",
        tabId: 4,
        frameId: 0,
        requestHeaders: [{ name: "Sec-Fetch-Dest", value: "sharedworker" }],
      })
    ).toBe("pass");
  });

  test("regular script (Sec-Fetch-Dest: script) is always pass", () => {
    tabPageUrlCache.set(5, "https://example.com/");
    expect(
      _classifyRequestForTest({
        requestId: "r5",
        url: "https://example.com/app.js",
        type: "script",
        method: "GET",
        tabId: 5,
        frameId: 0,
        requestHeaders: [{ name: "Sec-Fetch-Dest", value: "script" }],
      })
    ).toBe("pass");
  });

  test("same-origin allowlisted URL (no Sec-Fetch-Dest) is patch", () => {
    tabPageUrlCache.set(6, "https://example.com/");
    allowlistWorkerUrl("https://example.com/sw.js");
    expect(
      _classifyRequestForTest({
        requestId: "r6",
        url: "https://example.com/sw.js",
        type: "script",
        method: "GET",
        tabId: 6,
        frameId: 0,
        requestHeaders: [],
      })
    ).toBe("patch");
  });

  test("two-part eTLD same-origin worker is patch", () => {
    tabPageUrlCache.set(7, "https://www.example.co.uk/");
    expect(
      _classifyRequestForTest({
        requestId: "r7",
        url: "https://api.example.co.uk/worker.js",
        type: "script",
        method: "GET",
        tabId: 7,
        frameId: 0,
        requestHeaders: [{ name: "Sec-Fetch-Dest", value: "worker" }],
      })
    ).toBe("patch");
  });
});

describe("site locations", () => {
  const SITE_SETTINGS = {
    ...IN_SCOPE_SETTINGS,
    location: TOKYO,
    timezone: TOKYO_TZ,
    siteLocations: [ENTRY_DUBLIN],
  };

  test("workerPayloadFor uses the site zone on a matched page", () => {
    const payload = workerPayloadFor(SITE_SETTINGS, "https://chatgpt.com/c/1");
    expect(payload).toContain('"Europe/Dublin"');
    expect(payload).not.toContain('"Asia/Tokyo"');
  });

  test("workerPayloadFor uses the main zone elsewhere", () => {
    const payload = workerPayloadFor(SITE_SETTINGS, "https://example.com/");
    expect(payload).toContain('"Asia/Tokyo"');
    expect(payload).not.toContain('"Europe/Dublin"');
  });

  test("workerPayloadFor never applies a site zone out of scope", () => {
    const s = { ...SITE_SETTINGS, scopeMode: "denylist" as const, denylist: ["chatgpt.com"] };
    expect(workerPayloadFor(s, "https://chatgpt.com/")).not.toContain('"Europe/Dublin"');
  });

  test("workerPayloadFor is empty with no zone and no locale", () => {
    expect(workerPayloadFor({ ...IN_SCOPE_SETTINGS }, "https://example.com/")).toBe("");
  });

  test("hasWorkerTimezoneSource is true with only site locations", () => {
    expect(hasWorkerTimezoneSource({ ...SITE_SETTINGS, timezone: null })).toBe(true);
    expect(hasWorkerTimezoneSource({ ...IN_SCOPE_SETTINGS, timezone: TOKYO_TZ })).toBe(true);
    expect(hasWorkerTimezoneSource({ ...IN_SCOPE_SETTINGS })).toBe(false);
  });
});
