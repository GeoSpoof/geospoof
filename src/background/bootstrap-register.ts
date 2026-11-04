/**
 * Early-bootstrap registration (Firefox only).
 *
 * The injected content script runs at document_start but receives the spoofing
 * settings asynchronously, which leaves a brief window where the *synchronous*
 * timezone surfaces (`Intl.DateTimeFormat().resolvedOptions().timeZone`,
 * `Date.prototype.getTimezoneOffset`, etc.) answer with the user's real zone if
 * a page reads them in its very first `<script>`. See
 * `content/injected/bootstrap.ts` for the page-side half.
 *
 * To close that gap we register MAIN-world `userScripts` scripts that run at
 * document_start — before any page script — with the last-saved settings
 * inlined as code, stashing them in a global the injected script consumes
 * synchronously. `userScripts.register` only accepts file paths in Chrome's
 * `scripting` API, but Firefox's MV3 `userScripts` API accepts inline `code`,
 * which is what makes this possible on Firefox specifically.
 *
 * Per-site plan. The async path decides per tab, from the top-level URL, whether
 * GeoSpoof is on (Filters) and which location applies (site locations). The
 * bootstrap has to agree with it, but it can only use Firefox match patterns,
 * which can't express ports, paths, "subdomains but not the apex", or
 * most-specific-wins. `planBootstrapScripts` therefore emits one main script
 * (the main location) plus one script per site location, under one invariant:
 *
 *   THE BOOTSTRAP MAY BE ABSENT BUT MUST NEVER BE WRONG.
 *
 * A page with no seed just falls back to the async path a few ms later (the
 * pre-existing cold-start window). A page seeded with the wrong zone flips
 * after its first reads, which is a fingerprint. So `matches` always
 * under-approximate the URLs a script's settings are right for, and
 * `excludeMatches` always over-approximate the URLs they're wrong for. In
 * particular:
 *   - Scripts run in the top frame only whenever any site location exists or
 *     Filters aren't "all": `allFrames` matches each frame's OWN URL, but the
 *     async path decides from the top-level URL.
 *   - Patterns with a port, or (allowlist) a path, get no seed: match patterns
 *     ignore ports and paths. Their hosts are excluded from broader scripts.
 *   - A denylist entry excludes its whole host on every scheme and port; a
 *     denylist that matches every host (`*`) means no scripts at all.
 *   - `file:` and other non-http(s) pages are never seeded.
 *   - Exact entries (`=host`) get exact-host match patterns.
 *   - Site group and link tokens can't be match patterns. A script that must
 *     honor them inlines the groups' `"\n"`-framed strings into a small host
 *     gate in front of the seed (`buildBootstrapCode`), which runs the same
 *     test as `hostInGroupStrings`. Per-site-location scripts never get group
 *     data: they seed typed patterns only, which beat any group, and in
 *     denylist mode they leave out any typed pattern whose hosts a denied group
 *     touches (`groupsTouchHost`).
 *
 * Why Firefox-only:
 *   - Firefox: `userScripts` is an *optional-only* permission. The user grants
 *     it at runtime via the popup's "Instant timezone protection" toggle
 *     (`permissions.request`). Once granted, `browser.userScripts` appears and
 *     this registration takes effect on the next navigation.
 *   - Chrome: `chrome.userScripts` exists but, since Chrome 138, requires the
 *     user to manually flip a per-extension "Allow User Scripts" toggle in
 *     chrome://extensions that cannot be granted programmatically — a
 *     non-starter for a normal install.
 *   - Safari: no dependable inline early-injection primitive.
 * On engines/installs without the granted API the global is simply never set
 * and the page-side seed is a no-op, leaving the pre-existing (tiny) cold-start
 * window documented as a known limitation.
 *
 * Everything here is best-effort and fully guarded: if the `userScripts` API is
 * unavailable or a call throws, we log and no-op, preserving current behavior
 * (no regression).
 */

