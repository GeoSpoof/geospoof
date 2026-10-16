/**
 * The location-precision cadence rollover: `onPrecisionRolloverAlarm`, its
 * alarm-listener routing, and the spawn check in `src/background/index.ts`.
 *
 * The clock is faked with `toFake: ["Date"]` only, so `setTimeout` (and the
 * `flush()` helper) stay real, and so a module that read `performance.now()`
 * instead of `Date.now()` would visibly fail. Only the `onCreated` case also
 * fakes `setTimeout`.
 */

import { describe, test, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import type { Settings } from "@/shared/types/settings";
import type { Message, UpdateSettingsPayload } from "@/shared/types/messages";
import { clockBucket, nextBoundaryMs, resolvePageLocation } from "@/shared/precision/cadence";
import { sessionStorageData, storageData } from "../../setup";
import {
  BUCKET_STORAGE_KEY,
  CADENCE_SEED as SEED,
  cadenceWarns,
  deferred,
  flush,
  installUserScriptsMock,
  lastRegisteredPayload,
  makeCadenceSettings,
  mocks,
  rolloverCreates,
  seedHeldBucket,
  until,
  type UserScriptsMock,
} from "../../helpers/cadence";

type Background = typeof import("@/background");
type CadenceModule = typeof import("@/background/precision-cadence");

const T0 = 1_700_000_000_000;
const K = clockBucket("hour", SEED, T0);
/** First instant of bucket k + 1. */
const boundary = (k: number): number => nextBoundaryMs("hour", SEED, k);

let bg: Background;
let cad: CadenceModule;
let userScripts: UserScriptsMock;
let warn: MockInstance<typeof console.warn>;
let sent: Array<{ tabId: number; payload: UpdateSettingsPayload }>;

const healthyAlarm = () => ({
  name: "precision-rollover",
  scheduledTime: Date.now() + 600_000,
});

function clearCounted(): void {
  for (const m of [
    mocks.tabsQuery(),
    mocks.tabsSendMessage(),
    mocks.alarmsCreate(),
    mocks.alarmsClear(),
    mocks.alarmsGet(),
    mocks.sessionGet(),
    mocks.sessionSet(),
    mocks.localSet(),
    userScripts.register,
    userScripts.unregister,
    warn,
  ]) {
    m.mockClear();
  }
  userScripts.log.length = 0;
  sent.length = 0;
}

interface SpawnOptions {
  settings?: Settings;
  now?: number;
  /** The `alarms.get` result at spawn; defaults to a healthy alarm. */
  alarm?: unknown;
  /** Wait for the spawn check and clear the counted spies (default true). */
  settle?: boolean;
}

/** Import a fresh background, as a service-worker / event-page spawn does. */
async function spawn(opts: SpawnOptions = {}): Promise<void> {
  vi.setSystemTime(opts.now ?? T0);
  storageData.settings = opts.settings ?? makeCadenceSettings();
  mocks.alarmsGet().mockResolvedValue("alarm" in opts ? opts.alarm : healthyAlarm());
  vi.resetModules();
  bg = await import("@/background");
  cad = await import("@/background/precision-cadence");
  if (opts.settle === false) return;
  const cadence = (storageData.settings as Settings).precisionCadence;
  if (cadence === "hour" || cadence === "day") {
    await until(() => mocks.alarmsGet().mock.calls.length > 0, "the spawn's alarms.get");
  }
  await flush();
  clearCounted();
}

/** A content-script GET_SETTINGS reply's location. */
async function replyLocation(): Promise<UpdateSettingsPayload["location"]> {
  const reply = (await bg.handleMessage(
    { type: "GET_SETTINGS" },
    { tab: { id: 2, url: "https://example.com/page" } as browser.tabs.Tab }
  )) as UpdateSettingsPayload;
  return reply.location;
}

const pointFor = (k: number, s: Settings = makeCadenceSettings()) =>
  resolvePageLocation(s, { cadence: "hour", index: k });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  userScripts = installUserScriptsMock();
  sent = [];
  mocks.tabsQuery().mockResolvedValue([{ id: 1, url: "https://example.com" }]);
  mocks
    .tabsSendMessage()
    .mockImplementation((tabId: number, message: Message<UpdateSettingsPayload>) => {
      if (message.type === "UPDATE_SETTINGS" && message.payload) {
        sent.push({ tabId, payload: message.payload });
      }
      return Promise.resolve();
    });
  mocks.alarmsCreate().mockResolvedValue(undefined);
  mocks.alarmsClear().mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  userScripts.restore();
  vi.restoreAllMocks();
});

