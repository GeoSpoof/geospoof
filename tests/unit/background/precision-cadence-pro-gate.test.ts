/**
 * Safari Pro gate vs. cadence: a gated (non-Pro iOS) user gets the exact
 * location under every cadence, with no period I/O and no rollover push.
 *
 * Vitest compiles `__SAFARI__` to `false`, so the real gate in
 * `computeEffectiveLocationPrecision` can't fire here. This file swaps in the
 * gate's Safari behavior (blocked → exact) to prove the cadence code consults
 * it and honours its result everywhere; the real branch is covered by
 * construction and by `npm run build:safari`.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { LocationPrecision } from "@/shared/types/settings";
import type { Message, UpdateSettingsPayload } from "@/shared/types/messages";
import { clockBucket, nextBoundaryMs, resolvePageLocation } from "@/shared/precision/cadence";
import { storageData } from "../../setup";
import {
  CADENCE_ANCHOR,
  CADENCE_SEED as SEED,
  flush,
  installUserScriptsMock,
  makeCadenceSettings,
  mocks,
  seedHeldBucket,
  sessionCallCount,
  type UserScriptsMock,
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

const T0 = 1_700_000_000_000;
const K = clockBucket("hour", SEED, T0);
let userScripts: UserScriptsMock;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  userScripts = installUserScriptsMock();
  mocks.tabsQuery().mockResolvedValue([{ id: 1, url: "https://example.com" }]);
  mocks.alarmsGet().mockResolvedValue({ name: "precision-rollover", scheduledTime: T0 + 600_000 });
});

afterEach(() => {
  vi.useRealTimers();
  userScripts.restore();
  vi.restoreAllMocks();
});

describe("Pro gate beats every cadence", () => {
  test.each(["never", "session", "hour", "day"] as const)(
    "%s: a Pro-blocked user's pages get the exact Anchor, with no period I/O",
    async (cadence) => {
      const s = makeCadenceSettings({ precisionCadence: cadence, proFeaturesBlocked: true });
      storageData.settings = s;
      vi.resetModules();
      const bg = await import("@/background");
      const { resolveCurrentPageLocation } = await import("@/background/precision-cadence");
      await flush();
      mocks.sessionGet().mockClear();
      mocks.sessionSet().mockClear();

      expect(await resolveCurrentPageLocation(s)).toEqual(CADENCE_ANCHOR);
      expect(resolvePageLocation(s, { cadence: "hour", index: K })).toEqual(CADENCE_ANCHOR);

      const sent: UpdateSettingsPayload[] = [];
      mocks
        .tabsSendMessage()
        .mockImplementation((_tabId: number, message: Message<UpdateSettingsPayload>) => {
          if (message.type === "UPDATE_SETTINGS" && message.payload) sent.push(message.payload);
          return Promise.resolve();
        });
      await bg.broadcastSettingsToTabs(s);
      const reply = (await bg.handleMessage(
        { type: "GET_SETTINGS" },
        { tab: { id: 2, url: "https://example.com/page" } as browser.tabs.Tab }
      )) as UpdateSettingsPayload;

      expect(sent.map((p) => p.location)).toEqual([CADENCE_ANCHOR]);
      expect(reply.location).toEqual(CADENCE_ANCHOR);
      expect(sessionCallCount()).toBe(0);
    }
  );

  test("the swapped gate isn't trivially exact: an entitled user still gets an offset point", async () => {
    const { resolveCurrentPageLocation } = await import("@/background/precision-cadence");
    const s = makeCadenceSettings({ proFeaturesBlocked: false });
    expect(await resolveCurrentPageLocation(s)).not.toEqual(CADENCE_ANCHOR);
  });

  test("a rollover for a Pro-blocked user advances the bucket but pushes nothing", async () => {
    const s = makeCadenceSettings({ proFeaturesBlocked: true });
    storageData.settings = s;
    seedHeldBucket("hour", SEED, K);
    vi.setSystemTime(nextBoundaryMs("hour", SEED, K) + 1000);
    vi.resetModules();
    const bg = await import("@/background");
    const cad = await import("@/background/precision-cadence");
    await flush();
    mocks.tabsQuery().mockClear();

    await bg.onPrecisionRolloverAlarm();

    expect(await cad.getCurrentPeriod(s)).toEqual({ cadence: "hour", index: K + 1 });
    expect(mocks.tabsQuery()).not.toHaveBeenCalled();
    expect(userScripts.register).not.toHaveBeenCalled();
  });
});
