/**
 * Site group tokens: the stored forms of a site group (`geosite:<name>[@attr]...`)
 * and of a list from a link (`list:<https URL>`).
 *
 * Both live as strings inside the existing `allowlist`, `denylist` and
 * `siteLocations[].patterns` arrays. `parsePattern` rejects both prefixes (the
 * `:` after `geosite`/`list` reads as a non-numeric port), so a token can never
 * be mistaken for a typed pattern, here or in the Swift parser.
 *
 * Pure, and must not import `scope.ts`: scope.ts imports this module.
 */

/** Prefix of a site group token. Matched case-insensitively on input; stored lowercase. */
export const GROUP_PREFIX = "geosite:";
/** Prefix of a list-from-a-link token. */
export const LINK_PREFIX = "list:";

/** Longest raw input either parser looks at, the same cap as `parsePattern`. */
const MAX_INPUT_LENGTH = 2048;
/** Longest stored link URL (the `href`, without the `list:` prefix). */
const MAX_LINK_LENGTH = 2048;
/** Longest derived display name for a link. */
const MAX_LINK_NAME_LENGTH = 60;

/** A v2fly list name, as v2ray-core accepts it: lowercase letters, digits, `!` and `-`. */
const GROUP_NAME_PATTERN = /^[a-z0-9!-]{1,64}$/;
/** A v2fly attribute (`@cn`, `@ads`, `@!cn`). */
const GROUP_ATTR_PATTERN = /^[a-z0-9!-]{1,32}$/;
/** File extensions dropped from a link's derived name. */
const LINK_NAME_EXTENSION = /\.(txt|list|conf|yaml|yml)$/i;

/** A parsed site group token. */
export interface GroupToken {
  kind: "group";
  /** Canonical stored form: `geosite:` + name + each attr as `@attr`, attrs sorted. */
  token: string;
  name: string;
  /** Deduped and sorted. Several attrs mean AND, as in v2ray-core's `parseAttrs`. */
  attrs: readonly string[];
}

/** A parsed list-from-a-link token. */
export interface LinkToken {
  kind: "link";
  /** Canonical stored form: `list:` + the URL's `href` without its hash. */
  token: string;
  /** The URL's `href` without its hash. */
  url: string;
}

/**
 * Parse a site group token, or return null. The `geosite:` prefix is required
 * and matched case-insensitively; the name and attrs are lowercased, attrs are
 * deduped and sorted (plain code-unit order), so `GeoSite:Google@CN@ads` and
 * `geosite:google@ads@cn` are one token.
 */
export function parseGroupToken(input: string): GroupToken | null {
  if (input.length > MAX_INPUT_LENGTH) {
    return null;
  }
  const trimmed = input.trim();
  if (trimmed.slice(0, GROUP_PREFIX.length).toLowerCase() !== GROUP_PREFIX) {
    return null;
  }
  const [name, ...rawAttrs] = trimmed.slice(GROUP_PREFIX.length).toLowerCase().split("@");
  if (!GROUP_NAME_PATTERN.test(name)) {
    return null;
  }
  for (const attr of rawAttrs) {
    if (!GROUP_ATTR_PATTERN.test(attr)) {
      return null;
    }
  }
  const attrs = [...new Set(rawAttrs)].sort();
  const token = `${GROUP_PREFIX}${name}${attrs.map((a) => `@${a}`).join("")}`;
  return { kind: "group", token, name, attrs };
}

/**
 * Parse a list-from-a-link token, or return null. Accepts `list:<url>` (prefix
 * case-insensitive) or a bare URL. The URL must be https, carry no username or
 * password, and have a hostname. The hash is dropped (it never reaches the
 * server), and the `href` is capped at 2048 chars. A Unicode hostname comes
 * back as its A-label, because `URL` converts it.
 */
export function parseLinkToken(input: string): LinkToken | null {
  if (input.length > MAX_INPUT_LENGTH) {
    return null;
  }
  let raw = input.trim();
  if (raw.slice(0, LINK_PREFIX.length).toLowerCase() === LINK_PREFIX) {
    raw = raw.slice(LINK_PREFIX.length).trim();
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return null;
  }
  if (url.hostname.length === 0) {
    return null;
  }
  url.hash = "";
  const href = url.href;
  if (href.length > MAX_LINK_LENGTH) {
    return null;
  }
  return { kind: "link", token: `${LINK_PREFIX}${href}`, url: href };
}

/** True when a stored entry is a site group or list-from-a-link token (canonical prefixes). */
export function isSiteGroupToken(entry: string): boolean {
  return entry.startsWith(GROUP_PREFIX) || entry.startsWith(LINK_PREFIX);
}

/**
 * The name shown for a list from a link. Derived, never stored: the URL's last
 * non-empty path segment, percent-decoded, without a `.txt`/`.list`/`.conf`/
 * `.yaml`/`.yml` extension, capped at 60 characters. Falls back to the
 * hostname. Accepts the `href` or the whole `list:` token.
 */
export function linkDisplayName(url: string): string {
  const href = url.startsWith(LINK_PREFIX) ? url.slice(LINK_PREFIX.length) : url;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return Array.from(href).slice(0, MAX_LINK_NAME_LENGTH).join("");
  }
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  let name = segments.length > 0 ? segments[segments.length - 1] : "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // A malformed escape keeps the raw segment.
  }
  name = Array.from(name.replace(LINK_NAME_EXTENSION, "").trim())
    .slice(0, MAX_LINK_NAME_LENGTH)
    .join("");
  return name.length > 0 ? name : parsed.hostname;
}