import type { Settings, SiteLocation } from "@/shared/types/settings";
import {
  hostInGroupStrings,
  unionGroupStrings,
  type SiteGroupStrings,
} from "@/shared/site-groups/matcher";
import { isSiteGroupToken } from "@/shared/site-groups/tokens";
import { createLogger } from "@/shared/utils/debug-logger";
import { EXACT_PREFIX, isTypedEntry } from "@/shared/utils/filter-entries";
import { hostToASCII } from "@/shared/utils/idn";
import { computeEffectiveSiteLocations, decomposePattern, isValidIpv4 } from "@/shared/utils/scope";
import { compareSpecificity, siteLocationSpecificity } from "@/shared/utils/site-locations";
import { isOlderRevision, readRevision } from "@/shared/settings-revision";
import { buildBootstrapPayload } from "./page-payload";
import { RESTRICTED_DOMAINS } from "./restricted-url";
import {
  currentSiteGroupData,
  loadSiteGroupCache,
  onSiteGroupCacheLoaded,
  referencedSiteGroupTokens,
  siteGroupCacheLoaded,
} from "./site-groups-store";

/* eslint-disable no-var */
declare var process: { env: Record<string, string | undefined> };
/* eslint-enable no-var */

const logger = createLogger("BG");

/** Stable id for the main-location bootstrap user script. */
const SCRIPT_ID = "gs-tz-bootstrap";

/** Id of the allowlist's site-group script (main location, gated on the allowed groups). */
const GROUPS_SCRIPT_ID = "gs-tz-bootstrap-groups";

/** Id prefix for the per-site-location bootstrap scripts. */
const SITE_SCRIPT_ID_PREFIX = "gs-tz-bootstrap-site-";

/** The match pattern for every http(s) page; excluding it excludes everything. */
const ALL_HOSTS = "*://*/*";

/** Every http(s) page (not `<all_urls>`, so `file:` pages aren't seeded). */
const HTTP_HOSTS = ["http://*/*", "https://*/*"];

/**
 * Global name the bootstrap code writes to. MUST match `BOOT_KEY` in
 * `content/injected/bootstrap.ts` (same derivation from the EVENT_NAME secret).
 */
const BOOT_KEY: string = (process.env.EVENT_NAME || "__x_evt") + "_b";

/**
 * Minimal structural type for the slice of the `userScripts` API we use.
 * `webextension-polyfill` doesn't type the MV3 userScripts namespace yet.
 */
interface UserScriptsApi {
  register: (scripts: Array<Record<string, unknown>>) => Promise<void>;
  unregister: (filter?: { ids?: string[] }) => Promise<void>;
  getScripts?: (filter?: { ids?: string[] }) => Promise<Array<{ id: string }>>;
}

function getUserScriptsApi(): UserScriptsApi | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const api = (browser as any).userScripts as UserScriptsApi | undefined;
    if (api && typeof api.register === "function" && typeof api.unregister === "function") {
      return api;
    }
  } catch {
    /* namespace not present */
  }
  return null;
}

/**
 * The site group checks a script runs on the page's hostname before it seeds.
 * Each field is the union of some groups' `"\n"`-framed strings.
 */
export interface BootstrapGate {
  /** Seed only when the host is in these groups (the allowlist's groups). */
  allow?: SiteGroupStrings;
  /** Don't seed when the host is in these groups (the denylist's groups). */
  deny?: SiteGroupStrings;
  /** Don't seed when the host is in these groups (the site locations' groups). */
  skip?: SiteGroupStrings;
}

/**
 * The gate's prelude: `h` is the page's hostname and `m(d, f)` is
 * `hostInGroupStrings(d, f, h)`, written for a page script. It runs at
 * document_start in the MAIN world, before any page script can patch
 * `location` or `String.prototype`. An empty hostname seeds nothing.
 */
const GATE_PRELUDE =
  '(function(){var h=location.hostname;function m(d,f){if(f.indexOf("\\n"+h+"\\n")>=0)return true;' +
  'var s=h;while(s.length>0){if(d.indexOf("\\n"+s+"\\n")>=0)return true;var i=s.indexOf(".");' +
  "if(i<0)return false;s=s.slice(i+1);}return false;}if(!h)return;";

/** The gate's call of `m` for one pair of framed strings. */
function gateCall(g: SiteGroupStrings): string {
  return `m(${JSON.stringify(g.d)},${JSON.stringify(g.f)})`;
}

/**
 * Build the inline bootstrap code that stashes settings in the page global.
 * With no gate the code is the bare seed. With a gate, the seed runs inside a
 * function that returns first when the host is in `skip` or `deny`, or isn't
 * in `allow`.
 */
