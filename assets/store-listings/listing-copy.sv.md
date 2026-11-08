# Store Listing Copy — Swedish

Swedish copy for the Chrome Web Store and AMO. It mirrors the English copy in
[`listing-copy.md`](listing-copy.md), section for section, with the same emoji. The
terms follow `_locales/sv/messages.json` (förfalska, geolokalisering, tidszon, Synka med
VPN, Sajter (the tab), Filter, Filterläge, Alla webbplatser, Tillåtlista／Blocklista,
Platser per webbplats, Huvudplats, Slumpa plats, Webbplatsgrupp, Endast exakt adress,
Lista från en länk, Förfalskning på motornivå, Omedelbart tidszonsskydd) and its "du".
It was written from the English, not translated through another language, and **still
needs review by a native speaker**. When the English copy changes, update this file in
the same commit.

## Where each field comes from

| Store | Field                | Source                                               | What to do                                                                                       |
| ----- | -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| CWS   | Title                | `src/build/manifest.ts` (chromium override, English) | Nothing. The Chromium manifest uses a literal English title, so every listing language shows it. |
| CWS   | Short description    | `src/build/manifest.ts` (chromium override, English) | Nothing, for the same reason.                                                                    |
| CWS   | Detailed description | Section (a) below                                    | Paste it by hand under the Swedish listing language in the Developer Dashboard.                  |
| AMO   | Name                 | `_locales/sv/messages.json` (`extensionName`)        | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Summary              | `_locales/sv/messages.json` (`extensionDescription`) | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Detailed description | Section (b) below                                    | Paste it by hand into the sv-SE locale in the AMO Developer Hub.                                 |

---

## (a) Chrome Web Store detailed description (plain text)

🛡️ Förfalska geolokalisering, tidszon och alla andra platssignaler – med ett klick.

GeoSpoof är ett Chrome-tillägg som förfalskar din geolokalisering och ändrar din plats, med integriteten i fokus. Slå på en enda knapp så läser varje webbplats den falska plats du väljer, inte var du faktiskt befinner dig.

En enkel platsändrare flyttar bara nålen på kartan. GeoSpoof går längre: det anpassar din tidszon, blockerar WebRTC-IP-läckor och synkar automatiskt med ditt VPN, så att varje signal stämmer med platsen du valt.

Välj en stad, skriv in exakta koordinater eller låt GeoSpoof följa ditt VPN automatiskt. Stäng av det när du vill, så är din riktiga plats tillbaka oförändrad.

🆕 Nytt i 2.3.0: webbplatsgrupper, exakta adresser och listor från en länk, både i Filter och i Platser per webbplats; Slumpa plats; och en omgjord flik Sajter och omgjorda Inställningar.

⭐ Därför väljer folk GeoSpoof framför en enkel platsändrare

1️⃣ Ställ in en falsk GPS-plats med ett klick – vilken stad som helst eller exakta koordinater.
2️⃣ Synka med VPN – känner av ditt VPN:s utgångsregion och lägger din plats där.
3️⃣ Automatisk synk i bakgrunden – byt VPN-server så följer platsen med av sig själv.
4️⃣ Tidszonen också – klocka och datum stämmer med din plats, så att de inte motsäger varandra.
5️⃣ Blockera WebRTC-läckor – din riktiga IP förblir dold, även bakom ett VPN.
6️⃣ Förfalskning på motornivå – webbläsarens motor tillämpar själv din tidszon, även i workers och ramar från andra webbplatser, så tidigt som Chrome tillåter.
7️⃣ Skydd mot fingeravtryck – alla signaler förblir konsekventa och klarar de kontroller som riktiga fingeravtrycksskript kör.
8️⃣ Platser per webbplats – ge en webbplats en egen plats medan alla andra behåller din huvudplats.
9️⃣ Filter – välj Alla webbplatser, en tillåtlista eller en blocklista för att bestämma var GeoSpoof är aktivt.
🔟 Inget konto, ingen spårning, ingen analys – allt stannar på din enhet.

