/**
 * `buildOverridesForTab`: the per-tab CDP timezone plan for Chromium debugger
 * mode. `__CHROMIUM__` is false under Vitest, so the attach/apply path is
 * compiled out; the pure planner is what decides each tab's zone, and it must
 * agree with the page payload (Filters decide whether, a site location which).
 */

import { describe, test, expect } from "vitest";
import type { Settings } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import { buildOverridesForTab } from "@/background/debugger-spoof";
import { ENTRY_DUBLIN, ENTRY_MEXICO_CITY, TOKYO, TOKYO_TZ } from "../../helpers/site-locations";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    debuggerModeEnabled: true,
    location: TOKYO,
    timezone: TOKYO_TZ,
    siteLocations: [ENTRY_DUBLIN, ENTRY_MEXICO_CITY],
    ...overrides,
  };
}

describe("buildOverridesForTab", () => {
  test("a matched page gets its site location's zone", () => {
    expect(buildOverridesForTab(makeSettings(), "https://chatgpt.com/c/1")).toEqual({
      timezoneId: "Europe/Dublin",
    });
    expect(buildOverridesForTab(makeSettings(), "https://www.twitch.tv/x")).toEqual({
      timezoneId: "America/Mexico_City",
    });
  });

  test("an unmatched page gets the main zone", () => {
    expect(buildOverridesForTab(makeSettings(), "https://example.com/")).toEqual({
      timezoneId: "Asia/Tokyo",
    });
  });

  test("an out-of-scope page gets nothing, even when an entry matches", () => {
    const s = makeSettings({ scopeMode: "denylist", denylist: ["chatgpt.com"] });
    expect(buildOverridesForTab(s, "https://chatgpt.com/")).toBeNull();
    expect(buildOverridesForTab(makeSettings({ enabled: false }), "https://chatgpt.com/")).toBe(
      null
    );
  });

  test.each(["about:blank", "chrome://settings", "file:///tmp/a.html", "ftp://example.com/"])(
    "a non-http(s) URL %s gets nothing",
    (url) => {
      expect(buildOverridesForTab(makeSettings(), url)).toBeNull();
    }
  );

  test("a missing URL gets nothing", () => {
    expect(buildOverridesForTab(makeSettings(), undefined)).toBeNull();
  });

  test("no timezones: only site-location pages get an override", () => {
    const s = makeSettings({ location: null, timezone: null });
    expect(buildOverridesForTab(s, "https://example.com/")).toBeNull();
    expect(buildOverridesForTab(s, "https://chatgpt.com/")).toEqual({
      timezoneId: "Europe/Dublin",
    });
    const none = makeSettings({ location: null, timezone: null, siteLocations: [] });
    expect(buildOverridesForTab(none, "https://chatgpt.com/")).toBeNull();
  });
});
