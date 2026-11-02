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
  installWorkerRequestFilter,
  isSameOriginWorker,
  tabPageUrlCache,
  uninstallWorkerRequestFilter,
  untiedWorkerKeepsSiteLocation,
  updateWorkerFilterSettings,
  hasWorkerTimezoneSource,
  resolveWorkerPageUrl,
  workerPayloadFor,
} from "@/background/worker-request-filter";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import {
  decideNativeFractionalOffset,
  engineFamilyFromBuild,
  nativeDateSurfaceOf,
} from "@/shared/native-offset-precision";
import {
  ENTRY_DUBLIN,
  MEXICO_CITY,
  MEXICO_CITY_TZ,
  TOKYO,
  TOKYO_TZ,
  makeSiteLocation,
} from "../../helpers/site-locations";

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

  test("workerPayloadFor is empty out of scope", () => {
    const s = { ...SITE_SETTINGS, scopeMode: "denylist" as const, denylist: ["chatgpt.com"] };
    expect(workerPayloadFor(s, "https://chatgpt.com/")).toBe("");
    expect(workerPayloadFor({ ...SITE_SETTINGS, enabled: false }, "https://example.com/")).toBe("");
  });

  test("workerPayloadFor bakes in this realm's getTimezoneOffset precision", () => {
    // The background has no page decision to forward, so it runs the shared
    // probe on its own Date; same engine and zone as the page.
    const expected = decideNativeFractionalOffset(
      nativeDateSurfaceOf(Date),
      engineFamilyFromBuild(),
      () => navigator.userAgent
    );
    const payload = workerPayloadFor(SITE_SETTINGS, "https://example.com/");
    expect(payload).toContain(`var __fractionalOffset = ${String(expected)};`);
  });

  test("workerPayloadFor is empty with no zone and no locale", () => {
    expect(workerPayloadFor({ ...IN_SCOPE_SETTINGS }, "https://example.com/")).toBe("");
  });

  test("a SharedWorker from an embedded frame resolves to the frame's top-level page", () => {
    tabPageUrlCache.clear();
    const base = { requestId: "sw-1", url: "https://chatgpt.com/sw.js", type: "script" };
    const fromFrame = {
      ...base,
      method: "GET",
      tabId: -1,
      frameId: 9,
      documentUrl: "https://chatgpt.com/embed",
      frameAncestors: [{ url: "https://example.org/", frameId: 0 }],
    };
    expect(resolveWorkerPageUrl(fromFrame)).toBe("https://example.org/");
    // So the worker gets the main zone, like the frame's realm.
    expect(workerPayloadFor(SITE_SETTINGS, resolveWorkerPageUrl(fromFrame))).toContain(
      '"Asia/Tokyo"'
    );

    // A top-level document has no ancestors and resolves to itself.
    const fromTop = { ...fromFrame, documentUrl: "https://chatgpt.com/", frameAncestors: [] };
    expect(resolveWorkerPageUrl(fromTop)).toBe("https://chatgpt.com/");
    // The tab cache still wins when the request has a tab.
    tabPageUrlCache.set(3, "https://chatgpt.com/c/1");
    expect(resolveWorkerPageUrl({ ...fromFrame, tabId: 3 })).toBe("https://chatgpt.com/c/1");
    tabPageUrlCache.clear();
  });

  // Top-level page A (example.org) embeds frame B (chatgpt.com), which starts
  // a same-site SharedWorker. Firefox reports it with no tab, `documentUrl` B,
  // and `frameAncestors` [A]. Filters must judge A, as the payload does.
  describe("a SharedWorker from an embedded frame gets the top-level page's decision", () => {
    const fromFrame = {
      requestId: "sw-2",
      url: "https://chatgpt.com/shared.js",
      type: "script",
      method: "GET",
      tabId: -1,
      frameId: 9,
      documentUrl: "https://chatgpt.com/embed",
      frameAncestors: [{ url: "https://example.org/", frameId: 0 }],
      requestHeaders: [{ name: "Sec-Fetch-Dest", value: "sharedworker" }],
    };

    beforeEach(() => tabPageUrlCache.clear());
    afterEach(() => updateWorkerFilterSettings(IN_SCOPE_SETTINGS));

    test("Allowlist with only the top-level page allowed patches it with the page's zone", () => {
      const s = { ...SITE_SETTINGS, scopeMode: "allowlist" as const, allowlist: ["example.org"] };
      updateWorkerFilterSettings(s);
      expect(_classifyRequestForTest(fromFrame)).toBe("patch");
      expect(workerPayloadFor(s, resolveWorkerPageUrl(fromFrame))).toContain('"Asia/Tokyo"');
    });

    test("Denylist with the top-level page denied leaves it unmodified", () => {
      const s = { ...SITE_SETTINGS, scopeMode: "denylist" as const, denylist: ["example.org"] };
      updateWorkerFilterSettings(s);
      expect(_classifyRequestForTest(fromFrame)).toBe("pass");
      expect(workerPayloadFor(s, resolveWorkerPageUrl(fromFrame))).toBe("");
    });

    test("the same-site gate still judges the frame that started the worker", () => {
      updateWorkerFilterSettings(SITE_SETTINGS);
      expect(_classifyRequestForTest(fromFrame)).toBe("patch");
      // Same-site as A but not as B, the frame that started it.
      expect(_classifyRequestForTest({ ...fromFrame, url: "https://example.org/shared.js" })).toBe(
        "pass"
      );
    });
  });

  test("hasWorkerTimezoneSource is true with only site locations", () => {
    expect(hasWorkerTimezoneSource({ ...SITE_SETTINGS, timezone: null })).toBe(true);
    expect(hasWorkerTimezoneSource({ ...IN_SCOPE_SETTINGS, timezone: TOKYO_TZ })).toBe(true);
    expect(hasWorkerTimezoneSource({ ...IN_SCOPE_SETTINGS })).toBe(false);
  });
});

