/**
 * F23: the Firefox bootstrap write window. Before saveSettings writes storage,
 * the early userScripts built from the old settings are removed (bounded
 * wait), nothing registers while the write is in flight, and the scripts for
 * the stored settings are registered after it. A failed write re-registers
 * what's still stored.
 *
 * N is the stored settings with its scripts live; N + 1, N + 2, … are later
 * writes. Each version has its own zone, so the live scripts' inlined zones
 * name the settings they were built from. "Live" is what the userScripts mock
 * has registered right now (the liveUserScripts pattern from
 * bootstrap-plan.test.ts). Storage, register and payload builds can be held
 * with deferreds; 8 and 13 use fake timers.
 */

import { describe, test, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import type { Settings, Timezone } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import {
  deferred,
  flush,
  installUserScriptsMock,
  mocks,
  parseBootstrapPayload,
  until,
  type Deferred,
  type UserScriptsMock,
} from "../../helpers/cadence";
import {
  DUBLIN_TZ,
  MEXICO_CITY_TZ,
  TOKYO,
  TOKYO_NAME,
  TOKYO_TZ,
  makeSiteLocation,
} from "../../helpers/site-locations";

type Registration = Record<string, unknown> & { id: string; js: Array<{ code: string }> };

const PARIS_TZ: Timezone = { identifier: "Europe/Paris", offset: -60, dstOffset: 60 };
const SYDNEY_TZ: Timezone = { identifier: "Australia/Sydney", offset: -600, dstOffset: 60 };

/** The zone each version's scripts inline. */
const Z = {
  OLDER: SYDNEY_TZ.identifier,
  N: TOKYO_TZ.identifier,
  N1: DUBLIN_TZ.identifier,
  N2: MEXICO_CITY_TZ.identifier,
  N3: PARIS_TZ.identifier,
} as const;

/** N's stored revision. Saves stamp later ones (Date.now()). */
const R = 1_000;

function version(timezone: Timezone, overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    onboardingCompleted: true,
    location: TOKYO,
    timezone,
    locationName: TOKYO_NAME,
    locationPrecision: { mode: "exact" },
    accuracySeed: 777,
    precisionSeed: 123456789,
    ...overrides,
  };
}

/** N − 1: older than the stored settings. */
const OLDER = () => version(SYDNEY_TZ, { revision: R - 1 });
/** The stored settings. */
const N = () => version(TOKYO_TZ, { revision: R });
// Later writes; saveSettings stamps their revision.
const N1 = () => version(DUBLIN_TZ);
const N2 = () => version(MEXICO_CITY_TZ);
const N3 = () => version(PARIS_TZ);

// ─────────────────────────────── harness ───────────────────────────────

/** userScripts and storage.local.set calls, in order. */
let log: string[];
/** The scripts registered right now. */
let live: Registration[];
/** The live zones at each storage.local.set call. */
let liveAtSet: string[][];
/** The zone of each bootstrap payload build started. */
let builds: string[];
let stored: Settings | undefined;
let userScripts: UserScriptsMock | null;
let warn: MockInstance<typeof console.warn>;

// One-shot holds, consumed by the next call.
let buildHold: Promise<void> | null;
let registerHold: Promise<void> | null;
let setHold: Promise<void> | null;
/** How many of the next calls reject. */
let unregisterFailures: number;
let setFailures: number;
let getFailures: number;
/** Real-timer delay for every storage.local.set (interleaving 10). */
let setDelayMs: number;

function zonesOf(scripts: Registration[]): string[] {
  return scripts.map((r) => (parseBootstrapPayload(r.js[0].code).timezone as Timezone).identifier);
}

const liveZones = (): string[] => zonesOf(live);

/** The zones of each register batch. */
function registeredZones(): string[][] {
  return userScripts!.register.mock.calls.map((c) => zonesOf(c[0] as Registration[]));
}

const setCount = (): number => log.filter((e) => e === "set").length;

