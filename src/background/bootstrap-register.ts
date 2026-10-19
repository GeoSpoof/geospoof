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
import { createLogger } from "@/shared/utils/debug-logger";
import { hostToASCII } from "@/shared/utils/idn";
import { computeEffectiveSiteLocations, decomposePattern, isValidIpv4 } from "@/shared/utils/scope";
import { compareSpecificity, siteLocationSpecificity } from "@/shared/utils/site-locations";
import { buildBootstrapPayload } from "./page-payload";
import { RESTRICTED_DOMAINS } from "./restricted-url";

/* eslint-disable no-var */
declare var process: { env: Record<string, string | undefined> };
/* eslint-enable no-var */

const logger = createLogger("BG");

/** Stable id for the main-location bootstrap user script. */
const SCRIPT_ID = "gs-tz-bootstrap";

/** Id prefix for the per-site-location bootstrap scripts. */
const SITE_SCRIPT_ID_PREFIX = "gs-tz-bootstrap-site-";

/** The match pattern for every http(s) page; excluding it excludes everything. */
const ALL_HOSTS = "*://*/*";

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

/** Build the inline bootstrap code that stashes settings in the page global. */
function buildBootstrapCode(payload: unknown): string {
  // Non-enumerable so it doesn't show up in a casual `Object.keys(window)`
  // sweep; the injected script deletes it on first read regardless.
  const json = JSON.stringify(payload);
  const key = JSON.stringify(BOOT_KEY);
  return (
    `try{Object.defineProperty(globalThis,${key},` +
    `{value:${json},configurable:true,enumerable:false,writable:true});}catch(e){}`
  );
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
}

/**
 * A canonical pattern's host, in the A-label form URLs carry:
 *   - `any`: `*`
 *   - `subdomains`: `*.L` (GeoSpoof excludes the apex `L`)
 *   - `exact`: an IPv4 literal
 *   - `domain`: a bare `L` (GeoSpoof matches `L` and its subdomains; this
 *     includes `localhost`, which compiles to `{*.}?localhost` like any name)
 * Null when the host can't be converted to ASCII; such a pattern never matches
 * in GeoSpoof (the compiler yields a non-matching pattern), so it needs no seed
 * and no exclusion.
 */
interface PatternHost {
  kind: "any" | "subdomains" | "exact" | "domain";
  ascii: string;
}

function patternHost(host: string): PatternHost | null {
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

/**
 * Match patterns covering a SUBSET of the URLs `p` matches. Empty for a port
 * or path (match patterns can't express either) or an unconvertible host. An
 * unset scheme means http and https. A `*.L` result also matches the apex `L`,
 * which the caller must exclude (`apexExcludes`).
 */
function toMatchUnder(p: string): string[] {
  const { scheme, host, port, path } = decomposePattern(p);
  if (port !== "" || path !== "") return [];
  const h = patternHost(host);
  if (h === null) return [];
  const schemes = scheme === "" ? ["http", "https"] : [scheme];
  return schemes.map((s) => `${s}://${matchHost(h)}/*`);
}

/**
 * Match patterns covering a SUPERSET of the http(s) URLs `p` matches: any
 * scheme, port, and path on its host. A `*` host gives `ALL_HOSTS`.
 */
function toMatchOver(p: string): string[] {
  const h = patternHost(decomposePattern(p).host);
  return h === null ? [] : [`*://${matchHost(h)}/*`];
}

/** Necessary for two patterns to match one URL: one host literal is a label-suffix of the other. */
function hostsMayOverlap(p: string, q: string): boolean {
  const a = patternHost(decomposePattern(p).host);
  const b = patternHost(decomposePattern(q).host);
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
  const A = decomposePattern(a);
  const P = decomposePattern(p);
  if (A.path !== "" || A.port !== "" || P.path !== "") return false;
  if (!schemeCovers(A.scheme, P.scheme)) return false;
  const ha = patternHost(A.host);
  const hp = patternHost(P.host);
  if (ha === null || hp === null) return false;
  if (ha.kind === "any") return true;
  if (hp.kind === "any") return false;
  if (ha.kind === "exact" || hp.kind === "exact") {
    return ha.kind === hp.kind && ha.ascii === hp.ascii;
  }
  if (ha.kind === "domain") return isSameOrSubdomain(hp.ascii, ha.ascii);
  // `a` is `*.L_a`: `p` must sit strictly below `L_a`.
  if (hp.kind === "domain") return hp.ascii.endsWith("." + ha.ascii);
  return isSameOrSubdomain(hp.ascii, ha.ascii);
}

/**
 * Excludes for the apex `L` of every `*.L` pattern in `seeded`, since the
 * match pattern `*.L` also matches `L`. Skipped when one of `covering` covers
 * the bare `L` on http and https, i.e. the apex is right for the script anyway.
 */
function apexExcludes(seeded: readonly string[], covering: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of seeded) {
    const h = patternHost(decomposePattern(p).host);
    if (h === null || h.kind !== "subdomains") continue;
    if (covering.some((c) => covers(c, h.ascii))) continue;
    out.push(`*://${h.ascii}/*`);
  }
  return out;
}

