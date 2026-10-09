/**
 * The injected geolocation override must not consume page-visible randomness.
 *
 * Native `getCurrentPosition` never calls `Math.random`. If the override does,
 * a page can wrap `Math.random` and watch for calls during a location request,
 * which reveals the spoof. Using it also draws from the page's own PRNG stream,
 * whose state is recoverable from a handful of outputs, so a skipped value is
 * observable too.
 *
 * The override therefore draws from `crypto.getRandomValues`, captured at
 * module load (before any page script runs), so later page patches can't see it.
 */
import { describe, test, expect, vi, afterEach } from "vitest";

// jsdom has no Geolocation; state.ts captures its methods at import time.
vi.hoisted(() => {
  const noop = (): void => {};
  Object.defineProperty(globalThis.navigator, "geolocation", {
    configurable: true,
    value: { getCurrentPosition: noop, watchPosition: () => 0, clearWatch: noop },
  });
});

import { getPaddedCoords } from "@/content/injected/geolocation";
import { randomUnit } from "@/content/injected/safe-random";

describe("geolocation randomness isolation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("padding a coordinate never calls the page's Math.random", () => {
    const pageRandom = vi.spyOn(Math, "random");
    getPaddedCoords({ latitude: 12.5, longitude: -45.25 });
    expect(pageRandom).not.toHaveBeenCalled();
  });

  test("padding ignores a crypto.getRandomValues the page patches later", () => {
    const pagePatched = vi.spyOn(crypto, "getRandomValues");
    getPaddedCoords({ latitude: 33.125, longitude: 71.5 });
    expect(pagePatched).not.toHaveBeenCalled();
  });

  test("randomUnit stays in [0, 1) and touches no page-patchable global", () => {
    const pageRandom = vi.spyOn(Math, "random");
    const pageCrypto = vi.spyOn(crypto, "getRandomValues");
    const draws = Array.from({ length: 10_000 }, () => randomUnit());
    expect(pageRandom).not.toHaveBeenCalled();
    expect(pageCrypto).not.toHaveBeenCalled();
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThan(1);
    // Crude uniformity check: 10k draws should split roughly evenly.
    const low = draws.filter((x) => x < 0.5).length;
    expect(low).toBeGreaterThan(4_500);
    expect(low).toBeLessThan(5_500);
  });

  test("padded coordinates stay within ±5mm and carry 8 decimals", () => {
    const raw = { latitude: 48.8566, longitude: 2.3522 };
    const padded = getPaddedCoords(raw);
    expect(Math.abs(padded.latitude - raw.latitude)).toBeLessThanOrEqual(6e-8);
    expect(Math.abs(padded.longitude - raw.longitude)).toBeLessThanOrEqual(6e-8);
    expect(padded.latitude).toBe(Math.round(padded.latitude * 1e8) / 1e8);
  });
});