// Firefox 159 reports a URL SharedWorker's script request with no tab
// (tabId -1, frameId -1) and no frameAncestors, whether the top-level document
// or an embedded frame started it; thirdParty is true only for a cross-site
// frame (harness F-SW-signals). Review F18: a frame's site location must not
// reach a worker whose top-level page doesn't match it.
describe("a SharedWorker whose top-level page Firefox doesn't report", () => {
  const SETTINGS = {
    ...IN_SCOPE_SETTINGS,
    location: TOKYO,
    timezone: TOKYO_TZ,
    localeSpoofing: { mode: "match" as const },
    // Dublin on chatgpt.com and openai.com; Mexico City on sub.example.com only.
    siteLocations: [
      ENTRY_DUBLIN,
      makeSiteLocation({
        id: "1700000000003",
        patterns: ["sub.example.com"],
        location: MEXICO_CITY,
        timezone: MEXICO_CITY_TZ,
      }),
    ],
  };
  const BODY = "/*worker body*/";
  const MAIN = workerPayloadFor(SETTINGS, "https://example.org/");
  const DUBLIN_PAYLOAD = workerPayloadFor(SETTINGS, "https://chatgpt.com/");

  describe("untiedWorkerKeepsSiteLocation", () => {
    test("a cross-site frame, or no thirdParty flag, never keeps it", () => {
      const tops = ["https://example.org/", "https://chatgpt.com/"];
      expect(untiedWorkerKeepsSiteLocation(SETTINGS, "https://chatgpt.com/e", true, tops)).toBe(
        false
      );
      expect(
        untiedWorkerKeepsSiteLocation(SETTINGS, "https://chatgpt.com/e", undefined, tops)
      ).toBe(false);
    });

    test("a top-level start keeps it when every same-site tab agrees", () => {
      const tops = ["https://chatgpt.com/c/1", "https://example.org/"];
      expect(untiedWorkerKeepsSiteLocation(SETTINGS, "https://chatgpt.com/c/1", false, tops)).toBe(
        true
      );
    });

    test("a same-site tab that resolves differently drops it", () => {
      const frame = "https://sub.example.com/frame";
      // The worker may come from a sub.example.com frame on example.com (no entry).
      expect(untiedWorkerKeepsSiteLocation(SETTINGS, frame, false, ["https://example.com/"])).toBe(
        false
      );
      expect(
        untiedWorkerKeepsSiteLocation(SETTINGS, frame, false, [
          "https://sub.example.com/",
          "https://example.com/",
        ])
      ).toBe(false);
      expect(
        untiedWorkerKeepsSiteLocation(SETTINGS, frame, false, ["https://sub.example.com/"])
      ).toBe(true);
    });

    test("no open same-site tab drops it", () => {
      expect(
        untiedWorkerKeepsSiteLocation(SETTINGS, "https://chatgpt.com/", false, [
          "https://example.org/",
        ])
      ).toBe(false);
      expect(untiedWorkerKeepsSiteLocation(SETTINGS, "https://chatgpt.com/", false, [])).toBe(
        false
      );
    });
  });

  describe("through the response filter", () => {
    interface FakeFilter {
      ondata: ((event: { data: ArrayBuffer }) => void) | null;
      onstop: (() => void) | null;
      onerror: (() => void) | null;
      written: string[];
      write: (data: ArrayBuffer | Uint8Array) => void;
      close: () => void;
      disconnect: () => void;
    }
    type Details = Parameters<typeof _classifyRequestForTest>[0] & { thirdParty?: boolean };
    type Listener = (details: Details) => void;

    const listeners: { request?: Listener; headers?: Listener } = {};
    let filters: FakeFilter[] = [];
    let n = 0;
    const tabs = browser.tabs as unknown as Record<string, unknown> & {
      onUpdated: Record<string, unknown>;
    };

    function makeFilter(): FakeFilter {
      const written: string[] = [];
      return {
        ondata: null,
        onstop: null,
        onerror: null,
        written,
        write: (data) => written.push(new TextDecoder().decode(data)),
        close: () => undefined,
        disconnect: () => undefined,
      };
    }

    /** Run one SharedWorker script request through both listeners and onstop. */
    function runSharedWorker(overrides: Partial<Details>): string {
      const details: Details = {
        requestId: `untied-${++n}`,
        url: "https://chatgpt.com/shared.js",
        type: "script",
        method: "GET",
        tabId: -1,
        frameId: -1,
        requestHeaders: [{ name: "Sec-Fetch-Dest", value: "sharedworker" }],
        ...overrides,
      };
      const before = filters.length;
      listeners.request!(details);
      const filter = filters[before];
      expect(filter, "a filter is attached").toBeDefined();
      listeners.headers!(details);
      filter.ondata!({ data: new TextEncoder().encode(BODY).buffer });
      filter.onstop!();
      return filter.written.join("");
    }

    async function install(open: Array<{ id: number; url: string }>): Promise<void> {
      vi.mocked(browser.tabs.query).mockResolvedValue(open as never);
      await installWorkerRequestFilter();
      updateWorkerFilterSettings(SETTINGS);
    }

    beforeEach(() => {
      filters = [];
      (browser as unknown as { webRequest?: unknown }).webRequest = {
        filterResponseData: () => {
          const f = makeFilter();
          filters.push(f);
          return f;
        },
        onBeforeRequest: {
          addListener: (fn: Listener) => (listeners.request = fn),
          removeListener: () => undefined,
        },
        onBeforeSendHeaders: {
          addListener: (fn: Listener) => (listeners.headers = fn),
          removeListener: () => undefined,
        },
      };
      tabs.onRemoved = { addListener: () => undefined, removeListener: () => undefined };
      tabs.onUpdated.removeListener = () => undefined;
    });

    afterEach(() => {
      uninstallWorkerRequestFilter();
      delete (browser as unknown as { webRequest?: unknown }).webRequest;
      delete tabs.onRemoved;
      delete tabs.onUpdated.removeListener;
      vi.mocked(browser.tabs.query).mockResolvedValue([]);
      updateWorkerFilterSettings(IN_SCOPE_SETTINGS);
    });

    test("an entry's frame on an unmatched page gives its worker the main location", async () => {
      // example.org (no entry) embeds chatgpt.com (Dublin), which starts the worker.
      await install([{ id: 1, url: "https://example.org/" }]);
      const out = runSharedWorker({ documentUrl: "https://chatgpt.com/embed", thirdParty: true });
      expect(out).toBe(MAIN + BODY);
      expect(out).not.toContain("Europe/Dublin");
    });

    test("the same, even with a chatgpt.com tab open elsewhere", async () => {
      await install([
        { id: 1, url: "https://example.org/" },
        { id: 2, url: "https://chatgpt.com/c/1" },
      ]);
      expect(runSharedWorker({ documentUrl: "https://chatgpt.com/embed", thirdParty: true })).toBe(
        MAIN + BODY
      );
    });

    test("a same-site frame whose top-level page has another value gets the main location", async () => {
      await install([{ id: 1, url: "https://example.com/" }]);
      const out = runSharedWorker({
        url: "https://sub.example.com/shared.js",
        documentUrl: "https://sub.example.com/frame",
        thirdParty: false,
      });
      expect(out).toBe(MAIN + BODY);
      expect(out).not.toContain("America/Mexico_City");
    });

    test("a SharedWorker the matched top-level page started keeps its site location", async () => {
      await install([
        { id: 1, url: "https://chatgpt.com/c/1" },
        { id: 2, url: "https://example.org/" },
      ]);
      expect(runSharedWorker({ documentUrl: "https://chatgpt.com/c/1", thirdParty: false })).toBe(
        DUBLIN_PAYLOAD + BODY
      );
    });

    test("frameAncestors, when reported, still decide", async () => {
      await install([]);
      expect(
        runSharedWorker({
          documentUrl: "https://chatgpt.com/embed",
          frameAncestors: [{ url: "https://example.org/", frameId: 0 }],
        })
      ).toBe(MAIN + BODY);
      expect(
        runSharedWorker({
          documentUrl: "https://chatgpt.com/embed",
          frameAncestors: [{ url: "https://openai.com/", frameId: 0 }],
        })
      ).toBe(DUBLIN_PAYLOAD + BODY);
    });

    test("until the open tabs are known, no site location applies", async () => {
      let release!: (open: Array<{ id: number; url: string }>) => void;
      vi.mocked(browser.tabs.query).mockReturnValue(
        new Promise((resolve) => (release = resolve as typeof release)) as never
      );
      const installing = installWorkerRequestFilter();
      updateWorkerFilterSettings(SETTINGS);
      // A tab update lands before the seed does.
      tabPageUrlCache.set(1, "https://chatgpt.com/c/1");
      const top = { documentUrl: "https://chatgpt.com/c/1", thirdParty: false };
      expect(runSharedWorker(top)).toBe(MAIN + BODY);

      release([{ id: 1, url: "https://chatgpt.com/c/1" }]);
      await installing;
      updateWorkerFilterSettings(SETTINGS);
      expect(runSharedWorker(top)).toBe(DUBLIN_PAYLOAD + BODY);
    });
  });
});
