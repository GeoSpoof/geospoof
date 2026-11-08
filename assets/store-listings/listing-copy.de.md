# Store Listing Copy — German

German copy for the Chrome Web Store and AMO. It mirrors the English copy in
[`listing-copy.md`](listing-copy.md), section for section, with the same emoji. The
terms follow `_locales/de/messages.json` (fälschen, Geolokation, Zeitzone, Mit VPN
synchronisieren, Websites, Filter, Filtermodus, Zulassungsliste／Sperrliste, Standorte
pro Website, Hauptstandort, Standort zufällig versetzen, Website-Gruppe, Nur genau diese
Adresse, Liste von einem Link, Spoofing auf Engine-Ebene, Sofortiger Zeitzonenschutz)
and its informal "du". It was written from the English, not translated through another
language, and **still needs review by a native speaker**. When the English copy
changes, update this file in the same commit.

## Where each field comes from

| Store | Field                | Source                                               | What to do                                                                                       |
| ----- | -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| CWS   | Title                | `src/build/manifest.ts` (chromium override, English) | Nothing. The Chromium manifest uses a literal English title, so every listing language shows it. |
| CWS   | Short description    | `src/build/manifest.ts` (chromium override, English) | Nothing, for the same reason.                                                                    |
| CWS   | Detailed description | Section (a) below                                    | Paste it by hand under the German listing language in the Developer Dashboard.                   |
| AMO   | Name                 | `_locales/de/messages.json` (`extensionName`)        | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Summary              | `_locales/de/messages.json` (`extensionDescription`) | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Detailed description | Section (b) below                                    | Paste it by hand into the de locale in the AMO Developer Hub.                                    |

---

## (a) Chrome Web Store detailed description (plain text)

🛡️ Geolokation, Zeitzone und jedes andere Standortsignal fälschen – mit einem Klick.

GeoSpoof fälscht deine Geolokation und ändert deinen Standort in Chrome, mit Datenschutz an erster Stelle. Ein Schalter genügt, und jede Website liest den falschen Standort, den du wählst, statt deines echten Aufenthaltsorts.

Ein einfacher Standortwechsler verschiebt nur die Stecknadel auf der Karte. GeoSpoof geht weiter: Es passt deine Zeitzone an, blockiert WebRTC-IP-Leaks und synchronisiert sich automatisch mit deinem VPN, damit jedes Signal zum gewählten Ort passt.

Wähle eine Stadt, gib genaue Koordinaten ein oder lass GeoSpoof deinen VPN-Standort automatisch übernehmen. Du kannst es jederzeit ausschalten, und dein echter Standort ist unverändert zurück.

🆕 Neu in 2.3.0: Website-Gruppen, genaue Adressen und Listen von einem Link, sowohl in den Filtern als auch bei den Standorten pro Website; „Standort zufällig versetzen“; und ein neu gestalteter Websites-Tab und neue Einstellungen.

⭐ Warum GeoSpoof statt eines einfachen Standortwechslers?

1️⃣ Falschen GPS-Standort mit einem Klick setzen – jede Stadt oder genaue Koordinaten.
2️⃣ Mit VPN synchronisieren – erkennt die Ausgangsregion deines VPNs und setzt deinen Standort dorthin.
3️⃣ Automatische Hintergrund-Synchronisierung – wechsle den VPN-Server, und dein Standort folgt von selbst.
4️⃣ Auch die Zeitzone – Uhrzeit und Datum passen zu deinem Standort, damit sich beides nicht widerspricht.
5️⃣ WebRTC-Leaks blockieren – deine echte IP bleibt verborgen, auch hinter einem VPN.
6️⃣ Spoofing auf Engine-Ebene – die Browser-Engine selbst wendet deine Zeitzone an, auch in Workern und Frames anderer Websites, so früh wie Chrome es zulässt.
7️⃣ Schutz vor Fingerprinting – alle Signale bleiben stimmig und halten den Prüfungen stand, die echte Fingerprinting-Skripte durchführen.
8️⃣ Standorte pro Website – gib einer Website einen eigenen Standort, während alle anderen deinen Hauptstandort behalten.
9️⃣ Filter – wähle Alle Websites, eine Zulassungsliste oder eine Sperrliste und bestimme so, wo GeoSpoof aktiv ist.
🔟 Kein Konto, kein Tracking, keine Analyse – alles bleibt auf deinem Gerät.

📍 Setze deinen falschen Standort, wie du willst

