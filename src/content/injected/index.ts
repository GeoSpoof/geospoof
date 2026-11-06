/**
 * Entry point for the modular injected script.
 *
 * Imports and initializes all override modules in the exact order matching
 * the original monolithic IIFE's top-to-bottom execution sequence.
 * Vite/Rollup bundles this back into a single IIFE for page-context injection.
 */

// ── Known Limitations ────────────────────────────────────────────────
//
// The following detection vectors CANNOT be fully mitigated from a
// content script and are acknowledged as known limitations:
//
// 1. Cross-origin iframe timing side-channels — A cross-origin iframe
//    can compare its own Date/Intl results against the parent frame's
//    postMessage timestamps, revealing discrepancies. Cross-origin
//    iframes throw SecurityError on any property access and are
//    silently skipped (unavoidable without browser-level changes).
//
//    NOTE: Same-origin iframes ARE fully patched — patchIframeWindow()
//    installs overrides for geolocation, permissions, Intl, Date,
//    Temporal, lastModified, and nested-iframe cascades into every
//    same-origin iframe realm synchronously on first access.
//
//    Worker patching, iframe patching, and DOM insertion wrapping are
//    also skipped when the injected script itself runs inside a
//    cross-origin frame (detected via window.top.location access).
//    Installing those overrides inside third-party iframes (e.g.
//    Cloudflare Turnstile) causes those scripts to detect tampering
//    and break. Date/Intl/timezone overrides still run in all frames.
//
// 2. Web Worker timezone leaks — Content scripts cannot inject into
//    Web Worker, SharedWorker, or ServiceWorker contexts. What is
//    covered: the worker payload reaches inline (blob/data URL) workers
//    on every engine, held through a relay (worker-relay.ts) when they
//    are created before settings arrive (on Firefox, a document's first
//    8 only), and URL-based workers on
//    Firefox through filterResponseData. Code in the other workers sees
//    the real system timezone via Date and Intl. No public WebExtension
//    API provides Worker-injection access.
//
// 3. SharedArrayBuffer timing attacks — High-resolution timing via
//    SharedArrayBuffer can fingerprint execution patterns introduced
//    by API overrides. Unfixable at the content-script level.
//
// 4. XSLT/EXSLT datetime leak (Firefox only) — XSLTProcessor runs
//    inside a C++ engine that doesn't round-trip through JavaScript.
//    The EXSLT function date:date-time() emits the real system UTC
//    offset, bypassing every Date/Intl/Temporal override. We can't
//    reach into libxslt, but the result comes back through the JS
//    XSLTProcessor API, so `xslt-overrides.ts` wraps transformToFragment/
//    transformToDocument and rewrites the freshly emitted "now" datetime
//    into the spoofed zone. Chromium/WebKit don't ship EXSLT, so the
//    wrapper is a harmless no-op there.
//
// 5. Extension initialization race — Overrides install at
//    document_start, but spoofing settings arrive asynchronously
//    (50-250ms on cold page loads). A fingerprinting script that
//    reads timezone synchronously in <head> can win that race and
//    learn the real zone. Fundamental MV3 limitation. Dedicated inline
//    workers created in this window are held until settings arrive
//    (worker-relay.ts); the page's own early reads are not.
//
// 6. IP geolocation mismatch — The extension does not mask the
//    user's IP address. Fingerprinting scripts cross-check public
//    IP country/region against browser-reported geolocation. Closing
//    this requires a VPN exit in the spoofed region (hence VPN Sync).
//
// 7. Re-dispatched error event `isTrusted === false` — When a throw from
//    one of our overrides goes UNCAUGHT, window.onerror's `source` and the
//    error event's `filename` would otherwise name our injected script
//    (chrome-extension://<id>/…), leaking the extension id. The
//    error-report-sanitizer closes that by suppressing the id-bearing event
//    and re-emitting a sanitized twin. But a dispatchEvent()-generated event
//    is `isTrusted === false` per spec (only user-agent-generated events are
//    `true`, and there is no scripted path to forge a trusted one), so the
//    re-emitted event reports `false` where a genuine uncaught error reports
//    `true`. This is NON-IDENTIFYING — it reveals "an error was re-dispatched,"
//    never which extension — and is observable only by an addEventListener(
//    'error') handler that deliberately triggers one of our overrides uncaught
//    and inspects `isTrusted` (window.onerror receives positional args and
//    can't see it). We accept it because the alternative — not re-dispatching —
//    leaves the actual extension id in window.onerror's `source`, which is far
//    worse. Crucially, ONLY `error`/`unhandledrejection` are touched: the
//    `isTrusted` checks that matter in the wild (user-interaction events like
//    click/keydown, used by anti-bot code) are never affected.
//
// ────────────────────────────────────────────────────────────────────