📍 Ställ in din falska plats som du vill

▸ Sök på stad eller adress och hamna precis rätt.
▸ Skriv in exakt latitud och longitud för hand för en ren GPS-position.
▸ Justera noggrannheten, från realistisk till ett eget värde i meter.
▸ Spara upp till 50 favoritplatser och byt mellan dem med ett tryck.
▸ Inställningar, under kugghjulet ⚙, visar nu först vad webbplatser ser, med Avancerat och Allmänt längre ner.

🎲 Slumpa plats

Webbplatser kan få en slumpmässig punkt nära platsen du valt i stället för den exakta platsen: inom 0,5 km, 2 km eller 10 km. Behåll samma punkt, eller välj en ny vid varje webbläsarsession, varje timme eller varje dag.

Punkten dras alltid runt platsen du valt i GeoSpoof, aldrig runt din riktiga plats, och tidszonen fortsätter att följa platsen du valt. En avvägning att känna till: en punkt som byts är svårare att känna igen mellan besök, men en webbplats som samlar flera punkter kan räkna ut ett medelvärde.

🧭 Bestäm var det gäller, webbplats för webbplats

Den omgjorda fliken Sajter visar webbplatsen du är på och vilken plats den ser, med en knapp för att lägga till den i din lista eller ta bort den.

▸ Filter – under Filterläge väljer du Alla webbplatser, Tillåtlista (bara webbplatserna i din lista) eller Blocklista (alla webbplatser utom dem i din lista).
▸ Platser per webbplats – Twitch kan se Mexico City och ChatGPT Dublin medan alla andra webbplatser ser Tokyo. När flera poster matchar vinner den mest specifika.
▸ Webbplatsgrupp – en post täcker alla domäner en tjänst använder, som Google, Netflix eller OpenAI, eller en region som Kinesiska webbplatser. Ungefär 1 500 grupper kommer från v2flys domänlista, den som proxyverktyg kallar geosite, och GeoSpoof uppdaterar dem ungefär en gång i veckan.
▸ Endast exakt adress – matchar mail.example.com och ingen av dess underdomäner.
▸ Lista från en länk – klistra in en https://-länk till en domänlista du redan använder för din proxy. GeoSpoof laddar ner den och uppdaterar den varje vecka.

Webbplatsgrupper, exakta adresser och listor från en länk fungerar både i Filter och i Platser per webbplats.

🌍 Förfalska geolokalisering med eller utan VPN

Ett VPN ändrar din IP. GeoSpoof skriver om koordinaterna som din webbläsare rapporterar via geolokaliserings-API:t – och kan synka de två.

Använd det fristående, eller tillsammans med ditt VPN så att din IP, plats och tidszon berättar samma historia.

🔒 Integriteten först

🔹 Allt körs på din enhet – GeoSpoof skickar aldrig din riktiga plats till en server.
🔹 Inget konto, ingen spårning, ingen analys. Inställningarna sparas lokalt.
🔹 Dina filter och platser per webbplats lämnar aldrig din enhet. Uppdateringar av webbplatsgrupper laddar ner hela katalogen, så ingen förfrågan avslöjar vilka grupper du valt.
🔹 En lista från en länk laddas ner direkt från webbplatsen som har den, och den webbplatsen ser din IP-adress, som vid all nedladdning.
🔹 Öppen källkod – granska på GitHub exakt vad det gör.
🔹 Stäng av skyddet så är dina riktiga koordinater tillbaka oförändrade.

💡 Vem det passar

◆ Integritetsmedvetna personer som inte vill att webbplatser loggar var de är.
◆ Utvecklare som testar plats-, tidszons- och regionfunktioner.
◆ Alla som vill nå regionspecifikt innehåll och tjänster.
◆ VPN-användare som vill att webbläsarens plats ska stämma med utgångsnoden.

❓ Vanliga frågor

