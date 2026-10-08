/**
 * Manifest generator for Firefox and Chromium browser targets.
 *
 * Extracted from vite.config.ts so it can be imported in tests without
 * pulling in the Vite/esbuild dependency chain.
 */

/** Valid browser targets for the build system. */
export type BrowserTarget = "firefox" | "chromium" | "safari";

/**
 * Validate and return the browser target from the BROWSER env var.
 * Defaults to "firefox" when unset. Throws for invalid values.
 */
export function resolveBrowserTarget(envBrowser: string | undefined): BrowserTarget {
  if (!envBrowser) return "firefox";
  if (envBrowser === "firefox" || envBrowser === "chromium" || envBrowser === "safari")
    return envBrowser;
  throw new Error(
    `Invalid BROWSER environment variable: "${envBrowser}". ` +
      `Valid values are "firefox", "chromium", or "safari".`
  );
}

/**
 * Generate a browser-specific manifest.json from the shared base configuration.
 *
 * Shared fields (permissions, host_permissions, content_scripts, action, icons,
 * manifest_version, name, description, author, homepage_url, incognito) are
 * preserved for both targets. Browser-specific sections diverge:
 *
 * - Firefox: background.scripts, browser_specific_settings, web_accessible_resources
 * - Chromium: background.service_worker, type "module", injected.js with world "MAIN",
 *   no browser_specific_settings
 * - Safari 18+: scripts-based background, injected.js with world "MAIN"
 */
