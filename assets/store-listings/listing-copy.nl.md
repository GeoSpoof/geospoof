# Store Listing Copy — Dutch

Dutch copy for the Chrome Web Store and AMO. It mirrors the English copy in
[`listing-copy.md`](listing-copy.md), section for section, with the same emoji. The
terms follow `_locales/nl/messages.json` (vervalsen, geolocatie, tijdzone, Sync met VPN,
Sites, Filters, Filtermodus, Alle sites／Toestaan／Blokkeren with the lists Toegestane
sites／Blokkeerlijst, Locaties per site, Hoofdlocatie, Locatie willekeurig maken,
Sitegroep, Alleen exact adres, Lijst via een link, Spoofing op engineniveau, Directe
tijdzonebescherming) and its informal "je". It was written from the English, not
translated through another language, and **still needs review by a native speaker**.
When the English copy changes, update this file in the same commit.

## Where each field comes from

| Store | Field                | Source                                               | What to do                                                                                       |
| ----- | -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| CWS   | Title                | `src/build/manifest.ts` (chromium override, English) | Nothing. The Chromium manifest uses a literal English title, so every listing language shows it. |
| CWS   | Short description    | `src/build/manifest.ts` (chromium override, English) | Nothing, for the same reason.                                                                    |
| CWS   | Detailed description | Section (a) below                                    | Paste it by hand under the Dutch listing language in the Developer Dashboard.                    |
| AMO   | Name                 | `_locales/nl/messages.json` (`extensionName`)        | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Summary              | `_locales/nl/messages.json` (`extensionDescription`) | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Detailed description | Section (b) below                                    | Paste it by hand into the nl locale in the AMO Developer Hub.                                    |

---

## (a) Chrome Web Store detailed description (plain text)

🛡️ Vervals je geolocatie, tijdzone en elk ander locatiesignaal, met één klik.

GeoSpoof is een Chrome-extensie die je geolocatie vervalst en je locatie wijzigt, met privacy voorop. Zet één schakelaar om en elke site leest de nep-locatie die jij kiest, niet waar je echt bent.

Een simpele locatiewijziger verplaatst alleen de speld op de kaart. GeoSpoof gaat verder: het stemt je tijdzone af, blokkeert WebRTC-IP-lekken en synchroniseert automatisch met je VPN, zodat elk signaal past bij de plek die je koos.

Kies een stad, typ exacte coördinaten of laat GeoSpoof automatisch je VPN volgen. Zet het uit wanneer je wilt en je echte locatie is ongewijzigd terug.

🆕 Nieuw in 2.3.0: sitegroepen, exacte adressen en lijsten via een link, zowel in Filters als in Locaties per site; Locatie willekeurig maken; en een vernieuwd tabblad Sites en vernieuwde Instellingen.

⭐ Waarom mensen GeoSpoof kiezen in plaats van een simpele locatiewijziger

1️⃣ Stel met één klik een nep-GPS-locatie in: elke stad of exacte coördinaten.
2️⃣ Sync met VPN: herkent de uitgangsregio van je VPN en zet je locatie daarop.
3️⃣ Automatische synchronisatie op de achtergrond: wissel van VPN-server en je locatie volgt vanzelf.
4️⃣ Ook de tijdzone: klok en datum passen bij je locatie, zodat die twee elkaar niet tegenspreken.
5️⃣ Blokkeer WebRTC-lekken: je echte IP blijft verborgen, ook achter een VPN.
6️⃣ Spoofing op engineniveau: de browserengine zelf past je tijdzone toe, ook in workers en frames van andere sites, zo vroeg als Chrome toestaat.
7️⃣ Anti-fingerprinting: alle signalen blijven consistent en doorstaan de controles die echte fingerprintingscripts uitvoeren.
8️⃣ Locaties per site: geef een site een eigen locatie, terwijl alle andere sites je hoofdlocatie houden.
9️⃣ Filters: kies Alle sites, Toestaan of Blokkeren om te bepalen waar GeoSpoof werkt.
🔟 Geen account, geen tracking, geen analytics: alles blijft op je apparaat.

