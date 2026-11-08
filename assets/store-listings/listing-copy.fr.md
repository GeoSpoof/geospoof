# Store Listing Copy — French

French copy for the Chrome Web Store and AMO. It mirrors the English copy in
[`listing-copy.md`](listing-copy.md), section for section, with the same emoji. The
terms follow `_locales/fr/messages.json` (falsifier, géolocalisation, fuseau horaire,
Synchroniser avec le VPN, Sites, Filtres, Mode de filtrage, Liste d'autorisation／Liste
de blocage, Localisations par site, Localisation principale, Brouiller la position,
Groupe de sites, Adresse exacte uniquement, Liste depuis un lien, Spoofing au niveau du
moteur, Protection instantanée du fuseau horaire) and its "vous". It was written from
the English, not translated through another language, and **still needs review by a
native speaker**. When the English copy changes, update this file in the same commit.

## Where each field comes from

| Store | Field                | Source                                               | What to do                                                                                       |
| ----- | -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| CWS   | Title                | `src/build/manifest.ts` (chromium override, English) | Nothing. The Chromium manifest uses a literal English title, so every listing language shows it. |
| CWS   | Short description    | `src/build/manifest.ts` (chromium override, English) | Nothing, for the same reason.                                                                    |
| CWS   | Detailed description | Section (a) below                                    | Paste it by hand under the French listing language in the Developer Dashboard.                   |
| AMO   | Name                 | `_locales/fr/messages.json` (`extensionName`)        | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Summary              | `_locales/fr/messages.json` (`extensionDescription`) | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Detailed description | Section (b) below                                    | Paste it by hand into the fr locale in the AMO Developer Hub.                                    |

---

## (a) Chrome Web Store detailed description (plain text)

🛡️ Falsifiez votre géolocalisation, votre fuseau horaire et tous vos signaux de localisation, en un clic.

GeoSpoof est une extension Chrome qui falsifie votre géolocalisation et change votre position, en mettant la vie privée au premier plan. Activez un seul interrupteur et chaque site lit la fausse position que vous avez choisie, pas l'endroit où vous êtes réellement.

Un simple changeur de position se contente de déplacer l'épingle sur la carte. GeoSpoof va plus loin : il aligne votre fuseau horaire, bloque les fuites d'IP WebRTC et se synchronise automatiquement avec votre VPN, pour que chaque signal corresponde au lieu choisi.

Choisissez une ville, saisissez des coordonnées exactes ou laissez GeoSpoof suivre votre VPN automatiquement. Désactivez-le quand vous voulez : votre vraie position revient telle quelle.

🆕 Nouveautés de la 2.3.0 : groupes de sites, adresses exactes et listes depuis un lien, dans les Filtres comme dans les Localisations par site ; Brouiller la position ; et un onglet Sites et des Réglages entièrement repensés.

⭐ Pourquoi choisir GeoSpoof plutôt qu'un simple changeur de position

1️⃣ Une fausse position GPS en un clic : n'importe quelle ville ou des coordonnées exactes.
2️⃣ Synchroniser avec le VPN : détecte la région de sortie de votre VPN et y place votre position.
3️⃣ Synchronisation automatique en arrière-plan : changez de serveur VPN, votre position suit toute seule.
4️⃣ Le fuseau horaire aussi : l'heure et la date correspondent à votre position, sans contradiction entre les deux.
5️⃣ Bloque les fuites WebRTC : votre vraie IP reste cachée, même derrière un VPN.
6️⃣ Spoofing au niveau du moteur : le moteur du navigateur applique lui-même votre fuseau horaire, y compris dans les workers et les cadres d'autres sites, aussi tôt que Chrome le permet.
7️⃣ Anti-empreinte : tous les signaux restent cohérents et résistent aux vérifications que font les vrais scripts d'empreinte numérique.
8️⃣ Localisations par site : donnez à un site sa propre position pendant que tous les autres gardent votre localisation principale.
9️⃣ Filtres : choisissez Tous les sites, une Liste d'autorisation ou une Liste de blocage pour décider où GeoSpoof agit.
🔟 Pas de compte, pas de suivi, pas d'analytique : tout reste sur votre appareil.

