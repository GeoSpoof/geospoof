/**
 * Cross-bridge contract for the Safari app ↔ extension scope-list passthrough.
 *
 * The native app encodes the allow/deny lists as JSON string arrays and shuttles
 * them verbatim through the App Group store. On adoption the extension
 * (`adoptPendingSettingsFromApp` in src/background/app-bridge.ts) parses each
 * entry through the shared Filters entry grammar and de-duplicates by
 * canonical form:
 *
 *     for (const entry of arr) {
 *       const canonical = parseFilterEntry(entry);
 *       if (canonical !== null && !seen.has(canonical)) out.push(canonical);
 *     }
 *
 * The Safari-only native fetch is compiled out under the test harness
 * (`__SAFARI__` is a build-time literal `false`), so — like the accuracy bridge
 * test — we verify the reusable core the branch depends on: that the entry
 * grammar (not the old hostname-only normalizer) is used, so advanced glob
 * patterns and site group, link and exact entries survive the app→extension
 * round-trip instead of being silently dropped, and that bare hostnames still
 * carry forward losslessly. The last block drives the real
 * `adoptPendingSnapshot` with those entries.
 *
 * Validates: Requirements 13.3, 13.4 (via the bridge)
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Settings } from "@/shared/types/settings";
import { parseFilterEntry } from "@/shared/utils/filter-entries";
import { storageData } from "../../setup";
import { flush, makeCadenceSettings, mocks } from "../../helpers/cadence";
import { routeFetch } from "../../helpers/site-groups";

/** Mirror of the bridge's `parsePatternList`: JSON.parse → parse → dedupe-by-canonical. */
function adoptScopeList(json: string | undefined): string[] | undefined {
  if (typeof json !== "string") return undefined;
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(arr)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of arr) {
    if (typeof entry !== "string") continue;
    const canonical = parseFilterEntry(entry);
    if (canonical !== null && !seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

describe("Safari scope-list bridge contract", () => {
  test("advanced glob patterns survive the round-trip (the fix)", () => {
    // Under the old hostname-only normalizer these were all dropped.
    const json = JSON.stringify(["*.ru", "*.example.com", "localhost:3000", "site.com/app/*"]);
    expect(adoptScopeList(json)).toEqual([
      "*.ru",
      "*.example.com",
      "localhost:3000",
      "site.com/app/*",
    ]);
  });

  test("bare hostnames carry forward losslessly", () => {
    expect(adoptScopeList(JSON.stringify(["example.com", "sub.example.org"]))).toEqual([
      "example.com",
      "sub.example.org",
    ]);
  });

  test("invalid entries are dropped, valid ones kept", () => {
    const json = JSON.stringify(["bad_domain.com", "exa(mple).com", "no-dot", "valid.com"]);
    expect(adoptScopeList(json)).toEqual(["valid.com"]);
  });

  test("entries are canonicalized and de-duplicated by canonical form (keep first)", () => {
    const json = JSON.stringify(["EXAMPLE.com", "example.com", "  Example.COM  ", "other.org"]);
    expect(adoptScopeList(json)).toEqual(["example.com", "other.org"]);
  });

  test("non-string entries are skipped", () => {
    const json = JSON.stringify(["example.com", 42, null, { host: "x" }, "*.ru"]);
    expect(adoptScopeList(json)).toEqual(["example.com", "*.ru"]);
  });

  test("malformed JSON or a non-array is ignored (leaves existing state untouched)", () => {
    expect(adoptScopeList("not json")).toBeUndefined();
    expect(adoptScopeList(JSON.stringify({ not: "an array" }))).toBeUndefined();
    expect(adoptScopeList(undefined)).toBeUndefined();
  });
});

describe("site group, link and exact entries on the bridge", () => {
  const TOKENS = [
    "geosite:google@cn",
    "list:https://lists.example.org/direct-list.txt",
    "=mail.example.com",
  ];

  test("the mirror keeps them canonical and drops malformed ones", () => {
    const json = JSON.stringify([
      "GeoSite:Google@CN",
      "list:https://Lists.Example.org/direct-list.txt#x",
      "=Mail.Example.com",
      "geosite:",
      "list:http://lists.example.org/x.txt",
      "=*.example.com",
    ]);
    expect(adoptScopeList(json)).toEqual(TOKENS);
  });

  describe("adoptPendingSnapshot step 5", () => {
    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.alarmsGet().mockResolvedValue(undefined);
      mocks.tabsQuery().mockResolvedValue([]);
      routeFetch();
    });

    test("adopts the app's lists with the tokens intact", async () => {
      storageData.settings = makeCadenceSettings({ precisionCadence: "never" });
      vi.resetModules();
      await import("@/background");
      const bridge = await import("@/background/app-bridge");
      await flush();

      await bridge.adoptPendingSnapshot({
        updatedAt: Date.now() / 1000 + 60,
        scopeMode: "denylist",
        allowlist: JSON.stringify(["GeoSite:Google@CN", "example.com"]),
        denylist: JSON.stringify([...TOKENS, "geosite:bad name"]),
      });
      await flush();

      const stored = storageData.settings as Settings;
      expect(stored.scopeMode).toBe("denylist");
      expect(stored.allowlist).toEqual(["geosite:google@cn", "example.com"]);
      expect(stored.denylist).toEqual(TOKENS);
    });
  });
});