📍 Stel je nep-locatie in zoals jij wilt

▸ Zoek op stad of adres en kom precies op de juiste plek uit.
▸ Voer zelf een exacte breedte- en lengtegraad in voor een zuivere GPS-positie.
▸ Stel de nauwkeurigheid in, van realistisch tot een eigen waarde in meters.
▸ Bewaar tot 50 favoriete plekken en wissel met één tik.
▸ Instellingen, onder het ⚙-tandwiel, toont nu eerst wat sites zien, met Geavanceerd en Algemeen daaronder.

🎲 Locatie willekeurig maken

Sites kunnen een willekeurig punt in de buurt van je gekozen locatie krijgen in plaats van de exacte plek: binnen 0,5 km, 2 km of 10 km. Houd hetzelfde punt, of kies een nieuw punt bij elke browsersessie, elk uur of elke dag.

Het punt ligt altijd rond de locatie die je in GeoSpoof koos, nooit rond je echte locatie, en je tijdzone blijft je gekozen locatie volgen. Eén afweging om te kennen: een wisselend punt is lastiger te herkennen tussen bezoeken, maar een site die meerdere punten verzamelt, kan ze middelen.

🧭 Bepaal per site waar het werkt

Het vernieuwde tabblad Sites toont de site waarop je bent en welke locatie die ziet, met één knop om de site aan je lijst toe te voegen of eraf te halen.

▸ Filters: kies onder Filtermodus Alle sites, Toestaan (alleen de sites in Toegestane sites) of Blokkeren (elke site behalve die in de Blokkeerlijst).
▸ Locaties per site: Twitch kan Mexico-Stad zien en ChatGPT Dublin, terwijl alle andere sites Tokio zien. Passen meerdere items, dan wint het meest specifieke.
▸ Sitegroep: één item dekt alle domeinen van een dienst, zoals Google, Netflix of OpenAI, of een regio zoals Chinese sites. Zo'n 1.500 groepen komen uit de v2fly-domeinlijst die proxytools geosite noemen, en GeoSpoof werkt ze ongeveer eens per week bij.
▸ Alleen exact adres: past op mail.example.com en op geen van de subdomeinen.
▸ Lijst via een link: plak een https://-link naar een domeinlijst die je al voor je proxy gebruikt. GeoSpoof downloadt hem en werkt hem elke week bij.

Sitegroepen, exacte adressen en lijsten via een link werken zowel in Filters als in Locaties per site.

🌍 Vervals je geolocatie, met of zonder VPN

Een VPN verandert je IP. GeoSpoof herschrijft de coördinaten die je browser via de geolocatie-API doorgeeft, en kan die twee op elkaar afstemmen.

Gebruik het los, of combineer het met je VPN zodat je IP, locatie en tijdzone hetzelfde verhaal vertellen.

🔒 Privacy eerst

🔹 Alles draait op je apparaat: GeoSpoof stuurt je echte locatie nooit naar een server.
🔹 Geen account, geen tracking, geen analytics. Instellingen blijven lokaal.
🔹 Je filters en locaties per site verlaten je apparaat nooit. Updates van sitegroepen downloaden de hele catalogus, zodat geen enkel verzoek verraadt welke groepen je koos.
🔹 Een lijst via een link wordt rechtstreeks gedownload van de site waar hij staat, en die site ziet je IP-adres, zoals bij elke download.
🔹 Open source: bekijk op GitHub precies wat het doet.
🔹 Zet de bescherming uit en je echte coördinaten zijn ongewijzigd terug.

💡 Voor wie

◆ Privacybewuste mensen die niet willen dat sites bijhouden waar ze zijn.
◆ Ontwikkelaars die locatie-, tijdzone- en regiofuncties testen.
◆ Iedereen die regiogebonden content en diensten wil gebruiken.
◆ VPN-gebruikers die willen dat hun browserlocatie past bij hun exitnode.

❓ Veelgestelde vragen

📌 Zien sites dan toch mijn echte locatie?
💡 Nee. Zolang de bescherming aan staat, geeft de browser de plek door die jij koos.

