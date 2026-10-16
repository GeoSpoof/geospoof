/**
 * Task 4 guard test: the location-precision offset is applied to page-bound
 * payloads (broadcast + content-script GET_SETTINGS), both builders agree, the
 * `accuracy` field is preserved, `exact` mode is a no-op, and the stored
 * `Settings.location` anchor is never mutated.
 *
 * Property 9: Payload builders agree and preserve the anchor.
 * Validates: Requirements 5.2, 5.3, 5.4.
 */

import { describe, test, expect, vi } from "vitest";
import type { Location, Settings } from "@/shared/types/settings";
import type { Message, UpdateSettingsPayload } from "@/shared/types/messages";
import { clockBucket, resolvePageLocation } from "@/shared/precision/cadence";
import {
  deferred,
  flush,
  installUserScriptsMock,
  lastRegisteredPayload,
  mocks,
  seedHeldBucket,
  sessionCallCount,
} from "../../helpers/cadence";

const ANCHOR = { latitude: 37.7749, longitude: -122.4194, accuracy: 42 } as const;
const RADIUS = 5000;
const SEED = 123456789;

function makeSettings(overrides?: Partial<Settings>): Settings {
  return {
    enabled: true,
    location: { ...ANCHOR },
    timezone: { identifier: "America/Los_Angeles", offset: 480, dstOffset: 60 },
    locationName: { city: "San Francisco", country: "US", displayName: "San Francisco, US" },
    webrtcProtection: false,
    preserveGeolocationPrompt: false,
    onboardingCompleted: true,
    version: "1.2",
    lastUpdated: Date.now(),
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
    locationPrecision: { mode: "exact" },
    precisionSeed: SEED,
    precisionCadence: "never" as const,
    localeSpoofing: { mode: "off" as const },
    ...overrides,
  };
}

/** Great-circle distance in meters (reference impl). */
function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function importBackgroundWith(s: Settings) {
  vi.clearAllMocks();
  vi.resetModules();
  browser.storage.local.get = vi.fn().mockResolvedValue({ settings: s });
  browser.storage.local.set = vi.fn().mockResolvedValue(undefined);
  return import("@/background");
}

/** Broadcast to a single tab and return the delivered UpdateSettingsPayload. */
async function broadcastAndCapture(
  bg: { broadcastSettingsToTabs: (s: Settings) => Promise<void> },
  s: Settings
): Promise<UpdateSettingsPayload> {
  browser.tabs.query = vi.fn().mockResolvedValue([{ id: 1, url: "https://example.com" }]);
  const sent: UpdateSettingsPayload[] = [];
  browser.tabs.sendMessage = vi
    .fn()
    .mockImplementation((_tabId: number, message: Message<UpdateSettingsPayload>) => {
      if (message.type === "UPDATE_SETTINGS" && message.payload) sent.push(message.payload);
      return Promise.resolve();
    });
  await bg.broadcastSettingsToTabs(s);
  expect(sent).toHaveLength(1);
  return sent[0];
}

