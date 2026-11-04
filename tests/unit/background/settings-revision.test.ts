/**
 * F22: the settings revision. Every save issues one strictly greater than any
 * this background has stored, loaded, or issued, stamps it on the object it
 * stores, and puts the old one back when the write fails, so no snapshot a
 * caller keeps carries a revision that isn't stored.
 *
 * Most tests import `@/background/settings` on its own after vi.resetModules()
 * (a restart). Importing `@/background` would run its spawn-time
 * `loadSettings()`, which raises the revision floor or consumes a one-shot
 * read failure. The initialize test imports the whole background.
 *
 * Storage is one stateful slot. `setFailures` makes the next set calls reject
 * (storage keeps its value); `getFailures` does the same for reads.
 */

import { describe, test, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import fc from "fast-check";
import type { Settings } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import type { Message, UpdateSettingsMessage } from "@/shared/types/messages";
import { installUserScriptsMock } from "../../helpers/cadence";
import { TOKYO, TOKYO_NAME, TOKYO_TZ } from "../../helpers/site-locations";

type SettingsModule = typeof import("@/background/settings");

const T = 1_800_000_000_000;
const MAX = Number.MAX_SAFE_INTEGER;

/** The single persisted settings slot. */
let stored: Settings | undefined;
/** The storage.local.remove mock (the Safari quota retry's first step). */
let removeSpy: Mock;
/** The revision on each settings object passed to storage.local.set, failed calls included. */
let setRevisions: Array<number | undefined>;
/** Errors the next storage.local.set calls reject with, in order. */
let setFailures: Error[];
/** How many of the next storage.local.get calls reject. */
let getFailures: number;

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    onboardingCompleted: true,
    accuracySeed: 777,
    precisionSeed: 123456789,
    ...overrides,
  };
}

function installStorage(initial: Settings | undefined): void {
  stored = structuredClone(initial);
  setRevisions = [];
  setFailures = [];
  getFailures = 0;
  browser.storage.local.get = vi.fn(() => {
    if (getFailures > 0) {
      getFailures--;
      return Promise.reject(new Error("storage read failed"));
    }
    return Promise.resolve({ settings: structuredClone(stored) });
  });
  browser.storage.local.set = vi.fn((obj: { settings?: Settings }) => {
    if (!obj.settings) return Promise.resolve();
    setRevisions.push(obj.settings.revision);
    const failure = setFailures.shift();
    if (failure) return Promise.reject(failure);
    stored = structuredClone(obj.settings);
    return Promise.resolve();
  });
  removeSpy = vi.fn(() => {
    stored = undefined;
    return Promise.resolve();
  });
  browser.storage.local.remove = removeSpy;
}

/** A fresh settings module, as after a background restart. */
async function importSettings(): Promise<SettingsModule> {
  vi.resetModules();
  return import("@/background/settings");
}

function clockAt(ms: number): void {
  vi.spyOn(Date, "now").mockReturnValue(ms);
}

