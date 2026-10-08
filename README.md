<div align="center">
  <img src="assets/icon.png" alt="GeoSpoof" width="100" height="100">

# GeoSpoof

**Your VPN changes your IP address. Your device is still telling websites where you actually are.**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/Website-geospoof.com-4caf50.svg?logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABTElEQVQ4T41TS1LDMAyV3AXZsGPJJbgGC5qkoXG5Vi/AsAAS8uMi3AdmYiE5dRK7LoMzGSey9J70JCNcWLpNaSQDG1RA/FS7T4y5nhnL5oGQgxARiMjusuR7NAQfjz6QB6DbLQHgEnQ6Rba6NRqAuujnOA/g0GXWldiqFMDrdnI89IXwgwO6SW6T4/3xW85mAN1n5Bze8oVhXbcjEG3qkyYLAIvm2Kt8iAomAKKFZOh8Zsc918/SgWHFHXqouu6YhGmiAOWQk2KV1+mFAHMJ3Jk66yy53wXWwabIb5iFblJCNWW4LtED2FshufeSJu9VMfV87g7bzEZBnU7sZxmIwWkRDpKchexRADGWLJYI6ibRgcXaG22XbnZ3qMyXAxDVE7r+ec5frkJhowDi9DTwVHKkvQN8N+qs/d9l8iaPWysA71l8Mi9qEKb51/8vRNquEc5KgXwAAAAQZGVCRzg1RUVEM0EzRkYzNEI0MzTcy3bJAAAAAElFTkSuQmCC)](https://geospoof.com/?utm_source=github&utm_medium=readme)
[![Version](https://img.shields.io/github/package-json/v/GeoSpoof/geospoof?color=green)](https://github.com/GeoSpoof/geospoof/releases)
[![Firefox users](https://img.shields.io/amo/users/geo-spoof?logo=firefox-browser&label=Firefox%20users)](https://addons.mozilla.org/firefox/addon/geo-spoof/?utm_source=github&utm_medium=readme&utm_campaign=readme)
[![Chrome users](https://img.shields.io/chrome-web-store/users/dgdbdodafgaeifgajaajohkjjgobcgje?logo=googlechrome&label=Chrome%20users)](https://chromewebstore.google.com/detail/geospoof/dgdbdodafgaeifgajaajohkjjgobcgje?utm_source=github&utm_medium=readme&utm_campaign=readme)
[![App Store downloads](https://img.shields.io/badge/App%20Store%20downloads-30.8k-0071E3?logo=apple&logoColor=white)](https://apps.apple.com/app/apple-store/id6765719745?pt=128299974&ct=github&mt=8)
[![Reddit](https://img.shields.io/badge/Reddit-r%2FGeoSpoof-FF4500.svg?logo=reddit&logoColor=white)](https://www.reddit.com/r/geospoof)

  <p>
    <img src="assets/store-listings/github/hero.png" alt="GeoSpoof main view" width="960" />
  </p>
</div>

GeoSpoof now comes in two parts:

- **Browser extension** (free & open source) — stops websites from geolocating you by overriding the Geolocation API, timezone, `Intl`, WebRTC, and every other signal, so your browser reports a location you choose. Firefox, Chrome, and Safari.
- **[GeoSpoof GPS](#geospoof-gps-device-level-location)** — moves your iPhone or iPad's _real, system-level_ GPS to the location you pick, so location-aware apps across the whole device match it, not just the browser.

## Contents

- [Getting started](#getting-started) — [Install](#install) · [Usage](#usage)
- [Why GeoSpoof?](#why-geospoof) — [What it does NOT do](#what-this-does-not-do)
- [Reported Language](#reported-language-opt-in) — opt-in language & locale alignment
- [GeoSpoof GPS](#geospoof-gps-device-level-location) — device-level location on iPhone & iPad
- [Overridden APIs](#overridden-apis)
- [External Services](#external-services)
- [Featured in](#featured-in)
- [Development](#development)

## Getting started

### Install

|                                                                                                                                       Browser                                                                                                                                        | Store                                                                                                                                                          | Works on                                                                                  |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
|                                    [<img src="assets/store-listings/github/firefox.svg" alt="Get GeoSpoof for Firefox" height="55">](https://addons.mozilla.org/firefox/addon/geo-spoof/?utm_source=github&utm_medium=readme&utm_campaign=readme)                                    | [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/geo-spoof/?utm_source=github&utm_medium=readme&utm_campaign=readme)                                 | Firefox 140+ on desktop and Android                                                       |
|                     [<img src="assets/store-listings/github/chrome.svg" alt="Get GeoSpoof for Chrome" height="55">](https://chromewebstore.google.com/detail/geospoof/dgdbdodafgaeifgajaajohkjjgobcgje?utm_source=github&utm_medium=readme&utm_campaign=readme)                      | [Chrome Web Store](https://chromewebstore.google.com/detail/geospoof/dgdbdodafgaeifgajaajohkjjgobcgje?utm_source=github&utm_medium=readme&utm_campaign=readme) | Chrome, Brave, Edge, Opera, and other Chromium browsers                                   |
|                                                   [<img src="assets/store-listings/github/safari.svg" alt="Get GeoSpoof for Safari" height="55">](https://apps.apple.com/app/apple-store/id6765719745?pt=128299974&ct=github&mt=8)                                                   | [App Store](https://apps.apple.com/app/apple-store/id6765719745?pt=128299974&ct=github&mt=8)                                                                   | Safari on iOS, iPadOS, and macOS                                                          |
| [<picture><source media="(prefers-color-scheme: dark)" srcset="assets/store-listings/github/github-dark.svg"><img src="assets/store-listings/github/github-light.svg" alt="Get GeoSpoof from GitHub Releases" height="55"></picture>](https://github.com/GeoSpoof/geospoof/releases) | [GitHub Releases](https://github.com/GeoSpoof/geospoof/releases)                                                                                               | Firefox self-hosted signed XPI — [setup below](#from-github-releases-firefox-self-hosted) |

<details>
<summary><strong>Safari setup</strong> — enabling after install</summary>

<br>

After installing on Safari, tap the puzzle piece icon (or go to Safari Settings → Extensions) and enable GeoSpoof for the sites you want to protect. On iOS/iPadOS, you can also enable it per-site from the **AA** menu in the address bar.

</details>

<details>
<summary><strong>Other install paths</strong> — self-hosted XPI, from source</summary>

#### From GitHub Releases (Firefox self-hosted)

Each release includes a self-hosted signed XPI alongside the AMO submission. The self-hosted XPI uses a 4-segment version (e.g., `1.18.0.42`) to avoid collisions with the AMO listing.

1. Go to the [Releases](https://github.com/GeoSpoof/geospoof/releases) page
2. Download `geospoof-firefox-v<version>-signed.xpi` from the latest release
3. In Firefox, open `about:addons`
4. Click the gear icon (⚙) and select **Install Add-on From File…**
5. Select the downloaded `.xpi` file

The signed XPI works on standard Firefox with no extra configuration. Once installed, Firefox automatically checks for and installs new versions via the self-hosted update manifest. If you later install from AMO, Firefox will auto-upgrade to it since AMO releases use a higher base version.

> **Note:** An unsigned `geospoof-firefox-v<version>-unsigned.xpi` is also included in each release for Firefox forks that don't support AMO signatures. Most users should use the signed version.

#### From source

See [CONTRIBUTING.md](CONTRIBUTING.md) for build instructions.

</details>

### Usage

1. Click the GeoSpoof icon in your toolbar
2. Search for a city, enter coordinates manually, or use "Sync with VPN" to auto-detect your VPN exit region
3. Enable "Location Protection", "WebRTC Protection", and "Sync with VPN" features
4. Refresh open tabs to apply
5. Confirm it's working at [geospoof.com/verify](https://geospoof.com/verify)

See [docs/USER_GUIDE.md](docs/USER_GUIDE.md) for details.

## Why GeoSpoof?

A VPN changes your IP, but your browser still leaks your real location through the Geolocation API, timezone offsets, `Intl.DateTimeFormat`, WebRTC, and more. Sites cross-reference these signals against your IP — when they don't match, you're flagged.

GeoSpoof overrides every one of those channels so your browser reports a consistent, chosen location instead of your real one. Set it to match your VPN, mismatch it on purpose, or pick anywhere in the world.

- **VPN Region Sync** — detects your VPN exit IP and sets your location to match. One click, and it re-syncs automatically as you switch exit servers.
- **Manual control** — search for a city or enter coordinates directly.
- **Full signal alignment** — geolocation, timezone, Date APIs, Intl, Temporal, and WebRTC all report the same place.
- **Reported Language (opt-in)** — optionally report a language to match, so `navigator.language`, every `Intl` format, and the `Accept-Language` header agree instead of announcing where you actually come from.
- **Anti-fingerprinting** — overrides are disguised to pass native code checks used by real-world fingerprinting scripts.
- **Cross-browser** — Firefox, Chrome, Brave, Edge, and Safari. Single codebase, MV3.

> **Note:** Use of this tool may violate the Terms of Service of certain websites. Use responsibly.

### What This Does NOT Do

GeoSpoof is designed to work alongside a VPN, not replace one.

- Does NOT spoof your IP address (use a VPN for that)
- Does NOT change your browser's language by default — that's opt-in (see [Reported Language](#reported-language-opt-in)), and it does NOT change GeoSpoof's own interface language
- Does NOT bypass server-side detection (IP, payment info, account history)
- Does NOT track your browsing activity, collect telemetry, or store data on external servers. Some features (city search, VPN sync) call third-party APIs to function. See the [Privacy Policy](PRIVACY_POLICY.md) for exactly what's sent and to whom.
- Does NOT provide forensic-level anti-fingerprinting. Engine-level API tampering is also detectable by dedicated tools. For extreme threat models, use [Tor Browser](https://www.torproject.org/) or [Mullvad Browser](https://mullvad.net/browser) instead.

## Reported Language (opt-in)

Your VPN and your spoofed location can say Paris while your browser still says `navigator.language === "en-US"` and sends `Accept-Language: en-US` with every request. **Reported Language** closes that gap.

Turn it on in **Settings (the ⚙ gear in the popup header) → Reported Language** and pick either:

- **Match my location** — use the dominant language of the place you're already spoofing, resolved offline from your spoofed timezone.
- **Choose language…** — name any language tag your browser supports, like `fr-FR`, `ja`, or `pt-BR`. The field suggests common ones as you type but accepts any valid tag.

It's **off by default**, because it visibly changes browsing: many sites will switch language outright.

When it's on, these move together:

- `navigator.language` and `navigator.languages`, in the page and inside Workers
- The default locale of every `Intl` constructor, plus each `resolvedOptions()`
- `toLocaleString` on `Date`/`Number`/`BigInt`/`Array`, `localeCompare`, and locale-sensitive case mapping
- The `Accept-Language` request header

They move together on purpose. A browser claiming `fr-FR` in script while sending `Accept-Language: en-US` is obviously tampered with — a _stronger_ fingerprint than not spoofing at all — so both surfaces are derived from one resolver and can't disagree. Formats aren't faked either: the chosen locale is handed to the browser's own `Intl` engine, so separators, month names, collation order, and hour cycle are genuinely correct for the language you report.

**Limits, stated plainly:**

- Locale entropy outside an extension's reach is **not** covered: installed fonts, text-rendering metrics, and `speechSynthesis` voice lists still reflect your real system.
- What's advertised is shaped per engine to match what that browser natively sends — Firefox and Chromium expose the tag plus a bare-language fallback with different quality values, and Safari exposes a single language — so the output doesn't look like a different browser's.
- The `Accept-Language` header is rewritten on Firefox and Chromium. On Safari it depends on the engine honoring `declarativeNetRequest` header modification, which has historically been unreliable; where it doesn't, coverage degrades to the JavaScript surfaces only.
- If you pick a language your browser has no data for, GeoSpoof reports your real one rather than half-applying the change — the control tells you when that happens.

This is separate from the **Language** setting further down the same panel, which only changes GeoSpoof's own interface language and is never sent to websites.

## GeoSpoof GPS (device-level location)

The browser extension keeps your **browser** private. GeoSpoof GPS goes a level deeper: it moves your iPhone or iPad's **real, system-level GPS** to the location you choose, so location-aware apps across the whole device match it — not just Safari.

- **Whole-device, not just the browser** — sets the OS-level location every app reads, driven from a companion app for Mac.
- **Secure one-time pairing** — set up from your Mac over a secure pairing. No jailbreak.
- **Fully reversible** — reverts to your real GPS the moment you turn it off.
- **Private by design** — same no-account, no-tracking stance as the extension. Built for privacy and for testing location-based features; not designed for AR games.

GeoSpoof GPS is an optional **Pro** feature — browser and Safari spoofing stay free. It ships as a signed, notarized macOS app.

**Download it at [geospoof.com/gps](https://geospoof.com/gps?utm_source=github&utm_medium=readme).**

> GeoSpoof GPS is a separate, closed-source product and is **not** part of this repository — this repo is the open-source browser extension. See the [Privacy Policy](PRIVACY_POLICY.md) for exactly what each surface sends and to whom.

## Overridden APIs

When protection is enabled, GeoSpoof overrides browser APIs synchronously at `document_start` before any page JavaScript runs. Covered APIs include:

- **Geolocation** — `navigator.geolocation.getCurrentPosition/watchPosition`, `navigator.permissions.query`
- **Date & Timezone** — `Date` constructor, `Date.parse`, all `Date.prototype` getters and formatters, `getTimezoneOffset`
- **Intl** — `Intl.DateTimeFormat` constructor and `resolvedOptions`
- **Temporal** — `Temporal.Now.*` (feature-detected)
- **XSLT / EXSLT** — `XSLTProcessor.prototype.transformToFragment/transformToDocument` rewrite EXSLT `date:date-time()` output (Firefox, where available)
- **Workers** — `Worker`, `SharedWorker`, and `navigator.serviceWorker.register` wrapped to propagate the spoofed timezone into worker scopes (URL-based worker coverage is the Firefox `webRequest.filterResponseData` path; inline/blob workers are covered on every engine)
- **WebRTC** — via browser privacy API, no script injection needed
- **Locale** (opt-in, see [Reported Language](#reported-language-opt-in)) — `navigator.language`, `navigator.languages`, the default locale of every `Intl` constructor (`DateTimeFormat`, `NumberFormat`, `Collator`, `RelativeTimeFormat`, `ListFormat`, `PluralRules`, `DisplayNames`, `Segmenter`, `DurationFormat`) plus their `resolvedOptions()`, `toLocaleString` on `Date`/`Number`/`BigInt`/`Array`, `String.prototype.localeCompare`/`toLocaleUpperCase`/`toLocaleLowerCase`, and the `Accept-Language` request header
- **Anti-fingerprinting** — `Function.prototype.toString` returns `[native code]` for all overrides; iframes patched on insertion
- **Engine-level Spoofing** (Chrome/Chromium, opt-in) — an optional mode that drives the timezone override through the Chrome DevTools Protocol (`chrome.debugger` → `Emulation.setTimezoneOverride`) instead of page-world injection. It covers background/module/service workers and applies before a page's first script, closing the worker and cold-start timezone leaks the content-script path can't reach on Chromium MV3. Off by default; while on, Chrome shows a "started debugging this browser" notice. Geolocation stays on the injected path.

For the full API reference, see [docs/API.md](docs/API.md). For the VPN sync and auto-resync architecture, see [docs/VPN_SYNC.md](docs/VPN_SYNC.md).

## External Services

GeoSpoof runs no backend application and sends no data to the developer for collection or analytics. Some features — city search and the optional "Sync with VPN" — make requests directly from your device to third-party services. Timezone resolution downloads boundary data from the developer's own CDN (`cdn.geospoof.com`, hosted on AWS), which transmits your IP as part of that request. The developer does **not** use these requests for analytics, tracking, profiling, advertising, or user accounts, and stores no personal data from them. Exactly what is sent, when, and to whom (for both the Safari extension and the companion apps) is documented in the [Privacy Policy](PRIVACY_POLICY.md).

## Featured in

- [Privacy Guides community forum](https://discuss.privacyguides.net/t/geospoof-a-firefox-add-on-for-convenient-geolocation-privacy/36159) — "GeoSpoof: a Firefox add-on for convenient geolocation privacy"
- [Korben](https://korben.info/geospoof-vpn-navigateur-localisation.html) — "GeoSpoof - Le VPN cache votre IP mais le navigateur vous trahit" (FR)

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, scripts, testing, and the release pipeline.

## Legal

Using location spoofing may violate terms of service of streaming, financial, or e-commerce platforms. You are responsible for compliance. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md) for full details.

## License

Everything in this repository — the browser extension, its docs, and its assets — is **MIT**. See [LICENSE](LICENSE). Use, modify, and redistribute freely, including commercially.

Three GeoSpoof products are developed separately, are closed-source, and are not part of this repository:

- The **native iOS and macOS apps**. These previously lived in a `safari/` directory here, MIT-licensed until 2026-09-13. That history remains, tagged `pre-safari-extraction`.
- The **geospoof.com website**, including its marketing copy, translations, and imagery. This previously lived in a `site/` directory here; that history remains, tagged `pre-site-extraction`.
- The **GeoSpoof GPS desktop core** (the Rust/Swift device product).

In each case, copies obtained under MIT before the directory was removed keep those rights — nothing here revokes a grant already made.

**Trademarks:** The MIT license covers the source code only, not the brand. **GeoSpoof™ is a trademark of GeoSpoof LLC.** You're free to use and fork the code under MIT, but the GeoSpoof name and logo aren't licensed with it — please don't brand a fork or derivative product as "GeoSpoof" in a way that could confuse users about its source.

## Links

- [Website — geospoof.com](https://geospoof.com/?utm_source=github&utm_medium=readme)
- [GeoSpoof GPS — geospoof.com/gps](https://geospoof.com/gps?utm_source=github&utm_medium=readme)
- [Verify your protection — geospoof.com/verify](https://geospoof.com/verify?utm_source=github&utm_medium=readme)
- [Community — r/GeoSpoof](https://www.reddit.com/r/geospoof)
- [User Guide](docs/USER_GUIDE.md)
- [API Documentation](docs/API.md)
- [VPN Sync & Auto-Resync](docs/VPN_SYNC.md)
- [How Browsers Track Location](docs/BACKGROUND.md)
- [Privacy Policy](PRIVACY_POLICY.md)
- [Contributing](CONTRIBUTING.md)
- [Report Issues](https://github.com/GeoSpoof/geospoof/issues)
- [Buy me a coffee](https://buymeacoffee.com/sgro)

## Star History

<a href="https://www.star-history.com/?repos=anthonysgro%2Fgeospoof&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=anthonysgro/geospoof&type=date&theme=dark&legend=top-left&v=2&sealed_token=yU2IXP9gRuA7I9Fy83YFQ0cG5lEZe81LZeilLF2OFlkSp2nczAdshC2DPR0jIbrZPxB4fc7lM3_GXjqQqNYcO6d2UxNywpbPaGuOy1dswokuhzg08Wo5scMsbvRn9b9pnRcW763SZ3927aF6_8ZA35shdlQnoKkOuutDZiqsNMUlxbw1amErlL-BsGdz" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=anthonysgro/geospoof&type=date&legend=top-left&v=2&sealed_token=yU2IXP9gRuA7I9Fy83YFQ0cG5lEZe81LZeilLF2OFlkSp2nczAdshC2DPR0jIbrZPxB4fc7lM3_GXjqQqNYcO6d2UxNywpbPaGuOy1dswokuhzg08Wo5scMsbvRn9b9pnRcW763SZ3927aF6_8ZA35shdlQnoKkOuutDZiqsNMUlxbw1amErlL-BsGdz" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=anthonysgro/geospoof&type=date&legend=top-left&v=2&sealed_token=yU2IXP9gRuA7I9Fy83YFQ0cG5lEZe81LZeilLF2OFlkSp2nczAdshC2DPR0jIbrZPxB4fc7lM3_GXjqQqNYcO6d2UxNywpbPaGuOy1dswokuhzg08Wo5scMsbvRn9b9pnRcW763SZ3927aF6_8ZA35shdlQnoKkOuutDZiqsNMUlxbw1amErlL-BsGdz" />
 </picture>
</a>

## Acknowledgments

- [Nominatim](https://nominatim.org/) for geocoding
- [browser-geo-tz](https://github.com/kevmo314/browser-geo-tz) for timezone boundary-data lookup
- [BrowserLeaks](https://browserleaks.com/) for testing tools
- [arkenfox TZP](https://arkenfox.github.io/TZP/tzp.html) for timezone/geolocation fingerprint testing
- [CreepJS](https://abrahamjuliot.github.io/creepjs/) for fingerprint testing
- [webbrowsertools](https://webbrowsertools.com/) for testing tools

### Contributors

Thanks to everyone who has contributed to GeoSpoof.

<a href="https://github.com/GeoSpoof/geospoof/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=anthonysgro/geospoof" alt="GeoSpoof contributors" />
</a>
