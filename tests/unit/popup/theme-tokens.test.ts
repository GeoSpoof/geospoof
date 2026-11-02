/**
 * Dark-theme tokens in assets/popup.css. Secondary text needs its own tier
 * (not --text) that stays readable on every dark surface it sits on, and count
 * chips need a fill that differs from the card behind them. The tokens are
 * defined twice, for the system preference and for the explicit Dark theme,
 * and the two blocks must agree.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";

const CSS = readFileSync("assets/popup.css", "utf8");

/** The custom properties declared in the rule whose selector `selector` ends with. */
function tokens(selector: RegExp): Record<string, string> {
  const match = selector.exec(CSS);
  if (!match) throw new Error(`${String(selector)} not found`);
  const open = CSS.indexOf("{", match.index + match[0].length);
  const body = CSS.slice(open + 1, CSS.indexOf("}", open)).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** WCAG 2.x contrast ratio between two #rgb / #rrggbb colors. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    let h = hex.replace("#", "");
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    const [r, g, bl] = [0, 2, 4].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SYSTEM_DARK = tokens(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root/);
const EXPLICIT_DARK = tokens(/^body\.theme-dark/m);
/** Every dark background secondary text sits on: --surface, --bg/--surface-alt, chips and hover fills. */
const DARK_SURFACES = ["#23222b", "#2b2a33", "#3b3a41"];

describe("dark theme tokens", () => {
  test.each([
    ["system preference", SYSTEM_DARK],
    ["explicit Dark theme", EXPLICIT_DARK],
  ])("%s: muted text is its own tier and chips have a fill", (_label, t) => {
    expect(t["--text-muted"]).toBeDefined();
    expect(t["--text-muted"]).not.toBe(t["--text"]);
    expect(t["--badge-bg"]).toBeDefined();
    expect(t["--badge-bg"]).not.toBe(t["--surface"]);
    expect(t["--badge-bg"]).not.toBe(t["--bg"]);
  });

  test("both dark blocks define the same muted text and chip fill", () => {
    expect(EXPLICIT_DARK["--text-muted"]).toBe(SYSTEM_DARK["--text-muted"]);
    expect(EXPLICIT_DARK["--badge-bg"]).toBe(SYSTEM_DARK["--badge-bg"]);
  });

  test.each(DARK_SURFACES)("muted text keeps at least 4.5:1 on %s", (surface) => {
    expect(contrast(SYSTEM_DARK["--text-muted"], surface)).toBeGreaterThanOrEqual(4.5);
  });

  test("the surfaces checked are the dark tokens themselves", () => {
    expect(SYSTEM_DARK["--surface"]).toBe(DARK_SURFACES[0]);
    expect(SYSTEM_DARK["--bg"]).toBe(DARK_SURFACES[1]);
    expect(SYSTEM_DARK["--badge-bg"]).toBe(DARK_SURFACES[2]);
  });

  test("the contrast helper matches known WCAG values", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#666666", "#ffffff")).toBeCloseTo(5.74, 2);
  });
});