export function buildBootstrapCode(payload: unknown, gate: BootstrapGate | null = null): string {
  // Non-enumerable so it doesn't show up in a casual `Object.keys(window)`
  // sweep; the injected script deletes it on first read regardless.
  const json = JSON.stringify(payload);
  const key = JSON.stringify(BOOT_KEY);
  const seed =
    `try{Object.defineProperty(globalThis,${key},` +
    `{value:${json},configurable:true,enumerable:false,writable:true});}catch(e){}`;
  if (gate === null) return seed;
  let checks = "";
  if (gate.skip) checks += `if(${gateCall(gate.skip)})return;`;
  if (gate.deny) checks += `if(${gateCall(gate.deny)})return;`;
  if (gate.allow) checks += `if(!${gateCall(gate.allow)})return;`;
  return `${GATE_PRELUDE}${checks}${seed}})();`;
}

// ─────────────────────────────── Planner ───────────────────────────────

/** One planned registration: where it runs, and the settings its payload is built from. */
export interface BootstrapPlanItem {
  id: string;
  matches: string[];
  excludeMatches: string[];
  allFrames: boolean;
  /** The effective settings for this script's pages (main, or overlaid by a site location). */
  settings: Settings;
  /**
   * The site group checks the script's code runs before seeding. Absent when
   * there are none, so a plan for settings without site groups is unchanged.
   */
  gate?: BootstrapGate;
}

/**
 * A canonical typed entry's host, in the A-label form URLs carry:
 *   - `any`: `*`
 *   - `subdomains`: `*.L` (GeoSpoof excludes the apex `L`)
 *   - `exact`: an IPv4 literal
 *   - `host`: the host of an exact entry `=L` (that hostname only)
 *   - `domain`: a bare `L` (GeoSpoof matches `L` and its subdomains; this
 *     includes `localhost`, which compiles to `{*.}?localhost` like any name)
 * Null when the host can't be converted to ASCII; such a pattern never matches
 * in GeoSpoof (the compiler yields a non-matching pattern), so it needs no seed
 * and no exclusion.
 */
interface PatternHost {
  kind: "any" | "subdomains" | "exact" | "host" | "domain";
  ascii: string;
}

/** `host` is from an exact entry (`=` stripped) when `exact` is true. */
function patternHost(host: string, exact = false): PatternHost | null {
  if (exact) {
    // `=*` and `=*.L` never compile (`patternToInit`), so they never match.
    if (host === "*" || host.startsWith("*.")) return null;
    if (isValidIpv4(host)) return { kind: "exact", ascii: host };
    const ascii = hostToASCII(host);
    return ascii === null ? null : { kind: "host", ascii };
  }
  if (host === "*") return { kind: "any", ascii: "" };
  if (host.startsWith("*.")) {
    const ascii = hostToASCII(host.slice(2));
    return ascii === null ? null : { kind: "subdomains", ascii };
  }
  if (isValidIpv4(host)) return { kind: "exact", ascii: host };
  const ascii = hostToASCII(host);
  return ascii === null ? null : { kind: "domain", ascii };
}

/** The Firefox match-pattern host for a pattern host. `*.L` matches `L` and its subdomains. */
function matchHost(h: PatternHost): string {
  switch (h.kind) {
    case "any":
      return "*";
    case "exact":
    case "host":
      return h.ascii;
    case "subdomains":
    case "domain":
      return `*.${h.ascii}`;
  }
}

/** True when `host` is `base` or one of its subdomains (label-wise). */
function isSameOrSubdomain(host: string, base: string): boolean {
  return host === base || host.endsWith("." + base);
}

/** A canonical typed entry's pieces: a pattern, or an exact entry with its `=` stripped. */
function typedParts(entry: string): {
  scheme: string;
  host: string;
  port: string;
  path: string;
  exact: boolean;
} {
  const exact = entry.startsWith(EXACT_PREFIX);
  return { ...decomposePattern(exact ? entry.slice(EXACT_PREFIX.length) : entry), exact };
}

/** A canonical typed entry's host. */
function entryHost(entry: string): PatternHost | null {
  const { host, exact } = typedParts(entry);
  return patternHost(host, exact);
}

/**
 * Match patterns covering a SUBSET of the URLs `p` matches. Empty for a port
 * or path (match patterns can't express either) or an unconvertible host. An
 * unset scheme means http and https. A `*.L` result also matches the apex `L`,
 * which the caller must exclude (`apexExcludes`).
 */
