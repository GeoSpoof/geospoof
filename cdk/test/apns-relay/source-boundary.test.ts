import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The Lambda bundle must stay self-contained: aws-cdk-lib or the CDK config
// leaking in would bloat the bundle and couple runtime to synth-time code.
const DIR = join(__dirname, "../../lib/lambda/apns-relay");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

const ALLOWED = [
  /^node:[a-z0-9/_]+$/,
  /^\.\/[A-Za-z0-9-]+$/,
  /^@apple\/app-store-server-library$/,
  /^@aws-sdk\/client-secrets-manager$/,
];

function specifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) out.push(m[1]);
  return out;
}

describe("lib/lambda/apns-relay source boundary", () => {
  it("has the expected modules", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "apns-client.ts",
        "apple-root-ca.ts",
        "entitlement.ts",
        "env-contract.ts",
        "handler.ts",
        "http.ts",
        "metrics.ts",
        "provider-token.ts",
        "push-schema.ts",
        "relay.ts",
        "secrets.ts",
        "session-token.ts",
      ])
    );
  });

  it.each(files)("%s imports only node:*, siblings, and the two runtime packages", (file) => {
    const source = readFileSync(join(DIR, file), "utf8");
    for (const spec of specifiers(source)) {
      expect(
        ALLOWED.some((re) => re.test(spec)),
        `${file} imports "${spec}"`
      ).toBe(true);
    }
  });

  it.each(files)("%s never calls console.log or console.info", (file) => {
    const source = readFileSync(join(DIR, file), "utf8");
    expect(source).not.toMatch(/console\.(log|info)\s*\(/);
  });

  it("writes to the console only through logFailure", () => {
    for (const file of files) {
      const source = readFileSync(join(DIR, file), "utf8");
      const uses = source.match(/console\.[a-z]+\s*\(/g) ?? [];
      if (file === "metrics.ts") expect(uses).toEqual(["console.warn("]);
      else expect(uses, file).toEqual([]);
    }
  });
});
