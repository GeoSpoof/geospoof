/**
 * Shared helpers for the location-precision cadence tests. Not a `*.test.ts`
 * file, so Vitest doesn't collect it.
 */

import { vi, type Mock } from "vitest";
import type { Settings, PrecisionCadence } from "@/shared/types/settings";
import { sessionStorageData } from "../setup";

export const CADENCE_ANCHOR = { latitude: 37.7749, longitude: -122.4194, accuracy: 42 } as const;
export const CADENCE_SEED = 123456789;

/** A full Settings object: protection on, an approximate 2 km radius, and the hour cadence. */
export function makeCadenceSettings(overrides?: Partial<Settings>): Settings {
  return {
    enabled: true,
    location: { ...CADENCE_ANCHOR },
    timezone: { identifier: "America/Los_Angeles", offset: 480, dstOffset: 60 },
    locationName: { city: "San Francisco", country: "US", displayName: "San Francisco, US" },
    webrtcProtection: false,
    preserveGeolocationPrompt: false,
    onboardingCompleted: true,
    version: "1.2",
    lastUpdated: 1,
    vpnSyncEnabled: false,
    debuggerModeEnabled: false,
    autoSyncBlocked: false,
    proFeaturesBlocked: false,
    debugLogging: false,
    verbosityLevel: "INFO",
    theme: "system",
    uiLanguage: "",
    favorites: [],
    scopeMode: "all",
    allowlist: [],
    denylist: [],
    accuracySetting: { mode: "auto" },
    accuracySeed: 777,
    locationPrecision: { mode: "approximate", radiusMeters: 2000 },
    precisionSeed: CADENCE_SEED,
    precisionCadence: "hour",
    localeSpoofing: { mode: "off" },
    ...overrides,
  };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Write a held-bucket record straight into the mocked storage.session. */
export function seedHeldBucket(
  cadence: Exclude<PrecisionCadence, "never" | "session">,
  seed: number,
  index: number
): void {
  sessionStorageData["cache:precisionCadence:bucket"] = { cadence, seed, index };
}

/** Write a session id straight into the mocked storage.session. */
export function seedSessionId(id: unknown): void {
  sessionStorageData["cache:precisionCadence:session"] = id;
}

export interface UserScriptsMock {
  register: Mock;
  unregister: Mock;
  /** Call order across register/unregister. */
  log: string[];
  restore: () => void;
}

/** Install a minimal Firefox `userScripts` stand-in (absent in jsdom). */
export function installUserScriptsMock(): UserScriptsMock {
  const log: string[] = [];
  const register = vi.fn((_scripts: Array<Record<string, unknown>>) => {
    log.push("register");
    return Promise.resolve();
  });
  const unregister = vi.fn((_filter?: { ids?: string[] }) => {
    log.push("unregister");
    return Promise.resolve();
  });
  (browser as unknown as { userScripts?: unknown }).userScripts = { register, unregister };
  return {
    register,
    unregister,
    log,
    restore: () => {
      delete (browser as unknown as { userScripts?: unknown }).userScripts;
    },
  };
}

/** The payload the bootstrap code inlines, parsed back out of `buildBootstrapCode` output. */
export function parseBootstrapPayload(code: string): Record<string, unknown> {
  const match = /\{value:(\{.*\}),configurable:true/s.exec(code);
  if (!match) throw new Error(`could not extract bootstrap payload from: ${code.slice(0, 200)}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

/** The inlined payload of the most recent `userScripts.register` call. */
export function lastRegisteredPayload(register: Mock): Record<string, unknown> {
  const calls = register.mock.calls as Array<[Array<{ js: Array<{ code: string }> }>]>;
  const last = calls.at(-1);
  if (!last) throw new Error("userScripts.register was never called");
  return parseBootstrapPayload(last[0][0].js[0].code);
}

/** Let pending microtasks and short timers settle. */
export function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

/**
 * Poll `check` with real timers. `vi.waitFor` would advance a faked `Date` on
 * every poll, which moves the clock the cadence tests pin to bucket edges.
 */
export async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Read a mocked `browser.*` method through an index signature (keeps unbound-method quiet). */
function member(obj: unknown, key: string): Mock {
  return (obj as Record<string, Mock>)[key];
}

/** The global browser mocks the cadence tests count and drive. */
export const mocks = {
  sessionGet: (): Mock => member(browser.storage.session, "get"),
  sessionSet: (): Mock => member(browser.storage.session, "set"),
  localGet: (): Mock => member(browser.storage.local, "get"),
  localSet: (): Mock => member(browser.storage.local, "set"),
  alarmsCreate: (): Mock => member(browser.alarms, "create"),
  alarmsClear: (): Mock => member(browser.alarms, "clear"),
  alarmsGet: (): Mock => member(browser.alarms, "get"),
  tabsQuery: (): Mock => member(browser.tabs, "query"),
  tabsSendMessage: (): Mock => member(browser.tabs, "sendMessage"),
  onAlarmAddListener: (): Mock => member(browser.alarms.onAlarm, "addListener"),
  onCreatedAddListener: (): Mock => member(browser.tabs.onCreated, "addListener"),
};

export const SESSION_STORAGE_KEY = "cache:precisionCadence:session";
export const BUCKET_STORAGE_KEY = "cache:precisionCadence:bucket";

/** How many `storage.session.get` calls read `storageKey`. */
export function sessionGetsFor(storageKey: string): number {
  return mocks.sessionGet().mock.calls.filter((c) => c[0] === storageKey).length;
}

/** How many `storage.session.set` calls wrote `storageKey`. */
export function sessionSetsFor(storageKey: string): number {
  return mocks
    .sessionSet()
    .mock.calls.filter((c) => storageKey in (c[0] as Record<string, unknown>)).length;
}

/** Total `storage.session` get + set calls. */
export function sessionCallCount(): number {
  return mocks.sessionGet().mock.calls.length + mocks.sessionSet().mock.calls.length;
}

/** The `{ when }` of every `alarms.create("precision-rollover", …)` call, in order. */
export function rolloverCreates(): number[] {
  return (mocks.alarmsCreate().mock.calls as Array<[string, { when?: number }]>)
    .filter((c) => c[0] === "precision-rollover")
    .map((c) => c[1].when ?? NaN);
}

/** `[cadence]` WARN messages logged through console.warn (the logger's prefix is arg 0). */
export function cadenceWarns(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map((c) => c[1])
    .filter((m): m is string => typeof m === "string" && m.startsWith("[cadence]"));
}