📍 Réglez votre fausse position comme vous l'entendez

▸ Cherchez une ville ou une adresse et tombez pile au bon endroit.
▸ Saisissez à la main une latitude et une longitude précises pour une position GPS nette.
▸ Ajustez la précision, du réaliste à une valeur personnalisée en mètres.
▸ Enregistrez jusqu'à 50 lieux favoris et passez de l'un à l'autre d'un geste.
▸ Les Réglages, sous l'engrenage ⚙, montrent désormais d'abord ce que voient les sites, avec les options Avancé et Général en dessous.

🎲 Brouiller la position

Les sites peuvent recevoir un point aléatoire proche de la position que vous avez choisie, au lieu du lieu exact : dans un rayon de 0,5 km, 2 km ou 10 km. Gardez le même point, ou choisissez-en un nouveau à chaque session du navigateur, toutes les heures ou tous les jours.

Le point est toujours tiré autour de la position choisie dans GeoSpoof, jamais autour de votre vraie position, et votre fuseau horaire continue de suivre la position choisie. Un compromis à connaître : un point qui change est plus difficile à reconnaître d'une visite à l'autre, mais un site qui en collecte plusieurs peut en faire la moyenne.

🧭 Décidez où il agit, site par site

L'onglet Sites repensé affiche le site sur lequel vous êtes et la position qu'il voit, avec un bouton pour l'ajouter à votre liste ou l'en retirer.

▸ Filtres : dans Mode de filtrage, choisissez Tous les sites, Liste d'autorisation (seulement les sites de votre liste) ou Liste de blocage (tous les sites sauf ceux de votre liste).
▸ Localisations par site : Twitch peut voir Mexico et ChatGPT Dublin, pendant que tous les autres sites voient Tokyo. Quand plusieurs entrées correspondent, la plus précise l'emporte.
▸ Groupe de sites : une seule entrée couvre tous les domaines d'un service, comme Google, Netflix ou OpenAI, ou une région comme Sites chinois. Environ 1 500 groupes proviennent de la liste de domaines v2fly, celle que les outils proxy appellent geosite, et GeoSpoof les met à jour environ une fois par semaine.
▸ Adresse exacte uniquement : correspond à mail.example.com et à aucun de ses sous-domaines.
▸ Liste depuis un lien : collez un lien https:// vers une liste de domaines que vous utilisez déjà pour votre proxy. GeoSpoof la télécharge et la met à jour chaque semaine.

Les groupes de sites, les adresses exactes et les listes depuis un lien fonctionnent aussi bien dans les Filtres que dans les Localisations par site.

🌍 Falsifiez votre géolocalisation, avec ou sans VPN

Un VPN change votre IP. GeoSpoof réécrit les coordonnées que votre navigateur transmet via l'API de géolocalisation, et peut synchroniser les deux.

Utilisez-le seul, ou avec votre VPN pour que votre IP, votre position et votre fuseau horaire racontent la même histoire.

🔒 La vie privée d'abord

🔹 Tout se passe sur votre appareil : GeoSpoof n'envoie jamais votre vraie position à un serveur.
🔹 Pas de compte, pas de suivi, pas d'analytique. Les réglages restent en local.
🔹 Vos filtres et vos localisations par site ne quittent jamais votre appareil. Les mises à jour des groupes de sites téléchargent le catalogue entier : aucune requête ne révèle quels groupes vous avez choisis.
🔹 Une liste depuis un lien est téléchargée directement depuis le site qui l'héberge, qui voit votre adresse IP, comme pour tout téléchargement.
🔹 Open source : vérifiez sur GitHub exactement ce qu'il fait.
🔹 Désactivez la protection et vos vraies coordonnées reviennent telles quelles.

💡 Pour qui

◆ Les personnes soucieuses de leur vie privée qui ne veulent pas que les sites enregistrent où elles sont.
◆ Les développeurs qui testent des fonctions de localisation, de fuseau horaire et de région.
◆ Tous ceux qui veulent accéder à des contenus et services propres à une région.
◆ Les utilisateurs de VPN qui veulent que la position du navigateur corresponde à leur nœud de sortie.

❓ FAQ