// 1. Settings listener — MUST be installed first so the window is ready
//    to receive the CustomEvent from the content script as early as
//    possible. Content script and injected script both run at
//    document_start with no ordering guarantee; if the content script
//    dispatches its initial settings event before this listener is
//    installed, the event is lost forever (CustomEvents have no
//    subscription backlog). The content script pairs this with a
//    retry loop that redispatches a few times at short intervals,
//    but moving the listener install to the very top of the injected
//    script's module init gives us the widest possible window to
//    catch the first dispatch on the first try.
import { installSettingsListener } from "./settings-listener";
installSettingsListener();

// 2. Function masking infrastructure — toString masking must be installed
//    before any of the behaviour-modifying overrides so that every
//    subsequent override is indistinguishable from native code.
import { initFunctionMasking } from "./function-masking";
initFunctionMasking();

// 2b. Error-report sanitizer — installed right after function masking (so the
//     self-URL is captured) and BEFORE any behaviour override can throw. Closes
//     the extension-id leak on the UNCAUGHT error path: when an override's throw
//     goes uncaught, window.onerror / the error event report a `filename` naming
//     our injected.js — a channel the .stack scrubs can't reach. Ungated (runs
//     in every frame, including cross-origin) because Date/Intl overrides throw
//     there too. A no-op on engines that anonymize content-script frames.
import { installErrorReportSanitizer } from "./error-report-sanitizer";
installErrorReportSanitizer();

// 3. State module loads eagerly — original API references are captured at
//    import time, before any overrides replace them.
import "./state";

// 3b. Early bootstrap seed (Firefox). If the background registered a
//     document_start MAIN-world userScript that stashed the last-saved
//     settings in a global, consume it now — synchronously, before any
//     overrides install — so the spoof is live from the first instruction
//     and beats page scripts that snapshot Date/Intl in <head>. No-op on
//     Chrome/Safari (no such global) and harmless if it runs before the
//     bootstrap (the override hot paths re-attempt the seed lazily).
import { seedFromBootstrap } from "./bootstrap";
seedFromBootstrap();

// 4. Date constructor override — must precede other Date-related overrides
//    so the global Date is replaced before anything else uses it.
import { installDateConstructor } from "./date-constructor";
installDateConstructor();

// 5. Geolocation overrides
import { installGeolocationOverrides } from "./geolocation";
installGeolocationOverrides();

// 6. Permissions override
import { installPermissionsOverride } from "./permissions";
installPermissionsOverride();

// 6b. Locale overrides (navigator.language/languages, the Intl constructors
//     other than DateTimeFormat, and the toLocale*/localeCompare family).
//     Installed BEFORE the timezone overrides only for readability — the two are
//     independent. Note that Intl.DateTimeFormat and Date.prototype.toLocale*
//     get their locale injection inside their EXISTING timezone-aware wrappers
//     (steps 7 and 8) rather than being wrapped a second time here.
import { installLocaleOverrides } from "./locale-overrides";
installLocaleOverrides();

// 7. Timezone overrides (getTimezoneOffset and Intl.DateTimeFormat)
import { installTimezoneOverrides } from "./timezone-overrides";
installTimezoneOverrides();

// 8. Date formatting overrides (toString, toDateString, toTimeString, toLocale*)
import { installDateFormattingOverrides } from "./date-formatting";
installDateFormattingOverrides();

// 9. Date getter overrides (getHours, getMinutes, getDate, etc.)
import { installDateGetterOverrides } from "./date-getters";
installDateGetterOverrides();