📌 Is dit een VPN?
💡 Nee. GeoSpoof verandert de coördinaten die je browser doorgeeft, niet je IP. Het werkt perfect samen met een VPN en kan er zelfs automatisch mee synchroniseren.

📌 Kan ik een exact punt instellen?
💡 Ja. Voer een exacte breedte- en lengtegraad in, of zoek een stad, voor een zuivere GPS-spoof.

📌 Verandert het ook mijn tijdzone?
💡 Ja. GeoSpoof vervalst je tijdzone samen met je locatie, zodat ze altijd overeenkomen. Daar vallen tools die alleen de locatie wijzigen vaak door de mand.

📌 Is dit gewoon een locatiewijziger?
💡 Het is een locatiewijziger en meer. GeoSpoof stelt een nep-locatie in en stemt daarna ook je tijdzone af en blokkeert WebRTC-lekken, zodat niets die locatie tegenspreekt.

📌 Werkt het op Google Maps?
💡 Ja. GeoSpoof werkt op elke site die de geolocatie-API van de browser gebruikt.

📌 Zijn mijn gegevens veilig?
💡 Ja. GeoSpoof draait lokaal, verzamelt niets en is open source. Niets over je locatie verlaat je apparaat.

📌 Verandert een locatie per site mijn IP of de regio van mijn account?
💡 Nee. Het verandert wat de pagina's van die site uit je browser lezen: de locatie, de tijdzone, en de taal als je die je locatie laat volgen. Je IP en accountgegevens blijven hetzelfde, dus voor het meest consistente resultaat combineer je het met een VPN-exit op dezelfde plek.

📌 Kan een site zien dat ik GeoSpoof gebruik?
💡 Dat valt niet uit te sluiten. GeoSpoof doorstaat de controles die echte fingerprintingscripts uitvoeren en houdt alle signalen consistent, maar geen enkele extensie kan elk spoor wissen: engine-interne werking en timing-zijkanalen liggen buiten bereik. Controleer het zelf op geospoof.com/test.

📌 Moet ik me registreren?
💡 Geen account en niets in te stellen. Installeer het en wijzig meteen je locatie.

📲 Nu ook op iPhone, iPad en Mac.

Locaties per site, sitegroepen en Locatie willekeurig maken zijn gratis in Chrome. In Safari horen Filters, Locaties per site en Locatie willekeurig maken bij GeoSpoof Pro, en sitegroepen, exacte adressen en lijsten via een link zijn daar nog niet beschikbaar.

Installeer GeoSpoof, stel een nep-locatie in en bepaal zelf wat het web te zien krijgt over waar je bent.

Links:
— geospoof.com
— github.com/GeoSpoof/geospoof

---

## (b) AMO detailed description (Markdown)

Same rules as the English AMO copy: Markdown, bold lines instead of headings. Feature 6
describes Firefox's protection, not Chrome's Engine-level Spoofing.

**🛡️ Vervals je geolocatie, tijdzone en elk ander locatiesignaal, met één klik.**

GeoSpoof is een Firefox-extensie die je **geolocatie vervalst** en je **locatie wijzigt**, met privacy voorop. Zet één schakelaar om en elke site leest de nep-locatie die jij kiest, niet waar je echt bent.

Een simpele locatiewijziger verplaatst alleen de speld op de kaart. GeoSpoof gaat verder: het stemt je **tijdzone** af, blokkeert **WebRTC-IP-lekken** en synchroniseert automatisch met je **VPN**, zodat elk signaal past bij de plek die je koos.

Kies een stad, typ exacte coördinaten of laat GeoSpoof automatisch je VPN volgen. Zet het uit wanneer je wilt en je echte locatie is ongewijzigd terug.

**🆕 Nieuw in 2.3.0:** sitegroepen, exacte adressen en lijsten via een link, zowel in Filters als in Locaties per site; Locatie willekeurig maken; en een vernieuwd tabblad Sites en vernieuwde Instellingen.

**⭐ Waarom mensen GeoSpoof kiezen in plaats van een simpele locatiewijziger**

