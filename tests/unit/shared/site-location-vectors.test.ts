import { describe, it, expect } from "vitest";
import { parsePattern } from "@/shared/utils/scope";
import { parseSiteLocationPattern } from "@/shared/utils/site-locations";
import vectors from "../../fixtures/site-location-vectors.json";

/**
 * Cross-language parity: `parseSiteLocationPattern` must match every vector in
 * the shared fixture. A future geospoof-ios Swift test reads the same file, so
 * both sides stay pinned to one hand-authored contract.
 *
 * Every valid vector's expected value must also equal `parsePattern(input)`:
 * that's what makes the host-only grammar a subset of the Filters grammar, so a
 * site-location pattern and a Filters pattern for the same site are one string.
 */

interface Vector {
  input: string;
  expected: string | null;
}

const validVectors = vectors.valid as Vector[];
const invalidVectors = vectors.invalid as Vector[];

describe("parseSiteLocationPattern — shared parity fixture (valid)", () => {
  it.each(validVectors)("parseSiteLocationPattern($input) === $expected", ({ input, expected }) => {
    expect(parseSiteLocationPattern(input)).toBe(expected);
  });

  it.each(validVectors)("$expected is also the Filters canonical form", ({ input, expected }) => {
    expect(parsePattern(input)).toBe(expected);
  });
});

describe("parseSiteLocationPattern — shared parity fixture (invalid → null)", () => {
  it.each(invalidVectors)("parseSiteLocationPattern($input) === null", ({ input, expected }) => {
    expect(expected).toBeNull(); // fixture sanity: invalid entries declare null
    expect(parseSiteLocationPattern(input)).toBeNull();
  });
});
