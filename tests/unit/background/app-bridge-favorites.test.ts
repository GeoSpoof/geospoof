/**
 * Safari app bridge, inbound: adoption step 4 (`favorites`).
 *
 * The app and the extension share one capacity (MAX_FAVORITES). Adoption used to
 * cut the app's list at 10, so a user with more favorites in the app silently
 * lost the rest in Safari. These tests drive the exported adoptPendingSnapshot
 * directly (Vitest compiles `__SAFARI__` to `false`, which removes the native
 * fetch), with snapshots stamped just past the fixed clock so they always win.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { Favorite, Settings } from "@/shared/types/settings";
import { MAX_FAVORITES } from "@/shared/types/settings";
import type { PendingSettings } from "@/background/app-bridge";
import { storageData } from "../../setup";
import { flush, makeCadenceSettings, mocks } from "../../helpers/cadence";

type AppBridge = typeof import("@/background/app-bridge");

const T0 = 1_700_000_000_000;

let bridge: AppBridge;
let snapshotSeq = 0;

/** Import a fresh background with `settings` stored and let its spawn check settle. */
async function boot(settings: Settings): Promise<void> {
  storageData.settings = settings;
  mocks.alarmsGet().mockResolvedValue({ name: "precision-rollover", scheduledTime: T0 + 600_000 });
  vi.resetModules();
  await import("@/background");
  bridge = await import("@/background/app-bridge");
  await flush();
}

/** Adopt an app snapshot stamped just after the last one (and after any save). */
function adopt(fields: Record<string, unknown>): Promise<void> {
  snapshotSeq += 1;
  const snapshot: PendingSettings = { updatedAt: T0 / 1000 + snapshotSeq, ...fields };
  return bridge.adoptPendingSnapshot(snapshot);
}

/** `count` valid, distinct favorites, as the app would encode them. */
function makeFavorites(count: number): Favorite[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(1_600_000_000_000 + i),
    latitude: 10 + i * 0.5,
    longitude: 20 + i * 0.5,
    city: `City ${i}`,
    country: "Country",
    displayName: `City ${i}, Country`,
    label: null,
  }));
}

const storedFavorites = (): Favorite[] => (storageData.settings as Settings).favorites;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.spyOn(console, "warn").mockImplementation(() => {});
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

describe("adopting the app's favorites keeps up to MAX_FAVORITES", () => {
  test.each([11, MAX_FAVORITES])("%i favorites are all kept, in order", async (count) => {
    await boot(makeCadenceSettings({ favorites: [] }));
    const favorites = makeFavorites(count);

    await adopt({ favorites: JSON.stringify(favorites) });

    expect(storedFavorites()).toEqual(favorites);
  });

  test("one over capacity keeps the first MAX_FAVORITES", async () => {
    await boot(makeCadenceSettings({ favorites: [] }));
    const favorites = makeFavorites(MAX_FAVORITES + 1);

    await adopt({ favorites: JSON.stringify(favorites) });

    expect(storedFavorites()).toEqual(favorites.slice(0, MAX_FAVORITES));
  });
});
