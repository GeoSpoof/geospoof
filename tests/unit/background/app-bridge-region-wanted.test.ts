/**
 * Safari app bridge: the `regionWanted` handshake (decision D1 in the
 * geospoof-ios per-site locations design, §3.3.1).
 *
 * While the app has no current per-site list, its native handler adds
 * `regionWanted: true` to the GET_PENDING_SETTINGS response, often next to
 * `pending: null`. The extension answers with one REGION_UPDATE, but only after
 * the awaited adoption pass and only if that pass saved nothing, because every
 * save already pushes through saveSettings.
 *
 * Vitest compiles `__SAFARI__` to `false`, which removes the native fetch in
 * adoptPendingSettingsFromApp and saveSettings' own push, so these tests drive
 * the exported adoptPendingResponse directly. Every REGION_UPDATE counted here
 * therefore comes from the handshake, never from a save.
 *
 * One test per case in the design's list, in its order.
 */

import { describe, test, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { Settings } from "@/shared/types/settings";
import type { PendingResponse } from "@/background/app-bridge";
import { storageData } from "../../setup";
import { deferred, flush, makeCadenceSettings, mocks } from "../../helpers/cadence";
import { ENTRY_DUBLIN, ENTRY_MEXICO_CITY } from "../../helpers/site-locations";

type AppBridge = typeof import("@/background/app-bridge");

const T0 = 1_700_000_000_000;

let bridge: AppBridge;
let sendNativeMessage: Mock;

/** Import a fresh background with `settings` stored and let its spawn settle. */
async function boot(settings: Settings): Promise<void> {
  storageData.settings = settings;
  vi.resetModules();
  await import("@/background");
  bridge = await import("@/background/app-bridge");
  await flush();
  for (const m of [
    mocks.tabsQuery(),
    mocks.tabsSendMessage(),
    mocks.localGet(),
    mocks.localSet(),
  ]) {
    m.mockClear();
  }
  sendNativeMessage.mockClear();
}

/** A response that asks for the region, built from the exported field name. */
function asking(pending: PendingResponse["pending"]): PendingResponse {
  return { pending, [bridge.REGION_WANTED_FIELD]: true };
}

/** Every REGION_UPDATE sent to the native host, in order. */
function regionPushes(): Array<Record<string, unknown>> {
  return (sendNativeMessage.mock.calls as Array<[string, Record<string, unknown>]>)
    .filter(([, message]) => message.type === "REGION_UPDATE")
    .map(([, message]) => message);
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
  // The shared runtime mock has no sendNativeMessage; the push is observed through it.
  sendNativeMessage = vi.fn().mockResolvedValue(undefined);
  (browser.runtime as unknown as { sendNativeMessage?: Mock }).sendNativeMessage =
    sendNativeMessage;
});

afterEach(() => {
  delete (browser.runtime as unknown as { sendNativeMessage?: Mock }).sendNativeMessage;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("regionWanted handshake (design §3.3.1)", () => {
  test("1. the flag with pending: null pushes once", async () => {
    await boot(base({ siteLocations: [ENTRY_DUBLIN] }));

    await bridge.adoptPendingResponse(asking(null));
    await flush();

    const pushes = regionPushes();
    expect(pushes).toHaveLength(1);
    expect(JSON.parse(pushes[0].siteLocations as string)).toEqual([ENTRY_DUBLIN]);
    expect(sendNativeMessage).toHaveBeenCalledWith("com.moonloaf.geospoof", pushes[0]);
    // A push, not a save.
    expect(mocks.localSet()).not.toHaveBeenCalled();
    expect(stored().lastUpdated).toBe(1);
  });

  test("2. the flag with a pending snapshot that saves: no extra push", async () => {
    await boot(base());

    await bridge.adoptPendingResponse(
      asking({ updatedAt: T0 / 1000 + 1, siteLocations: JSON.stringify([ENTRY_DUBLIN]) })
    );
    await flush();

    // Adoption saved, and on Safari that save is the push the app receives.
    expect(stored().siteLocations).toEqual([ENTRY_DUBLIN]);
    expect(stored().lastUpdated).toBe(T0);
    expect(regionPushes()).toHaveLength(0);
  });

  test("3. the flag with a snapshot older than lastUpdated: one push", async () => {
    await boot(base({ lastUpdated: T0, siteLocations: [ENTRY_DUBLIN] }));

    await bridge.adoptPendingResponse(
      asking({ updatedAt: T0 / 1000 - 1, siteLocations: JSON.stringify([ENTRY_MEXICO_CITY]) })
    );
    await flush();

    // The older snapshot lost by last-writer-wins, so nothing saved and the push
    // carries Safari's list, not the app's.
    expect(mocks.localSet()).not.toHaveBeenCalled();
    const pushes = regionPushes();
    expect(pushes).toHaveLength(1);
    expect(JSON.parse(pushes[0].siteLocations as string)).toEqual([ENTRY_DUBLIN]);
  });

  test("4. two concurrent calls with the flag push once", async () => {
    await boot(base({ siteLocations: [ENTRY_DUBLIN] }));
    // Hold the first push open so both calls run while it's in flight.
    const landed = deferred<void>();
    sendNativeMessage.mockImplementation(() => landed.promise);

    await Promise.all([
      bridge.adoptPendingResponse(asking(null)),
      bridge.adoptPendingResponse(asking(null)),
    ]);

    expect(regionPushes()).toHaveLength(1);

    // Single-flight, not once ever: once the push settles, a call that still
    // sees the flag (the app didn't store the first one) pushes again.
    landed.resolve();
    await flush();
    await bridge.adoptPendingResponse(asking(null));

    expect(regionPushes()).toHaveLength(2);
  });

  test("5. no flag, no push", async () => {
    await boot(base({ siteLocations: [ENTRY_DUBLIN] }));
    const notAsking: Array<[string, PendingResponse | undefined]> = [
      ["no response", undefined],
      ["pending: null without the field", { pending: null }],
      ["the field false", { pending: null, [bridge.REGION_WANTED_FIELD]: false }],
      [
        "the field a string",
        { pending: null, [bridge.REGION_WANTED_FIELD]: "true" } as unknown as PendingResponse,
      ],
    ];

    for (const [, response] of notAsking) await bridge.adoptPendingResponse(response);
    // Unchanged from before the handshake: no snapshot means no storage access.
    expect(mocks.localGet()).not.toHaveBeenCalled();

    // An adoption pass that saves nothing pushes only when asked.
    await bridge.adoptPendingResponse({ pending: { updatedAt: 0 } });
    await flush();

    expect(mocks.localSet()).not.toHaveBeenCalled();
    expect(regionPushes()).toHaveLength(0);
  });
});