beforeEach(() => {
  // Failed saves log at ERROR; keep the output readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("issuing a revision", () => {
  test("two saves in one millisecond get R and R + 1", async () => {
    installStorage(makeSettings());
    clockAt(T);
    const s = await importSettings();
    await s.updateSettings({ theme: "dark" });
    await s.updateSettings({ theme: "light" });
    expect(setRevisions).toEqual([T, T + 1]);
    expect(stored?.revision).toBe(T + 1);
  });

  test("after a restart with the clock behind the stored revision, the next save is stored + 1", async () => {
    const R = T + 60_000;
    installStorage(makeSettings({ revision: R }));
    clockAt(T);
    const s = await importSettings();
    await s.updateSettings({ theme: "dark" });
    expect(stored?.revision).toBe(R + 1);

    const restarted = await importSettings();
    await restarted.updateSettings({ theme: "light" });
    expect(stored?.revision).toBe(R + 2);
  });

  test("a failed write doesn't lower the next revision", async () => {
    const R = T + 60_000;
    installStorage(makeSettings({ revision: R }));
    clockAt(T);
    const s = await importSettings();
    setFailures.push(new Error("disk I/O error"));
    await expect(s.updateSettings({ theme: "dark" })).rejects.toThrow("disk I/O error");
    expect(stored?.revision).toBe(R);

    await s.updateSettings({ theme: "light" });
    expect(setRevisions).toEqual([R + 1, R + 2]);
    expect(stored?.revision).toBe(R + 2);
  });

  test("the Safari quota retry writes the same revision both times", async () => {
    installStorage(makeSettings({ revision: T - 5 }));
    clockAt(T);
    const s = await importSettings();
    setFailures.push(new Error("QuotaExceededError: Exceeded storage quota"));
    await s.updateSettings({ theme: "dark" });
    expect(removeSpy).toHaveBeenCalledWith("settings");
    expect(setRevisions).toEqual([T, T]);
    expect(stored?.revision).toBe(T);
  });

  test("a save whose set rejects restores the object's revision, and the next one still advances", async () => {
    const R = T + 60_000;
    installStorage(makeSettings({ revision: R }));
    clockAt(T);
    const s = await importSettings();
    let given: Settings | undefined;
    setFailures.push(new Error("disk I/O error"));
    await expect(
      s.runSettingsWrite(async () => {
        given = await s.loadSettings();
        await s.saveSettings(given);
      })
    ).rejects.toThrow("disk I/O error");

    expect(setRevisions).toEqual([R + 1]);
    expect(given?.revision).toBe(R);
    expect(stored?.revision).toBe(R);
    expect(s.nextSettingsRevision(given?.revision)).toBe(R + 2);
  });

  test("at MAX_SAFE_INTEGER the revision stays there and reloads unrepaired", async () => {
    installStorage(makeSettings({ revision: MAX }));
    const s = await importSettings();
    await s.updateSettings({ theme: "dark" });
    await s.updateSettings({ theme: "light" });
    expect(setRevisions).toEqual([MAX, MAX]);

    const restarted = await importSettings();
    expect((await restarted.loadSettings()).revision).toBe(MAX);
  });

  test("MAX_SAFE_INTEGER - 1 stored: the next revision is MAX_SAFE_INTEGER", async () => {
    installStorage(makeSettings({ revision: MAX - 1 }));
    const s = await importSettings();
    await s.updateSettings({ theme: "dark" });
    expect(stored?.revision).toBe(MAX);
  });

  // A supplied revision above the stored one would be issued from (MAX here)
  // if the helpers didn't pin it; one below is covered by the floor anyway.
  test.each([
    ["updateSettings, revision 1", (s: SettingsModule) => s.updateSettings({ revision: 1 })],
    [
      "updateSettingsWith, revision 1",
      (s: SettingsModule) => s.updateSettingsWith(() => ({ revision: 1 })),
    ],
    ["updateSettings, revision MAX", (s: SettingsModule) => s.updateSettings({ revision: MAX })],
    [
      "updateSettingsWith, revision MAX",
      (s: SettingsModule) => s.updateSettingsWith(() => ({ revision: MAX })),
    ],
  ])("%s: an update can't supply the revision", async (_label, write) => {
    const R = T + 60_000;
    installStorage(makeSettings({ revision: R }));
    clockAt(T);
    const s = await importSettings();
    await write(s);
    expect(stored?.revision).toBe(R + 1);
  });
});

describe("validateSettings", () => {
  test.each([
    ["absent", undefined, 0],
    ["negative", -1, 0],
    ["fractional", 1.5, 0],
    ["unsafe-large", 2 ** 53, 0],
    ["NaN", NaN, 0],
    ["Infinity", Infinity, 0],
    ["a string", "5", 0],
    ["zero", 0, 0],
    ["valid", T, T],
    ["MAX_SAFE_INTEGER", MAX, MAX],
  ])("%s revision -> %s", async (_label, value, expected) => {
    const s = await importSettings();
    expect(s.validateSettings({ revision: value } as unknown as Partial<Settings>).revision).toBe(
      expected
    );
  });
});

describe("never bridged", () => {
  test("pushRegionNow sends today's REGION_UPDATE keys, with no revision and no lastUpdated", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const runtime = browser.runtime as unknown as { sendNativeMessage?: unknown };
    runtime.sendNativeMessage = send;
    try {
      const s = await importSettings();
      await s.pushRegionNow(makeSettings({ revision: T, lastUpdated: T }));
      expect(send).toHaveBeenCalledTimes(1);
      const message = send.mock.calls[0][1] as Record<string, unknown>;
      // The list from app-bridge-precision.test.ts AC 1.
      expect(Object.keys(message)).toEqual([
        "type",
        "enabled",
        "locationName",
        "location",
        "timezone",
        "webrtcProtection",
        "preserveGeolocationPrompt",
        "vpnSyncEnabled",
        "ip",
        "favorites",
        "scopeMode",
        "allowlist",
        "denylist",
        "accuracySetting",
        "locationPrecision",
        "precisionCadence",
        "localeSpoofing",
        "siteLocations",
      ]);
      expect(message).not.toHaveProperty("revision");
      expect(message).not.toHaveProperty("lastUpdated");
    } finally {
      delete runtime.sendNativeMessage;
    }
  });
});

describe("a read that fails inside a write", () => {
  test("still issues more than the revision loaded earlier", async () => {
    const R = T;
    installStorage(makeSettings({ revision: R }));
    clockAt(R - 10_000);
    const s = await importSettings();
    await s.loadSettings();
    getFailures = 1;
    // The write merges into the defaults (revision 0), the pre-existing
    // data-loss bug; the floor keeps the revision from going down with it.
    await s.updateSettings({ theme: "dark" });
    expect(stored?.revision).toBe(R + 1);
  });

  test("with no successful read since the restart, the revision goes backwards (the documented residual)", async () => {
    const R = T;
    installStorage(makeSettings({ revision: R }));
    clockAt(R - 10_000);
    const s = await importSettings();
    getFailures = 1;
    await s.updateSettings({ theme: "dark" });
    expect(stored?.revision).toBe(R - 10_000);
  });
});