describe("Property 9: precision offset in page-bound payloads", () => {
  test("approximate: broadcast location differs from anchor, stays within radius, preserves accuracy", async () => {
    const s = makeSettings({
      locationPrecision: { mode: "approximate", radiusMeters: RADIUS },
    });
    const bg = await importBackgroundWith(s);
    const payload = await broadcastAndCapture(bg, s);

    const loc = payload.location;
    expect(loc).not.toBeNull();
    // Offset actually moved the point.
    expect(loc!.latitude !== ANCHOR.latitude || loc!.longitude !== ANCHOR.longitude).toBe(true);
    // Non-coordinate fields preserved (Req 5.4).
    expect(loc!.accuracy).toBe(ANCHOR.accuracy);
    // Within the configured radius (Req 3.1).
    const dist = haversineMeters(ANCHOR.latitude, ANCHOR.longitude, loc!.latitude, loc!.longitude);
    expect(dist).toBeLessThanOrEqual(RADIUS * 1.02 + 2);
  });

  test("exact: broadcast location equals the anchor verbatim", async () => {
    const s = makeSettings({ locationPrecision: { mode: "exact" } });
    const bg = await importBackgroundWith(s);
    const payload = await broadcastAndCapture(bg, s);
    expect(payload.location).toEqual({ ...ANCHOR });
  });

  test("both builders agree: content-script GET_SETTINGS location === broadcast location", async () => {
    const s = makeSettings({
      locationPrecision: { mode: "approximate", radiusMeters: RADIUS },
    });
    const bg = await importBackgroundWith(s);

    const broadcastPayload = await broadcastAndCapture(bg, s);

    const response = (await bg.handleMessage(
      { type: "GET_SETTINGS" },
      { tab: { id: 2, url: "https://example.com/page" } as browser.tabs.Tab }
    )) as Record<string, unknown>;

    expect(response.location).toEqual(broadcastPayload.location);
  });

  test("stored Settings.location (anchor) is never mutated by the offset", async () => {
    const anchorObj = { ...ANCHOR };
    const s = makeSettings({
      location: anchorObj,
      locationPrecision: { mode: "approximate", radiusMeters: RADIUS },
    });
    const bg = await importBackgroundWith(s);
    await broadcastAndCapture(bg, s);
    // The offset builds a new object; the anchor in storage is untouched.
    expect(anchorObj).toEqual({ ...ANCHOR });
    expect(s.location).toEqual({ ...ANCHOR });
  });
});

/**
 * Regression guard for the two payload builders in `src/background/index.ts`
 * that the original implementation missed: the late-injection alarm path and the
 * new-tab path both destructured `location` off Settings and delivered it RAW,
 * with no `applyPrecisionOffset` call (the function wasn't even imported in that
 * file). A user who enabled approximate location therefore still received their
 * EXACT anchor coordinates on those paths — precisely what the feature exists to
 * prevent — and it violated Req 5.2's "both builders agree".
 *
 * The original suite only exercised `broadcastSettingsToTabs` and the
 * `GET_SETTINGS` branch, which were the two builders that were already correct,
 * so the bug was invisible to it. These tests pin the property at the level that
 * actually matters: no page-bound payload anywhere may carry the exact anchor
 * while approximate mode is on.
 */