// 10. Date setter overrides (setHours, setMinutes, setDate, etc.)
//     Installed AFTER the getters so multi-argument setters that
//     preserve omitted components read through the spoofed getters
//     when they fall back to "current" values.
import { installDateSetterOverrides } from "./date-setters";
installDateSetterOverrides();

// 11. Temporal API overrides (feature-detected, no-ops if unavailable)
import { installTemporalOverrides } from "./temporal";
installTemporalOverrides();

// ── Frame context detection ──────────────────────────────────────────
// Determine whether this script is running in a cross-origin frame.
// If window.top.location is inaccessible (throws SecurityError), we are
// inside a cross-origin iframe. Worker patching, iframe patching, and
// DOM insertion wrapping must be skipped in that case — installing them
// in a cross-origin context (e.g. Cloudflare Turnstile) causes those
// third-party scripts to detect tampering and break.
const isCrossOriginFrame = (() => {
  if (window === window.top) return false; // top-level page
  try {
    // Will throw SecurityError if cross-origin
    void window.top?.location.origin;
    return false;
  } catch {
    return true;
  }
})();

// 12. Iframe patching (contentWindow/contentDocument getter overrides)
import { installIframePatching } from "./iframe-patching";
if (!isCrossOriginFrame) installIframePatching();

// 13. DOM insertion wrapping and MutationObserver fallback
import { installDomInsertionWrapping } from "./dom-insertion";
if (!isCrossOriginFrame) installDomInsertionWrapping();

// 14. Document-level overrides (lastModified — ground-truth timezone
//     surface used by TZP and similar fingerprinters)
import { installDocumentOverrides } from "./document-overrides";
installDocumentOverrides();

// 15. Worker constructor interception. Wraps window.Worker and
//     window.SharedWorker so that classic Workers get a timezone
//     spoofing payload prepended to their source. Module Workers
//     pass through unmodified (blob URLs break relative imports).
//     Must run after settings-listener so timezone data is available
//     at Worker construction time. Dedicated inline Workers created
//     before settings arrive are held in a relay (worker-relay.ts),
//     which installs here too, and start with the payload once the
//     settings event lands.
//     Skipped in cross-origin frames — installing Worker overrides
//     inside third-party iframes (e.g. Cloudflare Turnstile) causes
//     those scripts to detect tampering and break.
import { installWorkerPatching } from "./worker-patching";
if (!isCrossOriginFrame) installWorkerPatching();

// 16. WebRTC IP-leak protection. Wraps RTCPeerConnection so no ICE
//     candidates ever gather when the user enables WebRTC Protection
//     in the popup. Closes the srflx/host/relay leaks that Firefox's
//     `disable_non_proxied_udp` policy misses without a proxy and
//     that Safari can't enforce at all. Flag is read lazily on each
//     constructor/getStats call so toggling the protection in the
//     popup takes effect for new peer connections without a reload.
import { installWebRTCOverride } from "./webrtc";
installWebRTCOverride();

// 18. XSLT / EXSLT date-time override. Wraps XSLTProcessor's transform
//     methods so EXSLT's date:date-time() — which emits the real system
//     offset from inside libxslt, bypassing every Date/Intl override — is
//     rewritten into the spoofed zone. Gecko-only in effect (Chromium/WebKit
//     don't ship the EXSLT date extension); a harmless no-op elsewhere.
import { installXsltOverrides } from "./xslt-overrides";
installXsltOverrides();

import { createLogger } from "@/shared/utils/debug-logger";
import { installActivationResponder } from "@/content/activation-responder";
import { settingsReceived, spoofedLocation, spoofingEnabled } from "./state";
const logger = createLogger("INJ");
logger.info("Geolocation API overrides installed");

// The activation page must be acknowledged by the MAIN-world engine, not the
// isolated relay. Installing this only after every override above has returned
// makes a READY response proof that the page-facing spoofing layer is present;
// the live state bindings also keep it silent until real, enabled settings with
// a selected location have arrived. The responder discloses no settings or
// coordinates and is restricted to the dedicated first-party top-level route.
installActivationResponder(
  () => settingsReceived && spoofingEnabled && spoofedLocation !== null,
  (message) => logger.debug(message)
);
