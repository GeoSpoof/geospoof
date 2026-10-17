/**
 * Background period state for the location-precision cadence: the session id,
 * the held hour/day bucket, and the rollover alarm scheduling.
 *
 * `vi.resetModules()` plus a re-import simulates a service-worker / event-page
 * respawn: module state is lost, while the mocked `storage.session` (setup.ts)
 * survives, as a real one does within a browser session.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  clockBucket,
  nextBoundaryMs,
  resolvePageLocation,
  type PeriodKey,
} from "@/shared/precision/cadence";
import { sessionStorageData } from "../../setup";
import {
  BUCKET_STORAGE_KEY,
  CADENCE_SEED as SEED,
  SESSION_STORAGE_KEY,
  cadenceWarns,
  deferred,
  flush,
  makeCadenceSettings,
  mocks,
  rolloverCreates,
  seedHeldBucket,
  seedSessionId,
  sessionCallCount,
  sessionGetsFor,
  sessionSetsFor,
} from "../../helpers/cadence";

type CadenceModule = typeof import("@/background/precision-cadence");

const T0 = 1_700_000_000_000;
const K = clockBucket("hour", SEED, T0);

let mod: CadenceModule;

/** A fresh module instance, as after a background respawn. */
async function respawn(): Promise<CadenceModule> {
  vi.resetModules();
  mod = await import("@/background/precision-cadence");
  return mod;
}

const isUint32 = (v: number): boolean => Number.isInteger(v) && v >= 0 && v < 2 ** 32;

const hourLoader = () =>
  Promise.resolve({ precisionCadence: "hour" as const, precisionSeed: SEED });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  mocks.alarmsGet().mockResolvedValue(undefined);
  mocks.alarmsCreate().mockResolvedValue(undefined);
  mocks.alarmsClear().mockResolvedValue(true);
  await respawn();
  mod._resetPrecisionCadenceState();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("no period I/O when the cadence can't matter (AC6)", () => {
  test("never: no storage.session or alarm calls, and today's expression", async () => {
    const s = makeCadenceSettings({ precisionCadence: "never" });
    const loc = await mod.resolveCurrentPageLocation(s);

    expect(loc).toEqual(resolvePageLocation(s, null));
    expect(sessionCallCount()).toBe(0);
    expect(mocks.alarmsCreate()).not.toHaveBeenCalled();
    expect(mocks.alarmsGet()).not.toHaveBeenCalled();
  });

  test.each(["session", "hour", "day"] as const)(
    "exact under %s: no storage.session calls, Anchor returned",
    async (cadence) => {
      const s = makeCadenceSettings({
        precisionCadence: cadence,
        locationPrecision: { mode: "exact" },
      });
      const loc = await mod.resolveCurrentPageLocation(s);

      expect(loc).toEqual(s.location);
      expect(sessionCallCount()).toBe(0);
    }
  );

  test.each(["session", "hour", "day"] as const)(
    "no location under %s: no storage.session calls",
    async (cadence) => {
      const s = makeCadenceSettings({ precisionCadence: cadence, location: null });
      expect(await mod.resolveCurrentPageLocation(s)).toBeNull();
      expect(sessionCallCount()).toBe(0);
    }
  );
});

