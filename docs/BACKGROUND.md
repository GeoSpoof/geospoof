# How Browsers Know Where You Are

A technical overview of browser location detection — the signals involved, how they work, and why a VPN alone is insufficient for location privacy.

## The Location Signal Stack

Modern browsers can determine a user's physical location through several independent channels. These signals vary in accuracy, availability, and ease of interception. A [VPN](https://en.wikipedia.org/wiki/Virtual_private_network) addresses exactly one of them.

### 1. IP Geolocation

Every internet connection is associated with a public [IP address](https://en.wikipedia.org/wiki/IP_address). Commercial databases such as [MaxMind GeoIP](https://www.maxmind.com/en/geoip-databases) and [IP2Location](https://www.ip2location.com/) map IP address ranges to approximate geographic locations by correlating [WHOIS](https://en.wikipedia.org/wiki/WHOIS) registration data, [BGP](https://en.wikipedia.org/wiki/Border_Gateway_Protocol) routing information, and active probing.

Accuracy is typically city-level for residential broadband, though mobile carrier IPs are often less precise. A VPN replaces the user's real IP with the VPN server's IP, causing IP geolocation to report the server's location instead. This is the only signal a VPN directly addresses.

### 2. Wi-Fi Positioning System (WPS)

Wi-Fi positioning is how browsers achieve GPS-level accuracy on devices without GPS hardware — and the mechanism most users are unaware of.

When a page calls [`navigator.geolocation.getCurrentPosition()`](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/getCurrentPosition), the browser requests a list of nearby [Wi-Fi access points](https://en.wikipedia.org/wiki/Wireless_access_point) from the operating system, including their [SSIDs](<https://en.wikipedia.org/wiki/Service_set_(802.11_network)#SSID>) and [MAC addresses](https://en.wikipedia.org/wiki/MAC_address) (BSSIDs). This list is transmitted over HTTPS to a location service — [Google Location Services](https://developers.google.com/maps/documentation/geolocation/overview), [Apple Location Services](https://support.apple.com/en-us/102515), or [Mozilla Location Services](https://location.services.mozilla.com/) depending on the platform.

These services maintain databases built through [wardriving](https://en.wikipedia.org/wiki/Wardriving) — systematic collection of access point locations by vehicles equipped with GPS and Wi-Fi receivers — as well as crowdsourced data from mobile devices. When a browser submits a set of observed access points with signal strengths, the service cross-references them against the database and returns coordinates typically accurate to 10–20 meters.

The practical implication: a laptop with no GPS chip, sitting in a basement, can report its location to within a city block. It only needs to observe its neighbors' routers.

### 3. GPS

On devices equipped with [GPS](https://en.wikipedia.org/wiki/Global_Positioning_System) receivers — smartphones, tablets, and some laptops — the operating system can provide coordinates derived directly from satellite signals. Accuracy outdoors is typically 3–5 meters under clear sky conditions, degrading indoors.

Browsers access GPS through the same `navigator.geolocation` API. The OS selects the best available positioning source (GPS, Wi-Fi, cell towers) and returns a result; the browser does not directly control which source is used.

### 4. Cell Tower Triangulation

Mobile devices can estimate position by measuring signal strength from multiple [cell towers](https://en.wikipedia.org/wiki/Cell_site) and applying [trilateration](https://en.wikipedia.org/wiki/Trilateration). Accuracy ranges from approximately 100 meters in dense urban areas to several kilometers in rural regions, depending on tower density.

This method is less precise than Wi-Fi positioning but functions anywhere with cellular coverage, including areas where Wi-Fi access points are sparse.

### 5. Timezone Offset

```javascript
new Date().getTimezoneOffset(); // e.g., -480 for UTC−8 (PST)
```

[`Date.prototype.getTimezoneOffset()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/getTimezoneOffset) returns the difference between [UTC](https://en.wikipedia.org/wiki/Coordinated_Universal_Time) and the system's local time in minutes. While this does not identify a specific city, it constrains the user's location to a UTC offset band. Combined with other signals, it is a reliable fingerprinting vector — particularly when it contradicts the IP geolocation result.

### 6. IANA Timezone Identifier

```javascript
Intl.DateTimeFormat().resolvedOptions().timeZone; // e.g., "America/Los_Angeles"
```

The [IANA Time Zone Database](https://www.iana.org/time-zones) assigns named identifiers to geographic timezone regions. [`Intl.DateTimeFormat`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat) exposes the system's current identifier through `resolvedOptions()`.

This is more informative than the raw offset. `"America/Los_Angeles"` places the user on the US West Coast. `"Asia/Kolkata"` identifies India specifically — it is the only country using UTC+5:30, a fact that is not lost on fingerprinting scripts.

### 7. WebRTC IP Leak

[WebRTC](https://en.wikipedia.org/wiki/WebRTC) (Web Real-Time Communication) is a browser API for peer-to-peer audio, video, and data transfer. To establish peer connections, WebRTC uses [ICE](https://en.wikipedia.org/wiki/Interactive_Connectivity_Establishment) (Interactive Connectivity Establishment), which enumerates the device's network interfaces to discover candidate connection paths.

This enumeration can expose the device's local network IP addresses and, critically, its public IP address — even when the device is behind a VPN. The VPN creates a virtual network interface, but ICE may also enumerate the physical interface and include its associated public IP as a candidate. A page can trigger ICE candidate gathering with a small JavaScript snippet and read the results without establishing any actual connection.

This behavior is known as a [WebRTC leak](https://browserleaks.com/webrtc). It is not a bug in WebRTC — it is working as specified. Mitigation requires either disabling WebRTC entirely or configuring the browser's IP handling policy to restrict which interfaces are enumerated.

### 8. Date and Time Formatting

```javascript
new Date().toString();
// "Sat May 03 2026 14:23:45 GMT-0800 (Pacific Standard Time)"
```

[`Date.prototype.toString()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/toString) includes the timezone name and UTC offset in its output. [`toLocaleString()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/toLocaleString) formats dates using the system timezone. These are consistent, low-effort signals that fingerprinting scripts routinely collect alongside the more obvious geolocation API.

### 9. The Temporal API

The [Temporal API](https://tc39.es/proposal-temporal/) is a TC39 stage 3 proposal providing a modern replacement for the `Date` object. It exposes timezone information more explicitly than its predecessor:

```javascript
Temporal.Now.timeZoneId(); // "America/Los_Angeles"
Temporal.Now.zonedDateTimeISO(); // includes timezone in the structured result
```

As Temporal ships in more browsers, it constitutes an additional channel requiring interception. GeoSpoof overrides `Temporal.Now.*` methods with feature detection — if the API is absent, the overrides are no-ops.

---

## Why Signal Consistency Matters

Location fingerprinting systems do not rely on a single signal. They cross-reference multiple signals and flag inconsistencies. A VPN that changes the IP geolocation to Tokyo while the system timezone remains `America/New_York` produces a detectable contradiction. Common mismatches that trigger flags:

- IP geolocation country ≠ timezone region
- `getTimezoneOffset()` value inconsistent with `Intl` timezone identifier
- `navigator.geolocation` coordinates in a different country than the IP
- WebRTC candidates revealing a non-VPN public IP

This is why overriding a single signal is insufficient. GeoSpoof overrides all of them — geolocation, timezone offset, IANA identifier, `Date` formatting, `Temporal`, and WebRTC — so they present a consistent identity regardless of which signals a site chooses to inspect.

---

## Limits of Extension-Level Spoofing

Browser extensions operate in a privileged but sandboxed context. Several attack surfaces remain outside their reach.

### Web Workers

[Content scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts) cannot directly inject into [`Worker`](https://developer.mozilla.org/en-US/docs/Web/API/Worker), [`SharedWorker`](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker), or [`ServiceWorker`](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorker) contexts — they run in separate global scopes with no shared state. GeoSpoof routes different worker-construction patterns through different mechanisms to balance protection coverage with site-breakage risk.

For URL-based workers (`new Worker("/foo.js")`, module workers, SharedWorker with a URL, `navigator.serviceWorker.register(url)`) the content script announces the URL to the background and passes the original URL through to the real constructor. On Firefox the background's always-on [`webRequest.filterResponseData`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData) listener prepends the spoofing payload to the response bytes, preserving the original URL and avoiding any CSP/import/location drift. On Chromium and Safari the API doesn't exist and URL-based workers run unpatched — a documented engine limit.

For inline workers (`new Worker(URL.createObjectURL(new Blob([...])))` or `new Worker("data:application/javascript,...")`), the content script blob-wraps the worker on every engine. The site already committed to an inline URL and its CSP necessarily allows it, so our replacement blob stays within the same CSP allowance.

Rewriting URL-based workers to blob URLs is deliberately avoided because blob wrapping fails on strict-CSP origins (breaking the site's worker entirely), shifts `self.location` which breaks relative `fetch`/`import` calls inside the worker, and can't preserve module-worker `import` resolution. When Advanced Worker Protection's `filterResponseData` path encounters a worker script protected by Subresource Integrity, the browser rejects the modified bytes, our `onerror` handler disconnects, the original response serves unmodified, and the site keeps working (with no protection on that origin).

When running on Firefox, CreepJS's `code:` worker-fingerprint hash matches the main window: the shared payload derives the engine-specific `[native code]` surround format at runtime to match Firefox's multi-line shape, so every spoofed function passes the native-shape check inside workers.

### Engine Internals

JavaScript engines maintain [internal slots](https://tc39.es/ecma262/#sec-object-internal-methods-and-internal-slots) and perform brand checks that can distinguish native built-in functions from JavaScript replacements. Dedicated fingerprinting tools such as [CreepJS](https://abrahamjuliot.github.io/creepjs/) and [TorZillaPrint](https://arkenfox.github.io/TZP/tzp.html) use these mechanisms to detect content-script-level overrides.

GeoSpoof's anti-fingerprinting layer — disguising overrides as `[native code]`, removing `prototype`, stripping `[[Construct]]` — defeats the checks used by real-world fingerprinting scripts. Forensic-level tools operating through engine internals and timing side-channels can still detect the overrides.

### Browser UI Language

The Reported Language feature covers the JavaScript and HTTP layers: `navigator.language`, `navigator.languages`, the default locale of every `Intl` constructor, the `toLocale*` family, and the `Accept-Language` header. The browser's **own** language — its UI locale and its accept-language preference — is a separate layer that no extension can reach, and several surfaces expose it directly:

- **SVG `systemLanguage`.** The [conditional processing attribute](https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/systemLanguage) is evaluated by the layout engine against the user's language preferences (`intl.accept_languages` on Gecko), _not_ against `navigator.languages`. Because a real browser's `navigator.languages` **is** that preference list, the two can never disagree without tampering — which makes the attribute a direct probe for a spoofed language. Measured behavior on Firefox, where every child whose conditions pass is rendered (failed conditionals behave as `display: none`):

  | reported languages       | children matching a real `en-US, en` | result          |
  | ------------------------ | ------------------------------------ | --------------- |
  | `en-US, en` (untampered) | both                                 | full match      |
  | `en-GB, en`              | `en` only                            | partial match   |
  | `ja-JP, ja`              | none                                 | no match at all |

  TorZillaPrint's `languages_system` metric builds one `<text systemLanguage>` per reported language and reports what rendered, so spoofing to a different primary language leaves it with nothing (it raises an error on the empty result), and spoofing a different region within the user's own language leaves it partially matched. It agrees only when the reported list is a subset of the real one — that is, when the language was not really changed.

  There is no JavaScript surface to override: conditional processing is resolved during layout, so patching the `SVGTests` IDL attribute changes nothing. And no WebExtension API can set the underlying preference — [`i18n.getAcceptLanguages()`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/i18n/getAcceptLanguages) is read-only, and [`browserSettings`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/browserSettings) exposes no equivalent key. Rewriting the `Accept-Language` header, which GeoSpoof does, affects HTTP only and never reaches layout.

- **Anything the browser itself writes for the user.** This is a whole class, not a list of specific probes. Every string the browser generates comes from its own localization bundles, so it reports the real application locale no matter what script says. Confirmed by measurement while reporting `fr-FR` on an English Firefox — all of these came back in English:
  - `input.validationMessage` (~14 distinct messages, e.g. "Please fill out this field.")
  - XML `<parsererror>` document text, and XSLT error text
  - The XML pretty-print "no style information" banner
  - `MediaDocument` titles ("PNG image, 100 × 100 pixels", "Scaled (50%)")
  - `ReportingObserver` deprecation message bodies

  TZP's `l10n_*` hashes sample this class; they are not the extent of it.

- **Strings that can be measured rather than read.** A subtler variant, since there is no text to inspect: the default labels on `<input type="file">`, `type="submit"` and `type="reset"` are localized, are NOT exposed through `value`, and are still fingerprintable from the control's rendered width. `<input type="date">`'s placeholder ordering behaves the same way. Measured on an English build: `file=244px submit=101px reset=49px date=132px` — French labels ("Parcourir…", "Envoyer") render to different widths.

- **`parsererror` text direction** and **`xsl:sort` collation**, derived from the app locale. Direction only leaks for RTL locales (`ar`, `fa`, `he`); it carries no signal between two LTR languages.

- **`speechSynthesis.getVoices()`**, which exposes installed OS voices and their language codes — an operating-system signal rather than a browser one, and equally out of reach.

### Two preferences, and only one of them is a real tell

These surfaces are not equally incriminating, because they read different Firefox preferences. Verified by setting `intl.accept_languages` to `de-DE, de` on an English-UI Firefox with the extension disabled — `navigator.languages` reported `["de-DE", "de"]`:

| driven by `intl.accept_languages`            | driven by the UI/app locale (language pack)                   |
| -------------------------------------------- | ------------------------------------------------------------- |
| `navigator.language` / `navigator.languages` | `input.validationMessage`                                     |
| the `Accept-Language` header                 | XML / XSLT parser errors, pretty-print banner                 |
| **SVG `systemLanguage`**                     | `MediaDocument` titles, `ReportingObserver` bodies            |
|                                              | `parsererror` direction, `xsl:sort` collation, control labels |

The right-hand column is **weak evidence**. Those strings disagreeing with the reported language is a configuration a real user can produce — an English Firefox whose page-language preference is German does exactly that, with no extension involved. So the l10n mismatch looks worse than it is.

The left-hand column is the actual problem. All of it reads one preference, so those surfaces must agree on an untampered browser. GeoSpoof can change the first two (script and header) but not `systemLanguage`, which is resolved during layout. That mismatch cannot occur naturally, so it is a reliable tampering signal rather than a language signal.

**The fix is available to the user, and it is not a language pack.** Setting Firefox's page-language preference (Settings → General → Language → "Choose your preferred language for displaying pages") to match the Reported Language aligns `systemLanguage` and removes the only hard tell. A language pack would only repaint the right-hand column, which was never the strong signal. Users should be told the former; nothing requires the latter.

Aligning `navigator.language` with `Accept-Language` is what avoids the _self-contradiction_ that would be worse than not spoofing (see `docs/API.md`). It does not, and cannot, make the browser itself appear to be a different localization. A fingerprinter that cross-references the JS-reported language against these engine-level surfaces will see the mismatch.

### Timing Side-Channels

High-resolution timing via [`SharedArrayBuffer`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer) or [`performance.now()`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now) can measure the execution overhead of override functions. A native `getTimezoneOffset()` call completes in nanoseconds; a JavaScript override takes microseconds. Sufficiently motivated scripts can detect this discrepancy.

### Per-site variation

Per-site locations give different sites different locations and time zones. Each site sees one consistent identity, because every frame and worker in a tab follows the top-level page. A third party embedded on many sites (ad tech, analytics) sees more: one IP address and one device fingerprint whose time zone depends on which site it's embedded in. That combination is rare in real populations, so it can make a browser more distinctive to trackers that join visits by IP or fingerprint. Storage partitioning stops cookie-based joins, not these, and companies that own several sites can correlate them on their own servers.

Per-site locations are a compatibility and preference feature, not an anti-tracking one, and they don't change the IP address. Choosing per-site locations in the same time zone as the main location reduces the variation, and pairing each one with a VPN exit in the same place avoids the IP-versus-time-zone contradiction described in [Why Signal Consistency Matters](#why-signal-consistency-matters).

### Full Undetectability

True undetectability requires modifications at the browser engine level — patching the JavaScript runtime itself rather than its exposed APIs. This is the approach taken by [Tor Browser](https://www.torproject.org/) and [Mullvad Browser](https://mullvad.net/browser), both of which ship with hardened `about:config` profiles and engine-level patches. Extensions cannot achieve this level of protection.

GeoSpoof provides the strongest location spoofing available from an extension context. For adversarial threat models, a privacy-hardened browser is the appropriate tool.

---

## The W3C Geolocation API

The browser geolocation API is standardized by the [W3C Geolocation Working Group](https://www.w3.org/groups/wg/geolocation). The current specification is at [w3.org/TR/geolocation](https://www.w3.org/TR/geolocation/).

Relevant design decisions:

- **Permission model**: Sites must request user permission before accessing location data. GeoSpoof overrides [`navigator.permissions.query`](https://developer.mozilla.org/en-US/docs/Web/API/Permissions/query) to report `"granted"` when spoofing is active, preventing permission prompts from appearing.
- **Asynchronous design**: `getCurrentPosition` is callback-based. GeoSpoof introduces a 10–50ms delay in spoofed responses to match the timing profile of native geolocation calls.
- **Accuracy field**: The [`GeolocationCoordinates`](https://developer.mozilla.org/en-US/docs/Web/API/GeolocationCoordinates) object includes an `accuracy` field in meters. GeoSpoof returns a realistic value rather than zero, which would be an obvious tell.

---

## Further Reading

- [W3C Geolocation API Specification](https://www.w3.org/TR/geolocation/)
- [MDN: Using the Geolocation API](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API/Using_the_Geolocation_API)
- [Temporal API Proposal (TC39)](https://tc39.es/proposal-temporal/)
- [WebRTC IP Leak — BrowserLeaks](https://browserleaks.com/webrtc)
- [IANA Time Zone Database](https://www.iana.org/time-zones)
- [Arkenfox user.js — Firefox privacy hardening](https://github.com/arkenfox/user.js)
- [CreepJS — advanced fingerprinting detection](https://abrahamjuliot.github.io/creepjs/)
- [Tor Browser](https://www.torproject.org/) / [Mullvad Browser](https://mullvad.net/browser) — engine-level privacy hardening
