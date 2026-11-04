/**
 * Every background consumer honors site group entries (plan item 12): with
 * `allowlist: ["geosite:t"]` and the store holding `t = {example.com}`, the
 * page payload, the badge, Accept-Language (Match mode), Engine-level
 * overrides and the worker filter all treat https://www.example.com/ as in
 * scope, and a site location on `["geosite:t"]` applies there.
 *
 * The resolvers take the group lookup as an optional argument that defaults
 * to "no groups", so a call site that forgets `currentSiteGroups()` still
 * compiles. The last block reads the source and fails on such a call.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import type { Settings } from "@/shared/types/settings";
import { __resetSiteGroupStoreForTest, writeSiteGroupData } from "@/background/site-groups-store";
import { buildPagePayload } from "@/background/page-payload";
import { applyTabIndicator } from "@/background/badge";
import { resolveAcceptLanguageFor, planAcceptLanguageRules } from "@/background/accept-language";
import { buildOverridesForTab } from "@/background/debugger-spoof";
import {
  _classifyRequestForTest,
  _resetWorkerFilterSettingsForTest,
  tabPageUrlCache,
  untiedWorkerKeepsSiteLocation,
  updateWorkerFilterSettings,
  workerPayloadFor,
} from "@/background/worker-request-filter";
import { installLocalStore, storedGroup } from "../../helpers/site-groups";
import { DUBLIN_TZ, TOKYO, TOKYO_TZ, makeSiteLocation } from "../../helpers/site-locations";

const T = "geosite:t";
const IN = "https://www.example.com/";
const OUT = "https://other.org/";

function settingsWith(overrides: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    onboardingCompleted: true,
    location: TOKYO,
    timezone: TOKYO_TZ,
    scopeMode: "allowlist",
    allowlist: [T],
    localeSpoofing: { mode: "match" },
    ...overrides,
  };
}

beforeEach(async () => {
  __resetSiteGroupStoreForTest();
  _resetWorkerFilterSettingsForTest();
  tabPageUrlCache.clear();
  installLocalStore();
  await writeSiteGroupData({ [T]: storedGroup(["example.com"]) });
});

describe("Filters: an allowlisted group puts its sites in scope everywhere", () => {
  const settings = settingsWith({});

  test("the page payload", async () => {
    expect((await buildPagePayload(settings, IN)).enabled).toBe(true);
    expect((await buildPagePayload(settings, OUT)).enabled).toBe(false);
  });

  test("the badge", () => {
    expect(applyTabIndicator(1, settings, IN).enabled).toBe(true);
    // The "active" badge.
    expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 1, text: "✓" });
    expect(applyTabIndicator(2, settings, OUT).enabled).toBe(false);
    // The "out of scope" badge.
    expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 2, text: "•" });
  });

  test("Accept-Language in Match mode", () => {
    const value = resolveAcceptLanguageFor(settings, IN);
    expect(value).toMatch(/^ja/);
    expect(resolveAcceptLanguageFor(settings, OUT)).toBeNull();
    // The per-tab DNR plan follows the same decision.
    const plan = planAcceptLanguageRules(settings, [
      { id: 1, url: IN },
      { id: 2, url: OUT },
    ]);
    expect(plan).toEqual([expect.objectContaining({ value, condition: { tabIds: [1] } })]);
  });

  test("Engine-level overrides", () => {
    expect(buildOverridesForTab(settings, IN)).toEqual({ timezoneId: TOKYO_TZ.identifier });
    expect(buildOverridesForTab(settings, OUT)).toBeNull();
  });

  test("the worker filter", () => {
    updateWorkerFilterSettings(settings);
    const request = (tabId: number, page: string) => {
      tabPageUrlCache.set(tabId, page);
      return _classifyRequestForTest({
        requestId: `r${tabId}`,
        url: new URL("/worker.js", page).href,
        type: "script",
        method: "GET",
        tabId,
        frameId: 0,
        requestHeaders: [{ name: "Sec-Fetch-Dest", value: "worker" }],
      });
    };
    expect(request(1, IN)).toBe("patch");
    expect(request(2, OUT)).toBe("pass");
    expect(workerPayloadFor(settings, IN)).toContain(TOKYO_TZ.identifier);
    expect(workerPayloadFor(settings, OUT)).toBe("");
  });

  test("a denylisted group takes its sites out of scope", async () => {
    const deny = settingsWith({ scopeMode: "denylist", allowlist: [], denylist: [T] });
    expect((await buildPagePayload(deny, IN)).enabled).toBe(false);
    expect((await buildPagePayload(deny, OUT)).enabled).toBe(true);
  });
});

describe("Per-site locations: a location on a group applies on its sites", () => {
  const settings = settingsWith({
    scopeMode: "all",
    allowlist: [],
    siteLocations: [makeSiteLocation({ id: "g", patterns: [T] })],
  });

  test("every consumer gets the group's location there, and the main one elsewhere", async () => {
    const inPayload = await buildPagePayload(settings, IN);
    expect(inPayload.timezone).toEqual(DUBLIN_TZ);
    expect((await buildPagePayload(settings, OUT)).timezone).toEqual(TOKYO_TZ);

    expect(applyTabIndicator(1, settings, IN).siteLocation?.id).toBe("g");
    expect(resolveAcceptLanguageFor(settings, IN)).toMatch(/^en/);
    expect(buildOverridesForTab(settings, IN)).toEqual({ timezoneId: DUBLIN_TZ.identifier });
    expect(workerPayloadFor(settings, IN)).toContain(DUBLIN_TZ.identifier);
    expect(untiedWorkerKeepsSiteLocation(settings, IN, false, [IN])).toBe(true);
  });

  test("without the data, the group matches nothing", async () => {
    __resetSiteGroupStoreForTest();
    expect((await buildPagePayload(settings, IN)).timezone).toEqual(TOKYO_TZ);
  });
});

describe("every background resolver call passes currentSiteGroups()", () => {
  const SRC = resolve("src/background");

  /** The argument text of every `name(` call in `source`. */
  function callArguments(source: string, name: string): string[] {
    const out: string[] = [];
    const re = new RegExp(`\\b${name}\\(`, "g");
    for (const m of source.matchAll(re)) {
      // Skip declarations and imports.
      const before = source.slice(Math.max(0, m.index - 20), m.index);
      if (/function\s+$/.test(before)) continue;
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < source.length && depth > 0; i++) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")") depth--;
      }
      out.push(source.slice(m.index + m[0].length, i - 1));
    }
    return out;
  }

  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
  const calls = files.flatMap((file) => {
    const source = readFileSync(join(SRC, file), "utf8");
    return ["resolveSiteSettings", "computeEffectiveEnabled", "matchSiteLocation"].flatMap((name) =>
      callArguments(source, name).map((args) => ({ file, name, args }))
    );
  });

  test("self-check: the scan finds the known call sites", () => {
    const sites = new Set(calls.map((c) => c.file));
    for (const file of [
      "page-payload.ts",
      "badge.ts",
      "accept-language.ts",
      "debugger-spoof.ts",
      "worker-request-filter.ts",
    ]) {
      expect(sites.has(file), file).toBe(true);
    }
  });

  test.each(calls.map((c) => [`${c.file}: ${c.name}`, c] as const))("%s", (_label, call) => {
    expect(call.args).toContain("currentSiteGroups()");
  });
});