▸ Suche nach Stadt oder Adresse und lande genau an der richtigen Stelle.
▸ Gib Breiten- und Längengrad von Hand ein, für eine saubere GPS-Position.
▸ Stelle die Genauigkeit ein, von realistisch bis zu einem eigenen Wert in Metern.
▸ Speichere bis zu 50 Lieblingsorte und wechsle mit einem Tippen zwischen ihnen.
▸ Die Einstellungen hinter dem ⚙-Zahnrad zeigen jetzt zuerst, was Websites sehen, darunter Erweitert und Allgemein.

🎲 Standort zufällig versetzen

Websites können statt des genauen Orts einen zufälligen Punkt in der Nähe deines gewählten Standorts bekommen: im Umkreis von 0,5 km, 2 km oder 10 km. Behalte denselben Punkt oder lass bei jeder Browsersitzung, jede Stunde oder jeden Tag einen neuen wählen.

Der Punkt liegt immer um den Standort, den du in GeoSpoof gewählt hast, nie um deinen echten. Auch die Zeitzone folgt weiter deinem gewählten Standort. Ein Kompromiss, den du kennen solltest: Ein wechselnder Punkt ist über Besuche hinweg schwerer wiederzuerkennen, aber eine Website, die mehrere Punkte sammelt, kann sie mitteln.

🧭 Bestimme Website für Website, wo es wirkt

Der neu gestaltete Websites-Tab zeigt die Website, auf der du gerade bist, und welchen Standort sie sieht. Mit einem Knopf nimmst du sie in deine Liste auf oder entfernst sie wieder.

▸ Filter – wähle unter Filtermodus Alle Websites, Zulassungsliste (nur die Websites auf deiner Liste) oder Sperrliste (alle Websites außer denen auf deiner Liste).
▸ Standorte pro Website – Twitch sieht Mexiko-Stadt und ChatGPT sieht Dublin, während alle anderen Websites Tokio sehen. Passen mehrere Einträge, gewinnt der genaueste.
▸ Website-Gruppe – ein Eintrag deckt alle Domains eines Dienstes ab, etwa Google, Netflix oder OpenAI, oder eine Region wie Chinesische Websites. Rund 1.500 Gruppen stammen aus der v2fly-Domainliste, die Proxy-Tools geosite nennen, und GeoSpoof aktualisiert sie etwa einmal pro Woche.
▸ Nur genau diese Adresse – trifft mail.example.com, aber keine seiner Subdomains.
▸ Liste von einem Link – füge einen https://-Link zu einer Domainliste ein, die du schon für deinen Proxy nutzt. GeoSpoof lädt sie herunter und aktualisiert sie wöchentlich.

Website-Gruppen, genaue Adressen und Listen von einem Link funktionieren sowohl in den Filtern als auch bei den Standorten pro Website.

🌍 Geolokation fälschen – mit oder ohne VPN

Ein VPN ändert deine IP. GeoSpoof schreibt die Koordinaten um, die dein Browser über die Geolokation-API meldet – und kann beides miteinander synchronisieren.

Nutze es allein oder zusammen mit deinem VPN, damit IP, Standort und Zeitzone dieselbe Geschichte erzählen.

🔒 Datenschutz zuerst

🔹 Alles läuft auf deinem Gerät – GeoSpoof sendet deinen echten Standort nie an einen Server.
🔹 Kein Konto, kein Tracking, keine Analyse. Die Einstellungen bleiben lokal.
🔹 Deine Filter und Standorte pro Website verlassen dein Gerät nie. Für Updates der Website-Gruppen wird der ganze Katalog geladen, sodass keine Anfrage verrät, welche Gruppen du gewählt hast.
🔹 Eine Liste von einem Link wird direkt von der Website geladen, die sie bereitstellt. Diese sieht dabei deine IP-Adresse, wie bei jedem Download.
🔹 Open Source – prüfe auf GitHub genau, was es tut.
🔹 Schalte den Schutz aus, und deine echten Koordinaten sind unverändert zurück.

💡 Für wen es gedacht ist

◆ Menschen, denen Datenschutz wichtig ist und die nicht wollen, dass Websites ihren Aufenthaltsort speichern.
◆ Entwickler, die Standort-, Zeitzonen- und Regionsfunktionen testen.
◆ Alle, die regionsspezifische Inhalte und Dienste nutzen möchten.
◆ VPN-Nutzer, deren Browser-Standort zum Ausgangsknoten passen soll.

❓ FAQ

📌 Sehen Websites trotzdem meinen echten Standort?
💡 Nein. Solange der Schutz aktiv ist, meldet der Browser den Ort, den du gewählt hast.

