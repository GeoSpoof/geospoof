/**
 * Convert a v2fly/domain-list-community release into GeoSpoof's site group
 * catalog (`src/shared/site-groups/catalog.ts` documents the format).
 *
 *   node scripts/site-groups/build-catalog.ts --input dlc.dat_plain.yml \
 *     --release 20261104112839 --released-at 2026-11-04T11:28:50Z \
 *     --upstream-sha256 <hex> --out assets/site-groups/catalog.json
 *   node scripts/site-groups/build-catalog.ts --download --out catalog.json \
 *     [--pointer latest.json] [--guard-against previous-catalog.json]
 *
 * Self-contained (only `node:` imports) so Node runs it directly through type
 * stripping, and tests import its functions. Output is compact JSON, so the
 * same input always gives the same bytes.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** One upstream list as `dlc.dat_plain.yml` holds it. */
export interface V2flyList {
  name: string;
  rules: string[];
}

export interface CatalogMeta {
  release: string;
  releasedAt: string;
  upstreamSha256: string;
}

/** Mirrors `SiteGroupCatalog` in src/shared/site-groups/catalog.ts. */
export interface Catalog extends CatalogMeta {
  format: 1;
  source: string;
  license: string;
  lists: Record<string, { rules: string; skipped: string[] }>;
}

export interface CatalogPointer {
  format: 1;
  release: string;
  releasedAt: string;
  path: string;
  sha256: string;
  bytes: number;
  lists: number;
  rules: number;
}

const SOURCE = "https://github.com/v2fly/domain-list-community";
const LICENSE = "MIT";
const RELEASES_API = "https://api.github.com/repos/v2fly/domain-list-community/releases/latest";
const PLAIN_ASSET = "dlc.dat_plain.yml";

const LIST_NAME_PATTERN = /^[a-z0-9!-]{1,64}$/;
const RELEASE_PATTERN = /^\d{14}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const RULE_PATTERN = /^(domain|full|regexp|keyword):(.*)$/;
const ATTRS_SUFFIX = /:(@[a-z0-9!-]{1,32}(?:,@[a-z0-9!-]{1,32})*)$/;

/** Most a list may shrink, as a fraction of the previous catalog, before the guard fails. */
const MAX_LIST_DROP = 0.1;
/** Most the rule count may shrink before the guard fails. */
const MAX_RULE_DROP = 0.2;

// ─────────────────────────────── Parsing ───────────────────────────────

/** Unquote a JSON string literal, throwing when it isn't one. */
function unquoteJson(literal: string, lineNo: number): string {
  let value: unknown;
  try {
    value = JSON.parse(literal);
  } catch {
    throw new Error(`line ${lineNo}: not a quoted string: ${literal}`);
  }
  if (typeof value !== "string") {
    throw new Error(`line ${lineNo}: not a quoted string: ${literal}`);
  }
  return value;
}

/**
 * Parse `dlc.dat_plain.yml`. Strict: it accepts only the shape the upstream
 * generator writes (`lists:`, then per list `- name:`, `length:`, `rules:` and
 * `- "rule"` items) and throws on anything else, including a `length` that
 * doesn't match the rule count.
 */
export function parseV2flyPlainYaml(text: string): V2flyList[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines[0] !== "lists:") {
    throw new Error('line 1: expected "lists:"');
  }
  const lists: V2flyList[] = [];
  let i = 1;
  while (i < lines.length) {
    const nameMatch = /^ {2}- name: (".*")$/.exec(lines[i]);
    if (nameMatch === null) {
      throw new Error(`line ${i + 1}: expected "- name:", got ${lines[i]}`);
    }
    const name = unquoteJson(nameMatch[1], i + 1);
    const lengthMatch = /^ {4}length: (\d+)$/.exec(lines[i + 1] ?? "");
    if (lengthMatch === null) {
      throw new Error(`line ${i + 2}: expected "length:" for ${name}`);
    }
    if (lines[i + 2] !== "    rules:") {
      throw new Error(`line ${i + 3}: expected "rules:" for ${name}`);
    }
    i += 3;
    const rules: string[] = [];
    while (i < lines.length) {
      const ruleMatch = /^ {6}- (".*")$/.exec(lines[i]);
      if (ruleMatch === null) {
        break;
      }
      rules.push(unquoteJson(ruleMatch[1], i + 1));
      i++;
    }
    if (rules.length !== Number(lengthMatch[1])) {
      throw new Error(`${name}: length ${lengthMatch[1]} but ${rules.length} rules`);
    }
    lists.push({ name, rules });
  }
  return lists;
}

