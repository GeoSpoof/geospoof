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
 * To close that gap we register a MAIN-world `userScripts` script that runs at
 * document_start — before any page script — with the last-saved settings
 * inlined as code, stashing them in a global the injected script consumes
 * synchronously. `userScripts.register` only accepts file paths in Chrome's
 * `scripting` API, but Firefox's MV3 `userScripts` API accepts inline `code`,
 * which is what makes this possible on Firefox specifically.
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

import type { Settings } from "@/shared/types/settings";
import { createLogger } from "@/shared/utils/debug-logger";
import { buildBootstrapPayload } from "./page-payload";

/* eslint-disable no-var */
declare var process: { env: Record<string, string | undefined> };
/* eslint-enable no-var */

const logger = createLogger("BG");

/** Stable id for the registered bootstrap user script. */
const SCRIPT_ID = "gs-tz-bootstrap";

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

/** Remove the registered bootstrap script, ignoring "not found" errors. */
async function unregister(api: UserScriptsApi): Promise<void> {
  try {
    await api.unregister({ ids: [SCRIPT_ID] });
  } catch {
    /* wasn't registered — fine */
  }
}

/** Serializes registrations so two calls can't interleave their unregister/register pairs. */
let queue: Promise<void> = Promise.resolve();

/**
 * Register (or refresh) the document_start bootstrap user script to reflect the
 * current settings, or remove it when spoofing is off / no timezone is set.
 *
 * Firefox-only and best-effort; safe to call on any settings change and on
 * startup. Idempotent. Calls run one after another in call order, so the last
 * call wins: without that, two overlapping calls could unregister twice, then
 * register A, then fail to register B on the duplicate id and leave A's stale
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
    // Only inject when there's actually a spoof to apply. Otherwise make sure
    // any stale registration (e.g. left from a previous location) is gone so we
    // never stamp an out-of-date zone into pages.
    if (!settings.enabled || !settings.timezone) {
      await unregister(api);
      logger.debug("[bootstrap] spoofing off / no timezone — unregistered bootstrap script");
      return;
    }

    // Built by the shared page-payload module, so the inlined point and locale
    // match what the async path delivers moments later.
    const payload = await buildBootstrapPayload(settings);

    // Re-register from scratch so the inlined payload always reflects the
    // latest settings (userScripts has no in-place "replace code" guarantee
    // across engines, so unregister-then-register is the portable path).
    await unregister(api);
    await api.register([
      {
        id: SCRIPT_ID,
        matches: ["<all_urls>"],
        allFrames: true,
        runAt: "document_start",
        world: "MAIN",
        js: [{ code: buildBootstrapCode(payload) }],
      },
    ]);
    logger.debug("[bootstrap] registered document_start bootstrap script", {
      timezone: settings.timezone.identifier,
    });
  } catch (error) {
    // Never let bootstrap registration break settings flow — the async
    // CustomEvent path still delivers settings, just slightly later.
    logger.warn("[bootstrap] registration failed (continuing without it):", error);
  }
}
