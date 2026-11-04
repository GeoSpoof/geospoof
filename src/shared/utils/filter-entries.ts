/**
 * The entry grammar shared by Filters and per-site locations: a superset of the
 * typed-pattern grammar (`parsePattern`) with three more forms.
 *
 *   - Exact address: `=` + a canonical typed pattern whose host isn't `*` or
 *     `*.x` (`=mail.example.com`). Matches that host only, no subdomains. An
 *     IPv4 host is already exact, so `=1.2.3.4` canonicalizes to `1.2.3.4`.
 *   - Site group: `geosite:<name>[@attr]...` (see `tokens.ts`).
 *   - List from a link: `list:<https URL>` (see `tokens.ts`).
 *
 * `parsePattern` and `parseSiteLocationPattern` reject all three and stay
 * unchanged (the Swift parser mirrors them). A bare `https://...` with no kind
 * given stays a typed pattern: only an explicit `link` kind (the popup's type
 * menu or auto-detect) turns a URL into a link.
 *
 * Pure.
 */

import {
  GROUP_PREFIX,
  LINK_PREFIX,
  isSiteGroupToken,
  parseGroupToken,
  parseLinkToken,
} from "@/shared/site-groups/tokens";
import { decomposePattern, isValidIpv4, parsePattern } from "./scope";

/** The kinds the popup's type menu offers. */
export type EntryInputKind = "site" | "exact" | "subdomains" | "group" | "link";

/** Prefix of an exact-address entry. */
export const EXACT_PREFIX = "=";

/** A canonical entry, classified. */
export type FilterEntryClass =
  | { type: "pattern"; pattern: string }
  | { type: "exact"; pattern: string }
  | { type: "group"; token: string; name: string; attrs: readonly string[] }
  | { type: "link"; token: string; url: string };

/** File extensions that make an `https://` input auto-detect as a list link. */
const LINK_FILE_EXTENSION = /\.(txt|list|conf|yaml|yml)$/i;

/** Rebuild a canonical pattern from its pieces (the inverse of `decomposePattern`). */
function composePattern(scheme: string, host: string, port: string, path: string): string {
  return `${scheme === "" ? "" : `${scheme}://`}${host}${port === "" ? "" : `:${port}`}${path}`;
}

/** True when `input` starts with `prefix`, ignoring ASCII case. */
function startsWithInsensitive(input: string, prefix: string): boolean {
  return input.slice(0, prefix.length).toLowerCase() === prefix;
}

/** The exact-address canonical form of a typed input, or null. */
function parseExact(input: string): string | null {
  const canonical = parsePattern(input);
  if (canonical === null) {
    return null;
  }
  const { host } = decomposePattern(canonical);
  if (host === "*" || host.startsWith("*.")) {
    return null;
  }
  return isValidIpv4(host) ? canonical : `${EXACT_PREFIX}${canonical}`;
}

/** The subdomains-only (`*.host`) canonical form of a typed input, or null. */
function parseSubdomains(input: string): string | null {
  const canonical = parsePattern(input);
  if (canonical === null) {
    return null;
  }
  const { scheme, host, port, path } = decomposePattern(canonical);
  if (host === "*" || isValidIpv4(host)) {
    return null;
  }
  if (host.startsWith("*.")) {
    return canonical;
  }
  return parsePattern(composePattern(scheme, `*.${host}`, port, path));
}

/**
 * Parse an entry into its canonical stored form, or return null.
 *
 * With no `kind` (stored values, bridged values, `ADD_SCOPE_SITE` payloads):
 * a `geosite:` token, then a `list:` token, then `=` exact, then a typed
 * pattern. With a `kind` (the popup's type menu), markers that conflict with
 * it are stripped first (`normalizeInputForKind`), then:
 *   - `site`: a typed pattern;
 *   - `subdomains`: a typed pattern with the host rebuilt as `*.host`;
 *   - `exact`: an exact address;
 *   - `group`: a site group, `geosite:` added when missing;
 *   - `link`: a list from a link (a bare https URL is accepted).
 *
 * Idempotent: a non-null result parses to itself with no kind.
 */
export function parseFilterEntry(input: string, kind?: EntryInputKind): string | null {
  if (kind === undefined) {
    const trimmed = input.trim();
    if (startsWithInsensitive(trimmed, GROUP_PREFIX)) {
      return parseGroupToken(trimmed)?.token ?? null;
    }
    if (startsWithInsensitive(trimmed, LINK_PREFIX)) {
      return parseLinkToken(trimmed)?.token ?? null;
    }
    if (trimmed.startsWith(EXACT_PREFIX)) {
      return parseExact(trimmed.slice(EXACT_PREFIX.length));
    }
    return parsePattern(input);
  }

  const normalized = normalizeInputForKind(input, kind);
  switch (kind) {
    case "site":
      return parsePattern(normalized);
    case "subdomains":
      return parseSubdomains(normalized);
    case "exact": {
      const trimmed = normalized.trim();
      return parseExact(
        trimmed.startsWith(EXACT_PREFIX) ? trimmed.slice(EXACT_PREFIX.length) : trimmed
      );
    }
    case "group": {
      const trimmed = normalized.trim();
      return (
        parseGroupToken(
          startsWithInsensitive(trimmed, GROUP_PREFIX) ? trimmed : `${GROUP_PREFIX}${trimmed}`
        )?.token ?? null
      );
    }
    case "link":
      return parseLinkToken(normalized)?.token ?? null;
  }
}