describe("rollover handler", () => {
  test("the bucket is held across a boundary until the rollover runs (AC13, AC22)", async () => {
    await spawn({ now: boundary(K) - 1000 });

    expect(await replyLocation()).toEqual(pointFor(K));
    vi.setSystemTime(boundary(K) + 1000);
    expect(await replyLocation(), "no alarm yet: still bucket K").toEqual(pointFor(K));

    await bg.onPrecisionRolloverAlarm();

    expect(await replyLocation()).toEqual(pointFor(K + 1));
    expect(mocks.tabsQuery()).toHaveBeenCalledTimes(1);
    expect(sent.filter((m) => m.tabId === 1).map((m) => m.payload.location)).toEqual([
      pointFor(K + 1),
    ]);
    expect(userScripts.register).toHaveBeenCalledTimes(1);
    expect(lastRegisteredPayload(userScripts.register).location).toEqual(pointFor(K + 1));
    expect(rolloverCreates()).toEqual([boundary(K + 1)]);
  });

  test("the listener routes the rollover alarm to the handler", async () => {
    seedHeldBucket("hour", SEED, K);
    await spawn({ now: boundary(K) + 1000 });
    const listener = mocks.onAlarmAddListener().mock.calls.at(-1)?.[0] as
      ((alarm: { name: string; scheduledTime: number }) => void) | undefined;
    expect(listener).toBeDefined();

    listener!({ name: "precision-rollover", scheduledTime: boundary(K) });
    await until(() => rolloverCreates().length > 0, "the handler's reschedule");

    expect(mocks.tabsQuery()).toHaveBeenCalledTimes(1);
    expect(rolloverCreates()).toEqual([boundary(K + 1)]);
  });

  test("an unchanged bucket pushes nothing and reschedules at the boundary (AC14)", async () => {
    await spawn();

    await bg.onPrecisionRolloverAlarm();

    expect(mocks.tabsQuery()).not.toHaveBeenCalled();
    expect(userScripts.register).not.toHaveBeenCalled();
    expect(mocks.alarmsCreate()).toHaveBeenCalledWith("precision-rollover", { when: boundary(K) });
  });

  test.each([
    ["Exact mode", { locationPrecision: { mode: "exact" as const } }],
    ["no location", { location: null }],
    ["protection off", { enabled: false }],
  ])("%s: the bucket advances but nothing is pushed (AC15)", async (_name, overrides) => {
    const s = makeCadenceSettings(overrides);
    seedHeldBucket("hour", SEED, K);
    await spawn({ settings: s, now: boundary(K) + 1000 });

    await bg.onPrecisionRolloverAlarm();

    expect(await cad.getCurrentPeriod(s)).toEqual({ cadence: "hour", index: K + 1 });
    expect(mocks.tabsQuery()).not.toHaveBeenCalled();
    expect(userScripts.register).not.toHaveBeenCalled();
    expect(rolloverCreates()).toEqual([boundary(K + 1)]);
  });

  test("a backward clock step keeps K until the rollover adopts K − 1 (AC16)", async () => {
    await spawn();
    expect(await replyLocation()).toEqual(pointFor(K));

    vi.setSystemTime(boundary(K - 1) - 1000); // inside bucket K − 1
    expect(await replyLocation(), "held, not recomputed").toEqual(pointFor(K));

    await bg.onPrecisionRolloverAlarm();
    expect(mocks.tabsQuery()).toHaveBeenCalledTimes(1);
    expect(await replyLocation()).toEqual(pointFor(K - 1));

    clearCounted();
    await bg.onPrecisionRolloverAlarm();
    expect(mocks.tabsQuery(), "a second run has nothing new to push").not.toHaveBeenCalled();
    // A clock behind the held bucket's boundary schedules at that boundary.
    expect(rolloverCreates()).toEqual([boundary(K - 1)]);
  });

  test("two concurrent runs for one changed bucket push once", async () => {
    seedHeldBucket("hour", SEED, K);
    await spawn({ now: boundary(K) + 1000 });

    await Promise.all([bg.onPrecisionRolloverAlarm(), bg.onPrecisionRolloverAlarm()]);

    expect(mocks.tabsQuery()).toHaveBeenCalledTimes(1);
    expect(userScripts.register).toHaveBeenCalledTimes(1);
    expect(rolloverCreates().at(-1)).toBe(boundary(K + 1));
  });

  test("a failed broadcast is logged, the bootstrap still registers, and it reschedules", async () => {
    seedHeldBucket("hour", SEED, K);
    await spawn({ now: boundary(K) + 1000 });
    mocks.tabsQuery().mockRejectedValueOnce(new Error("tabs unavailable"));

    await expect(bg.onPrecisionRolloverAlarm()).resolves.toBeUndefined();

    expect(
      cadenceWarns(warn).filter((m) => m.startsWith("[cadence] rollover push failed"))
    ).toHaveLength(1);
    // Deterministic: allSettled waits for the registration before rescheduling.
    expect(userScripts.register).toHaveBeenCalledTimes(1);
    expect(lastRegisteredPayload(userScripts.register).location).toEqual(pointFor(K + 1));
    expect(rolloverCreates()).toEqual([boundary(K + 1)]);
  });

  test("onCreated resolves the point at send time, after a rollover inside its delay (AC21)", async () => {
    await spawn();
    expect(await replyLocation()).toEqual(pointFor(K));
    const onCreated = mocks.onCreatedAddListener().mock.calls.at(-1)?.[0] as
      ((tab: { id?: number; url?: string }) => void) | undefined;
    expect(onCreated).toBeDefined();

    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(T0);
    onCreated!({ id: 42, url: "https://example.com/new" });
    await vi.advanceTimersByTimeAsync(50);
    vi.setSystemTime(boundary(K) + 1000);
    await bg.onPrecisionRolloverAlarm();
    await vi.advanceTimersByTimeAsync(100);

    const toNewTab = sent.filter((m) => m.tabId === 42);
    expect(toNewTab).toHaveLength(1);
    expect(toNewTab[0].payload.location).toEqual(pointFor(K + 1));
  });

  test("a SET_LOCATION save during the advance isn't reverted (AC27)", async () => {
    const NEW_ANCHOR = { latitude: 48.8566, longitude: 2.3522, accuracy: 30 };
    seedHeldBucket("hour", SEED, K);
    await spawn({ now: boundary(K) + 1000 });

    // Hold the advance's storage.session read open.
    const gate = deferred<void>();
    mocks.sessionGet().mockImplementationOnce(async (key: string) => {
      await gate.promise;
      return { [key]: sessionStorageData[key] };
    });

    const p = bg.onPrecisionRolloverAlarm();
    await until(
      () => mocks.sessionGet().mock.calls.some((c) => c[0] === BUCKET_STORAGE_KEY),
      "the advance's bucket read"
    );
    // The persistence step of SET_LOCATION; its fire-and-forget bootstrap
    // registration resolves the period through the same pending read.
    await bg.updateSettings({ location: NEW_ANCHOR });

    gate.resolve();
    await p;

    const expected = pointFor(K + 1, makeCadenceSettings({ location: NEW_ANCHOR }));
    const lastPush = sent.filter((m) => m.tabId === 1).at(-1);
    expect(lastPush?.payload.location).toEqual(expected);
    expect(lastRegisteredPayload(userScripts.register).location).toEqual(expected);
    for (const old of [pointFor(K), pointFor(K + 1)]) {
      expect(lastPush?.payload.location).not.toEqual(old);
      expect(lastRegisteredPayload(userScripts.register).location).not.toEqual(old);
    }
  });
});