📌 Les sites verront-ils quand même ma vraie position ?
💡 Non. Tant que la protection est active, le navigateur renvoie le lieu que vous avez choisi.

📌 Est-ce un VPN ?
💡 Non. GeoSpoof change les coordonnées que transmet votre navigateur, pas votre IP. Il se marie parfaitement avec un VPN et peut même s'y synchroniser automatiquement.

📌 Puis-je fixer un point exact ?
💡 Oui. Saisissez une latitude et une longitude précises, ou cherchez une ville, pour falsifier proprement le GPS.

📌 Change-t-il aussi mon fuseau horaire ?
💡 Oui. GeoSpoof falsifie votre fuseau horaire en même temps que votre position pour qu'ils concordent toujours, un détail qui trahit les outils qui ne changent que la position.

📌 Est-ce juste un changeur de position ?
💡 C'est un changeur de position, et plus encore. GeoSpoof définit une fausse position, puis aligne votre fuseau horaire et bloque les fuites WebRTC pour que rien ne la contredise.

📌 Est-ce que ça marche sur Google Maps ?
💡 Oui. GeoSpoof fonctionne sur tout site qui utilise l'API de géolocalisation du navigateur.

📌 Mes données sont-elles en sécurité ?
💡 Oui. GeoSpoof fonctionne en local, ne collecte rien et est open source. Rien sur votre position ne quitte votre appareil.

📌 Une localisation par site change-t-elle mon IP ou la région de mon compte ?
💡 Non. Elle change ce que les pages de ce site lisent dans votre navigateur : la position, le fuseau horaire, et la langue si vous la réglez pour suivre votre position. Votre IP et les données de votre compte ne changent pas ; pour le résultat le plus cohérent, associez-la à une sortie VPN au même endroit.

📌 Un site peut-il savoir que j'utilise GeoSpoof ?
💡 On ne peut pas l'exclure. GeoSpoof déjoue les vérifications que font les vrais scripts d'empreinte numérique et garde tous les signaux cohérents, mais aucune extension ne peut effacer toutes les traces : les mécanismes internes du moteur et les canaux auxiliaires temporels restent hors de portée. Vérifiez par vous-même sur geospoof.com/test.

📌 Dois-je créer un compte ?
💡 Pas de compte, pas de configuration. Installez-le et changez de position tout de suite.

📲 Disponible aussi sur iPhone, iPad et Mac.

Les localisations par site, les groupes de sites et Brouiller la position sont gratuits dans Chrome. Dans Safari, les Filtres, les Localisations par site et Brouiller la position font partie de GeoSpoof Pro, et les groupes de sites, les adresses exactes et les listes depuis un lien n'y sont pas encore disponibles.

Installez GeoSpoof, choisissez une fausse position et décidez exactement de ce que le web sait de l'endroit où vous êtes.

Liens :
— geospoof.com
— github.com/GeoSpoof/geospoof

---

## (b) AMO detailed description (Markdown)

Same rules as the English AMO copy: Markdown, bold lines instead of headings. Feature 6
describes Firefox's protection, not Chrome's Engine-level Spoofing.

**🛡️ Falsifiez votre géolocalisation, votre fuseau horaire et tous vos signaux de localisation, en un clic.**

GeoSpoof est une extension Firefox qui **falsifie votre géolocalisation** et **change votre position**, en mettant la vie privée au premier plan. Activez un seul interrupteur et chaque site lit la fausse position que vous avez choisie, pas l'endroit où vous êtes réellement.

Un simple changeur de position se contente de déplacer l'épingle sur la carte. GeoSpoof va plus loin : il aligne votre **fuseau horaire**, bloque les **fuites d'IP WebRTC** et se synchronise automatiquement avec votre **VPN**, pour que chaque signal corresponde au lieu choisi.

Choisissez une ville, saisissez des coordonnées exactes ou laissez GeoSpoof suivre votre VPN automatiquement. Désactivez-le quand vous voulez : votre vraie position revient telle quelle.

**🆕 Nouveautés de la 2.3.0 :** groupes de sites, adresses exactes et listes depuis un lien, dans les Filtres comme dans les Localisations par site ; Brouiller la position ; et un onglet Sites et des Réglages entièrement repensés.

**⭐ Pourquoi choisir GeoSpoof plutôt qu'un simple changeur de position**

