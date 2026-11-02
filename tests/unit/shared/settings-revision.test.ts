/**
 * The settings revision rule every receiver shares: which values count as a
 * revision, and when one is older than another.
 */

import { describe, test, expect } from "vitest";
import { MAX_SETTINGS_REVISION, isOlderRevision, readRevision } from "@/shared/settings-revision";

describe("readRevision", () => {
  test.each([0, 1, 1_700_000_000_000, Number.MAX_SAFE_INTEGER])("accepts %s", (v) => {
    expect(readRevision(v)).toBe(v);
  });

  test("the cap is the largest safe integer", () => {
    expect(MAX_SETTINGS_REVISION).toBe(Number.MAX_SAFE_INTEGER);
    expect(readRevision(MAX_SETTINGS_REVISION)).toBe(MAX_SETTINGS_REVISION);
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["-1", -1],
    ["1.5", 1.5],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["2 ** 53", 2 ** 53],
    ['"5"', "5"],
    ["an object", { revision: 5 }],
  ])("rejects %s", (_label, v) => {
    expect(readRevision(v)).toBeUndefined();
  });
});

describe("isOlderRevision", () => {
  test.each([
    { revision: 1, newest: 2, older: true },
    { revision: 0, newest: 1, older: true },
    { revision: 2, newest: 2, older: false },
    { revision: 3, newest: 2, older: false },
    { revision: undefined, newest: 2, older: false },
    { revision: 2, newest: undefined, older: false },
    { revision: undefined, newest: undefined, older: false },
  ])("$revision against $newest -> $older", ({ revision, newest, older }) => {
    expect(isOlderRevision(revision, newest)).toBe(older);
  });
});