describe("session id", () => {
  test("one id per spawn, one write, and the same id after a respawn (AC11)", async () => {
    const s = makeCadenceSettings({ precisionCadence: "session" });
    const [a, b] = await Promise.all([mod.getCurrentPeriod(s), mod.getCurrentPeriod(s)]);

    expect(a).toEqual(b);
    expect(a?.cadence).toBe("session");
    expect(isUint32(a!.index)).toBe(true);
    expect(sessionGetsFor(SESSION_STORAGE_KEY)).toBe(1);
    expect(sessionSetsFor(SESSION_STORAGE_KEY)).toBe(1);

    mocks.sessionGet().mockClear();
    mocks.sessionSet().mockClear();
    await respawn();

    expect(await mod.getCurrentPeriod(s)).toEqual(a);
    expect(sessionSetsFor(SESSION_STORAGE_KEY)).toBe(0);
  });

  test("a failed read never writes, and the stored id comes back (AC12)", async () => {
    seedSessionId(12345);
    mocks.sessionGet().mockRejectedValueOnce(new Error("session storage unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = makeCadenceSettings({ precisionCadence: "session" });

    const first = await mod.getCurrentPeriod(s);
    expect(isUint32(first!.index)).toBe(true);
    expect(sessionSetsFor(SESSION_STORAGE_KEY)).toBe(0);
    expect(sessionStorageData[SESSION_STORAGE_KEY]).toBe(12345);
    expect(cadenceWarns(warn)).toEqual(["[cadence] storage.session read failed"]);

    const second = await mod.getCurrentPeriod(s);
    expect(second).toEqual({ cadence: "session", index: 12345 });
    expect(sessionSetsFor(SESSION_STORAGE_KEY)).toBe(0);
  });

  test.each([-1, 2 ** 32, "x", 1.5])(
    "a corrupt stored id (%j) after a successful read is replaced",
    async (corrupt) => {
      seedSessionId(corrupt);
      const period = await mod.getCurrentPeriod(
        makeCadenceSettings({ precisionCadence: "session" })
      );

      expect(isUint32(period!.index)).toBe(true);
      expect(period!.index).not.toBe(corrupt);
      expect(sessionStorageData[SESSION_STORAGE_KEY]).toBe(period!.index);
    }
  );
});

describe("held hour/day bucket", () => {
  test("concurrent first callers share one storage.session read", async () => {
    const s = makeCadenceSettings();
    const [a, b] = await Promise.all([mod.getCurrentPeriod(s), mod.getCurrentPeriod(s)]);

    expect(a).toEqual({ cadence: "hour", index: K });
    expect(b).toEqual(a);
    expect(sessionGetsFor(BUCKET_STORAGE_KEY)).toBe(1);
    expect(sessionStorageData[BUCKET_STORAGE_KEY]).toEqual({
      cadence: "hour",
      seed: SEED,
      index: K,
    });
  });

  test("a stored record for this cadence and seed is adopted even when the clock differs", async () => {
    seedHeldBucket("hour", SEED, K - 3);
    expect(await mod.getCurrentPeriod(makeCadenceSettings())).toEqual({
      cadence: "hour",
      index: K - 3,
    });
    expect(sessionSetsFor(BUCKET_STORAGE_KEY)).toBe(0);
  });

  test.each([
    ["another cadence", { cadence: "day", seed: SEED, index: K - 3 }],
    ["another seed", { cadence: "hour", seed: SEED + 1, index: K - 3 }],
  ])("a stored record for %s is ignored and the clock bucket is held", async (_name, record) => {
    sessionStorageData[BUCKET_STORAGE_KEY] = record;
    expect(await mod.getCurrentPeriod(makeCadenceSettings())).toEqual({
      cadence: "hour",
      index: K,
    });
    expect(sessionStorageData[BUCKET_STORAGE_KEY]).toEqual({
      cadence: "hour",
      seed: SEED,
      index: K,
    });
  });

  test.each([
    ["a non-object", "x"],
    ["a fractional index", { cadence: "hour", seed: SEED, index: 1.5 }],
    ["a stray cadence", { cadence: "page", seed: SEED, index: K - 3 }],
    ["a non-numeric seed", { cadence: "hour", seed: "x", index: K - 3 }],
  ])("a corrupt record (%s) falls back to the clock bucket", async (_name, record) => {
    sessionStorageData[BUCKET_STORAGE_KEY] = record;
    expect(await mod.getCurrentPeriod(makeCadenceSettings())).toEqual({
      cadence: "hour",
      index: K,
    });
  });

  test("a backward clock keeps the held bucket until the advance (AC16)", async () => {
    const s = makeCadenceSettings();
    const intoPrevious = nextBoundaryMs("hour", SEED, K - 1) - 1000; // inside bucket K − 1

    const runOnce = async (): Promise<ReturnType<typeof resolvePageLocation>> => {
      vi.setSystemTime(T0);
      seedHeldBucket("hour", SEED, K);
      expect(await mod.getCurrentPeriod(s)).toEqual({ cadence: "hour", index: K });

      vi.setSystemTime(intoPrevious);
      expect(await mod.getCurrentPeriod(s), "held, not recomputed from the clock").toEqual({
        cadence: "hour",
        index: K,
      });

      expect(await mod.advanceHeldBucketToClock("hour", SEED)).toBe(true);
      expect(await mod.getCurrentPeriod(s)).toEqual({ cadence: "hour", index: K - 1 });
      return mod.resolveCurrentPageLocation(s);
    };

    const first = await runOnce();
    expect(first).toEqual(resolvePageLocation(s, { cadence: "hour", index: K - 1 }));

    // A respawn hydrates the advanced bucket.
    await respawn();
    expect(await mod.getCurrentPeriod(s)).toEqual({ cadence: "hour", index: K - 1 });

    // Rerun from scratch: the same inputs give the same output.
    for (const key of Object.keys(sessionStorageData)) delete sessionStorageData[key];
    await respawn();
    expect(await runOnce()).toEqual(first);
  });

  test("advance with the clock bucket already held reports no change", async () => {
    seedHeldBucket("hour", SEED, K);
    await mod.getCurrentPeriod(makeCadenceSettings());
    expect(await mod.advanceHeldBucketToClock("hour", SEED)).toBe(false);
  });

  test("advance with nothing stored hydrates to the clock bucket and reports no change", async () => {
    expect(await mod.advanceHeldBucketToClock("hour", SEED)).toBe(false);
    expect(await mod.getCurrentPeriod(makeCadenceSettings())).toEqual({
      cadence: "hour",
      index: K,
    });
    expect(sessionStorageData[BUCKET_STORAGE_KEY]).toEqual({
      cadence: "hour",
      seed: SEED,
      index: K,
    });
  });

  test("advance after a failed read pushes and holds the clock bucket", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.sessionGet().mockRejectedValueOnce(new Error("session storage unavailable"));

    expect(await mod.advanceHeldBucketToClock("hour", SEED)).toBe(true);
    expect(await mod.getCurrentPeriod(makeCadenceSettings())).toEqual({
      cadence: "hour",
      index: K,
    });
    expect(sessionGetsFor(BUCKET_STORAGE_KEY)).toBe(1);
  });

  test("adoptClockBucket replaces a held bucket with the clock's", async () => {
    seedHeldBucket("hour", SEED, K - 3);
    await mod.getCurrentPeriod(makeCadenceSettings());
    expect(await mod.adoptClockBucket("hour", SEED)).toBe(K);
    expect(await mod.getCurrentPeriod(makeCadenceSettings())).toEqual({
      cadence: "hour",
      index: K,
    });
  });

  test("a stray stored cadence resolves to no period", async () => {
    const period: PeriodKey | null = await mod.getCurrentPeriod({
      precisionCadence: "page" as never,
      precisionSeed: SEED,
    });
    expect(period).toBeNull();
    expect(sessionCallCount()).toBe(0);
  });
});

describe("rollover alarm scheduling (AC14)", () => {
  test("schedules at the held bucket's next boundary", async () => {
    seedHeldBucket("hour", SEED, K);
    await mod.reschedulePrecisionRollover(hourLoader);

    expect(mocks.alarmsCreate()).toHaveBeenCalledWith("precision-rollover", {
      when: nextBoundaryMs("hour", SEED, K),
    });
  });

  test("never schedules less than a second out", async () => {
    vi.setSystemTime(nextBoundaryMs("hour", SEED, K) - 500);
    seedHeldBucket("hour", SEED, K);
    await mod.reschedulePrecisionRollover(hourLoader);

    expect(rolloverCreates()).toEqual([Date.now() + 1000]);
  });

  test("a held bucket behind the clock becomes a catch-up alarm", async () => {
    seedHeldBucket("hour", SEED, K - 2);
    await mod.reschedulePrecisionRollover(hourLoader);
    expect(rolloverCreates()).toEqual([T0 + 1000]);
  });

  test.each(["never", "session"] as const)(
    "%s clears the alarm and touches no session state",
    async (cadence) => {
      await mod.reschedulePrecisionRollover(() =>
        Promise.resolve({ precisionCadence: cadence, precisionSeed: SEED })
      );

      expect(mocks.alarmsClear()).toHaveBeenCalledWith("precision-rollover");
      expect(mocks.alarmsCreate()).not.toHaveBeenCalled();
      expect(sessionCallCount()).toBe(0);
    }
  );

  test("jobs run in call order and read settings when they run", async () => {
    const slow = deferred<{ precisionCadence: "day"; precisionSeed: number }>();
    const p1 = mod.reschedulePrecisionRollover(() => slow.promise);
    const p2 = mod.reschedulePrecisionRollover(hourLoader);

    await flush();
    expect(mocks.alarmsCreate(), "the second job waits for the first").not.toHaveBeenCalled();

    slow.resolve({ precisionCadence: "day", precisionSeed: SEED });
    await Promise.all([p1, p2]);

    const creates = rolloverCreates();
    expect(creates).toHaveLength(2);
    expect(creates[0]).toBe(nextBoundaryMs("day", SEED, clockBucket("day", SEED, T0)));
    expect(creates.at(-1)).toBe(nextBoundaryMs("hour", SEED, K));
  });

  test("a rejecting loader logs one WARN and doesn't block the next job", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p1 = mod.reschedulePrecisionRollover(() => Promise.reject(new Error("load failed")));
    const p2 = mod.reschedulePrecisionRollover(hourLoader);

    await expect(p1).resolves.toBeUndefined();
    await p2;
    expect(cadenceWarns(warn)).toEqual(["[cadence] could not schedule rollover:"]);
    expect(rolloverCreates()).toEqual([nextBoundaryMs("hour", SEED, K)]);
  });

  test("a rejecting alarms.create logs a WARN and the queue continues", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.alarmsCreate().mockRejectedValueOnce(new Error("alarms unavailable"));

    await mod.reschedulePrecisionRollover(hourLoader);
    await mod.reschedulePrecisionRollover(hourLoader);

    expect(cadenceWarns(warn)).toEqual(["[cadence] could not schedule rollover:"]);
    expect(rolloverCreates()).toHaveLength(2);
  });
});