/**
 * Classify a canonical entry (a `parseFilterEntry` result). Null when a token
 * prefix is present but the token doesn't parse.
 */
export function classifyFilterEntry(canonical: string): FilterEntryClass | null {
  if (canonical.startsWith(GROUP_PREFIX)) {
    const group = parseGroupToken(canonical);
    return group === null
      ? null
      : { type: "group", token: group.token, name: group.name, attrs: group.attrs };
  }
  if (canonical.startsWith(LINK_PREFIX)) {
    const link = parseLinkToken(canonical);
    return link === null ? null : { type: "link", token: link.token, url: link.url };
  }
  if (canonical.startsWith(EXACT_PREFIX)) {
    return { type: "exact", pattern: canonical.slice(EXACT_PREFIX.length) };
  }
  return { type: "pattern", pattern: canonical };
}

/**
 * The kind an input's leading marker asks for, or null when it has none:
 * `geosite:` is a group; `list:`, or an `https://` URL whose last path segment
 * ends in `.txt`/`.list`/`.conf`/`.yaml`/`.yml`, is a link; `=` is exact; `*.`
 * is subdomains.
 */
export function detectEntryKind(input: string): EntryInputKind | null {
  const trimmed = input.trimStart();
  if (startsWithInsensitive(trimmed, GROUP_PREFIX)) {
    return "group";
  }
  if (startsWithInsensitive(trimmed, LINK_PREFIX)) {
    return "link";
  }
  if (startsWithInsensitive(trimmed, "https://")) {
    try {
      const segments = new URL(trimmed.trim()).pathname.split("/").filter((s) => s.length > 0);
      const last = segments.length > 0 ? segments[segments.length - 1] : "";
      if (LINK_FILE_EXTENSION.test(last)) {
        return "link";
      }
    } catch {
      // Not a URL yet; fall through.
    }
  }
  if (trimmed.startsWith(EXACT_PREFIX)) {
    return "exact";
  }
  if (trimmed.startsWith("*.")) {
    return "subdomains";
  }
  return null;
}

/** The leading markers each kind removes, because they ask for a different kind. */
const CONFLICTING_MARKERS: Readonly<Record<EntryInputKind, readonly string[]>> = {
  site: [EXACT_PREFIX, "*.", GROUP_PREFIX, LINK_PREFIX],
  exact: ["*.", GROUP_PREFIX, LINK_PREFIX],
  subdomains: [EXACT_PREFIX, GROUP_PREFIX, LINK_PREFIX],
  group: [EXACT_PREFIX, "*.", LINK_PREFIX],
  link: [EXACT_PREFIX, "*.", GROUP_PREFIX],
};

/**
 * Strip the leading markers that conflict with `kind` (for example `geosite:`
 * when the user picks Exact address), so the input reads as the chosen kind.
 * Leading whitespace goes too; the rest of the input is kept as typed.
 */
export function normalizeInputForKind(input: string, kind: EntryInputKind): string {
  let s = input.trimStart();
  let changed = true;
  while (changed) {
    changed = false;
    for (const marker of CONFLICTING_MARKERS[kind]) {
      if (startsWithInsensitive(s, marker)) {
        s = s.slice(marker.length).trimStart();
        changed = true;
      }
    }
  }
  return s;
}

/** True for typed patterns and exact addresses; false for group and link tokens. */
export function isTypedEntry(canonical: string): boolean {
  return !isSiteGroupToken(canonical);
}

/**
 * Parse a per-site location entry, or return null. Typed and exact entries
 * follow the `parseSiteLocationPattern` rules (no path, no wildcard-only host);
 * group and link tokens pass through as `parseFilterEntry` gives them.
 */
export function parseSiteLocationEntry(input: string, kind?: EntryInputKind): string | null {
  const canonical = parseFilterEntry(input, kind);
  if (canonical === null) {
    return null;
  }
  if (isSiteGroupToken(canonical)) {
    return canonical;
  }
  const typed = canonical.startsWith(EXACT_PREFIX)
    ? canonical.slice(EXACT_PREFIX.length)
    : canonical;
  const { host, path } = decomposePattern(typed);
  if (path !== "" || host === "*") {
    return null;
  }
  return canonical;
}