/** `[bootstrap]` WARN messages (the logger's prefix is arg 0). */
function bootstrapWarns(): string[] {
  return warn.mock.calls
    .map((c): unknown => c[1])
    .filter((m): m is string => typeof m === "string" && m.startsWith("[bootstrap]"));
}

function holdNextBuild(): Deferred<void> {
  const d = deferred<void>();
  buildHold = d.promise;
  return d;
}

function holdNextRegister(): Deferred<void> {
  const d = deferred<void>();
  registerHold = d.promise;
  return d;
}

function holdNextSet(): Deferred<void> {
  const d = deferred<void>();
  setHold = d.promise;
  return d;
}

/** Install the userScripts mock: register adds to `live` when it settles, unregister clears it. */
function installUserScripts(): void {
  userScripts = installUserScriptsMock();
  userScripts.register.mockImplementation(async (scripts: Array<Record<string, unknown>>) => {
    log.push("register");
    const h = registerHold;
    registerHold = null;
    if (h) await h;
    live = [...live, ...(scripts as Registration[])];
  });
  userScripts.unregister.mockImplementation(() => {
    log.push("unregister");
    if (unregisterFailures > 0) {
      unregisterFailures--;
      return Promise.reject(new Error("userScripts.unregister failed"));
    }
    live = [];
    return Promise.resolve();
  });
}

/** A single stateful settings slot; a set stores when it settles. */
function installStorage(initial: Settings): void {
  stored = structuredClone(initial);
  browser.storage.local.get = vi.fn(() => {
    if (getFailures > 0) {
      getFailures--;
      return Promise.reject(new Error("storage read failed"));
    }
    return Promise.resolve({ settings: structuredClone(stored) });
  });
  browser.storage.local.set = vi.fn(async (obj: { settings?: Settings }) => {
    if (!obj.settings) return;
    log.push("set");
    liveAtSet.push(liveZones());
    const snapshot = structuredClone(obj.settings);
    if (setDelayMs > 0) await new Promise((r) => setTimeout(r, setDelayMs));
    const h = setHold;
    setHold = null;
    if (h) await h;
    if (setFailures > 0) {
      setFailures--;
      throw new Error("disk I/O error");
    }
    stored = snapshot;
  });
}

/** Fresh settings + registrar modules, with buildBootstrapPayload holdable. */
async function importModules() {
  vi.resetModules();
  vi.doMock("@/background/page-payload", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/background/page-payload")>();
    return {
      ...actual,
      buildBootstrapPayload: async (s: Settings) => {
        builds.push(s.timezone?.identifier ?? "none");
        const h = buildHold;
        buildHold = null;
        if (h) await h;
        return actual.buildBootstrapPayload(s);
      },
    };
  });
  const s = await import("@/background/settings");
  const reg = await import("@/background/bootstrap-register");
  return { s, reg };
}

/** N stored and its scripts live (as initialize leaves them), with the logs cleared. */
async function startWithNLive() {
  installStorage(N());
  installUserScripts();
  const mods = await importModules();
  await mods.reg.updateBootstrapRegistration(N());
  expect(liveZones()).toEqual([Z.N]);
  log.length = 0;
  userScripts!.register.mockClear();
  return mods;
}

/** One more successful save, whose scripts must be live (the window closed). */
async function expectNextSaveLive(
  s: typeof import("@/background/settings"),
  next: Settings,
  zone: string
): Promise<void> {
  await s.saveSettings(next);
  await flush();
  expect(liveZones(), "the next save's scripts are live").toEqual([zone]);
}

/** Fake-timer tick: run timers due within `ms`, yielding to pending promise callbacks. */
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  log = [];
  live = [];
  liveAtSet = [];
  builds = [];
  stored = undefined;
  userScripts = null;
  buildHold = null;
  registerHold = null;
  setHold = null;
  unregisterFailures = 0;
  setFailures = 0;
  getFailures = 0;
  setDelayMs = 0;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // Failed saves and reads log at ERROR.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  userScripts?.restore();
  vi.doUnmock("@/background/page-payload");
  vi.restoreAllMocks();
});