describe("every page-bound builder offsets the location (Req 5.2)", () => {
  /**
   * Assert a delivered payload is offset rather than the verbatim anchor.
   * Kept as one helper so a future third builder can be checked the same way.
   */
  function expectOffset(loc: UpdateSettingsPayload["location"]): void {
    expect(loc).not.toBeNull();
    // Moved off the anchor...
    expect(loc!.latitude !== ANCHOR.latitude || loc!.longitude !== ANCHOR.longitude).toBe(true);
    // ...but still inside the configured radius, and with `accuracy` preserved.
    expect(loc!.accuracy).toBe(ANCHOR.accuracy);
    const dist = haversineMeters(ANCHOR.latitude, ANCHOR.longitude, loc!.latitude, loc!.longitude);
    expect(dist).toBeLessThanOrEqual(RADIUS * 1.02 + 2);
  }

  test("the new-tab path offsets, and agrees with the broadcast path", async () => {
    const s = makeSettings({
      locationPrecision: { mode: "approximate", radiusMeters: RADIUS },
    });
    const bg = await importBackgroundWith(s);

    // Baseline from the known-good builder, to compare against.
    const broadcast = await broadcastAndCapture(bg, s);
    expectOffset(broadcast.location);

    // Drive the tabs.onCreated listener and capture what the new tab receives.
    const sent: UpdateSettingsPayload[] = [];
    browser.tabs.sendMessage = vi
      .fn()
      .mockImplementation((_tabId: number, message: Message<UpdateSettingsPayload>) => {
        if (message.type === "UPDATE_SETTINGS" && message.payload) sent.push(message.payload);
        return Promise.resolve();
      });

    vi.useFakeTimers();
    try {
      const listener = (
        browser.tabs.onCreated.addListener as unknown as {
          mock: { calls: [(tab: { id?: number; url?: string }) => void][] };
        }
      ).mock.calls.at(-1)?.[0];
      expect(listener, "tabs.onCreated listener was not registered").toBeDefined();

      listener!({ id: 42, url: "https://example.com/new" });
      // The handler loads settings asynchronously, then defers the send.
      await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), { timeout: 2000 });
    } finally {
      vi.useRealTimers();
    }

    expectOffset(sent[0].location);
    // Determinism means every builder must land on the same point.
    expect(sent[0].location).toEqual(broadcast.location);
  });

  test("exact mode still delivers the verbatim anchor on the new-tab path", async () => {
    // The fix must not accidentally offset when the user asked for exact.
    const s = makeSettings({ locationPrecision: { mode: "exact" } });
    const bg = await importBackgroundWith(s);
    const broadcast = await broadcastAndCapture(bg, s);
    expect(broadcast.location).toEqual({ ...ANCHOR });
  });

  test("src/background/index.ts routes every payload site through the cadence resolver", async () => {
    // A structural guard, because the behavioural tests can only reach the
    // paths a unit test can drive. This catches a regression at any future
    // builder added to this file that runtime coverage would miss.
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/background/index.ts", "utf8");

    // Count payload literals against resolver calls: every `UpdateSettingsPayload`
    // built in this file must resolve its location through the shared resolver.
    const payloadSites = (src.match(/: UpdateSettingsPayload = \{/g) ?? []).length;
    const resolverCalls = (
      src.match(/location: await resolveCurrentPageLocation\(settings\)/g) ?? []
    ).length;
    expect(payloadSites).toBeGreaterThan(0);
    expect(resolverCalls, "a payload in index.ts bypasses the cadence resolver").toBe(payloadSites);

    // No inline offset that could skip the cadence period.
    expect(src).not.toContain("applyPrecisionOffset");

    // And none may pass the bare destructured `location` through.
    expect(src).not.toMatch(/\n\s+enabled,\n\s+location,\n/);
  });

  test("applyPrecisionOffset( is called only inside shared/precision", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const files = fs
      .readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join("src", f).split(path.sep).join("/"));

    const callers = files.filter((f) =>
      fs.readFileSync(f, "utf8").includes("applyPrecisionOffset(")
    );
    expect(callers.sort()).toEqual([
      "src/shared/precision/cadence.ts",
      "src/shared/precision/offset.ts",
    ]);
  });
});