function toMatchUnder(p: string): string[] {
  const { scheme, host, port, path, exact } = typedParts(p);
  if (port !== "" || path !== "") return [];
  const h = patternHost(host, exact);
  if (h === null) return [];
  const schemes = scheme === "" ? ["http", "https"] : [scheme];
  return schemes.map((s) => `${s}://${matchHost(h)}/*`);
}

/**
 * Match patterns covering a SUPERSET of the http(s) URLs `p` matches: any
 * scheme, port, and path on its host. A `*` host gives `ALL_HOSTS`.
 */
function toMatchOver(p: string): string[] {
  const h = entryHost(p);
  return h === null ? [] : [`*://${matchHost(h)}/*`];
}

/** Necessary for two patterns to match one URL: one host literal is a label-suffix of the other. */
function hostsMayOverlap(p: string, q: string): boolean {
  const a = entryHost(p);
  const b = entryHost(q);
  if (a === null || b === null) return false;
  if (a.kind === "any" || b.kind === "any") return true;
  return isSameOrSubdomain(a.ascii, b.ascii) || isSameOrSubdomain(b.ascii, a.ascii);
}

/** True when every scheme `p` matches is one `a` matches. */
function schemeCovers(a: string, p: string): boolean {
  if (a === "*") return true;
  if (a === "") return p === "" || p === "http" || p === "https";
  return a === p;
}

/**
 * True when every URL `p` matches is also matched by `a` (conservative: false
 * when unsure). `a` must be path-free and port-free; `p`'s port is irrelevant
 * because it only narrows `p`.
 */
function covers(a: string, p: string): boolean {
  const A = typedParts(a);
  const P = typedParts(p);
  if (A.path !== "" || A.port !== "" || P.path !== "") return false;
  if (!schemeCovers(A.scheme, P.scheme)) return false;
  const ha = patternHost(A.host, A.exact);
  const hp = patternHost(P.host, P.exact);
  if (ha === null || hp === null) return false;
  if (ha.kind === "any") return true;
  if (hp.kind === "any") return false;
  if (ha.kind === "exact" || hp.kind === "exact") {
    return ha.kind === hp.kind && ha.ascii === hp.ascii;
  }
  if (ha.kind === "host") return hp.kind === "host" && hp.ascii === ha.ascii;
  if (ha.kind === "domain") return isSameOrSubdomain(hp.ascii, ha.ascii);
  // `a` is `*.L_a`: a `*.L_p` must sit at or below `L_a`, any other `p`
  // strictly below it.
  if (hp.kind === "subdomains") return isSameOrSubdomain(hp.ascii, ha.ascii);
  return hp.ascii.endsWith("." + ha.ascii);
}

/**
 * Excludes for the apex `L` of every `*.L` pattern in `seeded`, since the
 * match pattern `*.L` also matches `L`. Skipped when one of `covering` covers
 * the host `L` on http and https, i.e. the apex is right for the script anyway.
 */
function apexExcludes(seeded: readonly string[], covering: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of seeded) {
    const h = entryHost(p);
    if (h === null || h.kind !== "subdomains") continue;
    // `=L` is the apex alone, so an exact entry for it covers it too.
    const apex = `${EXACT_PREFIX}${h.ascii}`;
    if (covering.some((c) => covers(c, apex))) continue;
    out.push(`*://${h.ascii}/*`);
  }
  return out;
}

/**
 * True when some group in `g` may contain a host that the typed entry `p`
 * matches, so a script seeding `p` could seed a host the groups decide
 * differently. Plan-time substring searches over the framed strings:
 *   - the host or one of its label suffixes is a `domain` entry;
 *   - for a bare `L` or an exact entry: the host is a `full` entry;
 *   - for a bare `L` or `*.L`: some entry sits below the host (`"." + host + "\n"`).
 */
function groupsTouchHost(g: SiteGroupStrings, p: string): boolean {
  const h = entryHost(p);
  if (h === null) return false; // never matches, so it's never seeded
  if (h.kind === "any") return true;
  if (hostInGroupStrings(g.d, "\n", h.ascii)) return true;
  const full = `\n${h.ascii}\n`;
  const below = `.${h.ascii}\n`;
  switch (h.kind) {
    case "exact":
    case "host":
      return g.f.includes(full);
    case "domain":
      return g.f.includes(full) || g.d.includes(below) || g.f.includes(below);
    case "subdomains":
      return g.d.includes(below) || g.f.includes(below);
  }
}

