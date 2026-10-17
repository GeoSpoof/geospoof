/**
 * Safari app bridge, inbound: adoption step 7a (`precisionCadence`).
 *
 * Vitest compiles `__SAFARI__` to `false`, which removes the native fetch in
 * adoptPendingSettingsFromApp, so these tests drive the exported
 * adoptPendingSnapshot directly with app-shaped snapshots. Each snapshot's
 * `updatedAt` (Unix seconds) is just past the fixed clock, so it is always
 * newer than the extension's last save.
 *
 * The cadence must arrive through applyPrecisionCadence, the function
 * SET_PRECISION_CADENCE uses, so hour/day get their seed, held bucket, and
 * rollover alarm; an absent or unchanged value must cost nothing.
 */

import { describe, test, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import type { LocationPrecision, Settings } from "@/shared/types/settings";
import type { Message, UpdateSettingsPayload } from "@/shared/types/messages";
import type { PendingSettings } from "@/background/app-bridge";
import { clockBucket, resolvePageLocation } from "@/shared/precision/cadence";
import { sessionStorageData, storageData } from "../../setup";
import {
  BUCKET_STORAGE_KEY,
  CADENCE_ANCHOR,
  CADENCE_SEED as SEED,
  cadenceWarns,
  flush,
  makeCadenceSettings,
  mocks,
  rolloverCreates,
  seedHeldBucket,
  sessionCallCount,
  sessionSetsFor,
} from "../../helpers/cadence";

vi.mock("@/shared/precision/offset", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/precision/offset")>();
  return {
    ...actual,
    // The Safari build's behavior: a Pro-blocked user is forced to exact.
    computeEffectiveLocationPrecision: (
      setting: LocationPrecision,
      proFeaturesBlocked?: boolean
    ): LocationPrecision => (proFeaturesBlocked === true ? { mode: "exact" } : setting),
  };
});

type AppBridge = typeof import("@/background/app-bridge");
type Background = typeof import("@/background");
type CadenceModule = typeof import("@/background/precision-cadence");

const T0 = 1_700_000_000_000;
const K = clockBucket("hour", SEED, T0);
const APPROX_500 = '{"mode":"approximate","radiusMeters":500}';
const APPROX_2000 = '{"mode":"approximate","radiusMeters":2000}';

let bridge: AppBridge;
let bg: Background;
let cad: CadenceModule;
let warnSpy: MockInstance<typeof console.warn>;
let snapshotSeq = 0;