// ─────────────────────────────── interleavings ───────────────────────────────

describe("the bootstrap write window (F23)", () => {
  test("1. idle queue, set held: nothing is live at set; N + 1 after it", async () => {
    const { s } = await startWithNLive();
    const gate = holdNextSet();
    const save = s.saveSettings(N1());
    await until(() => setCount() === 1, "set");
    expect(liveAtSet).toEqual([[]]);

    gate.resolve();
    await save;
    await flush();
    expect(liveZones()).toEqual([Z.N1]);
    // The window's removal, the write, then the registration for N + 1.
    expect(log).toEqual(["unregister", "set", "unregister", "register"]);
  });

  test("2. register(N) in flight: set waits; N's batch is removed, then the removal, then set", async () => {
    installStorage(N());
    installUserScripts();
    const { s, reg } = await importModules();
    const registering = holdNextRegister();
    const first = reg.updateBootstrapRegistration(N());
    await until(() => log.includes("register"), "register(N)");

    const save = s.saveSettings(N1());
    await flush();
    expect(log, "set isn't called while register is held").toEqual(["unregister", "register"]);

    registering.resolve();
    await Promise.all([first, save]);
    expect(log.slice(0, 5)).toEqual([
      "unregister",
      "register",
      "unregister", // the post-register check removes N's batch
      "unregister", // the window's removal job
      "set",
    ]);
    expect(liveAtSet).toEqual([[]]);
    await flush();
    expect(liveZones()).toEqual([Z.N1]);
  });

  test("3. N's payload build held, then a write: N never registers", async () => {
    installStorage(N());
    installUserScripts();
    const { s, reg } = await importModules();
    const building = holdNextBuild();
    const first = reg.updateBootstrapRegistration(N());
    await until(() => builds.length === 1, "N's build");

    const save = s.saveSettings(N1());
    building.resolve();
    await Promise.all([first, save]);
    await flush();
    expect(registeredZones()).toEqual([[Z.N1]]);
    expect(liveZones()).toEqual([Z.N1]);
  });

  test("4. N queued behind a held N − 1 build, then a write: neither old job registers", async () => {
    installStorage(N());
    installUserScripts();
    const { s, reg } = await importModules();
    const building = holdNextBuild();
    const older = reg.updateBootstrapRegistration(OLDER());
    await until(() => builds.length === 1, "N − 1's build");
    const queued = reg.updateBootstrapRegistration(N());

    const save = s.saveSettings(N1());
    building.resolve();
    await Promise.all([older, queued, save]);
    await flush();
    expect(registeredZones()).toEqual([[Z.N1]]);
    expect(liveZones()).toEqual([Z.N1]);
  });

  test("5. the removal unregister rejects once: WARN, and the save proceeds", async () => {
    const { s } = await startWithNLive();
    unregisterFailures = 1;
    await s.saveSettings(N1());
    expect(bootstrapWarns()).toEqual([
      "[bootstrap] couldn't remove the early scripts before a settings write (continuing):",
    ]);
    expect(setCount()).toBe(1);
    await flush();
    expect(liveZones()).toEqual([Z.N1]);

    await expectNextSaveLive(s, N2(), Z.N2);
  });

  test("6. set rejects: the save rejects and N's scripts are registered again", async () => {
    const { s } = await startWithNLive();
    setFailures = 1;
    await expect(s.saveSettings(N1())).rejects.toThrow("disk I/O error");
    await flush();
    expect(liveZones()).toEqual([Z.N]);
    expect(registeredZones(), "N + 1 is never registered").toEqual([[Z.N]]);

    await expectNextSaveLive(s, N2(), Z.N2);
  });

  test("7. set rejects and the recovery read returns the defaults: no scripts are live", async () => {
    const { s } = await startWithNLive();
    setFailures = 1;
    getFailures = 1; // the window's re-register read
    await expect(s.saveSettings(N1())).rejects.toThrow("disk I/O error");
    await flush();
    expect(liveZones()).toEqual([]);

    await expectNextSaveLive(s, N2(), Z.N2);
  });

  test("8. register(N) never settles: one save waits 1000 ms, the next doesn't wait", async () => {
    vi.useFakeTimers();
    installStorage(N());
    installUserScripts();
    const { s, reg } = await importModules();
    const hang = holdNextRegister();
    void reg.updateBootstrapRegistration(N());
    await tick();
    expect(log).toEqual(["unregister", "register"]);

    const first = s.saveSettings(N1());
    await tick(999);
    expect(setCount(), "still waiting at 999 ms").toBe(0);
    await tick(1);
    expect(setCount(), "stored at 1000 ms").toBe(1);
    await first;
    expect(bootstrapWarns()).toEqual([
      "[bootstrap] userScripts didn't answer within 1000 ms; storing the settings without waiting",
    ]);

    const second = s.saveSettings(N2());
    await tick();
    expect(setCount(), "N + 2 doesn't wait").toBe(2);
    await second;
    expect(bootstrapWarns()).toHaveLength(1);

    hang.resolve();
    await tick();
    expect(liveZones()).toEqual([Z.N2]);

    // The stall has cleared, so the next save waits for its removal again.
    const mark = log.length;
    const third = s.saveSettings(N3());
    await tick();
    await third;
    await tick();
    expect(log.slice(mark, mark + 2), "N + 3's removal comes before its set").toEqual([
      "unregister",
      "set",
    ]);
    expect(liveZones()).toEqual([Z.N3]);
  });

  test("9. a stale caller during the write registers nothing, and is skipped after it", async () => {
    const { s, reg } = await startWithNLive();
    const gate = holdNextSet();
    const save = s.saveSettings(N1());
    await until(() => setCount() === 1, "set");

    await reg.updateBootstrapRegistration(N());
    expect(
      userScripts!.register,
      "nothing registers while the write is open"
    ).not.toHaveBeenCalled();

    gate.resolve();
    await save;
    await flush();
    expect(liveZones()).toEqual([Z.N1]);

    await reg.updateBootstrapRegistration(N());
    expect(liveZones(), "N is older than N + 1: skipped").toEqual([Z.N1]);
  });

  test("10. two writes back to back through updateSettings: nothing is live at either set", async () => {
    const { s } = await startWithNLive();
    setDelayMs = 5;
    await Promise.all([
      s.updateSettings({ timezone: DUBLIN_TZ }),
      s.updateSettings({ timezone: MEXICO_CITY_TZ }),
    ]);
    await flush();
    expect(liveAtSet).toEqual([[], []]);
    expect(liveZones()).toEqual([Z.N2]);
  });

  test("11. no save: an overtaken register removes its batch before the next build", async () => {
    installStorage(N());
    installUserScripts();
    const { reg } = await importModules();
    const registering = holdNextRegister();
    const first = reg.updateBootstrapRegistration(N());
    await until(() => log.includes("register"), "register(N)");

    const building = holdNextBuild();
    const second = reg.updateBootstrapRegistration(version(DUBLIN_TZ, { revision: R + 1 }));
    registering.resolve();
    await until(() => builds.length === 2, "N′'s build");

    // The post-register check's unregister, then N′'s leading one.
    expect(log.slice(log.indexOf("register") + 1)).toEqual(["unregister", "unregister"]);
    expect(liveZones(), "nothing live while N′ builds").toEqual([]);

    building.resolve();
    await Promise.all([first, second]);
    expect(liveZones()).toEqual([Z.N1]);
  });

  test("12. userScripts absent: no userScripts calls and one set", async () => {
    installStorage(N());
    const { s } = await importModules();
    await s.saveSettings(N1());
    await flush();
    expect(log).toEqual(["set"]);
    expect(mocks.localSet()).toHaveBeenCalledTimes(1);
  });

  test("13. deadlock smoke: with register hung, settings, Filters and site-location writes resolve after 1000 ms", async () => {
    vi.useFakeTimers();
    const ENTRY = makeSiteLocation({ id: "e1", patterns: ["chatgpt.com"] });
    installStorage(version(TOKYO_TZ, { revision: R, siteLocations: [ENTRY] }));
    installUserScripts();
    registerHold = new Promise<void>(() => {}); // never settles
    vi.resetModules();
    const bg = await import("@/background");
    const reg = await import("@/background/bootstrap-register");
    await tick();
    void reg.updateBootstrapRegistration(stored!);
    await tick();
    expect(log).toContain("register");

    const settled: string[] = [];
    const track = <T>(name: string, p: Promise<T>): Promise<T> =>
      p.then((v) => {
        settled.push(name);
        return v;
      });
    const results = Promise.all([
      track("updateSettings", bg.updateSettings({ theme: "dark" })),
      track("handleAddScopeSite", bg.handleAddScopeSite({ list: "allowlist", pattern: "a.test" })),
      // A pattern-only edit: no timezone or place-name lookup.
      track(
        "handleSaveSiteLocation",
        bg.handleSaveSiteLocation({
          id: "e1",
          patterns: ["chatgpt.com", "openai.com"],
          latitude: ENTRY.location.latitude,
          longitude: ENTRY.location.longitude,
        })
      ),
    ]);

    await tick(1000);
    await tick();
    expect(settled.sort()).toEqual([
      "handleAddScopeSite",
      "handleSaveSiteLocation",
      "updateSettings",
    ]);
    const [, scope, site] = await results;
    expect(scope).toEqual({ success: true });
    expect(site).toEqual({ success: true, id: "e1" });
    expect(stored!.theme).toBe("dark");
    expect(stored!.allowlist).toEqual(["a.test"]);
    expect(stored!.siteLocations[0].patterns).toEqual(["chatgpt.com", "openai.com"]);
  });

  test("14. a permission grant during the write: nothing registers until it's stored", async () => {
    installStorage(N());
    const { s, reg } = await importModules();
    const gate = holdNextSet();
    const save = s.saveSettings(N1());
    await until(() => setCount() === 1, "set");

    // What the permissions.onAdded listener does.
    installUserScripts();
    await reg.updateBootstrapRegistration(await s.loadSettings());
    expect(
      userScripts!.register,
      "nothing registers while the write is open"
    ).not.toHaveBeenCalled();

    gate.resolve();
    await save;
    await flush();
    expect(liveZones()).toEqual([Z.N1]);
  });

  test("15. the post-register unregister rejects: WARN, and the removal still runs before set", async () => {
    installStorage(N());
    installUserScripts();
    const { s, reg } = await importModules();
    const registering = holdNextRegister();
    const first = reg.updateBootstrapRegistration(N());
    await until(() => log.includes("register"), "register(N)");

    const save = s.saveSettings(N1());
    unregisterFailures = 1; // the post-register check's call
    registering.resolve();
    await Promise.all([first, save]);

    expect(bootstrapWarns()).toEqual(["[bootstrap] registration failed (continuing without it):"]);
    expect(log.slice(0, 5)).toEqual([
      "unregister",
      "register",
      "unregister", // the post-register check (rejects)
      "unregister", // the window's removal job
      "set",
    ]);
    expect(liveAtSet).toEqual([[]]);
    await flush();
    expect(liveZones()).toEqual([Z.N1]);

    await expectNextSaveLive(s, N2(), Z.N2);
  });

  test("16. userScripts removed mid-write, then set rejects: the window still closes", async () => {
    const { s } = await startWithNLive();
    const gate = holdNextSet();
    const save = s.saveSettings(N1());
    await until(() => setCount() === 1, "set");

    userScripts!.restore(); // permission revoked during the write
    gate.reject(new Error("disk I/O error"));
    await expect(save).rejects.toThrow("disk I/O error");

    installUserScripts(); // granted again
    await expectNextSaveLive(s, N2(), Z.N2);
  });
});