📌 Ist das ein VPN?
💡 Nein. GeoSpoof ändert die Koordinaten, die dein Browser meldet, nicht deine IP. Es passt perfekt zu einem VPN und kann sich sogar automatisch damit synchronisieren.

📌 Kann ich einen genauen Punkt festlegen?
💡 Ja. Gib Breiten- und Längengrad genau ein oder suche eine Stadt, für ein sauberes GPS-Spoofing.

📌 Ändert es auch meine Zeitzone?
💡 Ja. GeoSpoof fälscht deine Zeitzone zusammen mit deinem Standort, damit beides immer zusammenpasst – genau das verraten Tools, die nur den Standort ändern.

📌 Ist das nur ein Standortwechsler?
💡 Ein Standortwechsler und mehr. GeoSpoof setzt einen falschen Standort, passt dann auch die Zeitzone an und blockiert WebRTC-Leaks, damit ihm nichts widerspricht.

📌 Funktioniert es mit Google Maps?
💡 Ja. GeoSpoof funktioniert auf jeder Website, die die Geolokation-API des Browsers nutzt.

📌 Sind meine Daten sicher?
💡 Ja. GeoSpoof läuft lokal, sammelt nichts und ist Open Source. Nichts über deinen Standort verlässt dein Gerät.

📌 Ändert ein Standort pro Website meine IP oder die Region meines Kontos?
💡 Nein. Er ändert, was die Seiten dieser Website aus deinem Browser lesen: den Standort, die Zeitzone und die Sprache, wenn du sie dem Standort folgen lässt. Deine IP und deine Kontodaten bleiben gleich. Für das stimmigste Ergebnis kombinierst du ihn mit einem VPN-Ausgang am selben Ort.

📌 Kann eine Website erkennen, dass ich GeoSpoof nutze?
💡 Ausschließen lässt sich das nicht. GeoSpoof besteht die Prüfungen, die echte Fingerprinting-Skripte durchführen, und hält alle Signale stimmig. Keine Erweiterung kann aber jede Spur verwischen: Engine-Interna und Timing-Seitenkanäle liegen außerhalb ihrer Reichweite. Auf geospoof.com/test kannst du es selbst prüfen.

📌 Muss ich mich registrieren?
💡 Kein Konto, keine Einrichtung. Installieren und sofort deinen Standort ändern.

📲 Jetzt auch auf iPhone, iPad und Mac.

Standorte pro Website, Website-Gruppen und „Standort zufällig versetzen“ sind in Chrome kostenlos. In Safari gehören Filter, Standorte pro Website und „Standort zufällig versetzen“ zu GeoSpoof Pro; Website-Gruppen, genaue Adressen und Listen von einem Link gibt es dort noch nicht.

Installiere GeoSpoof, setze einen falschen Standort und bestimme selbst, was das Web darüber erfährt, wo du bist.

Links:
— geospoof.com
— github.com/GeoSpoof/geospoof

---

## (b) AMO detailed description (Markdown)

Same rules as the English AMO copy: Markdown, bold lines instead of headings. Feature 6
describes Firefox's protection, not Chrome's Engine-level Spoofing.

**🛡️ Geolokation, Zeitzone und jedes andere Standortsignal fälschen – mit einem Klick.**

GeoSpoof **fälscht deine Geolokation** und **ändert deinen Standort** in Firefox, mit Datenschutz an erster Stelle. Ein Schalter genügt, und jede Website liest den falschen Standort, den du wählst, statt deines echten Aufenthaltsorts.

Ein einfacher Standortwechsler verschiebt nur die Stecknadel auf der Karte. GeoSpoof geht weiter: Es passt deine **Zeitzone** an, blockiert **WebRTC-IP-Leaks** und synchronisiert sich automatisch mit deinem **VPN**, damit jedes Signal zum gewählten Ort passt.

Wähle eine Stadt, gib genaue Koordinaten ein oder lass GeoSpoof deinen VPN-Standort automatisch übernehmen. Du kannst es jederzeit ausschalten, und dein echter Standort ist unverändert zurück.

**🆕 Neu in 2.3.0:** Website-Gruppen, genaue Adressen und Listen von einem Link, sowohl in den Filtern als auch bei den Standorten pro Website; „Standort zufällig versetzen“; und ein neu gestalteter Websites-Tab und neue Einstellungen.

**⭐ Warum GeoSpoof statt eines einfachen Standortwechslers?**