1. **Une fausse position GPS en un clic** : n'importe quelle ville ou des coordonnées exactes.
2. **Synchroniser avec le VPN** : détecte la région de sortie de votre VPN et y place votre position.
3. **Synchronisation automatique en arrière-plan** : changez de serveur VPN, votre position suit toute seule.
4. **Le fuseau horaire aussi** : l'heure et la date correspondent à votre position, sans contradiction entre les deux.
5. **Bloque les fuites WebRTC** : votre vraie IP reste cachée, même derrière un VPN.
6. **Protection du fuseau horaire dans les workers** : couvre les workers et le démarrage de la page, avec en option la Protection instantanée du fuseau horaire dès le premier script de la page.
7. **Anti-empreinte** : tous les signaux restent cohérents et résistent aux vérifications que font les vrais scripts d'empreinte numérique.
8. **Localisations par site** : donnez à un site sa propre position pendant que tous les autres gardent votre localisation principale.
9. **Filtres** : choisissez Tous les sites, une Liste d'autorisation ou une Liste de blocage pour décider où GeoSpoof agit.
10. **Pas de compte, pas de suivi, pas d'analytique** : tout reste sur votre appareil.

**📍 Réglez votre fausse position comme vous l'entendez**

- Cherchez une ville ou une adresse et tombez pile au bon endroit.
- Saisissez à la main une latitude et une longitude précises pour une position GPS nette.
- Ajustez la précision, du réaliste à une valeur personnalisée en mètres.
- Enregistrez jusqu'à 50 lieux favoris et passez de l'un à l'autre d'un geste.
- Les **Réglages**, sous l'engrenage ⚙, montrent désormais d'abord ce que voient les sites, avec les options Avancé et Général en dessous.

**🎲 Brouiller la position**

Les sites peuvent recevoir un point aléatoire proche de la position que vous avez choisie, au lieu du lieu exact : dans un rayon de 0,5 km, 2 km ou 10 km. Gardez le même point, ou choisissez-en un nouveau à chaque session du navigateur, toutes les heures ou tous les jours.

Le point est toujours tiré autour de la position choisie dans GeoSpoof, jamais autour de votre vraie position, et votre fuseau horaire continue de suivre la position choisie. Un compromis à connaître : un point qui change est plus difficile à reconnaître d'une visite à l'autre, mais un site qui en collecte plusieurs peut en faire la moyenne.

**🧭 Décidez où il agit, site par site**

L'onglet **Sites** repensé affiche le site sur lequel vous êtes et la position qu'il voit, avec un bouton pour l'ajouter à votre liste ou l'en retirer.

- **Filtres** : dans Mode de filtrage, choisissez Tous les sites, **Liste d'autorisation** (seulement les sites de votre liste) ou **Liste de blocage** (tous les sites sauf ceux de votre liste).
- **Localisations par site** : Twitch peut voir Mexico et ChatGPT Dublin, pendant que tous les autres sites voient Tokyo. Quand plusieurs entrées correspondent, la plus précise l'emporte.
- **Groupe de sites** : une seule entrée couvre tous les domaines d'un service, comme Google, Netflix ou OpenAI, ou une région comme Sites chinois. Environ 1 500 groupes proviennent de la [liste de domaines v2fly](https://github.com/v2fly/domain-list-community), celle que les outils proxy appellent `geosite`, et GeoSpoof les met à jour environ une fois par semaine.
- **Adresse exacte uniquement** : correspond à `mail.example.com` et à aucun de ses sous-domaines.
- **Liste depuis un lien** : collez un lien `https://` vers une liste de domaines que vous utilisez déjà pour votre proxy. GeoSpoof la télécharge et la met à jour chaque semaine.

Les groupes de sites, les adresses exactes et les listes depuis un lien fonctionnent aussi bien dans les Filtres que dans les Localisations par site.

**🌍 Falsifiez votre géolocalisation, avec ou sans VPN**

Un VPN change votre IP. GeoSpoof réécrit les coordonnées que votre navigateur transmet via l'API de géolocalisation, et peut synchroniser les deux.

Utilisez-le seul, ou avec votre VPN pour que votre IP, votre position et votre fuseau horaire racontent la même histoire.

