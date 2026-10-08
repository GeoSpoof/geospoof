# Chrome Web Store Listing — GeoSpoof

This file tracks the store listing copy. Where each field lives:

| Field                                 | Source of truth                                      | Notes                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Title** (`name`)                    | `src/build/manifest.ts` (chromium override)          | Baked into the build. Max 75 chars.                                                                                    |
| **Short description** (`description`) | `src/build/manifest.ts` (chromium override)          | Baked into the build. Max 132 chars; shown under the name and in search results.                                       |
| **Detailed description**              | Chrome Web Store Developer Dashboard (paste by hand) | No manifest field exists for it. The copy below is the source of truth — paste it into the dashboard on each revision. |

ASO note: Chrome's [listing policy](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements)
bans keyword spam. The practical ceiling is ~5 repetitions per keyword. Counts
below stay within that: `geolocation` = 5, `location changer/changers` = 3,
`GPS` = 3. Do not push these higher when editing.

---

## Title (manifest `name` — 38 chars)

```
GeoSpoof: Spoof Geolocation & Timezone
```

The "&" joins two different things you spoof (geolocation & timezone), so it
reads cleanly with no "location…location" repetition. Leads with the exact
"spoof geolocation" query; the location-changer intent is carried by the
description body (at the keyword cap there), not the title. Alternatives if you
ever want the location-changer query in the title instead:

```
GeoSpoof: Geolocation Spoofer & Location Changer   (parallel nouns; keeps exact "location changer", drops exact "spoof geolocation")
GeoSpoof: Spoof Geolocation & Change Location       (parallel verbs; repeats "location")
```

## Short description (manifest `description` — 123 chars)

```
Spoof geolocation, fake your GPS location & timezone — change your location to any city or sync it to your VPN. No account.
```

---

## Detailed description (paste into the Web Store dashboard — plain text)

🛡️ Spoof geolocation, timezone, and every location signal — in one click.

GeoSpoof is a privacy-first geolocation spoofer and location changer for Chrome. Flip one switch and every site reads the fake location you choose, not where you really are.

A basic location changer just moves the map pin. GeoSpoof goes further — it aligns your timezone, blocks WebRTC IP leaks, and auto-syncs to your VPN, so every signal matches your chosen spot.

Pick a city, type exact coordinates, or let GeoSpoof match your VPN automatically. Turn it off anytime and your real position returns untouched.

⭐ Why people choose GeoSpoof over a basic location changer

1️⃣ Set a fake GPS location in one click — any city or exact coordinates.
2️⃣ VPN Sync — detect your VPN's exit region and match your location to it.
3️⃣ Auto background sync — switch VPN servers and your location follows automatically.
4️⃣ Timezone too — clock and date match your location, so nothing gives you away.
5️⃣ Block WebRTC leaks — keep your real IP hidden, even behind a VPN.
6️⃣ Engine-level spoofing — deeper coverage that reaches workers and loads before the page.
7️⃣ Anti-fingerprinting — every signal stays consistent, so your location holds up.
8️⃣ Per-site control — allowlist or denylist which sites get spoofed.
9️⃣ Save favorites — pin up to 10 places, switch in a tap.
🔟 No account, no tracking, no analytics — everything stays on your device.

📍 Set your fake location any way you like

▸ Search by city or address and land on the exact spot.
▸ Enter precise latitude and longitude by hand for a clean GPS fix.
▸ Tune accuracy, from realistic to a custom meter value.
▸ Save the places you use most and reuse them instantly.

🌍 Spoof geolocation with or without a VPN

A VPN changes your IP. GeoSpoof rewrites the coordinates your browser reports through the geolocation API — and can sync the two together.

Run it solo, or pair it with your VPN so your IP, location, and timezone all tell the same story.

🔒 Privacy comes first

🔹 Everything runs on your device — GeoSpoof never sends your real location to a server.
🔹 No account, no tracking, no analytics. Settings live locally.
🔹 Open source — review exactly what it does on GitHub.
🔹 Turn protection off and your genuine coordinates return untouched.

💡 Who it's for

◆ Privacy-minded people who don't want sites logging where they are.
◆ Developers testing location, timezone, and region features.
◆ Anyone reaching region-specific content and services.
◆ VPN users who want their browser location to match their exit node.

❓ FAQ

📌 Will sites still see my real location?
💡 No. While protection is on, the browser returns the spot you picked.

📌 Is this a VPN?
💡 No. GeoSpoof changes the coordinates your browser reports, not your IP. It pairs perfectly with a VPN and can even sync to it automatically.

📌 Can I set an exact point?
💡 Yes. Enter precise latitude and longitude, or search a city, for a clean GPS spoof.

📌 Does it change my timezone too?
💡 Yes. GeoSpoof spoofs your timezone alongside your location so the two always match — a giveaway that location-only changers miss.