/** Import a fresh background with `settings` stored and let its spawn check settle. */
async function boot(settings: Settings): Promise<void> {
  storageData.settings = settings;
  mocks.alarmsGet().mockResolvedValue({ name: "precision-rollover", scheduledTime: T0 + 600_000 });
  vi.resetModules();
  bg = await import("@/background");
  // The same fresh instances the background just loaded.
  bridge = await import("@/background/app-bridge");
  cad = await import("@/background/precision-cadence");
  await flush();
  for (const m of [
    mocks.tabsQuery(),
    mocks.tabsSendMessage(),
    mocks.alarmsCreate(),
    mocks.alarmsClear(),
    mocks.alarmsGet(),
    mocks.localSet(),
    mocks.sessionGet(),
    mocks.sessionSet(),
  ]) {
    m.mockClear();
  }
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

/** Record every UPDATE_SETTINGS payload the broadcasts send. */
function recordBroadcasts(): UpdateSettingsPayload[] {
  const sent: UpdateSettingsPayload[] = [];
  mocks
    .tabsSendMessage()
    .mockImplementation((_tabId: number, message: Message<UpdateSettingsPayload>) => {
      if (message.type === "UPDATE_SETTINGS" && message.payload) sent.push(message.payload);
      return Promise.resolve();
    });
  return sent;
}

/** Assert the cadence step touched nothing: no save, alarm, broadcast, or period I/O. */
function expectNoCadenceWork(sessionCallsBefore: number): void {
  expect(mocks.localSet()).not.toHaveBeenCalled();
  expect(mocks.alarmsCreate()).not.toHaveBeenCalled();
  expect(mocks.alarmsClear()).not.toHaveBeenCalled();
  expect(mocks.tabsQuery()).not.toHaveBeenCalled();
  expect(sessionCallCount()).toBe(sessionCallsBefore);
}

const stored = (): Settings => storageData.settings as Settings;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.tabsQuery().mockResolvedValue([{ id: 1, url: "https://example.com" }]);
  mocks.tabsSendMessage().mockResolvedValue(undefined);
  mocks.alarmsCreate().mockResolvedValue(undefined);
  mocks.alarmsClear().mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("adopting a cadence the app changed", () => {
  test("never → hour persists a seed, holds the clock bucket, schedules, and broadcasts once (AC 7)", async () => {
    await boot(makeCadenceSettings({ precisionCadence: "never", precisionSeed: 0 }));

    await adopt({ precisionCadence: "hour" });

    const seed = stored().precisionSeed;
    expect(stored().precisionCadence).toBe("hour");
    expect(Number.isFinite(seed)).toBe(true);
    expect(seed).not.toBe(0);
    expect(sessionStorageData[BUCKET_STORAGE_KEY]).toEqual({
      cadence: "hour",
      seed,
      index: clockBucket("hour", seed, T0),
    });
    expect(rolloverCreates()).toHaveLength(1);
    expect(mocks.tabsQuery()).toHaveBeenCalledTimes(1);
  });

  test("a valid stored seed is kept (AC 7)", async () => {
    await boot(makeCadenceSettings({ precisionCadence: "never", precisionSeed: 555 }));

    await adopt({ precisionCadence: "hour" });

    expect(stored().precisionCadence).toBe("hour");
    expect(stored().precisionSeed).toBe(555);
  });

  test.each(["never", "session"] as const)(
    "hour → %s persists, clears the rollover alarm, and broadcasts once (AC 8)",
    async (cadence) => {
      await boot(makeCadenceSettings({ precisionCadence: "hour" }));

      await adopt({ precisionCadence: cadence });

      expect(stored().precisionCadence).toBe(cadence);
      expect(mocks.alarmsClear()).toHaveBeenCalledWith("precision-rollover");
      expect(mocks.alarmsCreate()).not.toHaveBeenCalled();
      expect(mocks.tabsQuery()).toHaveBeenCalledTimes(1);
    }
  );

  test('an unknown "page" repairs to never and is adopted over hour (AC 11)', async () => {
    await boot(makeCadenceSettings({ precisionCadence: "hour" }));

    await adopt({ precisionCadence: "page" });

    expect(stored().precisionCadence).toBe("never");
    expect(mocks.alarmsClear()).toHaveBeenCalledWith("precision-rollover");
  });
});

describe("a snapshot that doesn't change the cadence costs nothing", () => {
  test("no precisionCadence key: cadence, seed, held bucket, and alarm stay put (AC 9)", async () => {
    seedHeldBucket("hour", SEED, K);
    await boot(makeCadenceSettings({ precisionCadence: "hour" }));

    await adopt({ locationPrecision: APPROX_500 });

    expect(stored().locationPrecision).toEqual({ mode: "approximate", radiusMeters: 500 });
    expect(stored().precisionCadence).toBe("hour");
    expect(stored().precisionSeed).toBe(SEED);
    expect(sessionStorageData[BUCKET_STORAGE_KEY]).toEqual({
      cadence: "hour",
      seed: SEED,
      index: K,
    });
    expect(mocks.alarmsCreate()).not.toHaveBeenCalled();
    expect(mocks.alarmsClear()).not.toHaveBeenCalled();
    expect(sessionSetsFor(BUCKET_STORAGE_KEY)).toBe(0);
    // Step 7's broadcast only.
    expect(mocks.tabsQuery()).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["hour", "hour"],
    ["page", "never"],
    ["weekly", "never"],
    ["", "never"],
  ] as const)(
    "pending %j against a stored %s does no save, alarm call, or broadcast (AC 10)",
    async (pendingCadence, storedCadence) => {
      if (storedCadence === "hour") seedHeldBucket("hour", SEED, K);
      await boot(makeCadenceSettings({ precisionCadence: storedCadence }));
      const before = sessionCallCount();

      await adopt({ precisionCadence: pendingCadence });

      expectNoCadenceWork(before);
      expect(stored().precisionCadence).toBe(storedCadence);
      if (storedCadence === "hour") {
        expect(sessionStorageData[BUCKET_STORAGE_KEY]).toEqual({
          cadence: "hour",
          seed: SEED,
          index: K,
        });
      }
    }
  );

  test.each([
    ["a number", 17],
    ["null", null],
    ["an object", {}],
  ])("a non-string cadence (%s) is ignored (AC 11)", async (_name, value) => {
    await boot(makeCadenceSettings({ precisionCadence: "hour" }));
    const before = sessionCallCount();

    await adopt({ precisionCadence: value });

    expectNoCadenceWork(before);
    expect(stored().precisionCadence).toBe("hour");
  });
});

describe("a failed cadence step never stops the later steps (AC 12)", () => {
  test("a rejected save WARNs, keeps the stored cadence, and still adopts localeSpoofing", async () => {
    await boot(makeCadenceSettings({ precisionCadence: "hour" }));
    // Not a quota error, so saveSettings doesn't retry: one rejected write.
    mocks.localSet().mockRejectedValueOnce(new Error("disk unavailable"));

    await expect(
      adopt({ precisionCadence: "day", localeSpoofing: '{"mode":"match"}' })
    ).resolves.toBeUndefined();

    expect(cadenceWarns(warnSpy)).toContain("[cadence] app cadence not adopted:");
    expect(stored().localeSpoofing).toEqual({ mode: "match" });
    expect(stored().precisionCadence).toBe("hour");
  });

  test("a rejected broadcast WARNs; the cadence and its alarm stand and step 8 still runs", async () => {
    await boot(makeCadenceSettings({ precisionCadence: "never" }));
    mocks.tabsQuery().mockRejectedValueOnce(new Error("tabs unavailable"));

    await expect(
      adopt({ precisionCadence: "day", localeSpoofing: '{"mode":"match"}' })
    ).resolves.toBeUndefined();

    expect(cadenceWarns(warnSpy)).toContain("[cadence] app cadence adoption failed:");
    expect(stored().precisionCadence).toBe("day");
    expect(rolloverCreates()).toHaveLength(1);
    expect(stored().localeSpoofing).toEqual({ mode: "match" });
  });
});

test("precision and cadence changed together: both persist and the last push carries both (AC 13)", async () => {
  await boot(
    makeCadenceSettings({ locationPrecision: { mode: "exact" }, precisionCadence: "never" })
  );
  const sent = recordBroadcasts();

  await adopt({ locationPrecision: APPROX_2000, precisionCadence: "hour" });

  expect(stored().locationPrecision).toEqual({ mode: "approximate", radiusMeters: 2000 });
  expect(stored().precisionCadence).toBe("hour");
  expect(sent.at(-1)?.location).toEqual(
    resolvePageLocation(
      makeCadenceSettings({
        locationPrecision: { mode: "approximate", radiusMeters: 2000 },
        precisionCadence: "hour",
      }),
      { cadence: "hour", index: K }
    )
  );
});

test("an entitlement change leaves the cadence alone; the gate decides the point (AC 25)", async () => {
  await boot(makeCadenceSettings({ precisionCadence: "hour" }));

  await adopt({ proFeaturesBlocked: true });
  const blocked = await bg.loadSettings();
  expect(blocked.proFeaturesBlocked).toBe(true);
  expect(blocked.precisionCadence).toBe("hour");
  expect(await cad.resolveCurrentPageLocation(blocked)).toEqual(CADENCE_ANCHOR);

  await adopt({ proFeaturesBlocked: false });
  const entitled = await bg.loadSettings();
  expect(entitled.proFeaturesBlocked).toBe(false);
  expect(entitled.precisionCadence).toBe("hour");
  expect(await cad.resolveCurrentPageLocation(entitled)).toEqual(
    resolvePageLocation(entitled, { cadence: "hour", index: K })
  );
});
