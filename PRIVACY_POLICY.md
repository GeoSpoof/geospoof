# Privacy Policy for GeoSpoof

**Last Updated:** November 3, 2026

## Overview

GeoSpoof is committed to protecting your privacy. This extension is designed to enhance your location privacy and does not collect, store, or transmit any personal data to the extension developer.

**GeoSpoof does not implement VPN functionality.** It does not use NetworkExtension or any VPN framework, and it does not route, tunnel, or inspect network traffic. The word "VPN" appears only in reference to the optional "Sync with VPN" feature, which helps align your browser's reported location with the exit region of a third-party VPN you are already running.

## Data Collection

**The GeoSpoof extension does not collect any personal data.** It:

- Does NOT track your browsing activity
- Does NOT collect analytics or telemetry
- Does NOT store data on external servers
- Does NOT share data with third parties for advertising or marketing

The developer does keep records of App Store purchases, which reach the website's server from Apple, not from the extension or the app. See "In-App Purchases and Subscriptions" below.

## Website Analytics

The GeoSpoof browser extension and companion apps collect no analytics or telemetry, as described above. The GeoSpoof **website** (`geospoof.com`) — the marketing and documentation site — uses [Vercel Web Analytics](https://vercel.com/docs/analytics/privacy-and-compliance), a privacy-friendly, cookieless service that measures aggregate page views and traffic trends. It sets no cookies, does not track you across other websites, and does not build an advertising profile; the data is aggregated and is not used to identify individual visitors. This applies to the website only — never to the extension or apps, which remain analytics-free.

## Affiliate Links

GeoSpoof includes an affiliate link recommending **Proton VPN**, which helps fund the project. Following that link opens Proton's website through a redirect on the developer's own domain (`geospoof.com/go/proton/…`). **No personal data is collected when you click it** — the redirect performs no tracking and sets no cookies of its own.

Once you arrive on Proton's site, Proton and its affiliate network may process your data and set their own cookies under [Proton's privacy policy](https://proton.me/legal/privacy). If you subscribe through the link, the developer may earn a commission at no extra cost to you. The developer maintains no user accounts and receives no personal information about you from Proton. GeoSpoof is an independent project and is not affiliated with or endorsed by Proton.

## Local Data Storage

All extension settings are stored locally on your device using the browser's local storage API (`browser.storage.local`):

- Your spoofed location coordinates
- Your timezone preferences
- Resolved location name (city, country)
- WebRTC protection settings
- VPN sync preference
- Onboarding completion status

This data never leaves your device and is only accessible by the extension.

## Third-Party API Usage

When you use certain features, GeoSpoof communicates with external services. Both
the Safari extension and the companion app (iOS, iPadOS, macOS) may make these
requests, depending on which surface you're using. With one exception, none of
these requests reach a developer server, the developer receives none of this
data, and all such HTTPS requests go directly from your device to the third party
(the STUN requests below are direct UDP from your device). **The exception is the timezone boundary data
(section 2 below), which the extension fetches from the developer's own
content-delivery endpoint, `cdn.geospoof.com`.** See that section for what that
means for your IP address.

### 1. Location / place name resolution

**[Nominatim](https://nominatim.org/) (OpenStreetMap)** — _Extension only._
Used when you search for a city or the extension performs reverse geocoding.
Sends your search query (city name) or coordinates over HTTPS.
[OpenStreetMap Privacy Policy](https://wiki.osmfoundation.org/wiki/Privacy_Policy)

**Apple Maps and geocoding (MapKit, `CLGeocoder`)** — _Companion app only._
When you type in the app's location search, the text is sent to Apple's MapKit
service as you type, from the second character, so that Apple can suggest
matching addresses and places. Choosing a suggestion fetches its coordinates and
time zone from Apple. The built-in city list is searched on your device and
works offline. The Pro route builder uses the same Apple service to search for
places and plan paths between them. When you set a location from coordinates or
the map, the app asks Apple's geocoding service (`CLGeocoder`) for the time zone
at that point, and falls back to bundled offline boundary data when offline. The
app has no access to your device's location, so none is sent. As with any
network request, Apple receives your IP address. These requests are governed by
[Apple's Privacy Policy](https://www.apple.com/legal/privacy/), and the developer
receives none of this data.

### 2. Timezone boundary data

**[browser-geo-tz](https://github.com/kevmo314/browser-geo-tz) data, served from
`cdn.geospoof.com`** — _Extension only._ To resolve the correct IANA timezone
(e.g. `America/New_York`) for a location, the extension makes HTTPS range
requests to **`cdn.geospoof.com`** to download small chunks of geographic
boundary data, then performs the lookup locally on your device.
`cdn.geospoof.com` is the developer's own content-delivery endpoint — an Amazon
CloudFront distribution serving files from a private Amazon S3 bucket — and is
controlled by the developer, not a third party that receives your data for its
own purposes. (Older extension versions fetched the same data from
`geospoof.com`, hosted on Vercel; that path stays available for those installs
until they update. A public third-party CDN was used earlier but abandoned
because it truncated the dataset, silently breaking timezone resolution. The
move to CloudFront/S3 was made for reliability and hosting cost, not to change
what data is exposed — see below.)

**What hosting it ourselves means for your privacy:** because the request goes to
developer-controlled infrastructure, it carries your IP address (your real IP,
unless you are behind a VPN) like any ordinary web request, plus the specific
byte ranges requested. Those byte ranges correspond to the geographic region
being looked up, so the request can reveal your _approximate_ spoofed region.
Your coordinates are never sent as an explicit query. The developer does **not**
use these requests for analytics, tracking, profiling, advertising, or user
accounts, and stores no personal data from them. The developer has **not enabled
request (access) logging** on the CloudFront distribution; Amazon, as the
infrastructure operator, necessarily processes each request (including your IP
and the requested path) transiently in order to deliver the file and may retain
its own operational logs under its own policies. The IP is used only to deliver
the requested file. The boundary data is cached by your browser for a long
period, so after the first lookups the extension rarely needs to request it
again. (The companion app instead ships this boundary data inside the app, so it
never fetches it from cdn.geospoof.com. It asks Apple for a location's time zone
first, as described under Apple Maps and geocoding above, and uses the bundled
data when offline.)

### 3. VPN Sync (optional — only when you enable "Sync with VPN")

This feature never runs unless you have explicitly turned on "Sync with VPN" (or
tap "Re-sync"). It works in two steps — detect your current public (VPN exit) IP,
then look up the approximate region of that IP. **Only your public IP is
transmitted — no identifiers, account data, or browsing history.**

**Step 1 — public IP detection:**

- _Extension:_ tries, in order with failover, **AWS** (`checkip.amazonaws.com`),
  **Cloudflare** (`www.cloudflare.com/cdn-cgi/trace`), **Akamai**
  (`whatismyip.akamai.com`), and **[ipify](https://www.ipify.org/)**
  (`api.ipify.org`). Each simply returns your public-facing IP.
- _Companion app:_ uses **STUN** (a single UDP request) to **Cloudflare**
  (`stun.cloudflare.com`) and **Google** (`stun.l.google.com`) to discover the
  public IP, falling back to **ipify** (`api.ipify.org`) over HTTPS if STUN is
  blocked. STUN servers receive only the network request needed to report your
  public IP back to you.

**Step 2 — IP geolocation** (both extension and app), sent in parallel; first
successful response wins, the rest are cancelled:

- **[GeoJS](https://www.geojs.io/)** (`get.geojs.io`) — primary.
- **[FreeIPAPI](https://freeipapi.com/)** (`free.freeipapi.com`) — fallback.
  ([Privacy Policy](https://freeipapi.com/privacy-policy))
- **[ReallyFreeGeoIP](https://reallyfreegeoip.org/)** (`reallyfreegeoip.org`) — fallback.
- **[ipinfo.io](https://ipinfo.io/)** (`ipinfo.io`) — fallback.
  ([Privacy Policy](https://ipinfo.io/privacy-policy))

**Purpose:** to determine the geographic region of your VPN exit server so
GeoSpoof can set your spoofed location to match your VPN.

**Privacy safeguards:**

- All HTTPS requests are encrypted; STUN is a direct UDP round-trip to discover
  your IP.
- Your IP address is **never persisted to disk**. It is held only in an
  in-memory / session cache for the duration of your browser (or app) session.
- That cache is **cleared** when you disable VPN sync or switch to a different
  location input method.

> The IP these services see is typically your **VPN exit IP** (a shared address),
> not your home IP, because the whole point of the feature is that a VPN is
> already active.

## In-App Purchases and Subscriptions

The app offers paid options through Apple's In-App Purchase system:

- **GeoSpoof Pro** — _iOS, iPadOS, and macOS._ Unlocks Pro features such as automatic background VPN sync, per-site allowlist/denylist rules, widgets and controls, custom accuracy, the on-map location picker, and device-level GPS. Pro is available either as an auto-renewable subscription (monthly or annual), which renews automatically until cancelled and can be managed or cancelled anytime in your Apple Account settings, or as a **one-time "lifetime" purchase** (a non-consumable that unlocks the same features permanently and does not renew). Pro is a **Universal Purchase**, so a single purchase covers your iPhone, iPad, and Mac at no additional cost. A free, fully functional tier remains available without any purchase. Device-level GPS is the one Pro feature limited by platform: it sets the real system location of an iPhone or iPad, and is driven from the Mac app rather than applying to the Mac itself.
- **Tips** — _iOS, iPadOS, and macOS._ Optional one-time purchases that let you support development and unlock no features or functionality.

**All payments are processed by Apple via In-App Purchase. The developer never receives your name, email address, payment details, card information, or Apple Account identifier.** Billing, receipts, renewals, and refunds are handled entirely by Apple under its terms. That payment processing is governed by Apple's own privacy policy, and Apple acts as an independent data controller for it.

**How your Pro status is determined.** Your entitlement — whether you are a subscriber, a lifetime purchaser, or a grandfathered "founding" user — is resolved entirely on your device using Apple's StoreKit framework. Founder status is derived from your App Store purchase history (the original app version your Apple Account first downloaded) via StoreKit's `AppTransaction`; this needs no account, no sign-in, and no developer backend, and is read directly from Apple on-device. The resolved status is cached locally on your device only and is **never transmitted to the developer**, and GeoSpoof maintains no user accounts. The purchase records described below play no part in deciding your Pro access.

**Purchase records the developer keeps.** Whenever a Pro or tip purchase, renewal, refund, or other subscription event happens, Apple sends a signed App Store Server Notification to the GeoSpoof website's server (`geospoof.com`, hosted on Vercel). The server checks Apple's signature, then uses the notification in two ways:

- **A message to the developer's private Discord channel**, for sales, renewals, and refunds only. It shows the product, the price and currency, the App Store country (storefront), a short description of the event and its dates (such as "new subscriber" or the next renewal date), Apple's original transaction ID for the purchase, and the day's running totals.
- **A revenue tally** in a database hosted by Upstash and connected through Vercel. It holds the date the tally started, the day's counts of sales, renewals, and refunds and their amounts per currency, the daily changes in the number of paying Monthly and Annual subscribers, and the net number of Lifetime purchases since that date (refunds and revocations subtracted). To count each subscription only once, it also keeps a record for each Pro subscription or Lifetime purchase: the plan, whether it is paying, in a free trial, or ended, and the time of the latest event that updated it. Only a purchase, free-trial start, renewal, upgrade, redeemed offer, refund, reversed refund, or loss of access (such as an expired subscription) can update the record; other events, such as turning auto-renew off, don't. That record is filed under a one-way hash of Apple's original transaction ID, not the ID itself. In the tally, tips appear only in the day's totals.

**Morning summary.** Each morning the server downloads GeoSpoof's Sales and Subscription reports for the previous day from App Store Connect, Apple's portal for developers, and posts a summary to the same Discord channel: units sold per product, refunds, proceeds, and active subscriptions per plan. These reports contain totals, not individual purchases. The only figures the server keeps from them are the Monthly and Annual subscriber counts, which correct the tally.

**Exchange rates.** To show totals in approximate US dollars, the server fetches the day's currency exchange rates from [Frankfurter](https://frankfurter.dev/) and keeps them in the database for up to 4 days. The request asks only for the rates and carries no purchase or personal data.

**What the transaction ID is.** Apple's original transaction ID identifies a purchase and contains no name or account details, but Apple can link it to the Apple Account that made the purchase. The ID and its hash are therefore pseudonymous identifiers: they don't name you, but they can be linked to you with Apple's records. GeoSpoof sets no account token (Apple's `appAccountToken`) on purchases, and Apple's notifications contain no name, email address, or Apple Account identifier. Neither the Discord messages nor the database hold a name, email address, Apple Account identifier, device identifier, or card or payment-method details.

**How long purchase records are kept.** A Monthly or Annual subscription's record is kept until 400 days after the latest event that updated it. A Lifetime purchase's record has no expiry, so a refund years later can still be subtracted from the Lifetime count. The ID of each notification the tally counts (Apple's `notificationUUID`) is kept for 30 days, so a notification Apple delivers twice is counted once. The running totals hold no per-subscription data. Each day's totals of sales, renewals, and refunds are deleted within 3 days after the day ends. Each day's changes in paying Monthly and Annual subscribers are normally deleted by the morning summary about 9 days later. If the summary stops running, they stay until it runs again. The Lifetime count, the latest Monthly and Annual counts from Apple's reports, and the date the tally started have no expiry. Discord messages stay in the channel until the developer deletes them.

**Who handles these records.** Apple sends the notifications and provides the reports. Vercel runs the website's server, Upstash hosts the database, and Discord hosts the channel (see the privacy policies of [Vercel](https://vercel.com/legal/privacy-policy), [Upstash](https://upstash.com/trust/privacy.pdf), and [Discord](https://discord.com/privacy)). Frankfurter receives no purchase data.

**Asking about or deleting your records.** To ask what is held about your purchase, or to have it deleted, contact [support@geospoof.com](mailto:support@geospoof.com). Because the records contain no name or contact details, the developer can find yours only from details of the purchase that you provide, such as the order ID on Apple's receipt email.

## Permissions Explained

The extension requires the following permissions. Exact permissions vary slightly by browser (some APIs do not exist on every engine), but the principles below apply everywhere.

- **storage**: To save your settings locally on your device
- **privacy** (Firefox/Chromium only): To configure WebRTC protection settings
- **proxy** (Firefox/Chromium only): To detect when a browser-based VPN switches exit nodes so VPN Sync can re-align your spoofed location. GeoSpoof only _observes_ proxy changes — it never sets or routes a proxy.
- **scripting**: To inject the location-spoofing overrides into pages
- **alarms**: To run periodic health checks that keep the spoofing overrides active
- **idle** (Firefox/Chromium only): Part of the VPN-sync re-check scheduling
- **`<all_urls>` / host access to all websites**: To inject location spoofing on every website you visit
- **webRequest permissions** (Firefox only): To repair the timezone leak inside Web Workers at the network layer
- **debugger** (Chrome/Chromium only): Powers the optional "Engine-level Spoofing" mode. This mode is **off by default** and only runs if you turn it on. When enabled, GeoSpoof attaches to your tabs via Chrome's debugger interface to apply the timezone override deeper in the browser engine (using `Emulation.setTimezoneOverride`), so it also covers background workers and cross-site frames, and in a tab where the mode is already active it applies before a page's first script runs, unless that page's timezone differs from the previous page's. GeoSpoof uses this **only to set the timezone override** — it does not read page content, network traffic, passwords, or browsing history through it. While the mode is on, Chrome shows a "GeoSpoof started debugging this browser" notice; that is Chrome's standard warning for any extension using this interface, and the notice disappears when you turn the mode off. The permission is declared as required (Chrome does not allow it to be optional), but it does nothing unless you enable Engine-level Spoofing, and it adds no new install warning beyond the "access your data on all websites" prompt already covered by site access.
- **webNavigation** (Chrome/Chromium only): Requested at runtime (not at install) only when you enable Engine-level Spoofing. It lets GeoSpoof apply the timezone override when a navigation starts and again when it commits, which narrows the window in which a page can read your real timezone; it doesn't close it on a tab's first page. It is used solely for this timing and not to record or transmit the pages you visit.

These permissions are used solely for the extension's functionality and not for data collection.

### Why Safari warns that GeoSpoof can "read and alter webpages"

When you enable GeoSpoof, Safari shows a prompt similar to:

> "The extension 'GeoSpoof' would like to access [websites]. This extension will be able to read and alter webpages and see your browsing history on these websites. This could include sensitive information, including passwords, phone numbers, and credit cards."

**This warning is standard for any extension that runs on every site, and the specific websites Safari names are simply the tabs you happen to have open at that moment — GeoSpoof does not single them out and has no special interest in them.** Safari shows this same wording for ad blockers, password managers, and dark-mode extensions.

GeoSpoof needs broad website access because its only job is to make every site you visit see your chosen location instead of your real one. To do that it must run a small script on each page that overrides the browser's location, timezone, and date APIs _before_ the page's own code runs. There is no narrower permission that would let it spoof location site-wide.

**What "read and alter webpages" technically allows vs. what GeoSpoof actually does:**

| Safari says it _could_                                             | What GeoSpoof _actually_ does                                                                                                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read page content (including passwords, form fields, credit cards) | Never reads form fields, passwords, page text, or any page content. The overrides only replace location/time API return values.                                            |
| Alter webpages                                                     | Only "alters" the values returned by the Geolocation, `Date`, `Intl`, and Temporal APIs. It does not modify page text, inject ads, or rewrite content.                     |
| See your browsing history                                          | Never reads, stores, or transmits your history or the list of sites you visit.                                                                                             |
| Transmit data externally                                           | Sends nothing to the developer. The only outbound requests are the optional geocoding / VPN-sync API calls described above, and only when you actively use those features. |

The extension is open source, so you can verify all of the above:
[https://github.com/GeoSpoof/geospoof](https://github.com/GeoSpoof/geospoof)

**Which Safari permission option should you choose?**

- **Allow for One Day** — best for trying GeoSpoof out. Access expires automatically, so it's the lowest-commitment option.
- **Always Allow on Every Website** — most convenient if you want location protection everywhere without re-granting access.
- **Allow / Always Allow on specific websites** — if you only want spoofing on certain sites, grant access per-site and leave the rest unprotected.
- **Deny** — GeoSpoof will not run on that site (it cannot spoof your location there).

You can change or revoke any of these at any time in **Safari → Settings → Extensions → GeoSpoof**, or per-site from the **AA** menu in the address bar on iOS/iPadOS. Restricting access never deletes your settings — it only controls where spoofing is allowed to run.

## Data Security

- All settings are stored locally using the browser's secure storage API
- The extension transmits no data to the developer for collection, analytics, or profiling
- The one request that reaches developer-controlled infrastructure — fetching timezone boundary data from `cdn.geospoof.com` — is a static-file download that is not used to track or identify you (see "Third-Party API Usage")
- All third-party API calls use HTTPS encryption
- The developer maintains no user accounts, and `cdn.geospoof.com` (the timezone boundary data) serves only static files
- The website (`geospoof.com`) uses only cookieless, privacy-friendly analytics (see "Website Analytics"). The only personal data its server stores is the pseudonymous purchase records described under "In-App Purchases and Subscriptions", in an Upstash database protected by a secret access token

## Your Rights

You have complete control over your extension data:

- All settings can be cleared by disabling or removing the extension
- You can view all stored data in your browser's extension storage inspector
- No account or registration is required
- Removing the extension or the app doesn't affect the purchase records described under "In-App Purchases and Subscriptions". To ask about or delete yours, contact [support@geospoof.com](mailto:support@geospoof.com)

## For Users in the European Economic Area, United Kingdom, and Switzerland

If you are located in the EEA, UK, or Switzerland, the following applies to you in addition to the rest of this policy.

**Controller:** GeoSpoof LLC, a New York limited liability company based in the United States, acts as the data controller for any personal data processed by this extension. You can contact the controller at [support@geospoof.com](mailto:support@geospoof.com).

**Legal basis for processing:** Two kinds of personal data may be processed by the extension, both limited to your public IP address. (1) When you explicitly enable the "Sync with VPN" feature, your public IP is sent to the IP-detection and geolocation services listed above; we rely on your consent (GDPR Art. 6(1)(a)), which you give by enabling the feature and can withdraw at any time by disabling "Sync with VPN" in the extension popup. (2) Whenever the extension resolves a timezone, it fetches boundary data from `cdn.geospoof.com`, which — like any web request — transmits your IP to the developer's content-delivery host (Amazon CloudFront/S3); we rely on legitimate interests (GDPR Art. 6(1)(f)) in delivering the boundary data needed for the location-spoofing you requested, and the IP is used only to serve the file and is not retained or otherwise processed by the developer. Withdrawing consent does not affect the lawfulness of processing based on consent before its withdrawal.

**International transfers:** The third-party services listed above (AWS, Cloudflare, Akamai, ipify, GeoJS, FreeIPAPI, ReallyFreeGeoIP, ipinfo.io, Google STUN, Nominatim, and, for the companion app, Apple's MapKit and geocoding services) are operated outside the EEA, including in the United States; each is an independent controller and determines its own transfer mechanisms. Separately, the timezone boundary data is served from the developer's own domain `cdn.geospoof.com`, hosted on Amazon Web Services (CloudFront/S3), whose infrastructure is also located outside the EEA, including in the United States. (Older extension versions that still fetch from `geospoof.com` use the developer's Vercel host, likewise located in the United States.) When you use features that contact any of these endpoints, your public IP is transferred to that infrastructure. Apart from that static boundary data, the extension sends nothing to a developer server. The purchase records described under "In-App Purchases and Subscriptions" are handled by Vercel, Upstash, and Discord, which are United States companies, so those records may be processed outside the EEA, including in the United States.

**Your rights under GDPR / UK GDPR:** you have the right to access, rectify, erase, restrict, object to, and port your personal data, and to withdraw consent at any time. Because the extension stores no personal data on any server controlled by the developer, most of these rights are exercised directly by you within the extension: uninstalling the extension or disabling "Sync with VPN" fully erases everything the extension holds. The purchase records described under "In-App Purchases and Subscriptions" are the exception: to access or erase yours, contact [support@geospoof.com](mailto:support@geospoof.com). You also have the right to lodge a complaint with your local data protection authority.

**Retention:** Your public IP is held only in volatile memory for the current browser session and cleared when you disable the feature or close your browser. No retention period applies to it because no storage occurs. Purchase records are kept for the periods given under "In-App Purchases and Subscriptions".

## For California Residents

If you are a California resident, the California Consumer Privacy Act (CCPA), as amended by the California Privacy Rights Act (CPRA), gives you specific rights regarding your personal information.

**We do not sell or share your personal information** as those terms are defined under the CCPA/CPRA. We do not disclose personal information for cross-context behavioral advertising. We do not knowingly handle the personal information of consumers under 16.

**Categories collected:** The only category of personal information touched by the extension is an internet identifier (your public IP address). This happens in two cases: when you enable "Sync with VPN" (sent to the IP-detection and geolocation services), and when the extension fetches timezone boundary data from `cdn.geospoof.com` (your IP reaches the developer's content-delivery host, Amazon CloudFront/S3, as part of an ordinary web request). In both cases the IP is used only for the purposes described above and is not retained by the developer. Separately, the website receives and keeps the purchase records described under "In-App Purchases and Subscriptions".

**Your rights:** You have the right to know what personal information is collected, the right to delete personal information, the right to correct inaccurate personal information, the right to opt out of sale or sharing (there is nothing to opt out of here), and the right not to receive discriminatory treatment for exercising these rights. The extension retains no personal information, so for it these rights are effectively exercised by uninstalling the extension or disabling the feature. For the purchase records, or any other inquiry, contact [support@geospoof.com](mailto:support@geospoof.com).

## Children's Privacy

GeoSpoof is not directed to children under 13, and we do not knowingly collect personal information from children under 13. If you believe a child under 13 has used the extension in a way that caused personal information to reach a third-party service referenced above, please contact us at [support@geospoof.com](mailto:support@geospoof.com) and we will take reasonable steps to assist.

## Security Incidents

The extension stores no personal data on any developer-operated server. The one developer-side database is the website's purchase tally (see "In-App Purchases and Subscriptions"); it and the Discord channel hold no names, email addresses, or card or payment-method details. In the unlikely event of a security issue affecting the extension itself (for example, a vulnerability in the extension code), we will publish an advisory on the project's GitHub page and release a patched version through the relevant browser stores. Where required by applicable law, we will notify affected users and the relevant data protection authority.

## Changes to This Policy

If this privacy policy changes, the updated version will be posted in the extension's repository and on the GeoSpoof website. The "Last Updated" date will be revised accordingly. Continued use of the extension after changes are posted constitutes your acceptance of the updated policy.

## Contact

For questions or concerns about this privacy policy:

- Email: [support@geospoof.com](mailto:support@geospoof.com)
- GitHub: [https://github.com/GeoSpoof/geospoof](https://github.com/GeoSpoof/geospoof)

## Open Source

GeoSpoof is open source. You can review the complete source code to verify these privacy practices:

[https://github.com/GeoSpoof/geospoof](https://github.com/GeoSpoof/geospoof)

## Important Disclaimers

### What This Extension Does NOT Do

- **Does NOT implement VPN functionality** - No NetworkExtension, no tunneling, no traffic interception
- **Does NOT change browser language or locale settings** - Your browser's language preferences remain unchanged, which may create detectable inconsistencies with your spoofed location
- **Does NOT spoof IP address** - Your real IP address is still visible to websites unless you use a VPN
- **Does NOT bypass server-side detection** - Websites can still detect your location through IP address, payment methods, account history, and other server-side signals

### Terms of Service Compliance

Using location spoofing may violate the terms of service of certain websites, particularly:

- Streaming services (Netflix, HBO Max, Disney+, etc.)
- Financial services
- E-commerce platforms with region-specific pricing

**You are responsible for ensuring your use of this extension complies with applicable terms of service and laws.** The extension developer is not liable for any violations or consequences resulting from your use of this extension.

### Intended Use

This extension is intended for:

- Privacy protection and testing
- Web development and testing
- Educational purposes
- Legitimate privacy enhancement

This extension is NOT intended for:

- Circumventing geo-restrictions on copyrighted content
- Fraud or deception
- Violating terms of service agreements

I absolutely **do not endorse any illegitimate or illegal use of this tool** whatsoever. Use responsibly and in accordance with local laws and regulations.
