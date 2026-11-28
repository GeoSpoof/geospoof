# Privacy Policy for GeoSpoof

**Last Updated:** November 28, 2026

> This file mirrors the privacy policy at
> [geospoof.com/privacy](https://www.geospoof.com/privacy), which is the
> authoritative version. The two say the same thing; the only differences are
> phrases that depend on where you read them, such as "this website." This copy
> exists so the policy's history is public.

## The Short Version

GeoSpoof LLC ("GeoSpoof," "we," or "us") makes the GeoSpoof browser extension, the GeoSpoof app for iPhone, iPad, and Mac, the GeoSpoof GPS desktop app for Mac and Windows, and the website geospoof.com. This policy explains what personal data each of them handles.

- **No accounts, no ads, no tracking.** None of our products asks you to sign up, shows ads, or contains analytics or tracking code. The location you choose and the websites you visit are never sent to us.
- **What does reach us is limited** to ordinary web requests to servers we run, which carry your IP address and which we don't log; a record of each App Store purchase, which Apple sends us without your name or contact details; cookieless, aggregate visit counts on geospoof.com; and any email you send us.
- **We don't sell or share personal data**, and we don't use it for advertising.

The sections below give the details. Where a feature sends data to another company, we name the company.

## Who We Are

GeoSpoof LLC is a New York limited liability company in the United States. It is the controller, meaning the business responsible, for the personal data described in this policy. You can reach us at [support@geospoof.com](mailto:support@geospoof.com).

## Data That Stays on Your Device

**Browser extension.** Your settings are stored in your browser's extension storage (`browser.storage.local`), where only the extension can read them:

- the location you chose, its name (city and country), and its timezone
- your WebRTC protection, VPN sync, and Reported Language settings
- your Site Filters and per-site locations, and the site groups and lists from a link they use
- whether you've finished onboarding

In Safari, the extension and the GeoSpoof app pass your settings and Pro status to each other on your device. None of this is sent to us.

**GeoSpoof app (iPhone, iPad, and Mac).** Your settings and saved routes are stored on your device. The app has no access to your device's real location. If you're a founding user, the app saves a marker of that status in your own iCloud account (iCloud key-value storage and your private CloudKit database), so that your other devices signed in to the same iCloud account recognize it. The marker is filed under a one-way hash of the ID Apple gives your App Store account's download of GeoSpoof. Apple stores it for you under Apple's privacy policy, and we can't read it.

**GeoSpoof GPS (Mac and Windows).** The desktop app keeps its settings and a size-limited log on your computer. It works directly with your iPhone over a USB cable or your local network. It finds the phone on your network (Bonjour), reads the files the GeoSpoof app leaves for it (the location or route you chose, your Apple-signed Pro purchase proof, and what the Lock Screen route card needs), and writes back a status file that includes your computer's name. It checks your Pro purchase proof itself, on your computer. All of this stays between your own devices, except the Lock Screen route card updates described under "Services We Run." If you send us your log when asking for help, we see what it contains.

## Services We Run

Some features contact servers we operate. Like any web request, each request carries your IP address. We haven't turned on request logging for any of these servers, and we don't use the requests to track or identify you. The companies that host them process each request to deliver it and may keep their own short-term operational logs under their own policies.

**cdn.geospoof.com** (Amazon CloudFront and S3, in the United States) serves static files:

- **Timezone boundary data** (extension). To find the timezone of the location you chose, the extension downloads small pieces of a boundary file, using [browser-geo-tz](https://github.com/kevmo314/browser-geo-tz), and works out the timezone on your device. Your coordinates are never sent, but the pieces requested correspond to the region being looked up, so a request can reveal the approximate region of the location you chose. Your browser caches the data, so it is rarely downloaded again.
- **Site-group updates** (extension), only while one of your Site Filters or per-site locations uses a site group, or when you press **Update now**. About once a week the extension downloads a small pointer file and, when there's a newer release, the whole catalog of site groups (the public v2fly domain lists). The request is the same for every user and doesn't name the groups you picked. The GeoSpoof app makes no such request: it uses the copy it ships with.
- **Update checks.** GeoSpoof GPS checks here for new versions, and so does the Firefox version of the extension when installed from our website rather than from Mozilla's add-ons site. These are plain file downloads; they may tell the server which version you're running.

**push.geospoof.com** (Amazon API Gateway and Lambda, in the United States) keeps the GeoSpoof app's Lock Screen route card up to date while GeoSpoof GPS plays a route, which is a Pro feature. GeoSpoof GPS sends it:

- your Apple-signed Pro purchase proof, which the relay checks and then discards. Nothing about it is stored or logged.
- the card's push token, an address Apple issues for that one Lock Screen card
- the route's progress: distance travelled, total distance, time remaining, whether it's paused or finished, and an internal ID for the saved route. Never the route's name or points, and never your location.

The relay passes each update to Apple's push notification service, which delivers it to your phone. It keeps no record of your session or push token. It logs only failed requests, with a fixed set of fields (which request failed, the error, and Apple's status code, reason, and notification ID), never a token, purchase proof, or route detail, and deletes those logs after 14 days.

**geospoof.com** (Vercel, in the United States) is our website. See "The Website" below.

## Third-Party Services Our Products Contact

Some features send a request straight from your device to another company. We receive none of this data, and each company handles it under its own privacy policy.

**Nominatim (OpenStreetMap)** (extension only). Used when you search for a city in the extension, or when the extension looks up the name of a place from its coordinates. Sends your search text or those coordinates over HTTPS. [Privacy policy](https://wiki.osmfoundation.org/wiki/Privacy_Policy)

**VPN sync services**, used only when you turn on "Sync with VPN" or tap "Re-sync." GeoSpoof first detects your public IP address (normally your VPN's exit address), then looks up its approximate region. The extension detects it with `checkip.amazonaws.com` (AWS), `cloudflare.com/cdn-cgi/trace`, `whatismyip.akamai.com` (Akamai), and [ipify](https://www.ipify.org/) (`api.ipify.org`), in that order, moving on if one fails. The GeoSpoof app instead sends a STUN request, a standard network check, directly to Cloudflare and Google (`stun.cloudflare.com`, `stun.l.google.com`), with ipify as a fallback. The detected IP is then sent over HTTPS to up to four geolocation services at once; the first answer is used and the rest are cancelled. Only your IP is sent, with no identifiers, account data, or browsing history:

- [GeoJS](https://www.geojs.io/) (`get.geojs.io`)
- [FreeIPAPI](https://freeipapi.com/privacy) (`free.freeipapi.com`)
- ReallyFreeGeoIP (`reallyfreegeoip.org`)
- [ipinfo.io](https://ipinfo.io/privacy-policy) (`ipinfo.io`)

GeoSpoof keeps the detected IP only in memory for the current browser session and never writes it to disk. It is cleared as soon as you turn off "Sync with VPN" or switch to another way of setting your location.

**Apple Maps and geocoding** (GeoSpoof app only). When you type in the app's location search, the text is sent to Apple's MapKit service as you type, from the second character, so that Apple can suggest matching addresses and places. Choosing a suggestion fetches its coordinates and timezone from Apple. The built-in city list is searched on your device and works offline. The Pro route builder uses the same Apple service to search for places and plan paths between them. When you set a location from coordinates or the map, the app asks Apple's geocoding service (`CLGeocoder`) for the timezone at that point, and uses bundled offline data when you're offline. As with any request, Apple receives your IP address.

**Lists from a link**, only when you add one. When you add a list from a link, and then about once a week, the extension downloads that file directly from the host in the link, without cookies. The GeoSpoof app downloads it the same way, without cookies or credentials: when you add it, when a Sites screen shows it and the app's copy is a week old, or when you pull to refresh or tap **Update Now**. The host you chose receives your IP address and the request for that file. Matching sites against your lists happens entirely on your device; your lists and the sites you visit are never sent anywhere.

**Apple's platform services.** Purchases go through the App Store and StoreKit, Lock Screen card updates are delivered by Apple's push notification service, and the founder marker is stored in iCloud. Apple handles these under its [privacy policy](https://www.apple.com/legal/privacy/).

## Purchases and Pro

GeoSpoof Pro (a monthly or annual subscription, or a one-time Lifetime purchase) and optional tips are sold through Apple's In-App Purchase system. Apple handles billing, renewals, receipts, and refunds as an independent controller under its own privacy policy. **We never receive your name, email address, payment details, or Apple Account.**

**How Pro is checked.** The GeoSpoof app works out your Pro status on your device with Apple's StoreKit framework, including whether you're a founding user (from the version of the app your Apple Account first downloaded, through StoreKit's `AppTransaction`). GeoSpoof GPS and the Lock Screen relay each check Apple's signature on the proof the app gives them. None of these checks sends your status to us, and the purchase records below play no part in them.

**Purchase records we keep.** Whenever a Pro or tip purchase, renewal, refund, or other subscription event happens, Apple sends a signed App Store Server Notification to the geospoof.com server. The server checks Apple's signature, then uses the notification in two ways:

- **A message to our private Discord channel**, for sales, renewals, and refunds only. It shows the product, the price and currency, the App Store country, a short description of the event and its dates (such as "new subscriber" or the next renewal date), a short purchase reference, and the day's running totals. The reference is the first 12 characters of a one-way hash of Apple's original transaction ID for the purchase, not the ID itself. Messages posted before November 28, 2026 show the original transaction ID. The only other notification posted there is a test that we can ask Apple to send to check the connection; it shows only the running totals.
- **A revenue tally** in a database hosted by Upstash and connected through Vercel. It holds the date the tally started, each day's counts of sales, renewals, and refunds with their amounts per currency, the daily changes in the number of paying Monthly and Annual subscribers, and the net number of Lifetime purchases since the start (refunds and revocations subtracted). To count each subscription only once, it also keeps one record per Pro subscription or Lifetime purchase: the plan, whether it is paying, in a free trial, or ended, and the time of the latest event that updated it. Only a purchase, free-trial start, renewal, upgrade, redeemed offer, refund, reversed refund, or loss of access (such as an expired subscription) can update the record; other events, such as turning off auto-renew, don't. The record is filed under a one-way hash of Apple's original transaction ID, not the ID itself. Tips appear only in the day's totals.

**Morning summary.** Each morning the server downloads GeoSpoof's Sales and Subscription reports for the previous day from App Store Connect, Apple's portal for developers, and posts a summary to the same Discord channel: units sold per product, refunds, proceeds, and active subscriptions per plan. These reports contain totals, not individual purchases. The only figures the server keeps from them are the Monthly and Annual subscriber counts, which correct the tally.

**Exchange rates.** To show totals in approximate US dollars, the server fetches the day's exchange rates from [Frankfurter](https://frankfurter.dev/) and keeps them in the database for up to 4 days. The request asks only for the rates and carries no purchase or personal data.

**What these records can reveal.** Apple's original transaction ID identifies a purchase and contains no name or account details. Apple can link it to the Apple Account that made the purchase, and it can be found from the order ID on Apple's receipt email, so the hashes we keep are pseudonymous: they don't name you, but they can be connected to you. We set no account token (Apple's `appAccountToken`) on purchases, and Apple's notifications contain no name, email address, or Apple Account. Neither the Discord channel nor the database holds a name, email address, Apple Account, device identifier, or payment details.

**How long they're kept.** A Monthly or Annual subscription's record is kept until 400 days after the latest event that updated it. A Lifetime purchase's record has no expiry, so a refund years later can still be subtracted from the Lifetime count. The ID of each notification the tally counts or posts to Discord (Apple's `notificationUUID`) is kept for 30 days, so a notification Apple delivers twice is counted once and normally posted once. If the server, the database, or the connection to Discord fails partway through, the same message can occasionally be posted twice. Each day's totals of sales, renewals, and refunds are deleted within 3 days after the day ends. Each day's changes in paying Monthly and Annual subscribers are normally deleted by the morning summary about 9 days later; if the summary stops running, they stay until it runs again. The Lifetime count, the latest Monthly and Annual counts from Apple's reports, and the date the tally started have no expiry, and hold no per-purchase data. Discord messages stay in the channel until we delete them.

**Who handles them.** Apple sends the notifications and provides the reports. Vercel runs the website's server, Upstash hosts the database, and Discord hosts the channel (see the privacy policies of [Vercel](https://vercel.com/legal/privacy-policy), [Upstash](https://upstash.com/trust/privacy.pdf), and [Discord](https://discord.com/privacy)). Frankfurter receives no purchase data.

**Finding or deleting yours.** Email [support@geospoof.com](mailto:support@geospoof.com) with the order ID from Apple's receipt email. Because the records hold no name or contact details, that is how we find them.

## The Website

**Hosting.** Vercel serves geospoof.com. Like any web host, it processes each request, including your IP address and browser details, to deliver the page, and may keep short-term operational logs under [its privacy policy](https://vercel.com/legal/privacy-policy).

**Analytics.** The website uses [Vercel Web Analytics](https://vercel.com/docs/analytics/privacy-policy), a cookieless service that measures aggregate page views and traffic trends. It sets no cookies, doesn't track you across other websites, and doesn't build an advertising profile; the data is aggregated and isn't used to identify individual visitors. This applies to the website only, never to the extension or the apps. Beyond page views, the website counts two things:

- Clicks on the GeoSpoof GPS download buttons on **/gps**, with which build (Mac or Windows) and which button on the page.
- How a visit to the Safari setup page (**/activate**) ended: set up, location check failed, or opened in another browser. Each count carries the setup step the app asked for, which version of Safari's instructions was shown, and, once setup succeeds, roughly how long it took (under 5 seconds, a minute, 5 minutes, or longer).

These counts contain only which button or step it was. They never include your location, timezone, IP address, or anything you type. The setup page is part of the website, so it is the website that counts it; the app itself still sends nothing.

**Showing you your IP location.** A few pages show you what your network connection reveals about you: the leak detector (**/verify**), the Safari setup page (**/activate**), and the exposure prompt on the home page. To do that, the site reads your public IP address and the approximate city and country it maps to. This is normally worked out on our own server from information your connection already carries, so no other company is asked. When that isn't available, the page asks the same geolocation services listed under "VPN sync services" above. Either way, the result is shown to you and used for nothing else: it isn't stored, logged, or sent to us.

**Maps on the leak detector.** The map on **/verify** is drawn from map images that your browser downloads directly from CARTO (`basemaps.cartocdn.com`). CARTO receives your IP address and which area of the map is shown, under [CARTO's privacy notice](https://carto.com/privacy).

**Stored in your browser.** The website saves a few preferences in your browser's local storage, such as your color theme, banners you've dismissed, and whether you've dismissed the language suggestion, and sets one cookie that remembers whether a side menu is open. They exist only to remember your choices; we don't use them to identify or track you.

**Affiliate link.** GeoSpoof recommends **Proton VPN** through an affiliate link, which helps fund the project. The link opens Proton's website through a redirect on our own domain (`geospoof.com/go/proton/…`). The redirect collects no personal data and sets no cookies. Once you reach Proton's site, Proton and its affiliate network may process your data and set their own cookies under [Proton's privacy policy](https://proton.me/legal/privacy). If you subscribe through the link, we may earn a commission at no extra cost to you. We receive no personal information about you from Proton. GeoSpoof is independent and isn't affiliated with or endorsed by Proton.

**Feedback.** The website's feedback and support links open your own email app. Nothing is sent until you send the email.

## Emails You Send Us

Email sent to [support@geospoof.com](mailto:support@geospoof.com) is forwarded by our domain provider to the email service where we read it. We receive whatever you include: your email address, your name if your email shows it, your message, and any attachments, such as screenshots or logs. We use it only to answer you and to fix the problems you report. We keep a conversation for as long as it's useful for that and for our business records, and delete it sooner if you ask, unless we need to keep it for a legal reason.

If you open an issue on GitHub instead, it is public. Don't include personal details there.

## Information Apple and the Browser Stores Give Us

App Store Connect gives us aggregate figures such as downloads, sales, proceeds, and subscriber counts. If you've chosen to share analytics with app developers in your device's settings, Apple also gives us aggregate usage figures and crash reports, which contain technical details such as the device model and system version but not your identity. The browser extension stores give us similar aggregate counts for the extension. None of this identifies you to us.

## Who We Share Data With

We don't sell personal data or share it for advertising. The companies that handle data in connection with our products are the ones named in this policy:

- **Amazon Web Services**: cdn.geospoof.com and the Lock Screen relay
- **Vercel**: geospoof.com, its analytics, and its server
- **Upstash**: the purchase tally database
- **Discord**: our private sales channel
- **Apple**: App Store purchases, push delivery for the Lock Screen card, and iCloud
- **Our domain provider and email provider**: support email
- the third-party services described under "Third-Party Services Our Products Contact," which your device contacts directly

We may also disclose data if the law requires it, for example in response to a valid court order, or where needed to protect our rights or someone's safety. If GeoSpoof is ever sold or merged, the records described here could pass to the new owner, who would have to keep handling them as this policy describes.

## International Transfers

We're based in the United States, and the providers above process data there. If you're in the European Economic Area, the United Kingdom, or Switzerland, your data is therefore processed in a country whose laws may not protect it in the same way. Where our providers offer them, we rely on recognized safeguards, such as the EU–U.S. Data Privacy Framework and its UK and Swiss extensions, or the European Commission's standard contractual clauses.

## Legal Bases for Processing (EEA, UK, and Switzerland)

The EU and UK General Data Protection Regulation (GDPR) and the Swiss data protection act require a legal basis for each use of personal data. Ours are:

| What we do                                                         | Why                                                                              | Legal basis                                                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Serving files, update checks, and web pages                        | To deliver what your device asked for and keep our services working and secure   | Legitimate interests (Art. 6(1)(f))                                                              |
| Lock Screen route card updates                                     | To provide the Pro feature you use                                               | Performance of a contract (Art. 6(1)(b))                                                         |
| Checking Pro status, and the founder marker in your iCloud account | To give you the access you've paid for or earned                                 | Performance of a contract (Art. 6(1)(b))                                                         |
| VPN sync lookups                                                   | To match your chosen location to your VPN, as you asked                          | Consent (Art. 6(1)(a)), which you withdraw by turning off Sync with VPN                          |
| Purchase records                                                   | To keep accurate business records, track revenue, and handle refunds and support | Legitimate interests (Art. 6(1)(f))                                                              |
| Website analytics and counts                                       | To learn which pages and setup steps work, using cookieless, aggregate data      | Legitimate interests (Art. 6(1)(f))                                                              |
| Support emails                                                     | To answer you and fix what you report                                            | Legitimate interests (Art. 6(1)(f)), or performance of a contract when it concerns your purchase |

**Your right to object.** Where we rely on legitimate interests, you can object at any time, on grounds relating to your situation, by emailing [support@geospoof.com](mailto:support@geospoof.com). We'll then stop, unless we have compelling legitimate grounds that override your interests or need the data for a legal claim.

Withdrawing consent doesn't affect anything done with your consent before you withdrew it. You don't have to give us any personal data: our products work without an account. We don't make decisions about you by automated means, including profiling, that have legal or similarly significant effects.

## How Long We Keep Data

| Data                                                                  | How long                                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Web requests to cdn.geospoof.com, push.geospoof.com, and geospoof.com | Not stored by us. Amazon and Vercel may keep short-term operational logs under their own policies.                 |
| Lock Screen relay failure logs                                        | 14 days                                                                                                            |
| Purchase records                                                      | Subscriptions: 400 days after the latest update. Lifetime purchases: no expiry. Details under "Purchases and Pro." |
| Website analytics                                                     | Aggregate only, kept by Vercel under its policy                                                                    |
| Support emails                                                        | As long as useful to help you and for our business records; sooner if you ask                                      |
| Your IP address during VPN sync                                       | In memory only, for the browser session                                                                            |
| Data on your own devices and in your iCloud account                   | Until you delete it, or remove the extension or app                                                                |

## Your Rights

Wherever you live, you can ask us to:

- tell you what personal data we hold about you and give you a copy
- correct it
- delete it
- restrict how we use it, or object to our using it at all
- give it to you, or to another company, in a portable format
- stop using data you consented to, such as by turning off Sync with VPN

Most data our products touch is never stored by us, and you control what's on your devices directly: removing the extension or app, or turning off Sync with VPN, erases it. For anything else, email [support@geospoof.com](mailto:support@geospoof.com). We'll answer within one month, or tell you within that month if we need longer, as the law allows. Because our records hold no names, we'll ask only for details that let us find yours, such as the order ID from Apple's receipt email.

If you're in the EEA, the UK, or Switzerland, you also have the right to complain to your data protection authority (in Switzerland, the FDPIC). We'd appreciate the chance to sort out the problem first.

## US State Privacy Rights

Privacy laws in California and other US states give residents rights over their personal information. These laws may not apply to a business our size, but we follow them anyway. In the past 12 months we have collected these categories of personal information, from you or your device and from Apple, for the purposes in this policy:

- **Identifiers**: IP addresses in requests to our servers, the Lock Screen card's push token, and hashed purchase references
- **Commercial information**: the purchase records described under "Purchases and Pro"
- **Internet activity**: cookieless, aggregate website analytics
- **Communications**: the contents of emails you send us

We disclose them only to the companies listed under "Who We Share Data With," for the purposes in this policy. **We don't sell or share personal information** as those laws define it, including for cross-context behavioral advertising, and we don't knowingly handle the personal information of anyone under 16. We don't collect sensitive personal information, such as your precise location. You have the right to know, delete, and correct your personal information, and to opt out of its sale or sharing (we don't sell or share it, so there is nothing to opt out of). We won't treat you differently for using these rights. You, or an agent you authorize, can make a request at [support@geospoof.com](mailto:support@geospoof.com).

## Children

Our products aren't directed to children under 13, and we don't knowingly collect personal data from them. If you believe a child has sent us personal data, for example by email, contact us at [support@geospoof.com](mailto:support@geospoof.com) and we'll delete it.

## Security

- Our products' web requests use HTTPS. The one exception is the app's STUN check for VPN sync, a standard network check that carries nothing beyond what any connection reveals.
- There are no accounts or passwords to steal.
- Purchase records hold one-way hashes rather than Apple's IDs, and the database is protected by a secret access token.
- GeoSpoof GPS and the Lock Screen relay check every purchase proof against Apple's certificates, and the relay logs only a fixed set of fields.

If a security incident affects your personal data, we'll notify you and the relevant authorities where the law requires. For a vulnerability in the extension itself, we'll publish an advisory on GitHub and release a fix through the browser stores.

## Extension Permissions Explained

The extension asks for the following permissions. The exact set varies by browser, because some APIs don't exist on every engine, but the same principles apply everywhere.

- **storage**: to save your settings on your device
- **privacy** (Firefox and Chromium only): to apply WebRTC protection
- **proxy** (Firefox and Chromium only): to notice when a browser-based VPN switches exit location, so VPN sync can follow it. GeoSpoof only _observes_ proxy changes; it never sets or routes a proxy.
- **scripting**: to add the location overrides to pages
- **alarms**: to run periodic checks that keep the overrides active
- **idle** (Firefox and Chromium only): part of scheduling VPN sync re-checks
- **`<all_urls>` / access to all websites**: to apply location spoofing on every website you visit
- **webRequest permissions** (Firefox only): to close a timezone leak inside web workers at the network layer, and, when you turn on Reported Language, to set the language header (`Accept-Language`) your browser sends
- **userScripts** (Firefox only, optional): requested only when you turn on "Instant timezone protection," so the timezone override runs before a page's first script
- **declarativeNetRequestWithHostAccess** (Chromium and Safari): when you turn on Reported Language, to set the language header websites receive. It does nothing otherwise.
- **nativeMessaging** (Safari only): so the extension and the GeoSpoof app can exchange your settings and Pro status on your device
- **debugger** (Chrome and Chromium only): powers the optional "Engine-level Spoofing" mode, which is **off by default**. When you turn it on, GeoSpoof attaches to your tabs through Chrome's debugger interface to apply the timezone override deeper in the browser engine (using `Emulation.setTimezoneOverride`), so it also covers background workers and cross-site frames. In a tab where the mode is already active, it applies before a page's first script runs, unless that page's timezone differs from the previous page's. GeoSpoof uses this **only to set the timezone override**; it doesn't read page content, network traffic, passwords, or browsing history through it. While the mode is on, Chrome shows a "GeoSpoof started debugging this browser" notice, Chrome's standard warning for any extension using this interface, which disappears when you turn the mode off. Chrome doesn't allow this permission to be optional, but it does nothing unless you turn on Engine-level Spoofing, and it adds no install warning beyond the "access your data on all websites" prompt that site access already shows.
- **webNavigation** (Chrome and Chromium only): requested when you turn on Engine-level Spoofing, not at install. It lets GeoSpoof apply the timezone override when a navigation starts and again when it commits, which narrows the window in which a page can read your real timezone; it doesn't close it on a tab's first page. It is used only for this timing, not to record or send the pages you visit.

These permissions are used only to make the extension work, not to collect data.

## Why Safari Warns That GeoSpoof Can "Read and Alter Webpages"

When you turn on GeoSpoof, Safari shows a prompt similar to: "The extension 'GeoSpoof' would like to access [websites]. This extension will be able to read and alter webpages and see your browsing history on these websites. This could include sensitive information, including passwords, phone numbers, and credit cards."

**This warning is standard for any extension that runs on every site, and the websites Safari names are simply the tabs you happen to have open at that moment. GeoSpoof doesn't single them out and has no special interest in them.** Safari shows the same wording for ad blockers, password managers, and dark-mode extensions.

GeoSpoof needs access to every website because its job is to make every site you visit see your chosen location instead of your real one. To do that it must run a small script on each page that overrides the browser's location, timezone, and date APIs _before_ the page's own code runs. No narrower permission would let it do that site-wide.

**What "read and alter webpages" technically allows, and what GeoSpoof actually does:**

| Safari says it could                                               | What GeoSpoof actually does                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read page content (including passwords, form fields, credit cards) | Never reads form fields, passwords, page text, or any page content. The overrides only replace what location and time APIs return.                                                                                                                                                                                                                                                 |
| Alter webpages                                                     | Only "alters" the values returned by the Geolocation, `Date`, `Intl`, and Temporal APIs, and the reported language if you turn on Reported Language. It doesn't change page text, add ads, or rewrite content.                                                                                                                                                                     |
| See your browsing history                                          | Never reads, stores, or sends your history or the list of sites you visit.                                                                                                                                                                                                                                                                                                         |
| Send data elsewhere                                                | Sends nothing to us for collection or analytics. Its requests are the optional place-name and VPN sync lookups described above (only when you use those features), timezone boundary data from cdn.geospoof.com when a location is set, and, while you use them, site-group updates and lists from a link (see "Services We Run" and "Third-Party Services Our Products Contact"). |

The extension is open source, so you can check all of the above: [github.com/GeoSpoof/geospoof](https://github.com/GeoSpoof/geospoof)

**Which Safari option should you choose?**

- **Allow for One Day**: best for trying GeoSpoof out. Access expires automatically, so it's the lowest commitment.
- **Always Allow on Every Website**: most convenient if you want location protection everywhere without granting access again.
- **Allow or Always Allow on specific websites**: if you want spoofing only on certain sites, grant access site by site and leave the rest unprotected.
- **Deny**: GeoSpoof won't run on that site and can't spoof your location there.

You can change or revoke any of these at any time in **Safari → Settings → Extensions → GeoSpoof**, or site by site from the **AA** menu in the address bar on iPhone and iPad. Restricting access never deletes your settings; it only controls where spoofing can run.

## What GeoSpoof Doesn't Do

- **It isn't a VPN.** GeoSpoof doesn't use NetworkExtension or any VPN framework, and it doesn't route, tunnel, or inspect network traffic. "VPN" appears only in the optional Sync with VPN feature, which matches your browser's location to a VPN you already run.
- **It doesn't change your IP address.** Websites still see it unless you use a VPN.
- **It doesn't hide server-side signals.** Services can still estimate your location from your IP address, payment details, account history, and similar information.
- **It changes your browser's reported language only if you ask.** Reported Language is off unless you turn it on.

How you may use GeoSpoof is covered by our [Terms of Service](https://www.geospoof.com/terms).

## Changes to This Policy

We'll post any change on geospoof.com/privacy and update the date at the top. If a change is material, such as collecting a new kind of data or using data in a new way, we'll also note it in the release notes of the affected product before it takes effect. We won't use data we already hold in a materially different way without telling you first and, where the law requires it, asking for your consent. Earlier versions of this policy are in the history of this file.

## Contact

For questions about this policy, or to use any of your rights, email [support@geospoof.com](mailto:support@geospoof.com). You can also open an issue on [GitHub](https://github.com/GeoSpoof/geospoof), but issues there are public.

## Source Code

The browser extension's source code is public under the Apache License 2.0, in this repository, together with the code for cdn.geospoof.com and the Lock Screen relay, so you can check how they handle data. The GeoSpoof app, GeoSpoof GPS, and geospoof.com aren't open source; this policy describes how they handle data.
