/**
 * Shared fixtures for the background site group tests: a small catalog, a
 * multi-key `storage.local` stand-in (the global mock only persists
 * `settings`), and a `fetch` router.
 */
import { vi, type Mock } from "vitest";
import type { SiteGroupCatalog } from "@/shared/site-groups/catalog";
import type { StoredSiteGroup } from "@/background/site-groups-store";

/** The bundled catalog's URL under the global `runtime.getURL` mock. */
export const BUNDLED_URL = "moz-extension://test/site-groups/catalog.json";
export const POINTER_URL = "https://cdn.geospoof.com/site-groups/v1/latest.json";

/**
 * A small catalog. `google` has 3 usable rules (one tagged `@cn`, one full) and
 * 2 skipped (one untagged, one `@cn`); `youtube` has 1; `empty` has none.
 */
export const CATALOG_A: SiteGroupCatalog = {
  format: 1,
  source: "https://github.com/v2fly/domain-list-community",
  license: "MIT",
  release: "20260101000000",
  releasedAt: "2026-01-01T00:00:00Z",
  upstreamSha256: "a".repeat(64),
  lists: {
    empty: { rules: "", skipped: [] },
    google: { rules: "google.com\ngoogle.cn@cn\n=www.google.com", skipped: ["", "cn"] },
    youtube: { rules: "youtube.com", skipped: [] },
  },
};

/** A newer catalog: `google` gains a domain and `youtube` is gone upstream. */
export const CATALOG_B: SiteGroupCatalog = {
  ...CATALOG_A,
  release: "20260201000000",
  releasedAt: "2026-02-01T00:00:00Z",
  lists: {
    empty: { rules: "", skipped: [] },
    google: { rules: "google.com\ngoogle.cn@cn\n=www.google.com\ngoogle.de", skipped: [] },
  },
};

/** A `StoredSiteGroup` holding `domains` (and `fulls`). */
export function storedGroup(
  domains: readonly string[],
  overrides: Partial<StoredSiteGroup> = {},
  fulls: readonly string[] = []
): StoredSiteGroup {
  const frame = (e: readonly string[]) => (e.length === 0 ? "\n" : `\n${e.join("\n")}\n`);
  return {
    d: frame(domains),
    f: frame(fulls),
    n: domains.length + fulls.length,
    skipped: 0,
    source: "catalog",
    release: CATALOG_A.release,
    materializedAt: 1,
    ...overrides,
  };
}

/** A multi-key storage.local stand-in installed on the global mock. */
export interface LocalStore {
  data: Record<string, unknown>;
  /** Every key passed to `set`, in order. */
  writes: string[];
  get: Mock<(keys?: string | string[] | null) => Promise<Record<string, unknown>>>;
  set: Mock<(obj: Record<string, unknown>) => Promise<void>>;
  remove: Mock<(keys: string | string[]) => Promise<void>>;
}

export function installLocalStore(initial: Record<string, unknown> = {}): LocalStore {
  const store: LocalStore = {
    data: structuredClone(initial),
    writes: [],
    get: vi.fn((keys?: string | string[] | null) => {
      const list = keys == null ? Object.keys(store.data) : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in store.data) out[k] = structuredClone(store.data[k]);
      return Promise.resolve(out);
    }),
    set: vi.fn((obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) {
        store.writes.push(k);
        store.data[k] = structuredClone(v);
      }
      return Promise.resolve();
    }),
    remove: vi.fn((keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store.data[k];
      return Promise.resolve();
    }),
  };
  browser.storage.local.get = store.get;
  browser.storage.local.set = store.set;
  browser.storage.local.remove = store.remove;
  return store;
}

/** The stored group data's `groups`, or `{}`. */
export function storedGroups(store: LocalStore): Record<string, StoredSiteGroup> {
  const value = store.data.siteGroupData as
    { groups?: Record<string, StoredSiteGroup> } | undefined;
  return value?.groups ?? {};
}

/** A response whose `url` is `url` (a constructed Response has an empty one). */
export function responseAt(url: string, body: BodyInit | null, init: ResponseInit = {}): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

export type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

/**
 * Route `fetch`: the bundled catalog URL serves `bundled` (CATALOG_A by
 * default), and `routes[url]` serves the rest. Any other URL rejects.
 */
export function routeFetch(
  routes: Record<string, Route> = {},
  bundled: SiteGroupCatalog = CATALOG_A
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    if (input === BUNDLED_URL) return Promise.resolve(responseAt(input, JSON.stringify(bundled)));
    const route = routes[input];
    if (route === undefined) return Promise.reject(new TypeError(`no route for ${input}`));
    return Promise.resolve(route(input, init));
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** The URLs `fetch` was called with, in order. */
export function fetchedUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
}

/** sha256 of a string's UTF-8 bytes, lowercase hex. */
export async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Routes serving `catalog` from the CDN behind a matching pointer. */
export async function cdnRoutes(
  catalog: SiteGroupCatalog,
  pointerOverrides: Record<string, unknown> = {},
  body: string = JSON.stringify(catalog)
): Promise<Record<string, Route>> {
  const path = `site-groups/v1/catalog-${catalog.release}.json`;
  const pointer = {
    format: 1,
    release: catalog.release,
    releasedAt: catalog.releasedAt,
    path,
    sha256: await sha256(body),
    bytes: new TextEncoder().encode(body).byteLength,
    lists: Object.keys(catalog.lists).length,
    rules: 0,
    ...pointerOverrides,
  };
  return {
    [POINTER_URL]: (url) => responseAt(url, JSON.stringify(pointer)),
    [`https://cdn.geospoof.com/${path}`]: (url) => responseAt(url, body),
  };
}