1. **Stel met één klik een nep-GPS-locatie in**: elke stad of exacte coördinaten.
2. **Sync met VPN**: herkent de uitgangsregio van je VPN en zet je locatie daarop.
3. **Automatische synchronisatie op de achtergrond**: wissel van VPN-server en je locatie volgt vanzelf.
4. **Ook de tijdzone**: klok en datum passen bij je locatie, zodat die twee elkaar niet tegenspreken.
5. **Blokkeer WebRTC-lekken**: je echte IP blijft verborgen, ook achter een VPN.
6. **Tijdzonebescherming in workers**: dekt workers en het starten van de pagina, met optioneel Directe tijdzonebescherming vanaf het eerste script van de pagina.
7. **Anti-fingerprinting**: alle signalen blijven consistent en doorstaan de controles die echte fingerprintingscripts uitvoeren.
8. **Locaties per site**: geef een site een eigen locatie, terwijl alle andere sites je hoofdlocatie houden.
9. **Filters**: kies Alle sites, Toestaan of Blokkeren om te bepalen waar GeoSpoof werkt.
10. **Geen account, geen tracking, geen analytics**: alles blijft op je apparaat.

**📍 Stel je nep-locatie in zoals jij wilt**

- Zoek op stad of adres en kom precies op de juiste plek uit.
- Voer zelf een exacte breedte- en lengtegraad in voor een zuivere GPS-positie.
- Stel de nauwkeurigheid in, van realistisch tot een eigen waarde in meters.
- Bewaar tot 50 favoriete plekken en wissel met één tik.
- **Instellingen**, onder het ⚙-tandwiel, toont nu eerst wat sites zien, met Geavanceerd en Algemeen daaronder.

**🎲 Locatie willekeurig maken**

Sites kunnen een willekeurig punt in de buurt van je gekozen locatie krijgen in plaats van de exacte plek: binnen 0,5 km, 2 km of 10 km. Houd hetzelfde punt, of kies een nieuw punt bij elke browsersessie, elk uur of elke dag.

Het punt ligt altijd rond de locatie die je in GeoSpoof koos, nooit rond je echte locatie, en je tijdzone blijft je gekozen locatie volgen. Eén afweging om te kennen: een wisselend punt is lastiger te herkennen tussen bezoeken, maar een site die meerdere punten verzamelt, kan ze middelen.

**🧭 Bepaal per site waar het werkt**

Het vernieuwde tabblad **Sites** toont de site waarop je bent en welke locatie die ziet, met één knop om de site aan je lijst toe te voegen of eraf te halen.

- **Filters**: kies onder Filtermodus Alle sites, **Toestaan** (alleen de sites in Toegestane sites) of **Blokkeren** (elke site behalve die in de Blokkeerlijst).
- **Locaties per site**: Twitch kan Mexico-Stad zien en ChatGPT Dublin, terwijl alle andere sites Tokio zien. Passen meerdere items, dan wint het meest specifieke.
- **Sitegroep**: één item dekt alle domeinen van een dienst, zoals Google, Netflix of OpenAI, of een regio zoals Chinese sites. Zo'n 1.500 groepen komen uit de [v2fly-domeinlijst](https://github.com/v2fly/domain-list-community) die proxytools `geosite` noemen, en GeoSpoof werkt ze ongeveer eens per week bij.
- **Alleen exact adres**: past op `mail.example.com` en op geen van de subdomeinen.
- **Lijst via een link**: plak een `https://`-link naar een domeinlijst die je al voor je proxy gebruikt. GeoSpoof downloadt hem en werkt hem elke week bij.

Sitegroepen, exacte adressen en lijsten via een link werken zowel in Filters als in Locaties per site.

**🌍 Vervals je geolocatie, met of zonder VPN**

Een VPN verandert je IP. GeoSpoof herschrijft de coördinaten die je browser via de geolocatie-API doorgeeft, en kan die twee op elkaar afstemmen.

Gebruik het los, of combineer het met je VPN zodat je IP, locatie en tijdzone hetzelfde verhaal vertellen.