describe("location-precision cadence through the page-bound builders", () => {
  test("all five builders emit the held hour bucket's point (AC20)", async () => {
    const s = makeSettings({
      locationPrecision: { mode: "approximate", radiusMeters: 2000 },
      precisionCadence: "hour",
    });
    // Held three buckets behind the clock, so a builder that recomputed from
    // the clock instead of using the held period would be caught.
    const K = clockBucket("hour", SEED, Date.now()) - 3;
    seedHeldBucket("hour", SEED, K);
    const userScripts = installUserScriptsMock();

    try {
      // Spawn check: a healthy alarm, so nothing advances or reschedules.
      mocks
        .alarmsGet()
        .mockResolvedValue({ name: "precision-rollover", scheduledTime: Date.now() + 600_000 });
      const bg = await importBackgroundWith(s);
      const { updateBootstrapRegistration } = await import("@/background/bootstrap-register");
      const locations: Array<UpdateSettingsPayload["location"]> = [];

      // 1. sendSettingsToTab, via the broadcast.
      locations.push((await broadcastAndCapture(bg, s)).location);

      // 2. Content-script GET_SETTINGS.
      const reply = (await bg.handleMessage(
        { type: "GET_SETTINGS" },
        { tab: { id: 2, url: "https://example.com/page" } as browser.tabs.Tab }
      )) as UpdateSettingsPayload;
      locations.push(reply.location);

      // 3. tabs.onCreated, sent after its 100ms delay.
      const sent: Array<{ tabId: number; payload: UpdateSettingsPayload }> = [];
      browser.tabs.sendMessage = vi
        .fn()
        .mockImplementation((tabId: number, message: Message<UpdateSettingsPayload>) => {
          if (message.type === "UPDATE_SETTINGS" && message.payload) {
            sent.push({ tabId, payload: message.payload });
          }
          return Promise.resolve();
        });
      const onCreated = mocks.onCreatedAddListener().mock.calls.at(-1)?.[0] as
        ((tab: { id?: number; url?: string }) => void) | undefined;
      expect(onCreated, "tabs.onCreated listener was not registered").toBeDefined();
      vi.useFakeTimers();
      try {
        onCreated!({ id: 42, url: "https://example.com/new" });
        await vi.waitFor(() => expect(sent.some((m) => m.tabId === 42)).toBe(true), {
          timeout: 2000,
        });
      } finally {
        vi.useRealTimers();
      }
      locations.push(sent.find((m) => m.tabId === 42)!.payload.location);

      // 4. The injection-check alarm builder (PING resolves → injected).
      browser.tabs.get = vi.fn().mockResolvedValue({ id: 7, url: "https://example.com/late" });
      await bg.onAlarm({ name: "injection-check:7:0", scheduledTime: Date.now() });
      const late = sent.find((m) => m.tabId === 7);
      expect(late, "the injection-check alarm sent no UPDATE_SETTINGS").toBeDefined();
      locations.push(late!.payload.location);

      // 5. The Firefox bootstrap's inlined payload.
      await updateBootstrapRegistration(s);
      locations.push(lastRegisteredPayload(userScripts.register).location as Location);

      const expected = resolvePageLocation(s, { cadence: "hour", index: K });
      const today = resolvePageLocation(s, null);
      expect(locations).toHaveLength(5);
      for (const loc of locations) {
        expect(loc).toEqual(expected);
        expect(loc).not.toEqual(today);
      }
    } finally {
      userScripts.restore();
      mocks.alarmsGet().mockResolvedValue(undefined);
    }
  });

  test("concurrent bootstrap registrations run one after another (AC22)", async () => {
    vi.resetModules();
    const userScripts = installUserScriptsMock();
    try {
      const gate = deferred<void>();
      userScripts.unregister.mockImplementationOnce(() => {
        userScripts.log.push("unregister");
        return gate.promise;
      });
      const { updateBootstrapRegistration } = await import("@/background/bootstrap-register");
      const a = makeSettings({ locationPrecision: { mode: "approximate", radiusMeters: 2000 } });
      const b = makeSettings({
        location: { latitude: 48.8566, longitude: 2.3522, accuracy: 30 },
        locationPrecision: { mode: "approximate", radiusMeters: 2000 },
      });

      const pa = updateBootstrapRegistration(a);
      const pb = updateBootstrapRegistration(b);
      await flush();
      expect(userScripts.log, "the second call waits for the first").toEqual(["unregister"]);

      gate.resolve();
      await Promise.all([pa, pb]);

      expect(userScripts.log).toEqual(["unregister", "register", "unregister", "register"]);
      expect(lastRegisteredPayload(userScripts.register).location).toEqual(
        resolvePageLocation(b, null)
      );
    } finally {
      userScripts.restore();
    }
  });

  test("under never, the broadcast does no storage.session I/O (AC6)", async () => {
    const s = makeSettings({
      locationPrecision: { mode: "approximate", radiusMeters: 2000 },
      precisionCadence: "never",
    });
    const bg = await importBackgroundWith(s);
    await flush();
    mocks.sessionGet().mockClear();
    mocks.sessionSet().mockClear();

    const payload = await broadcastAndCapture(bg, s);

    expect(payload.location).toEqual(resolvePageLocation(s, null));
    expect(sessionCallCount()).toBe(0);
  });
});