/** A gate from its checks, or null when it has none. */
function makeGate(checks: {
  allow?: SiteGroupStrings | null;
  deny?: SiteGroupStrings | null;
  skip?: SiteGroupStrings | null;
}): BootstrapGate | null {
  const gate: BootstrapGate = {};
  if (checks.allow) gate.allow = checks.allow;
  if (checks.deny) gate.deny = checks.deny;
  if (checks.skip) gate.skip = checks.skip;
  return Object.keys(gate).length > 0 ? gate : null;
}

/** `item` with `gate` attached when there is one. */
function withGate(item: BootstrapPlanItem, gate: BootstrapGate | null): BootstrapPlanItem {
  return gate === null ? item : { ...item, gate };
}

function dedupeSorted(list: readonly string[]): string[] {
  return [...new Set(list)].sort();
}

/**
 * Plan the Firefox bootstrap registrations for `settings`: the main script
 * first, then the allowlist's site-group script, then one per site location
 * (sorted by id). `groups` is the site group data by token (the background
 * passes `currentSiteGroupData()`); a token without data matches nothing, as
 * on the async path. Pure. See the module doc for the invariant every item
 * satisfies.
 */
export function planBootstrapScripts(
  settings: Settings,
  groups: Readonly<Record<string, SiteGroupStrings>> = {}
): BootstrapPlanItem[] {
  if (!settings.enabled) return [];

  const entries: SiteLocation[] = [
    ...computeEffectiveSiteLocations(settings.siteLocations, settings.proFeaturesBlocked),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const mode = settings.scopeMode;
  // userScripts match each frame's own URL, but the async path follows the
  // top-level page, so subframes are only safe when every page gets one value.
  const allFrames = mode === "all" && entries.length === 0;

  // The async path says `enabled: false` on restricted hosts.
  const restricted = RESTRICTED_DOMAINS.map((d) => `*://*.${d}/*`);

  // Site group and link tokens match by hostname, so they never become match
  // patterns; the gates check them in the page instead.
  const allow =
    mode === "allowlist"
      ? unionGroupStrings(groups, settings.allowlist.filter(isSiteGroupToken))
      : null;
  const deny =
    mode === "denylist"
      ? unionGroupStrings(groups, settings.denylist.filter(isSiteGroupToken))
      : null;
  const skip = unionGroupStrings(
    groups,
    entries.flatMap((e) => e.patterns.filter(isSiteGroupToken))
  );
  const typedAllowlist = settings.allowlist.filter(isTypedEntry);

  const filterExcludes: string[] = [];
  if (mode === "denylist") {
    for (const d of settings.denylist.filter(isTypedEntry)) filterExcludes.push(...toMatchOver(d));
    if (filterExcludes.includes(ALL_HOSTS)) return [];
  }

  // Every host a typed site-location pattern could match.
  const siteExcludes: string[] = [];
  for (const entry of entries) {
    for (const p of entry.patterns.filter(isTypedEntry)) siteExcludes.push(...toMatchOver(p));
  }

  const plan: BootstrapPlanItem[] = [];

  // Main script: the main location, wherever no site location could apply.
  if (settings.timezone) {
    let matches: string[];
    const excludes = [...restricted, ...filterExcludes];
    if (mode === "allowlist") {
      // Only path-free, port-free entries have an under-approximation.
      const seeded = typedAllowlist.filter((a) => toMatchUnder(a).length > 0);
      matches = seeded.flatMap(toMatchUnder);
      excludes.push(...apexExcludes(seeded, seeded));
    } else {
      // Not <all_urls>, so file: (restricted) pages aren't seeded.
      matches = [...HTTP_HOSTS];
    }
    excludes.push(...siteExcludes);
    if (matches.length > 0) {
      plan.push(
        withGate(
          {
            id: SCRIPT_ID,
            matches: dedupeSorted(matches),
            excludeMatches: dedupeSorted(excludes),
            allFrames,
            settings,
          },
          makeGate({ deny, skip })
        )
      );
    }

    // Allowlist groups: every http(s) page, seeded in the page only when its
    // host is in an allowed group and in no site location's group.
    if (allow !== null) {
      plan.push(
        withGate(
          {
            id: GROUPS_SCRIPT_ID,
            matches: [...HTTP_HOSTS],
            excludeMatches: dedupeSorted([...restricted, ...siteExcludes]),
            allFrames: false,
            settings,
          },
          makeGate({ allow, skip })
        )
      );
    }
  }

  // Entry scripts: a site location's pages that it certainly wins. Typed
  // patterns only: they beat any group, so other entries' groups can't take
  // these pages, and the entry's own groups get no seed.
  entries.forEach((entry, n) => {
    const typed = entry.patterns.filter(isTypedEntry);
    let seeded = typed.filter((p) => typedParts(p).port === "");
    if (mode === "allowlist") {
      seeded = seeded.filter((p) => typedAllowlist.some((a) => covers(a, p)));
    }
    const matches = seeded.flatMap(toMatchUnder);
    if (matches.length === 0) return;

    const excludes = [...restricted, ...filterExcludes, ...apexExcludes(seeded, seeded)];
    // A denied group turns GeoSpoof off on its hosts: leave out every pattern
    // whose hosts it may touch.
    if (deny !== null) {
      for (const p of seeded) {
        if (groupsTouchHost(deny, p)) excludes.push(...toMatchOver(p));
      }
    }
    // Wherever another entry's pattern could match with at least equal
    // specificity, that entry might win, so leave its whole host unseeded.
    for (const p of typed) {
      const sp = siteLocationSpecificity(p);
      for (const other of entries) {
        if (other === entry) continue;
        for (const q of other.patterns.filter(isTypedEntry)) {
          if (hostsMayOverlap(p, q) && compareSpecificity(siteLocationSpecificity(q), sp) >= 0) {
            excludes.push(...toMatchOver(q));
          }
        }
      }
    }

    plan.push({
      id: `${SITE_SCRIPT_ID_PREFIX}${n}`,
      matches: dedupeSorted(matches),
      excludeMatches: dedupeSorted(excludes),
      allFrames: false,
      settings: {
        ...settings,
        location: entry.location,
        timezone: entry.timezone,
        locationName: entry.locationName,
      },
    });
  });

  return plan;
}

// ─────────────────────────────── Registration ───────────────────────────────

/**
 * How long a write (settings, or site group data that changes a referenced
 * token) waits for the old early scripts to be removed.
 */
export const BOOTSTRAP_INVALIDATION_TIMEOUT_MS = 1000;

/**
 * Serializes registrations and write-window removals so two jobs can't
 * interleave their unregister/register pairs.
 */
let queue: Promise<void> = Promise.resolve();

/** Counts calls and write windows; only the latest call may register. */
let generation = 0;

/** The newest settings revision a call has been made with since the background started. */
let newestRevision: number | undefined;

/**
 * Write windows open now. Two queues open them: settings writes
 * (`saveSettings`) and site group data writes (`site-groups.ts`). Each queue
 * is serialized, but the two run independently, so one window from each can
 * be open at the same time. Keep this a counter: only the last window to
 * close may register, and a boolean would let the first one to close do it.
 */
let openWrites = 0;

/** An earlier window's removal timed out and hasn't settled yet. */
let removalStalled = false;

/** The settings of the newest call that wasn't skipped as older; see `waitingForSiteGroups`. */
let latestSettings: Settings | null = null;

/**
 * The last registration registered nothing because its settings reference
 * site groups whose data couldn't be read. Planning with `{}` would treat
 * every group as matching nothing, so a denied group's hosts (or a per-site
 * group's) would get the main zone: wrong, not absent. The next read that
 * fills the cache redoes the registration with `latestSettings`.
 */
let waitingForSiteGroups = false;

if (__FIREFOX__) {
  onSiteGroupCacheLoaded(() => {
    if (!waitingForSiteGroups || latestSettings === null) return;
    waitingForSiteGroups = false;
    logger.debug("[bootstrap] site group data loaded; registering the scripts skipped earlier");
    void updateBootstrapRegistration(latestSettings);
  });
}

/**
 * The bootstrap side of one write, of settings or of site group data; see
 * {@link openBootstrapWriteWindow}.
 */
export interface BootstrapWriteWindow {
  /**
   * Settles once the scripts registered before this write are gone, or after
   * the timeout. Null when there's nothing to wait for (no userScripts, or an
   * earlier wait is still stuck). Never rejects.
   */
  readonly removed: Promise<void> | null;
  /**
   * The write succeeded: close the window and register `settings` (for a site
   * group data write, the stored settings, planned with the new data).
   * Synchronous; the registration runs queued.
   */
  stored(settings: Settings): void;
  /** The write failed: close the window and re-register what's still stored, read with `load`. Never rejects. */
  failed(load: () => Promise<Settings>): Promise<void>;
}

/**
 * Open a write window. Firefox-only; call once per write that changes what the
 * early scripts seed, before the storage write: every `saveSettings`, and every
 * site group data write that changes what a referenced token matches
 * (`writeSiteGroupDataReplacingBootstrap` in `site-groups.ts`). A settings
 * window and a site group window can be open at the same time.
 *
 * Until the window closes, no registration built from older settings or data
 * is installed, and the window queues an unfiltered `unregister` so the
 * scripts built from them are gone before the write. A page that loads in
 * between gets no seed rather than an old one. The loader for `failed` is
 * passed in, so this module never imports `./settings`: the bootstrap queue
 * must never wait on the settings-write queue.
 */
export function openBootstrapWriteWindow(): BootstrapWriteWindow {
  // From here no queued or building older registerNow registers. Counted
  // whether or not userScripts exists, so a permission grant during the write
  // can't register the pre-write settings early.
  openWrites += 1;
  generation += 1;

  let removed: Promise<void> | null = null;
  const api = getUserScriptsApi();
  if (api) {
    // Queued, so it runs after any in-flight register has settled. Never rejects.
    const job = queue.then(async () => {
      try {
        // Unfiltered, as in registerNow.
        await api.unregister();
      } catch (error) {
        logger.warn(
          "[bootstrap] couldn't remove the early scripts before a write (continuing):",
          error
        );
      }
    });
    queue = job;
    if (removalStalled) {
      logger.debug("[bootstrap] an earlier removal is still stuck; storing without waiting");
    } else {
      removed = boundedWait(job);
    }
  }

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    openWrites -= 1;
  };
  const stored = (settings: Settings): void => {
    if (closed) return;
    close();
    void updateBootstrapRegistration(settings);
  };

  return {
    removed,
    stored,
    async failed(load: () => Promise<Settings>): Promise<void> {
      if (closed) return;
      try {
        if (!getUserScriptsApi()) return;
        const s = await load();
        logger.debug("[bootstrap] write failed; re-registering what's still stored");
        stored(s); // closes, then registers
      } finally {
        close(); // no-op when stored() already closed
      }
    },
  };
}