// ─────────────────────────────── Conversion ───────────────────────────────

/**
 * Convert parsed lists into a catalog. `domain:` and `full:` rules become rule
 * lines (`full:` prefixed with `=`); `regexp:` and `keyword:` rules are
 * dropped, keeping their attrs in `skipped`. Attrs (`:@a,@b`) are deduped and
 * sorted. `include:` (already resolved upstream in this file) or any other
 * rule type, an invalid list name or an invalid host throws. Lists are
 * written in name order.
 */
export function convertV2flyLists(lists: readonly V2flyList[], meta: CatalogMeta): Catalog {
  if (!RELEASE_PATTERN.test(meta.release)) {
    throw new Error(`invalid release tag: ${meta.release}`);
  }
  if (!Number.isFinite(Date.parse(meta.releasedAt))) {
    throw new Error(`invalid release time: ${meta.releasedAt}`);
  }
  if (!SHA256_PATTERN.test(meta.upstreamSha256)) {
    throw new Error(`invalid upstream sha256: ${meta.upstreamSha256}`);
  }
  const converted: Record<string, { rules: string; skipped: string[] }> = {};
  for (const list of [...lists].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!LIST_NAME_PATTERN.test(list.name)) {
      throw new Error(`invalid list name: ${list.name}`);
    }
    if (Object.hasOwn(converted, list.name)) {
      throw new Error(`duplicate list name: ${list.name}`);
    }
    const lines: string[] = [];
    const skipped: string[] = [];
    for (const rule of list.rules) {
      const m = RULE_PATTERN.exec(rule);
      if (m === null) {
        throw new Error(`${list.name}: unsupported rule: ${rule}`);
      }
      const [, type, rest] = m;
      const attrMatch = ATTRS_SUFFIX.exec(rest);
      const value = attrMatch === null ? rest : rest.slice(0, attrMatch.index);
      const attrs =
        attrMatch === null
          ? []
          : [...new Set(attrMatch[1].split(",").map((a) => a.slice(1)))].sort();
      if (type === "regexp" || type === "keyword") {
        skipped.push(attrs.join("@"));
        continue;
      }
      if (value.length > 253 || !HOST_PATTERN.test(value)) {
        throw new Error(`${list.name}: invalid host: ${rule}`);
      }
      lines.push(`${type === "full" ? "=" : ""}${value}${attrs.map((a) => `@${a}`).join("")}`);
    }
    converted[list.name] = { rules: lines.join("\n"), skipped };
  }
  return {
    format: 1,
    source: SOURCE,
    license: LICENSE,
    release: meta.release,
    releasedAt: meta.releasedAt,
    upstreamSha256: meta.upstreamSha256,
    lists: converted,
  };
}

/** Rule lines across all lists. */
function countRules(catalog: Pick<Catalog, "lists">): number {
  let rules = 0;
  for (const list of Object.values(catalog.lists)) {
    rules += list.rules.length === 0 ? 0 : list.rules.split("\n").length;
  }
  return rules;
}

/**
 * Refuse a release that shrank suspiciously against the previous catalog:
 * more than 10% fewer lists or 20% fewer rules.
 */
