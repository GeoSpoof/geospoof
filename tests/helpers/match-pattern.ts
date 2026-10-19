/**
 * A minimal Firefox match-pattern matcher for the forms the bootstrap planner
 * emits: `<scheme>://<host>/*`. Scheme `*` means http or https; host `*` is
 * any host, `*.L` is `L` and its subdomains, anything else is exact. Ports are
 * ignored, as in Firefox. Not a `*.test.ts` file, so Vitest doesn't collect it.
 */

const FORM = /^(\*|https?):\/\/([^/]+)\/\*$/;

/** True when `url` matches the match pattern `pattern`. Throws on a form the planner never emits. */
export function matchesMatchPattern(url: string, pattern: string): boolean {
  const form = FORM.exec(pattern);
  if (!form) throw new Error(`unsupported match pattern: ${pattern}`);
  const [, scheme, host] = form;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const protocol = parsed.protocol.slice(0, -1);
  if (protocol !== "http" && protocol !== "https") return false;
  if (scheme !== "*" && scheme !== protocol) return false;

  const hostname = parsed.hostname;
  if (host === "*") return true;
  if (host.startsWith("*.")) {
    const base = host.slice(2);
    return hostname === base || hostname.endsWith("." + base);
  }
  return hostname === host;
}

/** True when a registration with these `matches` / `excludeMatches` runs on `url`. */
export function scriptMatchesUrl(
  script: { matches: readonly string[]; excludeMatches?: readonly string[] },
  url: string
): boolean {
  return (
    script.matches.some((p) => matchesMatchPattern(url, p)) &&
    !(script.excludeMatches ?? []).some((p) => matchesMatchPattern(url, p))
  );
}