1. **Falschen GPS-Standort mit einem Klick setzen** – jede Stadt oder genaue Koordinaten.
2. **Mit VPN synchronisieren** – erkennt die Ausgangsregion deines VPNs und setzt deinen Standort dorthin.
3. **Automatische Hintergrund-Synchronisierung** – wechsle den VPN-Server, und dein Standort folgt von selbst.
4. **Auch die Zeitzone** – Uhrzeit und Datum passen zu deinem Standort, damit sich beides nicht widerspricht.
5. **WebRTC-Leaks blockieren** – deine echte IP bleibt verborgen, auch hinter einem VPN.
6. **Zeitzonenschutz in Workern** – deckt Worker und den Seitenstart ab, optional mit „Sofortiger Zeitzonenschutz“ ab dem ersten Skript der Seite.
7. **Schutz vor Fingerprinting** – alle Signale bleiben stimmig und halten den Prüfungen stand, die echte Fingerprinting-Skripte durchführen.
8. **Standorte pro Website** – gib einer Website einen eigenen Standort, während alle anderen deinen Hauptstandort behalten.
9. **Filter** – wähle Alle Websites, eine Zulassungsliste oder eine Sperrliste und bestimme so, wo GeoSpoof aktiv ist.
10. **Kein Konto, kein Tracking, keine Analyse** – alles bleibt auf deinem Gerät.

**📍 Setze deinen falschen Standort, wie du willst**

- Suche nach Stadt oder Adresse und lande genau an der richtigen Stelle.
- Gib Breiten- und Längengrad von Hand ein, für eine saubere GPS-Position.
- Stelle die Genauigkeit ein, von realistisch bis zu einem eigenen Wert in Metern.
- Speichere bis zu 50 Lieblingsorte und wechsle mit einem Tippen zwischen ihnen.
- Die **Einstellungen** hinter dem ⚙-Zahnrad zeigen jetzt zuerst, was Websites sehen, darunter Erweitert und Allgemein.

**🎲 Standort zufällig versetzen**

Websites können statt des genauen Orts einen zufälligen Punkt in der Nähe deines gewählten Standorts bekommen: im Umkreis von 0,5 km, 2 km oder 10 km. Behalte denselben Punkt oder lass bei jeder Browsersitzung, jede Stunde oder jeden Tag einen neuen wählen.

Der Punkt liegt immer um den Standort, den du in GeoSpoof gewählt hast, nie um deinen echten. Auch die Zeitzone folgt weiter deinem gewählten Standort. Ein Kompromiss, den du kennen solltest: Ein wechselnder Punkt ist über Besuche hinweg schwerer wiederzuerkennen, aber eine Website, die mehrere Punkte sammelt, kann sie mitteln.

**🧭 Bestimme Website für Website, wo es wirkt**

Der neu gestaltete **Websites**-Tab zeigt die Website, auf der du gerade bist, und welchen Standort sie sieht. Mit einem Knopf nimmst du sie in deine Liste auf oder entfernst sie wieder.

