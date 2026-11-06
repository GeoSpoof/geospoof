/**
 * Build output verification tests for anti-fingerprint hardening.
 *
 * These tests run actual Vite builds and inspect the output to verify:
 * - Production builds strip console.log from injected.js
 * - The structured debug logger's console.info/debug/error/warn calls are
 *   intentionally preserved in production (always-on error/warn, level-gated info/debug/trace)
 * - Development builds preserve all console calls
 * - The built event name does not contain "GeoSpoof" or "geospoof"
 *
 * Requirements: 3.1, 3.3, 3.5
 */

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { describe, test, expect, beforeAll } from "vitest";

const ROOT = resolve(__dirname, "../..");
const DIST_INJECTED = resolve(ROOT, "dist/content/injected.js");

/**
 * Helper: run a Vite build with the given mode and return the injected.js content.
 * Caches results so each mode is only built once per test suite run.
 */
const buildCache = new Map<string, string>();

function buildAndRead(mode: "production" | "development"): string {
  const cached = buildCache.get(mode);
  if (cached !== undefined) return cached;

  execSync(`npx vite build --mode ${mode}`, {
    cwd: ROOT,
    stdio: "pipe",
    env: { ...process.env, NODE_ENV: mode },
    timeout: 60_000,
  });

  if (!existsSync(DIST_INJECTED)) {
    throw new Error(`Build output not found: ${DIST_INJECTED}`);
  }

  const content = readFileSync(DIST_INJECTED, "utf-8");
  buildCache.set(mode, content);
  return content;
}

// ---------------------------------------------------------------------------
// Production build tests
// ---------------------------------------------------------------------------
describe("Production build of injected.js", () => {
  let prodContent: string;

  beforeAll(() => {
    prodContent = buildAndRead("production");
  }, 120_000);

  test("contains no console.log calls (Req 3.1)", () => {
    // After minification, console.log calls are stripped by esbuild pure config.
    // Match console.log( but not console.log as part of a longer identifier.
    const matches = prodContent.match(/\bconsole\.log\s*\(/g);
    expect(matches).toBeNull();
  });

  test("console.info calls only originate from the structured logger (Req 3.1)", () => {
    // The structured debug logger intentionally uses console.info for INFO-level output.
    // Verify any console.info calls are from the logger (contain GeoSpoof prefix pattern).
    const allInfoCalls = prodContent.match(/\bconsole\.info\s*\([^)]*\)/g) ?? [];
    const nonLoggerInfoCalls = allInfoCalls.filter((call) => !call.includes("GeoSpoof"));
    expect(nonLoggerInfoCalls).toEqual([]);
  });

  test("console.debug calls only originate from the structured logger (Req 3.1)", () => {
    // The structured debug logger intentionally uses console.debug for DEBUG/TRACE-level output.
    // Verify any console.debug calls are from the logger (contain GeoSpoof prefix pattern).
    //
    // One exception, matched exactly: the worker relay's source (`RELAY_SOURCE`
    // in worker-relay.ts) is a string in this bundle. Its debug line runs in
    // the relay worker's own console, which page scripts can't hook, and only
    // when debug logging is on. It carries no brand because the relay's source
    // can reach the page: a `data:` relay's URL holds it.
    const allDebugCalls = prodContent.match(/\bconsole\.debug\s*\([^)]*\)/g) ?? [];
    const nonLoggerDebugCalls = allDebugCalls.filter(
      (call) => !call.includes("GeoSpoof") && call !== 'console.debug("[relay] " + what, e)'
    );
    expect(nonLoggerDebugCalls).toEqual([]);
  });

  test("console.error calls only originate from the structured logger", () => {
    // The structured debug logger's error() method always emits with GeoSpoof prefix.
    // Verify any console.error calls are from the logger.
    const allErrorCalls = prodContent.match(/\bconsole\.error\s*\([^)]*\)/g) ?? [];
    const nonLoggerErrorCalls = allErrorCalls.filter((call) => !call.includes("GeoSpoof"));
    expect(nonLoggerErrorCalls).toEqual([]);
  });

  test("console.warn calls only originate from the structured logger", () => {
    // The structured debug logger's warn() method always emits with GeoSpoof prefix.
    // Verify any console.warn calls are from the logger.
    const allWarnCalls = prodContent.match(/\bconsole\.warn\s*\([^)]*\)/g) ?? [];
    const nonLoggerWarnCalls = allWarnCalls.filter((call) => !call.includes("GeoSpoof"));
    expect(nonLoggerWarnCalls).toEqual([]);
  });

  test('event name does not contain "GeoSpoof" or "geospoof" (Req 3.5)', () => {
    // The event name should be replaced with a non-descriptive string at build time.
    // Check that no string literal in the output contains geospoof as part of an event name.
    expect(prodContent).not.toMatch(/__geospoof/i);
    expect(prodContent).not.toMatch(/geospoof_settings/i);
  });
});

// ---------------------------------------------------------------------------
// Development build tests
// ---------------------------------------------------------------------------
describe("Development build of injected.js", () => {
  let devContent: string;

  beforeAll(() => {
    devContent = buildAndRead("development");
  }, 120_000);

  test("preserves console.info calls from structured logger (Req 3.3)", () => {
    // All log calls now go through the structured logger which uses console.info for INFO level
    const matches = devContent.match(/\bconsole\.info\s*\(/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThan(0);
  });

  test("preserves console.error calls (Req 3.3)", () => {
    const matches = devContent.match(/\bconsole\.error\s*\(/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThan(0);
  });

  test("preserves console.warn calls (Req 3.3)", () => {
    // The source has at least one console.warn with GeoSpoof
    const matches = devContent.match(/\bconsole\.warn\s*\(/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThan(0);
  });
});
