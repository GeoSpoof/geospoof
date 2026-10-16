/**
 * SET_PRECISION_CADENCE: repair, persistence (including the seed), the alarm,
 * the broadcast, failure handling, and its interleaving with a rollover.
 * Driven through `handleMessage`, as the popup does.
 */

import { describe, test, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import type { Settings } from "@/shared/types/settings";
import type { Message, UpdateSettingsPayload } from "@/shared/types/messages";
import { clockBucket, nextBoundaryMs, resolvePageLocation } from "@/shared/precision/cadence";
import { storageData } from "../../setup";
import {
  CADENCE_SEED as SEED,
  deferred,
  flush,
  makeCadenceSettings,
  mocks,
  rolloverCreates,
  seedHeldBucket,
  until,
} from "../../helpers/cadence";

type Background = typeof import("@/background");

const T0 = 1_700_000_000_000;
const K = clockBucket("hour", SEED, T0);

let bg: Background;
let errorSpy: MockInstance<typeof console.error>;

/** Import a fresh background with `settings` stored (or nothing stored) and let its spawn check settle. */
async function boot(settings: Settings | undefined, now = T0): Promise<void> {
  vi.setSystemTime(now);
  if (settings) storageData.settings = settings;
  mocks.alarmsGet().mockResolvedValue({ name: "precision-rollover", scheduledTime: now + 600_000 });
  vi.resetModules();
  bg = await import("@/background");
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

function setCadence(cadence: unknown): Promise<unknown> {
  return bg.handleMessage(
    {
      type: "SET_PRECISION_CADENCE",
      payload: cadence === undefined ? undefined : { cadence },
    },
    {}
  );
}

async function replyLocation(): Promise<UpdateSettingsPayload["location"]> {
  const reply = (await bg.handleMessage(
    { type: "GET_SETTINGS" },
    { tab: { id: 2, url: "https://example.com/page" } as browser.tabs.Tab }
  )) as UpdateSettingsPayload;
  return reply.location;
}

const stored = (): Settings => storageData.settings as Settings;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.tabsQuery().mockResolvedValue([{ id: 1, url: "https://example.com" }]);
  mocks.tabsSendMessage().mockResolvedValue(undefined);
  mocks.alarmsCreate().mockResolvedValue(undefined);
  mocks.alarmsClear().mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("seed persistence (AC18)", () => {
  test("hour with nothing stored persists a stable seed, schedules, and broadcasts once", async () => {
    await boot(undefined);

    expect(await setCadence("hour")).toEqual({ success: true });

    const seed = stored().precisionSeed;
    expect(Number.isFinite(seed)).toBe(true);
    expect(seed).not.toBe(0);
    expect(stored().precisionCadence).toBe("hour");
    expect((await bg.loadSettings()).precisionSeed).toBe(seed);
    expect((await bg.loadSettings()).precisionSeed).toBe(seed);

    expect(rolloverCreates()).toHaveLength(1);
    expect(mocks.tabsQuery()).toHaveBeenCalledTimes(1);
  });

  test.each(["session", "hour", "day"] as const)(
    "%s never changes a valid stored seed",
    async (cadence) => {
      await boot(makeCadenceSettings({ precisionCadence: "never", precisionSeed: 555 }));
      await setCadence(cadence);
      expect(stored().precisionSeed).toBe(555);
    }
  );
});

describe("clear and repair (AC19)", () => {
  test.each(["never", "session"] as const)("%s clears the rollover alarm", async (cadence) => {
    await boot(makeCadenceSettings());

    expect(await setCadence(cadence)).toEqual({ success: true });
    expect(mocks.alarmsClear()).toHaveBeenCalledWith("precision-rollover");
    expect(mocks.alarmsCreate()).not.toHaveBeenCalled();
  });

  test.each([
    ["page", "page"],
    ["a number", 5],
    ["no payload", undefined],
  ])("an invalid cadence (%s) is stored as never", async (_name, cadence) => {
    await boot(makeCadenceSettings());

    expect(await setCadence(cadence)).toEqual({ success: true });
    expect(stored().precisionCadence).toBe("never");
    expect(mocks.alarmsClear()).toHaveBeenCalledWith("precision-rollover");
  });

  test("never mints no seed when nothing is stored", async () => {
    await boot(undefined);
    await setCadence("never");
    expect(stored().precisionSeed).toBe(0);
  });
});

describe("locationPrecision is untouched (AC2)", () => {
  test("every cadence change leaves locationPrecision deep-equal", async () => {
    const lp = { mode: "approximate" as const, radiusMeters: 2000 };
    await boot(makeCadenceSettings({ locationPrecision: lp, precisionCadence: "never" }));

    for (const cadence of ["session", "hour", "day", "never", "hour"]) {
      await setCadence(cadence);
      expect(stored().locationPrecision).toEqual(lp);
    }
  });
});

describe("failed save (AC28)", () => {
  test("hour → day with a failing write changes nothing", async () => {
    seedHeldBucket("hour", SEED, K - 2);
    await boot(makeCadenceSettings());
    const s = makeCadenceSettings();
    expect(await replyLocation()).toEqual(
      resolvePageLocation(s, { cadence: "hour", index: K - 2 })
    );

    mocks.tabsQuery().mockClear();
    // Not a quota error, so saveSettings doesn't retry: one rejected write.
    mocks.localSet().mockRejectedValueOnce(new Error("disk unavailable"));

    expect(await setCadence("day")).toEqual({ error: "STORAGE_ERROR" });
    expect(mocks.tabsQuery()).not.toHaveBeenCalled();
    expect(mocks.alarmsCreate()).not.toHaveBeenCalled();
    expect(mocks.alarmsClear()).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();

    expect(stored().precisionCadence).toBe("hour");
    expect(await replyLocation()).toEqual(
      resolvePageLocation(s, { cadence: "hour", index: K - 2 })
    );
  });
});

describe("switch semantics", () => {
  test("hour → day starts from the day clock bucket", async () => {
    seedHeldBucket("hour", SEED, K - 2);
    await boot(makeCadenceSettings());
    await replyLocation();

    await setCadence("day");

    const s = makeCadenceSettings({ precisionCadence: "day" });
    expect(await replyLocation()).toEqual(
      resolvePageLocation(s, { cadence: "day", index: clockBucket("day", SEED, T0) })
    );
  });

  test("re-selecting hour keeps a held bucket that's behind the clock", async () => {
    seedHeldBucket("hour", SEED, K - 2);
    await boot(makeCadenceSettings());
    await replyLocation();

    await setCadence("hour");

    expect(await replyLocation()).toEqual(
      resolvePageLocation(makeCadenceSettings(), { cadence: "hour", index: K - 2 })
    );
  });

  test("a switch broadcasts the new period's point", async () => {
    await boot(makeCadenceSettings({ precisionCadence: "never" }));
    const sent: UpdateSettingsPayload[] = [];
    mocks
      .tabsSendMessage()
      .mockImplementation((_tabId: number, message: Message<UpdateSettingsPayload>) => {
        if (message.type === "UPDATE_SETTINGS" && message.payload) sent.push(message.payload);
        return Promise.resolve();
      });

    await setCadence("hour");

    expect(sent.map((p) => p.location)).toEqual([
      resolvePageLocation(makeCadenceSettings(), { cadence: "hour", index: K }),
    ]);
  });
});

describe("broadcast failure", () => {
  test("the reply carries the error and the alarm is still scheduled", async () => {
    await boot(makeCadenceSettings({ precisionCadence: "never" }));
    mocks.tabsQuery().mockRejectedValueOnce(new Error("tabs unavailable"));

    const res = (await setCadence("hour")) as { error?: string };

    expect(res).toHaveProperty("error");
    expect(stored().precisionCadence).toBe("hour");
    expect(rolloverCreates()).toEqual([nextBoundaryMs("hour", SEED, K)]);
  });
});

describe("cadence saved during a rollover", () => {
  /** Record alarm writes in one ordered log. */
  function recordAlarmWrites(): Array<{ op: "create" | "clear"; when?: number }> {
    const log: Array<{ op: "create" | "clear"; when?: number }> = [];
    mocks.alarmsCreate().mockImplementation((_name: string, info: { when?: number }) => {
      log.push({ op: "create", when: info.when });
      return Promise.resolve();
    });
    mocks.alarmsClear().mockImplementation(() => {
      log.push({ op: "clear" });
      return Promise.resolve(true);
    });
    return log;
  }

  /** The first tabs.query (the rollover's broadcast) waits for `gate`; later ones resolve []. */
  function holdFirstBroadcast(): { release: () => void } {
    const gate = deferred<void>();
    mocks
      .tabsQuery()
      .mockImplementationOnce(async () => {
        await gate.promise;
        return [];
      })
      .mockResolvedValue([]);
    return { release: () => gate.resolve() };
  }

  test("day → hour ends with an alarm at the next hour boundary", async () => {
    const D = clockBucket("day", SEED, T0);
    seedHeldBucket("day", SEED, D);
    const now = nextBoundaryMs("day", SEED, D) + 1000;
    await boot(makeCadenceSettings({ precisionCadence: "day" }), now);
    const log = recordAlarmWrites();
    const held = holdFirstBroadcast();

    const p = bg.onPrecisionRolloverAlarm();
    await until(() => mocks.tabsQuery().mock.calls.length > 0, "the rollover's broadcast");
    expect(await setCadence("hour")).toEqual({ success: true });
    held.release();
    await p;

    const last = log.at(-1);
    expect(last?.op).toBe("create");
    expect(last?.when).toBe(nextBoundaryMs("hour", SEED, clockBucket("hour", SEED, now)));
  });

  test("hour → never ends with the alarm cleared", async () => {
    seedHeldBucket("hour", SEED, K);
    await boot(makeCadenceSettings(), nextBoundaryMs("hour", SEED, K) + 1000);
    const log = recordAlarmWrites();
    const held = holdFirstBroadcast();

    const p = bg.onPrecisionRolloverAlarm();
    await until(() => mocks.tabsQuery().mock.calls.length > 0, "the rollover's broadcast");
    expect(await setCadence("never")).toEqual({ success: true });
    held.release();
    await p;

    expect(log.length).toBeGreaterThan(0);
    expect(log.at(-1)?.op).toBe("clear");
  });
});