- **Filter** – wähle unter Filtermodus Alle Websites, **Zulassungsliste** (nur die Websites auf deiner Liste) oder **Sperrliste** (alle Websites außer denen auf deiner Liste).
- **Standorte pro Website** – Twitch sieht Mexiko-Stadt und ChatGPT sieht Dublin, während alle anderen Websites Tokio sehen. Passen mehrere Einträge, gewinnt der genaueste.
- **Website-Gruppe** – ein Eintrag deckt alle Domains eines Dienstes ab, etwa Google, Netflix oder OpenAI, oder eine Region wie Chinesische Websites. Rund 1.500 Gruppen stammen aus der [v2fly-Domainliste](https://github.com/v2fly/domain-list-community), die Proxy-Tools `geosite` nennen, und GeoSpoof aktualisiert sie etwa einmal pro Woche.
- **Nur genau diese Adresse** – trifft `mail.example.com`, aber keine seiner Subdomains.
- **Liste von einem Link** – füge einen `https://`-Link zu einer Domainliste ein, die du schon für deinen Proxy nutzt. GeoSpoof lädt sie herunter und aktualisiert sie wöchentlich.

Website-Gruppen, genaue Adressen und Listen von einem Link funktionieren sowohl in den Filtern als auch bei den Standorten pro Website.

**🌍 Geolokation fälschen – mit oder ohne VPN**

Ein VPN ändert deine IP. GeoSpoof schreibt die Koordinaten um, die dein Browser über die Geolokation-API meldet – und kann beides miteinander synchronisieren.

Nutze es allein oder zusammen mit deinem VPN, damit IP, Standort und Zeitzone dieselbe Geschichte erzählen.

**🔒 Datenschutz zuerst**

- Alles läuft auf deinem Gerät – GeoSpoof sendet deinen echten Standort nie an einen Server.
- Kein Konto, kein Tracking, keine Analyse. Die Einstellungen bleiben lokal.
- Deine Filter und Standorte pro Website verlassen dein Gerät nie. Für Updates der Website-Gruppen wird der ganze Katalog geladen, sodass keine Anfrage verrät, welche Gruppen du gewählt hast.
- Eine Liste von einem Link wird direkt von der Website geladen, die sie bereitstellt. Diese sieht dabei deine IP-Adresse, wie bei jedem Download.
- _Open Source_ – prüfe auf [GitHub](https://github.com/GeoSpoof/geospoof) genau, was es tut.
- Schalte den Schutz aus, und deine echten Koordinaten sind unverändert zurück.

**💡 Für wen es gedacht ist**

- Menschen, denen Datenschutz wichtig ist und die nicht wollen, dass Websites ihren Aufenthaltsort speichern.
- Entwickler, die Standort-, Zeitzonen- und Regionsfunktionen testen.
- Alle, die regionsspezifische Inhalte und Dienste nutzen möchten.
- VPN-Nutzer, deren Browser-Standort zum Ausgangsknoten passen soll.

**❓ FAQ**

📌 **Sehen Websites trotzdem meinen echten Standort?** Nein. Solange der Schutz aktiv ist, meldet der Browser den Ort, den du gewählt hast.

📌 **Ist das ein VPN?** Nein. GeoSpoof ändert die Koordinaten, die dein Browser meldet, nicht deine IP. Es passt perfekt zu einem VPN und kann sich sogar automatisch damit synchronisieren.

📌 **Kann ich einen genauen Punkt festlegen?** Ja. Gib Breiten- und Längengrad genau ein oder suche eine Stadt, für ein sauberes GPS-Spoofing.

📌 **Ändert es auch meine Zeitzone?** Ja. GeoSpoof fälscht deine Zeitzone zusammen mit deinem Standort, damit beides immer zusammenpasst – genau das verraten Tools, die nur den Standort ändern.

📌 **Ist das nur ein Standortwechsler?** Ein Standortwechsler und mehr. GeoSpoof setzt einen falschen Standort, passt dann auch die Zeitzone an und blockiert WebRTC-Leaks, damit ihm nichts widerspricht.

📌 **Funktioniert es mit Google Maps?** Ja. GeoSpoof funktioniert auf jeder Website, die die Geolokation-API des Browsers nutzt.

📌 **Sind meine Daten sicher?** Ja. GeoSpoof läuft lokal, sammelt nichts und ist Open Source. Nichts über deinen Standort verlässt dein Gerät.

📌 **Ändert ein Standort pro Website meine IP oder die Region meines Kontos?** Nein. Er ändert, was die Seiten dieser Website aus deinem Browser lesen: den Standort, die Zeitzone und die Sprache, wenn du sie dem Standort folgen lässt. Deine IP und deine Kontodaten bleiben gleich. Für das stimmigste Ergebnis kombinierst du ihn mit einem VPN-Ausgang am selben Ort.

📌 **Kann eine Website erkennen, dass ich GeoSpoof nutze?** Ausschließen lässt sich das nicht. GeoSpoof besteht die Prüfungen, die echte Fingerprinting-Skripte durchführen, und hält alle Signale stimmig. Keine Erweiterung kann aber jede Spur verwischen: Engine-Interna und Timing-Seitenkanäle liegen außerhalb ihrer Reichweite. Auf [geospoof.com/test](https://geospoof.com/test) kannst du es selbst prüfen.

📌 **Muss ich mich registrieren?** Kein Konto, keine Einrichtung. Installieren und sofort deinen Standort ändern.

**📲 Jetzt auch auf iPhone, iPad und Mac.**

Standorte pro Website, Website-Gruppen und „Standort zufällig versetzen“ sind in Firefox kostenlos. In Safari gehören Filter, Standorte pro Website und „Standort zufällig versetzen“ zu GeoSpoof Pro; Website-Gruppen, genaue Adressen und Listen von einem Link gibt es dort noch nicht.

Installiere GeoSpoof, setze einen falschen Standort und bestimme selbst, was das Web darüber erfährt, wo du bist.

Links:

- [geospoof.com](https://geospoof.com)
- [GitHub](https://github.com/GeoSpoof/geospoof)
