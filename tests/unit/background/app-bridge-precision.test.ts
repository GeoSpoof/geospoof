/**
 * Cross-bridge contract for the Safari app ↔ extension `locationPrecision`
 * passthrough.
 *
 * The native app encodes the precision setting as a compact JSON string
 * (`SpoofLocationPrecision.toJSON()` in geospoof-ios:app/Shared (App)/SpoofModel.swift)
 * and shuttles it verbatim through the App Group store. On adoption the
 * extension (`adoptPendingSettingsFromApp` in src/background/app-bridge.ts) does:
 *
 *     const parsed = JSON.parse(pending.locationPrecision);
 *     const validated = validateLocationPrecision(parsed);
 *     if (JSON.stringify(validated) !== JSON.stringify(latest.locationPrecision)) { ... }
 *
 * The Safari-only adoption branch itself is compiled out under the test harness
 * (`__SAFARI__` is a build-time literal `false`), so we verify the reusable core
 * it depends on: that the EXACT JSON shapes the Swift encoder emits round-trip
 * through `validateLocationPrecision` to the canonical TS value, and that the
 * change-detection / ignore-on-malformed semantics hold. This keeps the two
 * language sides in agreement.
 *
 * Validates: Requirements 7.1–7.5, 9.1.
 */

import { describe, test, expect, vi } from "vitest";
import { validateLocationPrecision } from "@/background/settings";
import type { LocationPrecision } from "@/shared/types/settings";
import { storageData } from "../../setup";
import { makeCadenceSettings } from "../../helpers/cadence";