describe("spawn wiring (AC17)", () => {
  test("a missing alarm under a time cadence is created once", async () => {
    await spawn({ alarm: undefined, settle: false });
    await until(() => rolloverCreates().length > 0, "alarms.create");
    await flush();

    expect(rolloverCreates()).toEqual([boundary(K)]);
  });

  test("a healthy existing alarm is not recreated", async () => {
    await spawn({ settle: false });
    await until(() => mocks.alarmsGet().mock.calls.length > 0, "alarms.get");
    await flush();

    expect(mocks.alarmsCreate()).not.toHaveBeenCalled();
    expect(mocks.tabsQuery()).not.toHaveBeenCalled();
  });

  test("under never, the alarm isn't even read", async () => {
    await spawn({ settings: makeCadenceSettings({ precisionCadence: "never" }), settle: false });
    await flush();
    await flush();

    expect(mocks.alarmsGet()).not.toHaveBeenCalled();
    expect(mocks.alarmsCreate()).not.toHaveBeenCalled();
    expect(mocks.sessionGet()).not.toHaveBeenCalled();
  });

  test("an overdue alarm at spawn runs the rollover once", async () => {
    seedHeldBucket("hour", SEED, K);
    const now = boundary(K) + 5000;
    await spawn({
      now,
      alarm: { name: "precision-rollover", scheduledTime: now - 600_000 },
      settle: false,
    });
    await until(() => rolloverCreates().length > 0, "the handler's reschedule");
    await flush();

    expect(mocks.tabsQuery()).toHaveBeenCalledTimes(1);
    expect(sent.filter((m) => m.tabId === 1).map((m) => m.payload.location)).toEqual([
      pointFor(K + 1),
    ]);
    expect(rolloverCreates()).toEqual([boundary(K + 1)]);
  });

  test("the held bucket survives a respawn within the session", async () => {
    await spawn();
    expect(await replyLocation()).toEqual(pointFor(K));

    // Past the boundary, but the alarm hasn't fired: a respawn hydrates K from
    // storage.session instead of recomputing from the clock.
    await spawn({ now: boundary(K) + 1000 });
    expect(await replyLocation()).toEqual(pointFor(K));
  });
});