function dedupeSorted(list: readonly string[]): string[] {
  return [...new Set(list)].sort();
}

/**
 * Plan the Firefox bootstrap registrations for `settings`: the main script
 * first, then one per site location (sorted by id). Pure. See the module doc
 * for the invariant every item satisfies.
 */
export function planBootstrapScripts(settings: Settings): BootstrapPlanItem[] {
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

  const filterExcludes: string[] = [];
  if (mode === "denylist") {
    for (const d of settings.denylist) filterExcludes.push(...toMatchOver(d));
    if (filterExcludes.includes(ALL_HOSTS)) return [];
  }

  const plan: BootstrapPlanItem[] = [];

  // Main script: the main location, wherever no site location could apply.
  if (settings.timezone) {
    let matches: string[];
    const excludes = [...restricted, ...filterExcludes];
    if (mode === "allowlist") {
      // Only path-free, port-free entries have an under-approximation.
      const seeded = settings.allowlist.filter((a) => toMatchUnder(a).length > 0);
      matches = seeded.flatMap(toMatchUnder);
      excludes.push(...apexExcludes(seeded, seeded));
    } else {
      // Not <all_urls>, so file: (restricted) pages aren't seeded.
      matches = ["http://*/*", "https://*/*"];
    }
    for (const entry of entries) {
      for (const p of entry.patterns) excludes.push(...toMatchOver(p));
    }
    if (matches.length > 0) {
      plan.push({
        id: SCRIPT_ID,
        matches: dedupeSorted(matches),
        excludeMatches: dedupeSorted(excludes),
        allFrames,
        settings,
      });
    }
  }

  // Entry scripts: a site location's pages that it certainly wins.
  entries.forEach((entry, n) => {
    let seeded = entry.patterns.filter((p) => decomposePattern(p).port === "");
    if (mode === "allowlist") {
      seeded = seeded.filter((p) => settings.allowlist.some((a) => covers(a, p)));
    }
    const matches = seeded.flatMap(toMatchUnder);
    if (matches.length === 0) return;

    const excludes = [...restricted, ...filterExcludes, ...apexExcludes(seeded, seeded)];
    // Wherever another entry's pattern could match with at least equal
    // specificity, that entry might win, so leave its whole host unseeded.
    for (const p of entry.patterns) {
      const sp = siteLocationSpecificity(p);
      for (const other of entries) {
        if (other === entry) continue;
        for (const q of other.patterns) {
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

/** Serializes registrations so two calls can't interleave their unregister/register pairs. */
let queue: Promise<void> = Promise.resolve();

/**
 * Register (or refresh) the document_start bootstrap user scripts to reflect
 * the current settings, or remove them when there's nothing to seed.
 *
 * Firefox-only and best-effort; safe to call on any settings change and on
 * startup. Idempotent. Calls run one after another in call order, so the last
 * call wins: without that, two overlapping calls could unregister twice, then
 * register A, then fail to register B on the duplicate ids and leave A's stale
 * code in place.
 */
export function updateBootstrapRegistration(settings: Settings): Promise<void> {
  // Compiled out entirely on Chromium / Safari builds.
  if (!__FIREFOX__) return Promise.resolve();

  // registerNow catches everything, so the queue never wedges.
  const run = queue.then(() => registerNow(settings));
  queue = run.catch(() => undefined);
  return run;
}

async function registerNow(settings: Settings): Promise<void> {
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
    const plan = planBootstrapScripts(settings);

    // Build every registration before touching the live ones, so a failure
    // here leaves the previous set in place. Payloads come from the shared
    // page-payload module, so the inlined point and locale match what the
    // async path delivers moments later.
    const registrations: Array<Record<string, unknown>> = [];
    for (const item of plan) {
      const registration: Record<string, unknown> = {
        id: item.id,
        matches: item.matches,
        allFrames: item.allFrames,
        runAt: "document_start",
        world: "MAIN",
        js: [{ code: buildBootstrapCode(await buildBootstrapPayload(item.settings)) }],
      };
      if (item.excludeMatches.length > 0) {
        registration.excludeMatches = item.excludeMatches;
      }
      registrations.push(registration);
    }

    // Re-register from scratch so the inlined payloads always reflect the
    // latest settings (userScripts has no in-place "replace code" guarantee
    // across engines, so unregister-then-register is the portable path).
    // Unfiltered on purpose: only this module registers user scripts, the ids
    // vary with the plan, and an id filter naming an unregistered id may
    // reject the whole call and leave stale scripts behind.
    await api.unregister();

    if (registrations.length === 0) {
      logger.debug("[bootstrap] nothing to seed — removed bootstrap scripts");
      return;
    }
    // One batch, main script first.
    await api.register(registrations);
    logger.debug("[bootstrap] registered document_start bootstrap scripts", {
      ids: plan.map((item) => item.id),
    });
  } catch (error) {
    // Never let bootstrap registration break settings flow — the async
    // CustomEvent path still delivers settings, just slightly later.
    logger.warn("[bootstrap] registration failed (continuing without it):", error);
  }
}