describe("ensurePrecisionRollover (AC17)", () => {
  const hour = { precisionCadence: "hour" as const, precisionSeed: SEED };

  test.each(["never", "session"] as const)(
    "%s returns false without reading the alarm",
    async (cadence) => {
      const load = vi.fn(hourLoader);
      expect(
        await mod.ensurePrecisionRollover({ precisionCadence: cadence, precisionSeed: SEED }, load)
      ).toBe(false);
      expect(mocks.alarmsGet()).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
    }
  );

  test("a missing alarm is created once", async () => {
    expect(await mod.ensurePrecisionRollover(hour, hourLoader)).toBe(false);
    expect(rolloverCreates()).toEqual([nextBoundaryMs("hour", SEED, K)]);
  });

  test("a healthy alarm is left alone", async () => {
    mocks
      .alarmsGet()
      .mockResolvedValue({ name: "precision-rollover", scheduledTime: Date.now() + 600_000 });
    const load = vi.fn(hourLoader);

    expect(await mod.ensurePrecisionRollover(hour, load)).toBe(false);
    expect(mocks.alarmsCreate()).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  test.each([
    ["10 minutes overdue", -600_000, true],
    ["1 minute overdue (inside the grace)", -60_000, false],
  ])("an alarm %s → %s", async (_name, offset, expected) => {
    mocks
      .alarmsGet()
      .mockResolvedValue({ name: "precision-rollover", scheduledTime: Date.now() + offset });
    expect(await mod.ensurePrecisionRollover(hour, hourLoader)).toBe(expected);
    expect(mocks.alarmsCreate()).not.toHaveBeenCalled();
  });

  test("a non-finite scheduledTime is treated as healthy", async () => {
    mocks.alarmsGet().mockResolvedValue({ name: "precision-rollover", scheduledTime: NaN });
    expect(await mod.ensurePrecisionRollover(hour, hourLoader)).toBe(false);
    expect(mocks.alarmsCreate()).not.toHaveBeenCalled();
  });

  test("a rejected alarms.get is treated as missing", async () => {
    mocks.alarmsGet().mockRejectedValueOnce(new Error("alarms unavailable"));
    expect(await mod.ensurePrecisionRollover(hour, hourLoader)).toBe(false);
    expect(rolloverCreates()).toHaveLength(1);
  });
});