export function generateManifest(target: BrowserTarget, version: string): Record<string, unknown> {
  const shared: Record<string, unknown> = {
    manifest_version: 3,
    // Use __MSG_*__ references so the Chrome Web Store, AMO, and the
    // App Store can localize the extension name and description to
    // match each user's browser/OS locale. `default_locale` is the
    // fallback when a user's locale has no messages.json file.
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    default_locale: "en",
    author: "GeoSpoof LLC",
    homepage_url: "https://github.com/GeoSpoof/geospoof",
    incognito: "spanning",
    version,
    // `proxy` powers the VPN-sync auto-resync watcher: GeoSpoof observes
    // `proxy.settings.onChange` to detect when a browser-based VPN (e.g. the
    // Proton VPN extension) switches exit nodes, and re-syncs the spoofed
    // location to match the new exit IP. It is observe-only — GeoSpoof never
    // *sets* the proxy. On Chromium the permission's user-facing warning
    // ("Read and change all your data on all websites") is already triggered
    // by the existing `<all_urls>` host permission, so it adds no new install
    // prompt there. Safari has no proxy WebExtensions API, so it is filtered
    // out of the Safari build below (the watcher feature-detects and no-ops).
    permissions: ["storage", "privacy", "proxy", "scripting", "alarms", "idle"],
    host_permissions: ["<all_urls>"],
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["content/content.js"],
        run_at: "document_start",
        all_frames: true,
      },
    ],
    action: {
      default_popup: "popup/popup.html",
      default_icon: {
        "16": "icons/icon-16.png",
        "32": "icons/icon-32.png",
        "48": "icons/icon-48.png",
      },
    },
    icons: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
      "1024": "icons/icon-1024.png",
    },
  };

  if (target === "firefox") {
  // Firefox: scripts-based background, injected.js as world: "MAIN" content script.
  //
  // Permission notes — all four of these are listed under required
  // `permissions`. The scary install string users see is
  // "Block content on any page" from `webRequestBlocking`. This is
  // intentional: GeoSpoof's Firefox build uses `webRequest.
  // filterResponseData` to inject its timezone-spoofing payload into
  // Worker / SharedWorker / ServiceWorker script responses at the
  // network layer. Without these permissions we cannot close the
  // worker timezone leaks that are now widely known (CreepJS and
  // similar tools flag them). The feature is baked in and always on
  // — there is no opt-in toggle because the alternative (content-
  // script blob-URL wrapping) fails on strict-CSP origins and can
  // break site functionality, whereas filterResponseData degrades
  // gracefully (onerror fallback keeps the site working, just
  // unprotected) on the rare origin that ships SRI on workers.
  //
  //   - `webRequest` — baseline API access
  //   - `webRequestBlocking` — required to attach filters to responses.
  //     This is the permission whose user-facing string is "Block
  //     content on any page."
  //   - `webRequestFilterResponse` — MV3-specific gate added in Firefox
  //     110. MV2 extensions got this implicitly from
  //     `webRequestBlocking`; MV3 needs it listed separately.
  //   - `webRequestFilterResponse.serviceWorkerScript` — required to
  //     intercept `navigator.serviceWorker.register()` script fetches.
  //     Without this the filter fires for dedicated / shared / module
  //     workers but not service workers. Added in Firefox 95.
  //
  // These are Firefox-only; Chromium MV3 removed response-body
  // modification entirely (declarativeNetRequest can't modify bodies)
  // and Safari never implemented the API.
  return {
    ...shared,
    permissions: [
      ...(shared.permissions as string[]),
      "webRequest",
      "webRequestBlocking",
      "webRequestFilterResponse",
      "webRequestFilterResponse.serviceWorkerScript",
    ],
    // userScripts lets us register a document_start MAIN-world script with the
    // saved timezone inlined, so synchronous Date/Intl reads in a page's first
    // <script> are already spoofed (closes the cold-start race). In Firefox it
    // is an *optional-only* permission: it CANNOT be listed under required
    // `permissions` (Firefox drops it there, leaving `browser.userScripts`
    // undefined) and is never granted silently — it must be requested at
    // runtime from a user gesture via `permissions.request({permissions:
    // ["userScripts"]})`. The popup's "Instant timezone protection" toggle
    // (Advanced section) drives that request; until the user opts in, the
    // bootstrap registration no-ops and the pre-existing async path applies the
    // spoof a few ms later. Optional-only permissions must be requested alone,
    // so this array contains nothing else.
    optional_permissions: ["userScripts"],
    browser_specific_settings: {
      gecko: {
        id: "{a8f7e9c2-4d3b-4a1e-9f8c-7b6d5e4a3c2b}",
        strict_min_version: "140.0",
        // THIS URL IS EFFECTIVELY PERMANENT ONCE SHIPPED, so it deliberately
        // names a domain we own rather than a github.io path.
        //
        // Firefox keeps polling whatever update_url was compiled into the copy a
        // user installed; an existing install CANNOT be told about a new one. So
        // changing this only affects future installs and whoever updates through
        // the OLD url first. It reached the wrong host historically
        // (anthonysgro.github.io/geospoof/update.json, served from gh-pages),
        // which tied every self-hosted install's update path to a personal GitHub
        // username - and GitHub does not redirect Pages when a repo is
        // transferred, so moving the repo would have stranded those installs
        // silently, a failed update check being invisible to the user.
        //
        // Both URLs are published during the migration; see the release workflow.
        // The AMO-listed build has this key stripped entirely, so AMO users never
        // consult it.
        update_url: "https://cdn.geospoof.com/firefox/update.json",
        data_collection_permissions: {
          required: ["none"],
        },
      },
      gecko_android: {
        strict_min_version: "140.0",
      },
    },
    background: {
      scripts: ["background/background.js"],
      type: "module",
    },
    content_scripts: [
      ...(shared.content_scripts as Array<Record<string, unknown>>),
      {
        matches: ["<all_urls>"],
        js: ["content/injected.js"],
        run_at: "document_start",
        all_frames: true,
        world: "MAIN",
      },
    ],
    web_accessible_resources: [
      {
        resources: ["content/injected.js"],
        matches: ["<all_urls>"],
      },
    ],
  };
  }

  if (target === "safari") {
    // Safari: scripts-based background (avoids service worker suspension bug),
    // no privacy permission (unsupported), no proxy permission (no proxy API),
    // no idle permission (the activity watcher's idle trigger feature-detects to
    // a no-op; tab-navigation triggers still work), no browser_specific_settings.
    const safariPermissions = (shared.permissions as string[]).filter(
      (p) => p !== "privacy" && p !== "proxy" && p !== "idle"
    );
    // nativeMessaging enables browser.runtime.sendNativeMessage →
    // SafariWebExtensionHandler, used to push the current region to the
    // containing app via the shared App Group UserDefaults suite.
    if (!safariPermissions.includes("nativeMessaging")) {
      safariPermissions.push("nativeMessaging");
    }
    // Safari shares the Chromium `declarativeNetRequest` path for the Reported
    // Language `Accept-Language` rewrite (no blocking webRequest in MV3).
    // Safari's `modifyHeaders` support has historically been unreliable, so this
    // is best-effort: where the engine ignores the rule the feature degrades to
    // JS-only locale coverage, which is disclosed in the popup and README rather
    // than silently assumed to work. Requesting the permission costs nothing if
    // unsupported.
    if (!safariPermissions.includes("declarativeNetRequestWithHostAccess")) {
      safariPermissions.push("declarativeNetRequestWithHostAccess");
    }
    // Host permissions are `<all_urls>` and nothing else — deliberately.
    //
    // This used to also list the nine geo/IP service origins (checkip.amazonaws.com,
    // api.ipify.org, get.geojs.io, nominatim.openstreetmap.org and friends), on the
    // reasoning that "Safari may not honor <all_urls> for CORS exemption in background
    // pages". That was a hedge, not a finding, and the cost of it was visible to users:
    // Safari's Settings screen renders one row per declared origin, so GeoSpoof's
    // permission list read as ten entries naming Amazon, Cloudflare and Akamai. For a
    // privacy tool that invites exactly the question it shouldn't — why does a location
    // spoofer want amazonaws.com — and the answer was in a build file nobody reads.
    //
    // They bought nothing in practice. Declaring an origin does not grant it: on a fresh
    // install every one of those rows sits at "Ask" with nothing allowed, so the fetches
    // were no more permitted than they would have been without the declaration. And once
    // the user sets "Other Websites" to Allow, Safari records a single `*://*/*` grant
    // that already covers them — confirmed on device, where
    // `permissions.contains({ origins: ["https://get.geojs.io/*"] })` returned true
    // against that wildcard with no per-origin grant present.
    //
    // So the only capability lost is a user allowing GeoSpoof's VPN-sync endpoints while
    // refusing it every page — which no one would find, and which the nine rows made
    // look like a demand rather than an option.
    //
    // If VPN sync's IP lookup or Change Location's geocoding ever fails on Safari with a
    // CORS error while every-site access is granted, this is the first place to look —
    // and the fix is to restore the specific origin that failed, with a note of what was
    // observed, rather than the whole list on suspicion.
    //
    // Two things in the iOS app now depend on this list staying empty, and both break
    // quietly rather than loudly if origins come back:
    //
    //   1. Onboarding's Settings step instructs the user to "Set All Websites to Allow"
    //      by name (`settingsChecklist` in `geospoof-ios:app/Shared (App)/SpoofDetailsView.swift`).
    //      With declared origins that row is titled "Other Websites" instead, so the
    //      instruction would name a row that isn't on the screen.
    //   2. That step is also where website access is now asked for at all. It replaced a
    //      separate `.grant` screen, on the grounds that the collapsed Permissions
    //      section puts both consents on the one pane the deep link opens. Ten rows put
    //      the second consent below the fold again, which is the condition that made a
    //      separate step necessary in the first place.
    //
    // So restoring an origin means revisiting that step's copy and the accompanying
    // screenshot, not just this array.
    return {
      ...shared,
      permissions: safariPermissions,
      background: {
        scripts: ["background/background.js"],
        type: "module",
        persistent: false,
      },
      // Safari 18 is the product's minimum supported OS. Its declarative
      // `world: "MAIN"` content-script path is the earliest and most reliable
      // way to install the page-facing overrides: WebKit owns the injection at
      // document_start, independent of background-page startup. Keep this as a
      // single static path; combining it with runtime registration would
      // double-install every override on supported Safari versions.
      content_scripts: [
        ...(shared.content_scripts as Array<Record<string, unknown>>),
        {
          matches: ["<all_urls>"],
          js: ["content/injected.js"],
          run_at: "document_start",
          all_frames: true,
          world: "MAIN",
        },
      ],
    };
  }

  // Chromium: service_worker background, injected.js as world: "MAIN" content script
  return {
    ...shared,
    // `declarativeNetRequestWithHostAccess` powers the Reported Language
    // feature's `Accept-Language` header rewrite. MV3 removed blocking
    // `webRequest`, so DNR's `modifyHeaders` action is the only way to align the
    // header with the spoofed locale on Chromium — and without that alignment the
    // feature would ship a browser that claims `fr-FR` in script while sending
    // `Accept-Language: en-US`, a stronger fingerprint than not spoofing at all.
    //
    // The `WithHostAccess` variant is chosen deliberately over plain
    // `declarativeNetRequest`. Both grant identical capabilities and both need
    // host permissions to modify headers (we already hold `<all_urls>`), but only
    // the plain form carries an install-time permission warning. That distinction
    // is not cosmetic: Chrome DISABLES an extension until the user manually
    // re-accepts whenever an update adds a permission with a new warning, so
    // shipping the plain form would have silently disabled GeoSpoof for every
    // existing Chrome user. `WithHostAccess` adds no warning, so it adds no
    // disable and no new install prompt — same "no new warning" reasoning already
    // documented for `proxy` and `debugger` below.
    //
    // The rule is only installed while a locale is actually being reported, and
    // is removed when the feature is off (which is the default).
    //
    // `debugger` powers the optional browser-level (Chrome DevTools Protocol)
    // spoofing mode: when the user turns it on, GeoSpoof attaches via
    // `chrome.debugger` and drives `Emulation.setTimezoneOverride` /
    // `setGeolocationOverride`, which apply across every frame and worker before
    // the first script runs — closing the module/service-worker timezone leaks
    // the content-script path can't cover on Chromium MV3. It must be a REQUIRED
    // permission because Chrome forbids `debugger` in `optional_permissions`.
    // Crucially this adds NO new install warning and does NOT disable the
    // extension for existing users on update: `debugger` maps to the "Access
    // your data on all websites" warning, already triggered by the existing
    // `<all_urls>` host permission (and `proxy`) — same reasoning documented for
    // `proxy` above. The "started debugging this browser" infobar only appears
    // when the user actually enables the mode (i.e. when we attach).
    permissions: [
      ...(shared.permissions as string[]),
      "debugger",
      "declarativeNetRequestWithHostAccess",
    ],
    // `webNavigation` is requested at runtime (from the popup toggle, a user
    // gesture) only when debugger mode is enabled — it lets us attach on
    // `onBeforeNavigate`, before a page's first script, for a race-free
    // override. It's OPTIONAL (unlike `debugger`, it's allowed to be) so it adds
    // no install-time warning and never disables the extension on update; users
    // who never enable debugger mode are never prompted for it. Without the
    // grant we fall back to a `tabs.onUpdated` attach (works, slightly later).
    optional_permissions: ["webNavigation"],
    // Register the popup UI as an options page — Chromium-only. This is a fix
    // for mobile Chromium browsers (Cromite / Kiwi on Android): they graft the
    // desktop popup into the mobile UI, which breaks Android's focus engine, so
    // tapping a text input in the popup never summons the virtual keyboard and
    // coordinates/city search can't be typed. The options page opens as a
    // normal tab (via the extensions manager → Details → "Extension options")
    // where focus and the keyboard work, giving mobile users a working path to
    // the exact same UI. Scoped to Chromium because that's the only target with
    // this bug: Firefox-for-Android generally handles popup focus, and Safari
    // (macOS/iOS) doesn't have it — so their builds skip the redundant entry.
    //
    // `open_in_tab: true` is required, not cosmetic: the default (`false`)
    // embeds the page in an iframe inside the extensions manager, which
    // reintroduces the focus/keyboard bug on mobile (see crbug 464769552).
    // `options_ui` is the MV3-preferred field over the legacy `options_page`.
    // The page reuses popup.html verbatim — no new build artifact — and its
    // viewport (width=350) renders as a clean, tappable single column on phone.
    options_ui: {
      page: "popup/popup.html",
      open_in_tab: true,
    },
    // Chrome-only store name + description. The Chrome Web Store reads both
    // straight from the manifest, so we override the shared
    // `__MSG_extensionName__` / `__MSG_extensionDescription__` with literal,
    // keyword-focused strings here. Firefox (AMO) and Safari (App Store) keep
    // the localized messages (name → "GeoSpoof", description → the WebRTC
    // variant).
    //
    // ASO notes (Chrome Web Store search ranking):
    // - `name` is the listing TITLE and the highest-weighted ranking field. It
    //   leads with the exact "spoof geolocation" query, then "timezone" — a
    //   genuine secondary feature and query, and a clean parallel object after
    //   the "&" (two different things you spoof, no "location…location" repeat).
    //   The location-changer intent isn't in the title because it's already at
    //   the keyword cap inside the long description. Kept under the 75-char
    //   manifest limit (currently 38 chars).
    // - `description` is the 132-char SHORT description (the snippet shown under
    //   the name and in search results). It front-loads "spoof geolocation",
    //   "fake GPS location", and "change your location" (the "location changer"
    //   intent), plus timezone + VPN sync. It deliberately drops WebRTC — a
    //   low-volume search term — to spend characters on higher-volume keywords.
    //   Currently 123 chars (must stay <= 132).
    // - The long/detailed listing description lives in the Web Store Developer
    //   Dashboard (no manifest field exists for it); see
    //   assets/store-listings/listing-copy.md.
    name: "GeoSpoof: Spoof Geolocation & Timezone",
    description:
      "Spoof geolocation, fake your GPS location & timezone — change your location to any city or sync it to your VPN. No account.",
    background: {
      service_worker: "background/background.js",
      type: "module",
    },
    content_scripts: [
      ...(shared.content_scripts as Array<Record<string, unknown>>),
      {
        matches: ["<all_urls>"],
        js: ["content/injected.js"],
        run_at: "document_start",
        all_frames: true,
        world: "MAIN",
      },
    ],
  };
}