/** Mirror of the bridge's parse step: JSON.parse in try/catch, undefined on error. */
function parsePrecisionJSON(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** Mirror of the bridge's adopt decision: parse → validate → change-detect. */
function adoptPrecision(json: string, current: LocationPrecision): LocationPrecision | null {
  const parsed = parsePrecisionJSON(json);
  if (parsed === undefined) return null; // malformed JSON — ignored by the bridge
  const validated = validateLocationPrecision(parsed);
  if (JSON.stringify(validated) === JSON.stringify(current)) return null; // no-op
  return validated;
}

describe("Safari locationPrecision bridge contract", () => {
  describe("exact Swift toJSON() shapes round-trip to the canonical TS value", () => {
    test('{"mode":"exact"} → { mode: "exact" }', () => {
      expect(validateLocationPrecision(JSON.parse('{"mode":"exact"}'))).toEqual({ mode: "exact" });
    });

    test('{"mode":"approximate","radiusMeters":N} → { mode: "approximate", radiusMeters: N }', () => {
      expect(
        validateLocationPrecision(JSON.parse('{"mode":"approximate","radiusMeters":500}'))
      ).toEqual({ mode: "approximate", radiusMeters: 500 });
    });

    test("radii at the shared [50, 50000] clamp limits survive verbatim", () => {
      expect(
        validateLocationPrecision(JSON.parse('{"mode":"approximate","radiusMeters":50}'))
      ).toEqual({ mode: "approximate", radiusMeters: 50 });
      expect(
        validateLocationPrecision(JSON.parse('{"mode":"approximate","radiusMeters":50000}'))
      ).toEqual({ mode: "approximate", radiusMeters: 50000 });
    });
  });

  describe("adoption decision (parse → validate → change-detect)", () => {
    test("adopts a changed setting", () => {
      const result = adoptPrecision('{"mode":"approximate","radiusMeters":2000}', {
        mode: "exact",
      });
      expect(result).toEqual({ mode: "approximate", radiusMeters: 2000 });
    });

    test("no-ops when the decoded value matches the current setting", () => {
      expect(adoptPrecision('{"mode":"exact"}', { mode: "exact" })).toBeNull();
    });

    test("no-ops when an out-of-range radius repairs back to the current setting", () => {
      // A hand-tampered store could carry radiusMeters:5; validation clamps it
      // to the 50 m floor, matching the current value.
      const result = adoptPrecision('{"mode":"approximate","radiusMeters":5}', {
        mode: "approximate",
        radiusMeters: 50,
      });
      expect(result).toBeNull();
    });

    test("ignores malformed JSON (leaves existing state untouched)", () => {
      expect(adoptPrecision("not json", { mode: "approximate", radiusMeters: 2000 })).toBeNull();
      expect(adoptPrecision("", { mode: "exact" })).toBeNull();
    });

    test("repairs an unknown mode to exact, then adopts only if that differs", () => {
      expect(
        adoptPrecision('{"mode":"bogus"}', { mode: "approximate", radiusMeters: 500 })
      ).toEqual({ mode: "exact" });
      expect(adoptPrecision('{"mode":"bogus"}', { mode: "exact" })).toBeNull();
    });

    test("approximate with a non-finite radius repairs to exact", () => {
      expect(
        validateLocationPrecision(JSON.parse('{"mode":"approximate","radiusMeters":null}'))
      ).toEqual({ mode: "exact" });
    });
  });
});

/**
 * precisionCadence crosses the Safari bridge as its own plain top-level string,
 * never inside `locationPrecision`: the app rewrites `locationPrecision` from an
 * enum holding only mode/radius, so the cadence has to live outside it and
 * survive the app's partial adoption. Only the preference crosses, and every
 * write goes through applyPrecisionCadence, so hour/day keep their rollover
 * alarm. The adoption behavior itself is in app-bridge-cadence.test.ts.
 */
describe("precisionCadence crosses the bridge as a plain string", () => {
  /** Every `src/background/*.ts` source, keyed by file name. */
  async function backgroundSources(): Promise<Map<string, string>> {
    const fs = await import("node:fs");
    const dir = "src/background";
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
    return new Map(files.map((f) => [f, fs.readFileSync(`${dir}/${f}`, "utf8")]));
  }

  /** The text of `export async function <name>(` up to its closing `}` at column 0. */
  function functionBody(src: string, name: string): string {
    const start = src.indexOf(`export async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const end = src.indexOf("\n}\n", start);
    expect(end, `${name} has no closing brace`).toBeGreaterThan(start);
    return src.slice(start, end + 2);
  }

  test("REGION_UPDATE carries its existing keys plus precisionCadence (AC 1)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/background/settings.ts", "utf8");
    const start = src.indexOf('type: "REGION_UPDATE"');
    expect(start, "REGION_UPDATE message not found").toBeGreaterThan(-1);
    const body = src.slice(src.lastIndexOf("\n", start) + 1, src.indexOf("});", start));
    const keys = [...body.matchAll(/^\s{6}(\w+)[:,]/gm)].map((m) => m[1]);

    expect(keys).toEqual([
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
    // A plain string, not JSON; locationPrecision's JSON is unchanged.
    expect(body).toContain("precisionCadence: settings.precisionCadence,");
    expect(body).toContain("locationPrecision: JSON.stringify(settings.locationPrecision),");
  });

  test("one function owns the cadence side effects (AC 5)", async () => {
    const sources = await backgroundSources();
    const owners = [...sources].filter(([, src]) =>
      src.includes("export async function applyPrecisionCadence(")
    );
    expect(owners.map(([file]) => file)).toEqual(["messages.ts"]);
    const messages = sources.get("messages.ts") ?? "";
    expect(messages.split("export async function applyPrecisionCadence(")).toHaveLength(2);

    const handler = functionBody(messages, "handleSetPrecisionCadence");
    expect(handler).toContain("applyPrecisionCadence(payload?.cadence)");
    expect(handler).not.toContain("updateSettings(");

    expect(sources.get("app-bridge.ts")).toContain("applyPrecisionCadence(");

    // No bare cadence write anywhere: that would leave hour/day without an alarm.
    for (const [file, src] of sources) {
      expect(src, file).not.toMatch(/updateSettings\(\s*\{[^}]*\bprecisionCadence\b/);
    }
    const write = "const updates: Partial<Settings> = { precisionCadence };";
    const writes = [...sources.values()].reduce((n, src) => n + src.split(write).length - 1, 0);
    expect(writes).toBe(1);
    expect(functionBody(messages, "applyPrecisionCadence")).toContain(write);

    // Step 7's locationPrecision adoption is unchanged.
    expect(sources.get("app-bridge.ts")).toContain(
      "updateSettings({ locationPrecision: validatedPrecision })"
    );
  });

  test("a rollover saves nothing, so it never sends REGION_UPDATE (FR-1.6)", async () => {
    const fs = await import("node:fs");
    const body = functionBody(
      fs.readFileSync("src/background/index.ts", "utf8"),
      "onPrecisionRolloverAlarm"
    );
    expect(body).not.toContain("updateSettings(");
    expect(body).not.toContain("saveSettings(");
  });

  test("the bridge's locationPrecision adoption keeps a stored cadence", async () => {
    storageData.settings = makeCadenceSettings({
      precisionCadence: "hour",
      locationPrecision: { mode: "exact" },
    });
    vi.resetModules();
    const bg = await import("@/background");
    const { validateLocationPrecision: validate } = await import("@/background/settings");

    // adoptPendingSettingsFromApp's step-7 write, verbatim in shape.
    const validatedPrecision = validate(JSON.parse('{"mode":"approximate","radiusMeters":2000}'));
    await bg.updateSettings({ locationPrecision: validatedPrecision });

    const loaded = await bg.loadSettings();
    expect(loaded.precisionCadence).toBe("hour");
    expect(loaded.locationPrecision).toEqual({ mode: "approximate", radiusMeters: 2000 });

    const fs = await import("node:fs");
    const bridge = fs.readFileSync("src/background/app-bridge.ts", "utf8");
    // The cadence is adopted in its own step, never as part of step 7's write.
    expect(bridge).toContain("applyPrecisionCadence(nextCadence)");
    expect(bridge).toContain("updateSettings({ locationPrecision: validatedPrecision })");
  });
});
