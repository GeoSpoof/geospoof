// @vitest-environment node
/**
 * `buildWorkerSpoofCore` builds the core by string concatenation, so the worker
 * relay's settings flush calls no array method a page could have replaced.
 * These tests pin that the output is byte-identical to the array form it
 * replaced (8c07f6c) and that no array method runs.
 */
import { describe, test, expect } from "vitest";
import {
  SPOOF_CORE,
  SPOOF_LOCALE_CORE,
  SPOOF_MASK_HELPERS,
  buildWorkerSpoofCore,
} from "@/shared/worker-payload";
import type { SpoofedLocalePayload } from "@/shared/locale/resolver";

/** `SPOOF_CORE` is `${SPOOF_MASK_HELPERS}\n${SPOOF_TZ_BODY}`; the body isn't exported. */
const SPOOF_TZ_BODY = SPOOF_CORE.slice(SPOOF_MASK_HELPERS.length + 1);

/** The 8c07f6c implementation, rebuilt in the test's realm. */
function arrayForm(
  identifier: string | null,
  locale: SpoofedLocalePayload | null,
  fractionalOffset: boolean,
  engineZoneMayChange: boolean
): string {
  if (!identifier && !locale) return "";
  const parts: string[] = [SPOOF_MASK_HELPERS];
  if (identifier) {
    const idJson = JSON.stringify(identifier);
    const fractionalLiteral = fractionalOffset === true ? "true" : "false";
    const engineLiteral = engineZoneMayChange === true ? "true" : "false";
    parts.push(
      SPOOF_TZ_BODY.replace("__NATIVE_FRACTIONAL_OFFSET__", () => fractionalLiteral)
        .replace("__ENGINE_ZONE_MAY_CHANGE__", () => engineLiteral)
        .replace("__SPOOF_TZ_ID__", () => idJson)
    );
  }
  if (locale) {
    const localeJson = JSON.stringify(locale);
    parts.push(SPOOF_LOCALE_CORE.replace("__SPOOF_LOCALE__", () => localeJson));
  }
  return parts.join("\n");
}

const IDENTIFIERS: Array<string | null> = [
  null,
  "Asia/Tokyo",
  "America/St_Johns",
  "Etc/$&-$1-$$-x",
];
const LOCALES: Array<SpoofedLocalePayload | null> = [
  null,
  { tag: "fr-FR", languages: ["fr-FR", "fr"] },
];
const BOOLS = [true, false];

describe("buildWorkerSpoofCore: string concatenation", () => {
  test("output is byte-identical to the array form over the whole matrix", () => {
    let compared = 0;
    for (const identifier of IDENTIFIERS) {
      for (const locale of LOCALES) {
        for (const fractionalOffset of BOOLS) {
          for (const engineZoneMayChange of BOOLS) {
            const expected = arrayForm(identifier, locale, fractionalOffset, engineZoneMayChange);
            const actual = buildWorkerSpoofCore(
              identifier,
              locale,
              fractionalOffset,
              engineZoneMayChange
            );
            expect(actual).toBe(expected);
            compared++;
          }
        }
      }
    }
    expect(compared).toBe(IDENTIFIERS.length * LOCALES.length * BOOLS.length * BOOLS.length);
  });

  test("the reference exercises every substitution, including $-patterns", () => {
    const out = buildWorkerSpoofCore("Etc/$&-$1-$$-x", LOCALES[1], true, true);
    expect(out).toContain(JSON.stringify("Etc/$&-$1-$$-x"));
    expect(out).toContain(JSON.stringify(LOCALES[1]));
    expect(out).not.toContain("__SPOOF_TZ_ID__");
    expect(out).not.toContain("__SPOOF_LOCALE__");
  });

  test("both axes null still returns an empty string", () => {
    expect(buildWorkerSpoofCore(null, null, true, true)).toBe("");
    expect(buildWorkerSpoofCore(undefined, undefined, false, false)).toBe("");
  });

  test("no Array.prototype.push or join call while building", () => {
    const originalPush = Array.prototype.push;
    const originalJoin = Array.prototype.join;
    let calls = 0;
    let out = "";
    try {
      Array.prototype.push = function (this: unknown[], ...items: unknown[]): number {
        calls++;
        return originalPush.apply(this, items);
      };
      Array.prototype.join = function (this: unknown[], separator?: string): string {
        calls++;
        return originalJoin.call(this, separator);
      };
      out = buildWorkerSpoofCore("Asia/Tokyo", LOCALES[1], false, false);
    } finally {
      Array.prototype.push = originalPush;
      Array.prototype.join = originalJoin;
    }
    expect(calls).toBe(0);
    expect(out).toBe(arrayForm("Asia/Tokyo", LOCALES[1], false, false));
  });
});