/**
 * Resolve when `job` settles or after BOOTSTRAP_INVALIDATION_TIMEOUT_MS,
 * whichever comes first. On timeout, later windows skip their wait until `job`
 * settles, so a hung userScripts delays at most one save by the timeout.
 */
function boundedWait(job: Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      removalStalled = true;
      logger.warn(
        `[bootstrap] userScripts didn't answer within ${BOOTSTRAP_INVALIDATION_TIMEOUT_MS} ms; writing without waiting`
      );
      void job.finally(() => {
        removalStalled = false;
      });
      resolve();
    }, BOOTSTRAP_INVALIDATION_TIMEOUT_MS);
    void job.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Register (or refresh) the document_start bootstrap user scripts to reflect
 * the current settings, or remove them when there's nothing to seed.
 *
 * Firefox-only and best-effort; safe to call on any settings change and on
 * startup. Idempotent. Calls run one after another in call order, and the last
 * call wins: without that, two overlapping calls could unregister twice, then
 * register A, then fail to register B on the duplicate ids and leave A's stale
 * code in place. A call whose settings are older (by settings revision) than a
 * call already made is skipped without cancelling anything, so a caller that
 * loaded settings before a write can't replace the write's registration with
 * the older settings. While a write window is open, nothing registers. A
 * call overtaken by a newer call or a write stops before registering, or
 * removes what it registered, so scripts for settings that are no longer
 * stored don't stay installed.
 */