describe("property", () => {
  type Command =
    | { kind: "clock"; at: number }
    | { kind: "save" }
    | { kind: "failingSave" }
    | { kind: "restart" };

  // A narrow clock range, so same-millisecond saves and a clock behind the
  // revision are common.
  const clockValue = fc.integer({ min: T - 50, max: T + 50 });
  const command: fc.Arbitrary<Command> = fc.oneof(
    clockValue.map((at): Command => ({ kind: "clock", at })),
    fc.constant<Command>({ kind: "save" }),
    fc.constant<Command>({ kind: "failingSave" }),
    fc.constant<Command>({ kind: "restart" })
  );

  test("stored revisions strictly increase, and a failing save leaves a stored revision on its object", async () => {
    await fc.assert(
      fc.asyncProperty(
        clockValue,
        clockValue,
        fc.array(command, { maxLength: 20 }),
        async (start, firstClock, commands) => {
          installStorage(makeSettings({ revision: start }));
          let now = firstClock;
          const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
          try {
            let s = await importSettings();
            const storedHistory: number[] = [start];
            for (const c of commands) {
              if (c.kind === "clock") {
                now = c.at;
              } else if (c.kind === "restart") {
                s = await importSettings();
              } else if (c.kind === "save") {
                await s.updateSettings({ theme: stored?.theme === "dark" ? "light" : "dark" });
                const r = stored!.revision!;
                expect(r).toBeGreaterThan(storedHistory.at(-1)!);
                storedHistory.push(r);
              } else {
                // Never a quota message: the remove-and-set retry could clear
                // storage, which is the documented way down.
                setFailures.push(new Error("disk I/O error"));
                let given: Settings | undefined;
                await expect(
                  s.runSettingsWrite(async () => {
                    given = await s.loadSettings();
                    await s.saveSettings(given);
                  })
                ).rejects.toThrow("disk I/O error");
                expect(storedHistory).toContain(given!.revision);
                expect(stored!.revision).toBe(storedHistory.at(-1));
              }
            }
          } finally {
            clock.mockRestore();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe("initialize after a failed migration save", () => {
  afterEach(() => {
    vi.doUnmock("@/background/worker-request-filter");
  });

  test("delivers the stored revision, and a later bootstrap refresh isn't skipped", async () => {
    const R = T;
    installStorage(
      makeSettings({
        version: "1.1",
        revision: R,
        enabled: true,
        location: TOKYO,
        timezone: TOKYO_TZ,
        locationName: TOKYO_NAME,
      })
    );
    clockAt(R + 5_000);
    // Only the migration save fails.
    setFailures.push(new Error("disk I/O error"));

    const envelopes: UpdateSettingsMessage[] = [];
    browser.tabs.query = vi.fn().mockResolvedValue([{ id: 1, url: "https://example.com/" }]);
    browser.tabs.sendMessage = vi.fn((_tabId: number, message: Message) => {
      if (message.type === "UPDATE_SETTINGS") envelopes.push(message as UpdateSettingsMessage);
      return Promise.resolve();
    });

    vi.resetModules();
    const filterSnapshots: Settings[] = [];
    vi.doMock("@/background/worker-request-filter", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/background/worker-request-filter")>();
      return {
        ...actual,
        updateWorkerFilterSettings: (s: Settings) => {
          filterSnapshots.push(structuredClone(s));
          actual.updateWorkerFilterSettings(s);
        },
      };
    });
    const userScripts = installUserScriptsMock();
    try {
      const bg = await import("@/background");
      await bg.initialize();

      expect(setRevisions).toEqual([R + 5_000]);
      expect(stored?.revision).toBe(R);
      // Soft, so a regression reports every delivery that carried the unstored revision.
      expect(envelopes.length).toBeGreaterThan(0);
      for (const e of envelopes) expect.soft(e.revision, "UPDATE_SETTINGS envelope").toBe(R);
      expect(filterSnapshots.length).toBeGreaterThan(0);
      for (const f of filterSnapshots) expect.soft(f.revision, "worker-filter snapshot").toBe(R);

      // What the rollover does: a refresh from storage registers.
      const { updateBootstrapRegistration } = await import("@/background/bootstrap-register");
      userScripts.register.mockClear();
      await updateBootstrapRegistration(await bg.loadSettings());
      expect.soft(userScripts.register, "bootstrap refresh registered").toHaveBeenCalledTimes(1);
    } finally {
      userScripts.restore();
    }
  });
});