📌 Ser webbplatser ändå min riktiga plats?
💡 Nej. Så länge skyddet är på returnerar webbläsaren platsen du valt.

📌 Är det här ett VPN?
💡 Nej. GeoSpoof ändrar koordinaterna som din webbläsare rapporterar, inte din IP. Det passar perfekt ihop med ett VPN och kan till och med synka med det automatiskt.

📌 Kan jag ställa in en exakt punkt?
💡 Ja. Skriv in exakt latitud och longitud, eller sök efter en stad, för en ren GPS-förfalskning.

📌 Ändrar det även min tidszon?
💡 Ja. GeoSpoof förfalskar tidszonen tillsammans med platsen så att de alltid stämmer överens – en detalj som avslöjar verktyg som bara ändrar platsen.

📌 Är det bara en platsändrare?
💡 Det är en platsändrare och mer. GeoSpoof ställer in en falsk plats och anpassar sedan även tidszonen och blockerar WebRTC-läckor, så att inget motsäger den.

📌 Fungerar det på Google Maps?
💡 Ja. GeoSpoof fungerar på alla webbplatser som använder webbläsarens geolokaliserings-API.

📌 Är mina data säkra?
💡 Ja. GeoSpoof körs lokalt, samlar inte in något och har öppen källkod. Inget om din plats lämnar din enhet.

📌 Ändrar en plats per webbplats min IP eller mitt kontos region?
💡 Nej. Den ändrar vad webbplatsens sidor läser från din webbläsare: platsen, tidszonen och språket om du låter det följa platsen. Din IP och dina kontouppgifter är desamma, så kombinera den med en VPN-utgång på samma ställe för det mest konsekventa resultatet.

📌 Kan en webbplats se att jag använder GeoSpoof?
💡 Det går inte att utesluta. GeoSpoof klarar de kontroller som riktiga fingeravtrycksskript kör och håller alla signaler konsekventa, men inget tillägg kan sudda ut alla spår: motorns interna mekanismer och tidsbaserade sidokanaler ligger utom räckhåll. Kontrollera själv på geospoof.com/test.

📌 Måste jag registrera mig?
💡 Inget konto och ingen konfiguration. Installera och börja ändra din plats direkt.

📲 Nu även på iPhone, iPad och Mac.

Platser per webbplats, webbplatsgrupper och Slumpa plats är gratis i Chrome. I Safari ingår Filter, Platser per webbplats och Slumpa plats i GeoSpoof Pro, och webbplatsgrupper, exakta adresser och listor från en länk finns inte där än.

Installera GeoSpoof, ställ in en falsk plats och bestäm själv vad webben får veta om var du är.

Länkar:
— geospoof.com
— github.com/GeoSpoof/geospoof

---

## (b) AMO detailed description (Markdown)

Same rules as the English AMO copy: Markdown, bold lines instead of headings. Feature 6
describes Firefox's protection, not Chrome's Engine-level Spoofing.

**🛡️ Förfalska geolokalisering, tidszon och alla andra platssignaler – med ett klick.**

GeoSpoof är ett Firefox-tillägg som **förfalskar din geolokalisering** och **ändrar din plats**, med integriteten i fokus. Slå på en enda knapp så läser varje webbplats den falska plats du väljer, inte var du faktiskt befinner dig.

En enkel platsändrare flyttar bara nålen på kartan. GeoSpoof går längre: det anpassar din **tidszon**, blockerar **WebRTC-IP-läckor** och synkar automatiskt med ditt **VPN**, så att varje signal stämmer med platsen du valt.

Välj en stad, skriv in exakta koordinater eller låt GeoSpoof följa ditt VPN automatiskt. Stäng av det när du vill, så är din riktiga plats tillbaka oförändrad.

**🆕 Nytt i 2.3.0:** webbplatsgrupper, exakta adresser och listor från en länk, både i Filter och i Platser per webbplats; Slumpa plats; och en omgjord flik Sajter och omgjorda Inställningar.