export function updateBootstrapRegistration(settings: Settings): Promise<void> {
  // Compiled out entirely on Chromium / Safari builds.
  if (!__FIREFOX__) return Promise.resolve();

  const r = readRevision(settings.revision);
  if (isOlderRevision(r, newestRevision)) {
    // No generation bump: the newer registration must not be cancelled.
    logger.debug(`[bootstrap] skipped settings revision ${r}, older than ${newestRevision}`);
    return Promise.resolve();
  }
  if (r !== undefined) newestRevision = r;
  latestSettings = settings;

  // registerNow catches everything, so the queue never wedges.
  const gen = ++generation;
  const run = queue.then(() => registerNow(settings, gen));
  queue = run.catch(() => undefined);
  return run;
}

async function registerNow(settings: Settings, gen: number): Promise<void> {
  const api = getUserScriptsApi();
  if (!api) {
    // userScripts permission not yet granted (it's an optional-only permission
    // the user opts into via the popup) or the API is unavailable on this
    // build. Nothing to register; the async settings path still applies the
    // spoof shortly after document_start.
    logger.debug(
      "[bootstrap] browser.userScripts unavailable — permission not granted yet; skipping registration"
    );
    return;
  }

  try {
    // Remove the live scripts before building their replacements. They were
    // built from older settings, so a page loading while the new payloads are
    // built must get no seed rather than a stale one, and a failed build
    // leaves no bootstrap at all (absent, never wrong). Re-registering from
    // scratch is the portable path: userScripts has no in-place "replace code"
    // guarantee across engines.
    // Unfiltered on purpose: only this module registers user scripts, the ids
    // vary with the plan, and an id filter naming an unregistered id may
    // reject the whole call and leave stale scripts behind.
    await api.unregister();
    if (gen !== generation) return; // a newer call registers its own settings

    // The plan needs these settings' group data. loadSettings() normally
    // loaded it, but if that read failed the cache is still unloaded, and
    // planning with `{}` would seed the main zone on a denied group's hosts.
    // Try once more; if storage still can't be read, register nothing (absent,
    // never wrong) until a later read fills the cache (`waitingForSiteGroups`).
    if (!siteGroupCacheLoaded() && referencedSiteGroupTokens(settings).length > 0) {
      try {
        await loadSiteGroupCache();
      } catch (error) {
        waitingForSiteGroups = true;
        logger.warn(
          "[bootstrap] couldn't read site group data; no early scripts until it loads:",
          error
        );
        return;
      }
      if (gen !== generation) return;
    }
    waitingForSiteGroups = false;

    // Timed for the real-browser checks: build plus register.
    const started = Date.now();
    // The cached site group data, loaded for these settings above or by
    // loadSettings(). A data change re-registers through a write window.
    const plan = planBootstrapScripts(settings, currentSiteGroupData());

    // Payloads come from the shared page-payload module, so the inlined point
    // and locale match what the async path delivers moments later.
    const registrations: Array<Record<string, unknown>> = [];
    for (const item of plan) {
      const payload = await buildBootstrapPayload(item.settings);
      // Overtaken while building: stop early, which shortens a write's wait.
      if (gen !== generation) return;
      const registration: Record<string, unknown> = {
        id: item.id,
        matches: item.matches,
        allFrames: item.allFrames,
        runAt: "document_start",
        world: "MAIN",
        js: [{ code: buildBootstrapCode(payload, item.gate ?? null) }],
      };
      if (item.excludeMatches.length > 0) {
        registration.excludeMatches = item.excludeMatches;
      }
      registrations.push(registration);
    }

    // Settings changed again, or a write window opened, while the payloads
    // were built. The window registers what's stored when it closes.
    if (gen !== generation || openWrites > 0) return;

    if (registrations.length === 0) {
      logger.debug("[bootstrap] nothing to seed — removed bootstrap scripts");
      return;
    }
    // One batch, main script first.
    await api.register(registrations);
    if (gen !== generation || openWrites > 0) {
      // Overtaken while registering. The window's removal job is queued behind
      // this one anyway; removing here keeps the overtaken batch from staying
      // live until the next job starts.
      await api.unregister();
      logger.debug("[bootstrap] overtaken while registering; removed its scripts");
      return;
    }
    logger.debug(
      `[bootstrap] registered ${plan.map((item) => item.id).join(", ")} in ${Date.now() - started} ms`
    );
  } catch (error) {
    // Never let bootstrap registration break settings flow — the async
    // CustomEvent path still delivers settings, just slightly later.
    logger.warn("[bootstrap] registration failed (continuing without it):", error);
  }
}