📌 Is this just a location changer?
💡 It's a location changer and more. GeoSpoof sets a fake location, then also matches your timezone and blocks WebRTC leaks so nothing contradicts it.

📌 Does it work on Google Maps?
💡 Yes. GeoSpoof works on any site that uses the browser geolocation API.

📌 Is my data safe?
💡 Yes. GeoSpoof runs locally, collects nothing, and is open source. Nothing about your location leaves your device.

📌 Do I need to sign up?
💡 No account and no setup. Install and start changing your location right away.

📲 Now on iPhone, iPad & Mac too.

Install GeoSpoof, set a fake location, and decide exactly what the web sees about where you are.

Links:
— geospoof.com
— github.com/GeoSpoof/geospoof

---

# Firefox Add-on Listing (AMO) — GeoSpoof

AMO field sources:

| Field                    | Source of truth                                                                  | Notes                                                                                                                                                                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**                 | `_locales/en/messages.json` (`extensionName`) → manifest `__MSG_extensionName__` | "GeoSpoof". Localized per-locale.                                                                                                                                                                                                                                                        |
| **Summary**              | `_locales/en/messages.json` (`extensionDescription`)                             | Leads with the WebRTC value prop.                                                                                                                                                                                                                                                        |
| **Detailed description** | AMO Developer Hub (paste by hand)                                                | **Markdown**, not HTML. AMO dropped HTML support in March 2025 (https://blog.mozilla.org/addons/2025/03/03/markdown/). Supported: bold, italic, monospace, links, abbreviations, code blocks, blockquotes, ordered/unordered lists. **No headings** — use bold lines for section titles. |

Differences vs. the Chrome detailed description:

- Real Markdown formatting (bold headers, numbered/bulleted lists, inline links).
- Feature 6 is Firefox's worker-level timezone protection + optional Instant
  timezone protection (`userScripts`), not Chrome's debugger-based Engine-level
  Spoofing.
- WebRTC is emphasized (matches the Firefox `extensionDescription`).
- Same keyword discipline: geolocation = 5, location changer = 3, GPS = 3.

## Detailed description (paste into AMO — Markdown)

**🛡️ Spoof geolocation, timezone, and every location signal — in one click.**

GeoSpoof is a privacy-first **geolocation spoofer** and **location changer** for Firefox. Flip one switch and every site reads the fake location you choose, not where you really are.

A basic location changer just moves the map pin. GeoSpoof goes further — it aligns your **timezone**, blocks **WebRTC IP leaks**, and auto-syncs to your **VPN**, so every signal matches your chosen spot.

Pick a city, type exact coordinates, or let GeoSpoof match your VPN automatically. Turn it off anytime and your real position returns untouched.

**⭐ Why people choose GeoSpoof over a basic location changer**

1. **Set a fake GPS location in one click** — any city or exact coordinates.
2. **VPN Sync** — detect your VPN's exit region and match your location to it.
3. **Auto background sync** — switch VPN servers and your location follows automatically.
4. **Timezone too** — clock and date match your location, so nothing gives you away.
5. **Block WebRTC leaks** — keep your real IP hidden, even behind a VPN.
6. **Worker-level timezone protection** — closes worker and cold-start leaks, with optional first-script coverage.
7. **Anti-fingerprinting** — every signal stays consistent, so your location holds up.
8. **Per-site control** — allowlist or denylist which sites get spoofed.
9. **Save favorites** — pin up to 10 places, switch in a tap.
10. **No account, no tracking, no analytics** — everything stays on your device.

**📍 Set your fake location any way you like**

- Search by city or address and land on the exact spot.
- Enter precise latitude and longitude by hand for a clean GPS fix.
- Tune accuracy, from realistic to a custom meter value.
- Save the places you use most and reuse them instantly.

**🌍 Spoof geolocation with or without a VPN**

A VPN changes your IP. GeoSpoof rewrites the coordinates your browser reports through the geolocation API — and can sync the two together.

Run it solo, or pair it with your VPN so your IP, location, and timezone all tell the same story.

**🔒 Privacy comes first**

- Everything runs on your device — GeoSpoof never sends your real location to a server.
- No account, no tracking, no analytics. Settings live locally.
- _Open source_ — review exactly what it does on [GitHub](https://github.com/GeoSpoof/geospoof).
- Turn protection off and your genuine coordinates return untouched.

**💡 Who it's for**

- Privacy-minded people who don't want sites logging where they are.
- Developers testing location, timezone, and region features.
- Anyone reaching region-specific content and services.
- VPN users who want their browser location to match their exit node.

**❓ FAQ**

📌 **Will sites still see my real location?** No. While protection is on, the browser returns the spot you picked.

📌 **Is this a VPN?** No. GeoSpoof changes the coordinates your browser reports, not your IP. It pairs perfectly with a VPN and can even sync to it automatically.

📌 **Can I set an exact point?** Yes. Enter precise latitude and longitude, or search a city, for a clean GPS spoof.

📌 **Does it change my timezone too?** Yes. GeoSpoof spoofs your timezone alongside your location so the two always match — a giveaway that location-only changers miss.

📌 **Is this just a location changer?** It's a location changer and more. GeoSpoof sets a fake location, then also matches your timezone and blocks WebRTC leaks so nothing contradicts it.

📌 **Does it work on Google Maps?** Yes. GeoSpoof works on any site that uses the browser geolocation API.

📌 **Is my data safe?** Yes. GeoSpoof runs locally, collects nothing, and is open source. Nothing about your location leaves your device.

📌 **Do I need to sign up?** No account and no setup. Install and start changing your location right away.

**📲 Now on iPhone, iPad & Mac too.**

Install GeoSpoof, set a fake location, and decide exactly what the web sees about where you are.

Links:

- [geospoof.com](https://geospoof.com)
- [GitHub](https://github.com/GeoSpoof/geospoof)

---

# App Store Listing (iOS / iPadOS / macOS) — GeoSpoof

**ASO model is different from Chrome/AMO.** Apple does NOT index the description
for search. Only three fields feed App Store search ranking:

| Field                | Limit      | Role                                                                                                                              |
| -------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **App name**         | 30 chars   | Highest-weighted search field.                                                                                                    |
| **Subtitle**         | 30 chars   | High-weighted search field. Use keywords NOT in the name.                                                                         |
| **Keywords**         | 100 chars  | Hidden, comma-separated, NO spaces. Use tokens NOT in name/subtitle — Apple combines tokens across all three fields into phrases. |
| **Promotional text** | 170 chars  | Above the description; updatable without review. Not indexed.                                                                     |
| **Description**      | 4000 chars | Conversion copy only — NOT indexed. Do not keyword-stuff.                                                                         |

> **Source of truth for the App Store listing is `app/fastlane/metadata/<locale>/` in the
> private `geospoof-ios` repo**, not this file. `fastlane deliver` uploads that tree
> directly, so the hand-paste step is gone. Twelve locales ship: `en-US`, `de-DE`,
> `es-ES`, `fr-FR`, `id`, `ja`, `nl-NL`, `pt-BR`, `ru`, `sv`, `vi`, `zh-Hans`. Field
> limits are enforced by `tests/unit/appstore-metadata-parity.unit.test.ts` there.
>
> The sections below keep the **English ASO reasoning** — why each token was chosen — which
> the `.txt` files have nowhere to record. Chrome and AMO above have no automation path and
> remain hand-pasted from this file.
>
> Localization note: the four short fields were **authored per locale, not translated.**
> English uses 87–100% of every short-field budget, so a translated subtitle overflows in 9
> of 11 languages and a translated promo text in 8 of 11. Keyword sets were built from terms
> already shipped in `_locales/<locale>/messages.json` and are **not** volume-validated —
> run them through a keyword tool before treating them as final.

Apple auto-handles singular/plural and forms phrases by combining tokens across
name + subtitle + keywords, so never repeat a word across those fields.

## App name (26 chars)

```
GeoSpoof: Location Changer
```

Captures the higher-volume "location changer" query; "location spoofer" is still
formed by combining with the `spoof` keyword token. Alternatives:

```
GeoSpoof - Fake GPS Location   (higher-volume "fake gps" query, but still risky — device GPS exists only as a Pro feature that needs the Mac companion, so a "Fake GPS" name over-promises for free/iPhone-only users and pulls game-cheat installs)
GeoSpoof: Spoof Location       (shorter; "spoof location")
```

## Subtitle (30 chars — at the hard limit, zero headroom)

```
GPS, Safari & Timezone Spoofer
```

`Spoofer` moved here from the name, so name + subtitle together still form both
"location changer" and "location spoofer".

**GPS leads, deliberately — decided, do not silently revert.** An earlier revision
of this file argued for `Safari` first, on the grounds that leading with GPS invites
the wrong installs and the 1-star "doesn't work in Pokémon GO" reviews. That
reasoning is on the record and was overruled: GPS is the higher-intent query and
the differentiator worth ranking for.

The honesty work that `Safari`-first was doing is instead carried by the
description, which states plainly that Device GPS is Pro, Experimental, and needs
a Mac companion. If wrong-fit installs or AR-game reviews show up, that's the
signal to revisit — not a style preference.

All 11 localized subtitles lead with `GPS` too, verified by
`tests/unit/appstore-metadata-parity.unit.test.ts`. Two needed rewording to get
there: German was `Safari-GPS & Zeitzone fälschen` and Swedish was
`Spoofa GPS, Safari & tidszon`.

## Keywords field (100 chars — no spaces, no name/subtitle repeats)

```
fake,spoof,geolocation,vpn,teleport,region,virtual,mock,coordinates,privacy,map,emulator,hide,change
```

Reasoning notes:

- `spoof` is included on purpose. "Spoofer" (name) → "spoof" is a derivational
  change, NOT a singular/plural pair, and Apple only reliably matches
  singular↔plural. So the standalone `spoof` token is what actually earns
  "spoof location" / "spoof gps".
- `change` (same logic vs. "Changer") captures the high-volume "change location",
  "change gps", "change timezone" queries.
- `geolocation` stays so "spoof geolocation" can still form, without spending
  title characters on the low-volume `geolocation` token.
- Deliberately excluded: `faker` (low search volume; "fake \_\_\_" phrases already
  covered by `fake`), and `ip` (would imply IP-changing, which contradicts the
  "not a VPN" scope and pulls the wrong installs).

Phrases Apple can form by combining with name/subtitle tokens: location spoofer,
location changer, change location, fake location, spoof location, fake gps,
spoof gps, gps location, location privacy, hide location, vpn location, fake gps,
spoof geolocation, location emulator, teleport location.

## Promotional text (143 chars)

```
NEW — GeoSpoof GPS moves your iPhone's GPS to your chosen location, driven from a Mac companion app. A Pro feature; Safari spoofing stays free.
```

Plain text only — App Store promotional text renders **no** markdown.

🔴 **Live defect, confirmed:** App Store Connect currently holds
`**NEW** — GeoSpoof GPS moves…`, so customers are seeing literal asterisks on the
product page right now. The `.txt` files in `fastlane/metadata/` are already
correct (plain `NEW —`), so a metadata push fixes it.

Promotional text is one of the fields editable **without submitting a new version**
(`deliver`'s `LOCALISED_LIVE_VALUES`), so this can also be corrected by hand in
App Store Connect immediately, independently of the localization rollout. Worth
doing that rather than waiting.

Not indexed and updatable without review, so this is the place to announce
GeoSpoof GPS (device-level location). Rotate the previous Auto Background Sync
line back in later if you want:

```
NEW Auto Background Sync: switch VPN servers and your Safari location follows automatically — no manual re-sync, no need to open the app.
```

## Description

**Lives in `app/fastlane/metadata/en-US/description.txt` in the private `geospoof-ios`
repo** — edit it there, not here, so the uploaded copy and the reviewed copy can't
diverge. 2654 of 4000 chars; German, the longest translation, lands at 3115.

Structural notes for whoever edits it next:

- Blank lines between bullets are **intentional**. The App Store renders line breaks
  literally, so they produce real vertical spacing. The parity test asserts every
  translation keeps the same paragraph and bullet counts as English.
- The SUBSCRIPTIONS block is required by Guideline 3.1.2: billing period, renewal
  terms, cancellation window, and functional EULA + privacy links. The test asserts
  both links survive in all 12 locales.
- `GeoSpoof Pro Monthly / Annual / Lifetime` are **also IAP display names**. The
  localized descriptions translate the period word and keep `GeoSpoof Pro` as brand
  (`GeoSpoof Pro Monatlich`), matching the app's own `Monthly`/`Annual`/`Lifetime`
  catalog strings. **The ASC in-app purchase display names must be set to match** —
  they currently have zero localizations, so today a German reader sees a translated
  name in the listing and an English one at the paywall.

The stale version previously inlined here opened with "Your VPN changes your IP
address…" and claimed "33,000+ cities"; neither is in the live copy. It also had no
SUBSCRIPTIONS block, which Guideline 3.1.2 requires. It has been removed rather than
updated in place — keeping a second copy here is what let it drift in the first place.

## Screenshot copy

Lives in `assets/store-listings/appstore/screenshot-copy.md` — the headlines
burned into the screenshot images, in all 12 locales.

## macOS listing

Not written yet. `app/fastlane/metadata/` in `geospoof-ios` holds the iOS copy at its root.

The iOS description can't be reused as-is: it casts the Mac app as the companion
("requires the free GeoSpoof GPS companion app for Mac"), which is backwards on the
Mac listing, where that app is the thing being installed. Same App Store record,
separate per-platform listings, so this needs its own copy.

⚠️ **Do not add it as `fastlane/metadata/macos/`.** `deliver` validates every
directory inside `metadata_path` against its list of App Store locales and aborts on
anything else — and it does that **even when `skip_metadata: true`**, so a platform
subfolder breaks routine binary-only uploads with `Unsupported directory name(s)`.
That failure shipped once and broke a release build. macOS copy goes in a sibling
tree (e.g. `fastlane/metadata-macos/`) with an explicit `metadata_path:` on the macOS
lane only. `tests/unit/appstore-metadata-parity.unit.test.ts` fails on any
non-locale directory under `fastlane/metadata/` to keep this from recurring.
