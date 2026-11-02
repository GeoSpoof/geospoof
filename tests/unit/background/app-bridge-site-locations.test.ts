/**
 * Safari app bridge, inbound: adoption step 9 (`siteLocations`), plus the
 * literal shapes a future geospoof-ios parity test regex-reads.
 *
 * Vitest compiles `__SAFARI__` to `false`, which removes the native fetch in
 * adoptPendingSettingsFromApp, so these tests drive the exported
 * adoptPendingSnapshot directly with app-shaped snapshots. Each snapshot's
 * `updatedAt` (Unix seconds) is just past the fixed clock, so it is always
 * newer than the extension's last save.
 *
 * Step 9 must never wipe the list on bad input: an absent key, invalid JSON,
 * or a non-array costs nothing, and only a real array (including `[]`) is
 * re-validated and adopted.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import type { Settings } from "@/shared/types/settings";
import type { PendingSettings } from "@/background/app-bridge";
import { computeOffsets } from "@/background/timezone";
import { storageData } from "../../setup";
import { flush, makeCadenceSettings, mocks } from "../../helpers/cadence";
import { ENTRY_DUBLIN, ENTRY_MEXICO_CITY, makeSiteLocation } from "../../helpers/site-locations";

type AppBridge = typeof import("@/background/app-bridge");

const T0 = 1_700_000_000_000;

let bridge: AppBridge;
let snapshotSeq = 0;

/** Import a fresh background with `settings` stored and let its spawn settle. */
async function boot(settings: Settings): Promise<void> {
  storageData.settings = settings;
  vi.resetModules();
  await import("@/background");
  bridge = await import("@/background/app-bridge");
  await flush();
  for (const m of [mocks.tabsQuery(), mocks.tabsSendMessage(), mocks.localSet()]) {
    m.mockClear();
  }
  vi.mocked(browser.action.setBadgeText).mockClear();
  vi.mocked(browser.action.setTitle).mockClear();
}

/**
 * Adopt an app snapshot stamped just after the last one (and after any save).
 * Fields are untyped on purpose: the App Group can hand back any value.
 */
function adopt(fields: Record<string, unknown>): Promise<void> {
  snapshotSeq += 1;
  const snapshot: PendingSettings = { updatedAt: T0 / 1000 + snapshotSeq, ...fields };
  return bridge.adoptPendingSnapshot(snapshot);
}

const stored = (): Settings => storageData.settings as Settings;