export function catalogGuard(
  prev: Pick<Catalog, "lists">,
  next: Pick<Catalog, "lists">
): { ok: true } | { ok: false; reason: string } {
  const prevLists = Object.keys(prev.lists).length;
  const nextLists = Object.keys(next.lists).length;
  if (nextLists < prevLists * (1 - MAX_LIST_DROP)) {
    return { ok: false, reason: `lists dropped from ${prevLists} to ${nextLists}` };
  }
  const prevRules = countRules(prev);
  const nextRules = countRules(next);
  if (nextRules < prevRules * (1 - MAX_RULE_DROP)) {
    return { ok: false, reason: `rules dropped from ${prevRules} to ${nextRules}` };
  }
  return { ok: true };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The CDN pointer (`site-groups/v1/latest.json`) for a written catalog file. */
export function catalogPointer(catalogBytes: Uint8Array, catalog: Catalog): CatalogPointer {
  return {
    format: 1,
    release: catalog.release,
    releasedAt: catalog.releasedAt,
    path: `site-groups/v1/catalog-${catalog.release}.json`,
    sha256: sha256Hex(catalogBytes),
    bytes: catalogBytes.byteLength,
    lists: Object.keys(catalog.lists).length,
    rules: countRules(catalog),
  };
}

// ─────────────────────────────── CLI ───────────────────────────────

interface CliOptions {
  input?: string;
  release?: string;
  releasedAt?: string;
  upstreamSha256?: string;
  out?: string;
  pointer?: string;
  guardAgainst?: string;
  download: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { download: false };
  const valued: Record<string, Exclude<keyof CliOptions, "download">> = {
    "--input": "input",
    "--release": "release",
    "--released-at": "releasedAt",
    "--upstream-sha256": "upstreamSha256",
    "--out": "out",
    "--pointer": "pointer",
    "--guard-against": "guardAgainst",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--download") {
      options.download = true;
      continue;
    }
    const key = valued[arg];
    const value = argv[i + 1];
    if (key === undefined || value === undefined) {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
    options[key] = value;
    i++;
  }
  return options;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await globalThis.fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`GET ${url}: HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Download the latest release's plain YAML, verifying it against the sum file and the API digest. */
async function downloadLatest(): Promise<{ text: string; meta: CatalogMeta }> {
  const res = await globalThis.fetch(RELEASES_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GET ${RELEASES_API}: HTTP ${res.status}`);
  }
  const release = (await res.json()) as {
    tag_name?: unknown;
    published_at?: unknown;
    assets?: unknown;
  };
  if (typeof release.tag_name !== "string" || typeof release.published_at !== "string") {
    throw new Error("release response is missing tag_name or published_at");
  }
  const assets = Array.isArray(release.assets) ? (release.assets as ReleaseAsset[]) : [];
  const plain = assets.find((a) => a.name === PLAIN_ASSET);
  const sum = assets.find((a) => a.name === `${PLAIN_ASSET}.sha256sum`);
  if (plain === undefined || sum === undefined) {
    throw new Error(`release ${release.tag_name} lacks ${PLAIN_ASSET} or its .sha256sum`);
  }
  const bytes = await fetchBytes(plain.browser_download_url);
  const digest = sha256Hex(bytes);
  const sumText = new TextDecoder().decode(await fetchBytes(sum.browser_download_url));
  const expected = sumText.trim().split(/\s+/)[0]?.toLowerCase();
  if (expected !== digest) {
    throw new Error(`sha256 mismatch: sum file says ${expected}, download is ${digest}`);
  }
  if (plain.digest !== `sha256:${digest}`) {
    throw new Error(`sha256 mismatch: API says ${String(plain.digest)}, download is ${digest}`);
  }
  return {
    text: new TextDecoder().decode(bytes),
    meta: {
      release: release.tag_name,
      releasedAt: release.published_at,
      upstreamSha256: digest,
    },
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv);
  if (options.out === undefined) {
    throw new Error("--out is required");
  }

  let text: string;
  let meta: CatalogMeta;
  if (options.download) {
    ({ text, meta } = await downloadLatest());
  } else {
    if (
      options.input === undefined ||
      options.release === undefined ||
      options.releasedAt === undefined ||
      options.upstreamSha256 === undefined
    ) {
      throw new Error("--input, --release, --released-at and --upstream-sha256 are required");
    }
    const bytes = readFileSync(options.input);
    const digest = sha256Hex(bytes);
    if (digest !== options.upstreamSha256) {
      throw new Error(
        `sha256 mismatch: --upstream-sha256 is ${options.upstreamSha256}, input is ${digest}`
      );
    }
    text = bytes.toString("utf8");
    meta = {
      release: options.release,
      releasedAt: options.releasedAt,
      upstreamSha256: digest,
    };
  }

  const catalog = convertV2flyLists(parseV2flyPlainYaml(text), meta);

  if (options.guardAgainst !== undefined) {
    const prev = JSON.parse(readFileSync(options.guardAgainst, "utf8")) as Pick<Catalog, "lists">;
    const guard = catalogGuard(prev, catalog);
    if (!guard.ok) {
      throw new Error(`guard failed: ${guard.reason}`);
    }
  }

  const bytes = new TextEncoder().encode(JSON.stringify(catalog));
  writeFileSync(options.out, bytes);
  const pointer = catalogPointer(bytes, catalog);
  if (options.pointer !== undefined) {
    writeFileSync(options.pointer, JSON.stringify(pointer));
  }
  console.log(
    `catalog ${pointer.release}: ${pointer.lists} lists, ${pointer.rules} rules, ` +
      `${Object.values(catalog.lists).reduce((sum, l) => sum + l.skipped.length, 0)} skipped, ` +
      `${pointer.bytes} bytes, sha256 ${pointer.sha256}`
  );
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