**🔒 La vie privée d'abord**

- Tout se passe sur votre appareil : GeoSpoof n'envoie jamais votre vraie position à un serveur.
- Pas de compte, pas de suivi, pas d'analytique. Les réglages restent en local.
- Vos filtres et vos localisations par site ne quittent jamais votre appareil. Les mises à jour des groupes de sites téléchargent le catalogue entier : aucune requête ne révèle quels groupes vous avez choisis.
- Une liste depuis un lien est téléchargée directement depuis le site qui l'héberge, qui voit votre adresse IP, comme pour tout téléchargement.
- _Open source_ : vérifiez sur [GitHub](https://github.com/GeoSpoof/geospoof) exactement ce qu'il fait.
- Désactivez la protection et vos vraies coordonnées reviennent telles quelles.

**💡 Pour qui**

- Les personnes soucieuses de leur vie privée qui ne veulent pas que les sites enregistrent où elles sont.
- Les développeurs qui testent des fonctions de localisation, de fuseau horaire et de région.
- Tous ceux qui veulent accéder à des contenus et services propres à une région.
- Les utilisateurs de VPN qui veulent que la position du navigateur corresponde à leur nœud de sortie.

**❓ FAQ**

📌 **Les sites verront-ils quand même ma vraie position ?** Non. Tant que la protection est active, le navigateur renvoie le lieu que vous avez choisi.

📌 **Est-ce un VPN ?** Non. GeoSpoof change les coordonnées que transmet votre navigateur, pas votre IP. Il se marie parfaitement avec un VPN et peut même s'y synchroniser automatiquement.

📌 **Puis-je fixer un point exact ?** Oui. Saisissez une latitude et une longitude précises, ou cherchez une ville, pour falsifier proprement le GPS.

📌 **Change-t-il aussi mon fuseau horaire ?** Oui. GeoSpoof falsifie votre fuseau horaire en même temps que votre position pour qu'ils concordent toujours, un détail qui trahit les outils qui ne changent que la position.

📌 **Est-ce juste un changeur de position ?** C'est un changeur de position, et plus encore. GeoSpoof définit une fausse position, puis aligne votre fuseau horaire et bloque les fuites WebRTC pour que rien ne la contredise.

📌 **Est-ce que ça marche sur Google Maps ?** Oui. GeoSpoof fonctionne sur tout site qui utilise l'API de géolocalisation du navigateur.

📌 **Mes données sont-elles en sécurité ?** Oui. GeoSpoof fonctionne en local, ne collecte rien et est open source. Rien sur votre position ne quitte votre appareil.

📌 **Une localisation par site change-t-elle mon IP ou la région de mon compte ?** Non. Elle change ce que les pages de ce site lisent dans votre navigateur : la position, le fuseau horaire, et la langue si vous la réglez pour suivre votre position. Votre IP et les données de votre compte ne changent pas ; pour le résultat le plus cohérent, associez-la à une sortie VPN au même endroit.

📌 **Un site peut-il savoir que j'utilise GeoSpoof ?** On ne peut pas l'exclure. GeoSpoof déjoue les vérifications que font les vrais scripts d'empreinte numérique et garde tous les signaux cohérents, mais aucune extension ne peut effacer toutes les traces : les mécanismes internes du moteur et les canaux auxiliaires temporels restent hors de portée. Vérifiez par vous-même sur [geospoof.com/test](https://geospoof.com/test).

📌 **Dois-je créer un compte ?** Pas de compte, pas de configuration. Installez-le et changez de position tout de suite.

**📲 Disponible aussi sur iPhone, iPad et Mac.**

Les localisations par site, les groupes de sites et Brouiller la position sont gratuits dans Firefox. Dans Safari, les Filtres, les Localisations par site et Brouiller la position font partie de GeoSpoof Pro, et les groupes de sites, les adresses exactes et les listes depuis un lien n'y sont pas encore disponibles.

Installez GeoSpoof, choisissez une fausse position et décidez exactement de ce que le web sait de l'endroit où vous êtes.

Liens :

- [geospoof.com](https://geospoof.com)
- [GitHub](https://github.com/GeoSpoof/geospoof)