/** Main settings with cadence off, so no rollover alarm work muddies the counts. */
const base = (overrides?: Partial<Settings>): Settings =>
  makeCadenceSettings({ precisionCadence: "never", ...overrides });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.alarmsGet().mockResolvedValue(undefined);
  mocks.tabsQuery().mockResolvedValue([{ id: 1, url: "https://www.twitch.tv/somechannel" }]);
  mocks.tabsSendMessage().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("adopting site locations from the app", () => {
  test("an absent key is a no-op", async () => {
    await boot(base({ siteLocations: [ENTRY_DUBLIN] }));

    await adopt({});

    expect(mocks.localSet()).not.toHaveBeenCalled();
    expect(mocks.tabsSendMessage()).not.toHaveBeenCalled();
    expect(stored().siteLocations).toEqual([ENTRY_DUBLIN]);
  });

  test("a valid list is adopted, broadcast, and badged", async () => {
    await boot(base());

    await adopt({ siteLocations: JSON.stringify([ENTRY_DUBLIN, ENTRY_MEXICO_CITY]) });

    expect(stored().siteLocations).toEqual([ENTRY_DUBLIN, ENTRY_MEXICO_CITY]);
    expect(mocks.tabsSendMessage()).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: "UPDATE_SETTINGS" })
    );
    expect(browser.action.setBadgeText).toHaveBeenCalledWith(expect.objectContaining({ tabId: 1 }));
    expect(browser.action.setTitle).toHaveBeenCalledWith({
      tabId: 1,
      title: "GeoSpoof: Mexico City on www.twitch.tv",
    });
  });

  test("an empty array is a real clear", async () => {
    await boot(base({ siteLocations: [ENTRY_DUBLIN] }));

    await adopt({ siteLocations: "[]" });

    expect(stored().siteLocations).toEqual([]);
  });

  test.each([
    ["invalid JSON", "[{not json"],
    ["a JSON object", JSON.stringify({ entries: [ENTRY_MEXICO_CITY] })],
    ["JSON null", "null"],
    ["a JSON string", JSON.stringify("twitch.tv")],
  ])("%s is ignored, never a wipe, and step 8 still runs", async (_name, value) => {
    await boot(base({ siteLocations: [ENTRY_DUBLIN] }));

    await adopt({ siteLocations: value, localeSpoofing: '{"mode":"match"}' });

    expect(stored().siteLocations).toEqual([ENTRY_DUBLIN]);
    expect(stored().localeSpoofing).toEqual({ mode: "match" });
  });

  test("a non-string value is ignored", async () => {
    await boot(base({ siteLocations: [ENTRY_DUBLIN] }));

    await adopt({ siteLocations: [ENTRY_MEXICO_CITY] });

    expect(mocks.localSet()).not.toHaveBeenCalled();
    expect(stored().siteLocations).toEqual([ENTRY_DUBLIN]);
  });

  test('a bare "Europe/Dublin" zone is repaired with offsets', async () => {
    await boot(base());
    const bare = { ...ENTRY_DUBLIN, timezone: "Europe/Dublin" };

    await adopt({ siteLocations: JSON.stringify([bare]) });

    expect(stored().siteLocations).toEqual([
      {
        ...ENTRY_DUBLIN,
        timezone: { identifier: "Europe/Dublin", ...computeOffsets("Europe/Dublin") },
      },
    ]);
  });

  // Zones the format check used to refuse, so step 9 dropped these entries.
  // Each arrives once bare (repaired with offsets) and once as a full object
  // (passed through).
  test.each([
    "America/Port-au-Prince",
    "Africa/Porto-Novo",
    "America/Blanc-Sablon",
    "Asia/Ust-Nera",
    "GMT",
  ])("a %s zone is adopted, bare or as an object", async (identifier) => {
    await boot(base());
    const timezone = { identifier, ...computeOffsets(identifier) };
    const bare = makeSiteLocation({ id: "bare", patterns: ["a.com"] });
    const full = makeSiteLocation({ id: "full", patterns: ["b.com"], timezone });

    await adopt({ siteLocations: JSON.stringify([{ ...bare, timezone: identifier }, full]) });

    expect(stored().siteLocations).toEqual([{ ...bare, timezone }, full]);
  });

  test("a zone object with non-finite offsets is recomputed", async () => {
    await boot(base());
    const partial = { ...ENTRY_DUBLIN, timezone: { identifier: "Europe/Dublin" } };

    await adopt({ siteLocations: JSON.stringify([partial]) });

    expect(stored().siteLocations[0]?.timezone).toEqual({
      identifier: "Europe/Dublin",
      ...computeOffsets("Europe/Dublin"),
    });
  });

  test("invalid entries are dropped and valid ones kept", async () => {
    await boot(base());
    const list = [
      ENTRY_DUBLIN,
      makeSiteLocation({ id: "bad-kind", kind: "language" as "location", patterns: ["a.com"] }),
      makeSiteLocation({ id: "bad-pattern", patterns: ["*"] }),
      { ...makeSiteLocation({ id: "bad-zone", patterns: ["b.com"] }), timezone: "Not/AZone" },
      "twitch.tv",
      ENTRY_MEXICO_CITY,
    ];

    await adopt({ siteLocations: JSON.stringify(list) });

    expect(stored().siteLocations).toEqual([ENTRY_DUBLIN, ENTRY_MEXICO_CITY]);
  });

  test("an identical list doesn't save or broadcast", async () => {
    await boot(base({ siteLocations: [ENTRY_DUBLIN, ENTRY_MEXICO_CITY] }));

    await adopt({ siteLocations: JSON.stringify([ENTRY_DUBLIN, ENTRY_MEXICO_CITY]) });

    expect(mocks.localSet()).not.toHaveBeenCalled();
    expect(mocks.tabsSendMessage()).not.toHaveBeenCalled();
  });

  test("a snapshot not newer than the last change adopts nothing", async () => {
    await boot(base({ lastUpdated: T0 }));

    await bridge.adoptPendingSnapshot({
      updatedAt: T0 / 1000,
      siteLocations: JSON.stringify([ENTRY_DUBLIN]),
    });

    expect(mocks.localSet()).not.toHaveBeenCalled();
    expect(stored().siteLocations).toEqual([]);
  });
});

describe("literal shapes the geospoof-ios parity test reads", () => {
  test("REGION_UPDATE sends the list as a JSON string", () => {
    const src = fs.readFileSync("src/background/settings.ts", "utf8");
    expect(src).toContain("siteLocations: JSON.stringify(settings.siteLocations),");
  });

  test("adoption reads pending.siteLocations", () => {
    const src = fs.readFileSync("src/background/app-bridge.ts", "utf8");
    expect(src).toContain("pending.siteLocations");
  });

  test("the list cap is a literal", () => {
    const src = fs.readFileSync("src/shared/types/settings.ts", "utf8");
    expect(src).toContain("export const MAX_SITE_LOCATIONS = 50;");
  });
});
