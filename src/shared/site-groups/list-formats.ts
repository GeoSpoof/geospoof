/**
 * Parse a domain list downloaded from a user's link into domain and full
 * entries. One parser reads the formats proxy users already have:
 *
 *   - plain lines (`example.com`) and v2fly `domain:` mean the domain plus
 *     subdomains; v2fly `full:` means that host only. A v2fly inline attr
 *     (` @cn`, or `:@cn` as in `dlc.dat_plain.yml`) is stripped;
 *   - Clash `DOMAIN-SUFFIX,` is a domain and `DOMAIN,` is exact;
 *   - mihomo `+.x` is a domain. If any line uses `+.`, the file is in mihomo
 *     domain format, where a plain line means exact (mihomo's own rule);
 *   - a YAML `payload:` wrapper (Clash/mihomo rule providers) is unwrapped.
 *
 * Regex and keyword rules aren't run (Filters rejects regex on purpose), and
 * any other rule type, wildcard form or invalid host is counted as `other`.
 * `#` comments, a BOM and CRLF line ends are handled.
 *
 * Pure.
 */

import { hostToASCII } from "@/shared/utils/idn";

/** Default cap on unique entries (domains plus fulls). */
export const MAX_LIST_ENTRIES = 250_000;

export interface ParsedDomainList {
  /** Unique, lowercase A-label hosts matching themselves and their subdomains. */
  domains: string[];
  /** Unique, lowercase A-label hosts matching only themselves. */
  fulls: string[];
  /** Rules that were read but not used. */
  skipped: { regexp: number; keyword: number; other: number };
}

export type DomainListResult = ParsedDomainList | { error: "TOO_LARGE" };

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOST_LENGTH = 253;
/** An inline comment: `#` at the start or after whitespace. */
const INLINE_COMMENT = /(^|\s)#.*$/;
/** A v2fly attr suffix: ` @a @b` or `:@a,@b`. */
const V2FLY_ATTRS = /(?:\s+@[^\s]+)+$|:@[a-z0-9!-]+(?:,@[a-z0-9!-]+)*$/i;

/** A host converted to its lowercase A-label and checked against strict label rules, or null. */
function normalizeHost(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_HOST_LENGTH * 4) {
    return null;
  }
  const ascii = hostToASCII(raw.toLowerCase());
  if (ascii === null || ascii.length > MAX_HOST_LENGTH) {
    return null;
  }
  for (const label of ascii.split(".")) {
    if (!LABEL_PATTERN.test(label)) {
      return null;
    }
  }
  return ascii;
}

/** Remove one pair of matching quotes around a YAML scalar. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === "'" || first === '"') && value[value.length - 1] === first) {
      return value.slice(1, -1);
    }
  }
  return value;
}

type RuleKind = "domain" | "full" | "regexp" | "keyword" | "other";

/** Classify one non-empty, comment-free line. `plain` is what a bare host means. */
function classifyLine(line: string, plain: "domain" | "full"): { kind: RuleKind; host?: string } {
  const lower = line.toLowerCase();

  // v2fly
  const v2fly = /^(domain|full|regexp|keyword|include):(.*)$/.exec(lower);
  if (v2fly !== null) {
    const kind = v2fly[1];
    if (kind === "regexp" || kind === "keyword") {
      return { kind };
    }
    if (kind === "include") {
      return { kind: "other" };
    }
    const host = normalizeHost(
      line
        .slice(kind.length + 1)
        .replace(V2FLY_ATTRS, "")
        .trim()
    );
    return host === null ? { kind: "other" } : { kind: kind as "domain" | "full", host };
  }

  // Clash / mihomo classical rules: TYPE,value[,policy...]
  if (line.includes(",")) {
    const [type, value = ""] = line.split(",").map((part) => part.trim());
    switch (type.toUpperCase()) {
      case "DOMAIN-SUFFIX":
      case "DOMAIN": {
        const host = normalizeHost(value);
        if (host === null) {
          return { kind: "other" };
        }
        return { kind: type.toUpperCase() === "DOMAIN" ? "full" : "domain", host };
      }
      case "DOMAIN-KEYWORD":
        return { kind: "keyword" };
      case "DOMAIN-REGEX":
        return { kind: "regexp" };
      default:
        return { kind: "other" };
    }
  }

  // mihomo domain format
  if (line.startsWith("+.")) {
    const host = normalizeHost(line.slice(2));
    return host === null ? { kind: "other" } : { kind: "domain", host };
  }

  // plain host (with a v2fly-style ` @attr` tolerated)
  const host = normalizeHost(line.replace(V2FLY_ATTRS, "").trim());
  return host === null ? { kind: "other" } : { kind: plain, host };
}

/**
 * Parse a downloaded list. `TOO_LARGE` when it holds more than `maxEntries`
 * unique entries; nothing is returned in that case.
 */
export function parseDomainList(
  text: string,
  { maxEntries = MAX_LIST_ENTRIES }: { maxEntries?: number } = {}
): DomainListResult {
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  let lines = body
    .split(/\r\n|\r|\n/)
    .map((raw) => raw.replace(INLINE_COMMENT, "").trim())
    .filter((line) => line.length > 0);

  // A YAML rule provider: `payload:` followed by `- item` lines.
  if (lines.some((line) => line === "payload:")) {
    lines = lines
      .filter((line) => line !== "payload:")
      .map((line) => (line.startsWith("- ") ? unquote(line.slice(2).trim()) : line))
      .filter((line) => line.length > 0);
  }

  const plain = lines.some((line) => line.startsWith("+.")) ? "full" : "domain";
  const domains = new Set<string>();
  const fulls = new Set<string>();
  const skipped = { regexp: 0, keyword: 0, other: 0 };

  for (const line of lines) {
    const { kind, host } = classifyLine(line, plain);
    if ((kind === "domain" || kind === "full") && host !== undefined) {
      (kind === "domain" ? domains : fulls).add(host);
      if (domains.size + fulls.size > maxEntries) {
        return { error: "TOO_LARGE" };
      }
    } else if (kind === "regexp" || kind === "keyword") {
      skipped[kind]++;
    } else {
      skipped.other++;
    }
  }

  return { domains: [...domains], fulls: [...fulls], skipped };
}