**⭐ Därför väljer folk GeoSpoof framför en enkel platsändrare**

1. **Ställ in en falsk GPS-plats med ett klick** – vilken stad som helst eller exakta koordinater.
2. **Synka med VPN** – känner av ditt VPN:s utgångsregion och lägger din plats där.
3. **Automatisk synk i bakgrunden** – byt VPN-server så följer platsen med av sig själv.
4. **Tidszonen också** – klocka och datum stämmer med din plats, så att de inte motsäger varandra.
5. **Blockera WebRTC-läckor** – din riktiga IP förblir dold, även bakom ett VPN.
6. **Tidszonsskydd i workers** – täcker workers och sidans uppstart, med valfritt Omedelbart tidszonsskydd från sidans första skript.
7. **Skydd mot fingeravtryck** – alla signaler förblir konsekventa och klarar de kontroller som riktiga fingeravtrycksskript kör.
8. **Platser per webbplats** – ge en webbplats en egen plats medan alla andra behåller din huvudplats.
9. **Filter** – välj Alla webbplatser, en tillåtlista eller en blocklista för att bestämma var GeoSpoof är aktivt.
10. **Inget konto, ingen spårning, ingen analys** – allt stannar på din enhet.

**📍 Ställ in din falska plats som du vill**

- Sök på stad eller adress och hamna precis rätt.
- Skriv in exakt latitud och longitud för hand för en ren GPS-position.
- Justera noggrannheten, från realistisk till ett eget värde i meter.
- Spara upp till 50 favoritplatser och byt mellan dem med ett tryck.
- **Inställningar**, under kugghjulet ⚙, visar nu först vad webbplatser ser, med Avancerat och Allmänt längre ner.

**🎲 Slumpa plats**

Webbplatser kan få en slumpmässig punkt nära platsen du valt i stället för den exakta platsen: inom 0,5 km, 2 km eller 10 km. Behåll samma punkt, eller välj en ny vid varje webbläsarsession, varje timme eller varje dag.

Punkten dras alltid runt platsen du valt i GeoSpoof, aldrig runt din riktiga plats, och tidszonen fortsätter att följa platsen du valt. En avvägning att känna till: en punkt som byts är svårare att känna igen mellan besök, men en webbplats som samlar flera punkter kan räkna ut ett medelvärde.

**🧭 Bestäm var det gäller, webbplats för webbplats**

Den omgjorda fliken **Sajter** visar webbplatsen du är på och vilken plats den ser, med en knapp för att lägga till den i din lista eller ta bort den.

