/**
 * A configured coordinate with few decimals (35.6762) is padded to 8, because
 * native readings carry 7-8 and a page can count them. The padding is a random
 * offset of at most ±5e-8 degrees rounded to 8 decimals, so a draw within half
 * a step of zero must still move the value, or the page sees the raw 4 digits.
 */
import { describe, test, expect, vi } from "vitest";

// jsdom has no Geolocation; state.ts captures its methods at import time.
vi.hoisted(() => {
  const noop = (): void => {};
  Object.defineProperty(globalThis.navigator, "geolocation", {
    configurable: true,
    value: { getCurrentPosition: noop, watchPosition: () => 0, clearWatch: noop },
  });
});

const draw = vi.hoisted(() => ({ value: 0.5 }));
vi.mock("@/content/injected/safe-random", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/content/injected/safe-random")>();
  return { ...mod, randomUnit: () => draw.value };
});

import { getPaddedCoords } from "@/content/injected/geolocation";

const decimals = (n: number): number => n.toString().split(".")[1]?.length ?? 0;
const MAX_OFFSET = 5.0000001e-8;

describe("coordinate padding", () => {
  // randomUnit() 0.5 is a zero offset; 0.53 and 0.47 are under half a step; 0 and
  // 0.9999999 are the ends of the range. Each case pads a different pair, since
  // the padded pair is cached by its raw value.
  test.each([
    [0.5, 35.6762, 139.6503],
    [0.53, 48.8566, 2.3522],
    [0.47, 34.0522, -118.2437],
    [0, 12.25, -45.125],
    [0.9999999, -33.8688, 151.2093],
  ])("draw %s pads %s, %s to 8 decimals within ±5e-8", (value, latitude, longitude) => {
    draw.value = value;
    const padded = getPaddedCoords({ latitude, longitude });
    for (const [got, raw] of [
      [padded.latitude, latitude],
      [padded.longitude, longitude],
    ]) {
      expect(decimals(got)).toBe(8);
      expect(got).not.toBe(raw);
      expect(Math.abs(got - raw)).toBeLessThanOrEqual(MAX_OFFSET);
    }
  });

  test("a coordinate that already has 7 decimals is left alone", () => {
    draw.value = 0.9;
    expect(getPaddedCoords({ latitude: 1.2345678, longitude: 2.3456789 })).toEqual({
      latitude: 1.2345678,
      longitude: 2.3456789,
    });
  });
});
