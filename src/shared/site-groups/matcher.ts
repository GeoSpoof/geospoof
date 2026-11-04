/**
 * Site group matching: is a page's hostname in a group?
 *
 * A group's data is two `"\n"`-framed strings: `d` holds `domain` entries
 * (the host or any subdomain of it) and `f` holds `full` entries (that exact
 * host). Framing makes a membership test a substring search for
 * `"\n" + host + "\n"`, which needs no parse step, so it suits the Firefox
 * head start that inlines the strings into a page script. The background
 * builds `Set`s lazily instead (`createSiteGroupLookup`); both forms give the
 * same answers.
 *
 * Only the top-level URL's `hostname` (ASCII, lowercase) is matched. A host
 * with a trailing dot matches nothing, the same as typed patterns.
 *
 * Pure, and must not import `scope.ts`: scope.ts imports this module.
 */

/** A group's entries as `"\n"`-framed strings. */
export interface SiteGroupStrings {
  /** `domain` entries: the host or any subdomain. */
  d: string;
  /** `full` entries: that exact host. */
  f: string;
}

/** A group's data as the resolvers need it: entries plus the usable entry count. */
export interface SiteGroupData extends SiteGroupStrings {
  /** Unique `domain` plus `full` entries; the per-site location tie-break uses it. */
  n: number;
}

/** Frame entries as `"\n" + join("\n") + "\n"`, or `"\n"` when there are none. */
export function frameEntries(entries: readonly string[]): string {
  return entries.length === 0 ? "\n" : `\n${entries.join("\n")}\n`;
}

/** Split a framed string back into its entries. */
function unframe(framed: string): string[] {
  return framed.split("\n").filter((e) => e.length > 0);
}

/**
 * True when `host` is in the group: it equals a `full` entry, or it or one of
 * its label suffixes equals a `domain` entry. Single-label entries (`cn`) work.
 */
export function hostInGroupStrings(d: string, f: string, host: string): boolean {
  if (host.length === 0) {
    return false;
  }
  if (f.includes(`\n${host}\n`)) {
    return true;
  }
  let s = host;
  while (s.length > 0) {
    if (d.includes(`\n${s}\n`)) {
      return true;
    }
    const dot = s.indexOf(".");
    if (dot === -1) {
      break;
    }
    s = s.slice(dot + 1);
  }
  return false;
}

/** Group membership and size by stored token. */
export interface SiteGroupLookup {
  /** True when `token`'s data is present and contains `host`. */
  has(token: string, host: string): boolean;
  /** The group's usable entry count, or undefined when its data is absent. */
  size(token: string): number | undefined;
}

/** The lookup with no data: every token matches nothing. */
export const NO_SITE_GROUPS: SiteGroupLookup = {
  has: () => false,
  size: () => undefined,
};

/**
 * Build a lookup over group data keyed by token. Each token's `Set`s are built
 * on its first `has()` call, so waking with many groups costs nothing until a
 * page needs one. Answers exactly like `hostInGroupStrings`.
 */
export function createSiteGroupLookup(
  groups: Readonly<Record<string, SiteGroupData>>
): SiteGroupLookup {
  const sets = new Map<string, { d: Set<string>; f: Set<string> }>();

  function setsFor(token: string): { d: Set<string>; f: Set<string> } | null {
    if (!Object.hasOwn(groups, token)) {
      return null;
    }
    let built = sets.get(token);
    if (built === undefined) {
      const group = groups[token];
      built = { d: new Set(unframe(group.d)), f: new Set(unframe(group.f)) };
      sets.set(token, built);
    }
    return built;
  }

  return {
    has(token: string, host: string): boolean {
      if (host.length === 0) {
        return false;
      }
      const group = setsFor(token);
      if (group === null) {
        return false;
      }
      if (group.f.has(host)) {
        return true;
      }
      let s = host;
      while (s.length > 0) {
        if (group.d.has(s)) {
          return true;
        }
        const dot = s.indexOf(".");
        if (dot === -1) {
          break;
        }
        s = s.slice(dot + 1);
      }
      return false;
    },
    size(token: string): number | undefined {
      return Object.hasOwn(groups, token) ? groups[token].n : undefined;
    },
  };
}

/**
 * The union of several tokens' entries as one pair of framed strings, deduped
 * and in first-seen order. Tokens without data are skipped; null when none has
 * data.
 */
export function unionGroupStrings(
  groups: Readonly<Record<string, SiteGroupStrings>>,
  tokens: readonly string[]
): SiteGroupStrings | null {
  const present = [...new Set(tokens)].filter((t) => Object.hasOwn(groups, t));
  if (present.length === 0) {
    return null;
  }
  if (present.length === 1) {
    const { d, f } = groups[present[0]];
    return { d, f };
  }
  const d = new Set<string>();
  const f = new Set<string>();
  for (const token of present) {
    for (const e of unframe(groups[token].d)) d.add(e);
    for (const e of unframe(groups[token].f)) f.add(e);
  }
  return { d: frameEntries([...d]), f: frameEntries([...f]) };
}