- **Filter** – under Filterläge väljer du Alla webbplatser, **Tillåtlista** (bara webbplatserna i din lista) eller **Blocklista** (alla webbplatser utom dem i din lista).
- **Platser per webbplats** – Twitch kan se Mexico City och ChatGPT Dublin medan alla andra webbplatser ser Tokyo. När flera poster matchar vinner den mest specifika.
- **Webbplatsgrupp** – en post täcker alla domäner en tjänst använder, som Google, Netflix eller OpenAI, eller en region som Kinesiska webbplatser. Ungefär 1 500 grupper kommer från [v2flys domänlista](https://github.com/v2fly/domain-list-community), den som proxyverktyg kallar `geosite`, och GeoSpoof uppdaterar dem ungefär en gång i veckan.
- **Endast exakt adress** – matchar `mail.example.com` och ingen av dess underdomäner.
- **Lista från en länk** – klistra in en `https://`-länk till en domänlista du redan använder för din proxy. GeoSpoof laddar ner den och uppdaterar den varje vecka.

Webbplatsgrupper, exakta adresser och listor från en länk fungerar både i Filter och i Platser per webbplats.

**🌍 Förfalska geolokalisering med eller utan VPN**

Ett VPN ändrar din IP. GeoSpoof skriver om koordinaterna som din webbläsare rapporterar via geolokaliserings-API:t – och kan synka de två.

Använd det fristående, eller tillsammans med ditt VPN så att din IP, plats och tidszon berättar samma historia.

**🔒 Integriteten först**

- Allt körs på din enhet – GeoSpoof skickar aldrig din riktiga plats till en server.
- Inget konto, ingen spårning, ingen analys. Inställningarna sparas lokalt.
- Dina filter och platser per webbplats lämnar aldrig din enhet. Uppdateringar av webbplatsgrupper laddar ner hela katalogen, så ingen förfrågan avslöjar vilka grupper du valt.
- En lista från en länk laddas ner direkt från webbplatsen som har den, och den webbplatsen ser din IP-adress, som vid all nedladdning.
- _Öppen källkod_ – granska på [GitHub](https://github.com/GeoSpoof/geospoof) exakt vad det gör.
- Stäng av skyddet så är dina riktiga koordinater tillbaka oförändrade.

**💡 Vem det passar**

- Integritetsmedvetna personer som inte vill att webbplatser loggar var de är.
- Utvecklare som testar plats-, tidszons- och regionfunktioner.
- Alla som vill nå regionspecifikt innehåll och tjänster.
- VPN-användare som vill att webbläsarens plats ska stämma med utgångsnoden.

**❓ Vanliga frågor**

📌 **Ser webbplatser ändå min riktiga plats?** Nej. Så länge skyddet är på returnerar webbläsaren platsen du valt.

📌 **Är det här ett VPN?** Nej. GeoSpoof ändrar koordinaterna som din webbläsare rapporterar, inte din IP. Det passar perfekt ihop med ett VPN och kan till och med synka med det automatiskt.

📌 **Kan jag ställa in en exakt punkt?** Ja. Skriv in exakt latitud och longitud, eller sök efter en stad, för en ren GPS-förfalskning.

📌 **Ändrar det även min tidszon?** Ja. GeoSpoof förfalskar tidszonen tillsammans med platsen så att de alltid stämmer överens – en detalj som avslöjar verktyg som bara ändrar platsen.

📌 **Är det bara en platsändrare?** Det är en platsändrare och mer. GeoSpoof ställer in en falsk plats och anpassar sedan även tidszonen och blockerar WebRTC-läckor, så att inget motsäger den.

📌 **Fungerar det på Google Maps?** Ja. GeoSpoof fungerar på alla webbplatser som använder webbläsarens geolokaliserings-API.

📌 **Är mina data säkra?** Ja. GeoSpoof körs lokalt, samlar inte in något och har öppen källkod. Inget om din plats lämnar din enhet.

📌 **Ändrar en plats per webbplats min IP eller mitt kontos region?** Nej. Den ändrar vad webbplatsens sidor läser från din webbläsare: platsen, tidszonen och språket om du låter det följa platsen. Din IP och dina kontouppgifter är desamma, så kombinera den med en VPN-utgång på samma ställe för det mest konsekventa resultatet.

📌 **Kan en webbplats se att jag använder GeoSpoof?** Det går inte att utesluta. GeoSpoof klarar de kontroller som riktiga fingeravtrycksskript kör och håller alla signaler konsekventa, men inget tillägg kan sudda ut alla spår: motorns interna mekanismer och tidsbaserade sidokanaler ligger utom räckhåll. Kontrollera själv på [geospoof.com/test](https://geospoof.com/test).

📌 **Måste jag registrera mig?** Inget konto och ingen konfiguration. Installera och börja ändra din plats direkt.

**📲 Nu även på iPhone, iPad och Mac.**

Platser per webbplats, webbplatsgrupper och Slumpa plats är gratis i Firefox. I Safari ingår Filter, Platser per webbplats och Slumpa plats i GeoSpoof Pro, och webbplatsgrupper, exakta adresser och listor från en länk finns inte där än.

Installera GeoSpoof, ställ in en falsk plats och bestäm själv vad webben får veta om var du är.

Länkar:

- [geospoof.com](https://geospoof.com)
- [GitHub](https://github.com/GeoSpoof/geospoof)
