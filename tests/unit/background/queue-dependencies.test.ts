/**
 * F23 deadlock rule: the bootstrap queue never waits on the settings-write
 * queue. `saveSettings` waits (bounded) on the bootstrap queue, so if anything
 * the bootstrap jobs run could reach the settings-write queue or the
 * site-location queue, the three queues could wait on each other. This pins
 * the static half of that: `bootstrap-register.ts` and everything it loads at
 * runtime import none of the modules that own or call into those queues.
 *
 * Parsing uses three line-anchored regexes over the raw source, with no
 * comment stripping: a block-comment regex would treat the `/*` inside
 * `const ALL_HOSTS = "*://*\/*";` as a comment opening and swallow real
 * imports. Every possible mismatch is a false positive (a module added to the
 * closure, or an unresolvable specifier), which fails loudly.
 */

import { describe, test, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// import … from "x" and export … from "x", multi-line included ([^;] spans newlines); skips `import type` / `export type`.
const STATIC = /^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']/gm;
// import "x" (side effect).
const SIDE_EFFECT = /^\s*import\s*["']([^"']+)["']/gm;
// import("x") with a string literal, anywhere.
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

const SRC = resolve("src");
const ENTRY = resolve("src/background/bootstrap-register.ts");

function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile();
}

/** The local file a specifier names, null for a bare package; throws when a local one resolves to nothing. */
function resolveSpecifier(spec: string, importer: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) base = resolve(dirname(importer), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (isFile(candidate)) return candidate;
  }
  throw new Error(`unresolvable import "${spec}" in ${relative(process.cwd(), importer)}`);
}

function runtimeSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const re of [STATIC, SIDE_EFFECT, DYNAMIC]) {
    for (const m of source.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

/** Every local module `entry` loads at runtime, transitively, as repo-relative paths (entry included). */
function runtimeClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      const target = resolveSpecifier(spec, file);
      if (target !== null && !seen.has(target)) pending.push(target);
    }
  }
  return new Set([...seen].map((f) => relative(process.cwd(), f).split("\\").join("/")));
}

describe("the bootstrap queue never waits on the settings-write queue (F23)", () => {
  const closure = runtimeClosure(ENTRY);

  test("bootstrap-register.ts loads none of the queue-owning modules", () => {
    for (const forbidden of [
      "src/background/settings.ts",
      "src/background/site-location-queue.ts",
      "src/background/messages.ts",
      "src/background/tabs.ts",
      "src/background/app-bridge.ts",
      "src/background/index.ts",
    ]) {
      expect(closure.has(forbidden), forbidden).toBe(false);
    }
  });

  test("self-check: the walker follows real imports", () => {
    for (const expected of [
      "src/background/page-payload.ts",
      "src/background/precision-cadence.ts",
      "src/background/session-cache.ts",
    ]) {
      expect(closure.has(expected), expected).toBe(true);
    }
  });
});