**🔒 Privacy eerst**

- Alles draait op je apparaat: GeoSpoof stuurt je echte locatie nooit naar een server.
- Geen account, geen tracking, geen analytics. Instellingen blijven lokaal.
- Je filters en locaties per site verlaten je apparaat nooit. Updates van sitegroepen downloaden de hele catalogus, zodat geen enkel verzoek verraadt welke groepen je koos.
- Een lijst via een link wordt rechtstreeks gedownload van de site waar hij staat, en die site ziet je IP-adres, zoals bij elke download.
- _Open source_: bekijk op [GitHub](https://github.com/GeoSpoof/geospoof) precies wat het doet.
- Zet de bescherming uit en je echte coördinaten zijn ongewijzigd terug.

**💡 Voor wie**

- Privacybewuste mensen die niet willen dat sites bijhouden waar ze zijn.
- Ontwikkelaars die locatie-, tijdzone- en regiofuncties testen.
- Iedereen die regiogebonden content en diensten wil gebruiken.
- VPN-gebruikers die willen dat hun browserlocatie past bij hun exitnode.

**❓ Veelgestelde vragen**

📌 **Zien sites dan toch mijn echte locatie?** Nee. Zolang de bescherming aan staat, geeft de browser de plek door die jij koos.

📌 **Is dit een VPN?** Nee. GeoSpoof verandert de coördinaten die je browser doorgeeft, niet je IP. Het werkt perfect samen met een VPN en kan er zelfs automatisch mee synchroniseren.

📌 **Kan ik een exact punt instellen?** Ja. Voer een exacte breedte- en lengtegraad in, of zoek een stad, voor een zuivere GPS-spoof.

📌 **Verandert het ook mijn tijdzone?** Ja. GeoSpoof vervalst je tijdzone samen met je locatie, zodat ze altijd overeenkomen. Daar vallen tools die alleen de locatie wijzigen vaak door de mand.

📌 **Is dit gewoon een locatiewijziger?** Het is een locatiewijziger en meer. GeoSpoof stelt een nep-locatie in en stemt daarna ook je tijdzone af en blokkeert WebRTC-lekken, zodat niets die locatie tegenspreekt.

📌 **Werkt het op Google Maps?** Ja. GeoSpoof werkt op elke site die de geolocatie-API van de browser gebruikt.

📌 **Zijn mijn gegevens veilig?** Ja. GeoSpoof draait lokaal, verzamelt niets en is open source. Niets over je locatie verlaat je apparaat.

📌 **Verandert een locatie per site mijn IP of de regio van mijn account?** Nee. Het verandert wat de pagina's van die site uit je browser lezen: de locatie, de tijdzone, en de taal als je die je locatie laat volgen. Je IP en accountgegevens blijven hetzelfde, dus voor het meest consistente resultaat combineer je het met een VPN-exit op dezelfde plek.

📌 **Kan een site zien dat ik GeoSpoof gebruik?** Dat valt niet uit te sluiten. GeoSpoof doorstaat de controles die echte fingerprintingscripts uitvoeren en houdt alle signalen consistent, maar geen enkele extensie kan elk spoor wissen: engine-interne werking en timing-zijkanalen liggen buiten bereik. Controleer het zelf op [geospoof.com/test](https://geospoof.com/test).

📌 **Moet ik me registreren?** Geen account en niets in te stellen. Installeer het en wijzig meteen je locatie.

**📲 Nu ook op iPhone, iPad en Mac.**

Locaties per site, sitegroepen en Locatie willekeurig maken zijn gratis in Firefox. In Safari horen Filters, Locaties per site en Locatie willekeurig maken bij GeoSpoof Pro, en sitegroepen, exacte adressen en lijsten via een link zijn daar nog niet beschikbaar.

Installeer GeoSpoof, stel een nep-locatie in en bepaal zelf wat het web te zien krijgt over waar je bent.

Links:

- [geospoof.com](https://geospoof.com)
- [GitHub](https://github.com/GeoSpoof/geospoof)
