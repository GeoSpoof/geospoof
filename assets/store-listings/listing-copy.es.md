# Store Listing Copy — Spanish

Spanish copy for the Chrome Web Store and AMO. It mirrors the English copy in
[`listing-copy.md`](listing-copy.md), section for section, with the same emoji. The
terms follow `_locales/es/messages.json` (falsificar, geolocalización, zona horaria,
Sincronizar con VPN, Sitios, Filtros, Modo de filtro, Lista de permitidos／Lista de
bloqueados, Ubicaciones por sitio, Ubicación principal, Aleatorizar ubicación, Grupo de
sitios, Solo la dirección exacta, Lista desde un enlace, Spoofing a nivel de motor,
Protección de zona horaria instantánea) and its informal "tú". It was written from the
English, not translated through another language, and **still needs review by a native
speaker**. When the English copy changes, update this file in the same commit.

## Where each field comes from

| Store | Field                | Source                                               | What to do                                                                                       |
| ----- | -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| CWS   | Title                | `src/build/manifest.ts` (chromium override, English) | Nothing. The Chromium manifest uses a literal English title, so every listing language shows it. |
| CWS   | Short description    | `src/build/manifest.ts` (chromium override, English) | Nothing, for the same reason.                                                                    |
| CWS   | Detailed description | Section (a) below                                    | Paste it by hand under the Spanish listing language in the Developer Dashboard.                  |
| AMO   | Name                 | `_locales/es/messages.json` (`extensionName`)        | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Summary              | `_locales/es/messages.json` (`extensionDescription`) | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Detailed description | Section (b) below                                    | Paste it by hand into the es-ES locale in the AMO Developer Hub.                                 |

---

## (a) Chrome Web Store detailed description (plain text)

🛡️ Falsifica tu geolocalización, tu zona horaria y cualquier otra señal de ubicación, con un clic.

GeoSpoof es una extensión para Chrome que falsifica tu geolocalización y cambia tu ubicación, con la privacidad por delante. Activa un interruptor y todos los sitios leerán la ubicación falsa que elijas, no el lugar donde estás de verdad.

Un cambiador de ubicación básico solo mueve el pin del mapa. GeoSpoof va más allá: ajusta tu zona horaria, bloquea las fugas de IP por WebRTC y se sincroniza solo con tu VPN, para que cada señal coincida con el lugar que elegiste.

Elige una ciudad, escribe coordenadas exactas o deja que GeoSpoof se ajuste a tu VPN automáticamente. Desactívalo cuando quieras y tu ubicación real vuelve intacta.

🆕 Novedades de la 2.3.0: grupos de sitios, direcciones exactas y listas desde un enlace, tanto en Filtros como en Ubicaciones por sitio; Aleatorizar ubicación; y la pestaña Sitios y los Ajustes rediseñados.

⭐ Por qué elegir GeoSpoof en lugar de un cambiador de ubicación básico

1️⃣ Pon una ubicación GPS falsa con un clic: cualquier ciudad o coordenadas exactas.
2️⃣ Sincronizar con VPN: detecta la región de salida de tu VPN y ajusta tu ubicación a ella.
3️⃣ Sincronización automática en segundo plano: cambia de servidor VPN y tu ubicación lo sigue sola.
4️⃣ También la zona horaria: la hora y la fecha coinciden con tu ubicación, así no se contradicen.
5️⃣ Bloquea las fugas de WebRTC: tu IP real sigue oculta, incluso detrás de una VPN.
6️⃣ Spoofing a nivel de motor: el propio motor del navegador aplica tu zona horaria, también en workers y marcos de otros sitios, tan pronto como Chrome lo permite.
7️⃣ Antifingerprinting: todas las señales se mantienen coherentes y superan las comprobaciones que hacen los scripts de fingerprinting reales.
8️⃣ Ubicaciones por sitio: da a un sitio su propia ubicación mientras los demás siguen con tu ubicación principal.
9️⃣ Filtros: elige Todos los sitios, una Lista de permitidos o una Lista de bloqueados para decidir dónde funciona GeoSpoof.
🔟 Sin cuenta, sin rastreo, sin analíticas: todo se queda en tu dispositivo.

📍 Pon tu ubicación falsa como prefieras

▸ Busca por ciudad o dirección y cae justo en el sitio.
▸ Escribe la latitud y la longitud exactas a mano para una posición GPS limpia.
▸ Ajusta la precisión, desde realista hasta un valor propio en metros.
▸ Guarda hasta 50 lugares favoritos y cambia entre ellos con un toque.
▸ Los Ajustes, en el engranaje ⚙, ahora muestran primero lo que ven los sitios, con las opciones Avanzado y General debajo.

🎲 Aleatorizar ubicación

Los sitios pueden recibir un punto aleatorio cerca de la ubicación que elegiste en lugar del lugar exacto: en un radio de 0,5 km, 2 km o 10 km. Mantén el mismo punto o elige uno nuevo en cada sesión del navegador, cada hora o cada día.

El punto siempre se toma alrededor de la ubicación que elegiste en GeoSpoof, nunca alrededor de la real, y tu zona horaria sigue la ubicación que elegiste. Un compromiso que conviene conocer: un punto que cambia es más difícil de reconocer entre visitas, pero un sitio que reúna varios puntos puede promediarlos.

🧭 Decide dónde funciona, sitio por sitio

La pestaña Sitios rediseñada muestra el sitio en el que estás y la ubicación que ve, con un botón para añadirlo a tu lista o quitarlo.

▸ Filtros: en Modo de filtro, elige Todos los sitios, Lista de permitidos (solo los sitios de tu lista) o Lista de bloqueados (todos los sitios menos los de tu lista).
▸ Ubicaciones por sitio: Twitch puede ver Ciudad de México y ChatGPT puede ver Dublín, mientras todos los demás sitios ven Tokio. Si coinciden varias entradas, gana la más específica.
▸ Grupo de sitios: una sola entrada cubre todos los dominios de un servicio, como Google, Netflix u OpenAI, o una región como Sitios de China. Unos 1.500 grupos salen de la lista de dominios de v2fly, la que las herramientas de proxy llaman geosite, y GeoSpoof los actualiza más o menos una vez por semana.
▸ Solo la dirección exacta: coincide con mail.example.com y con ninguno de sus subdominios.
▸ Lista desde un enlace: pega un enlace https:// a una lista de dominios que ya uses para tu proxy. GeoSpoof la descarga y la actualiza cada semana.

Los grupos de sitios, las direcciones exactas y las listas desde un enlace funcionan tanto en Filtros como en Ubicaciones por sitio.

🌍 Falsifica tu geolocalización con o sin VPN

Una VPN cambia tu IP. GeoSpoof reescribe las coordenadas que tu navegador comunica mediante la API de geolocalización, y puede sincronizar ambas cosas.

Úsalo solo o combínalo con tu VPN para que tu IP, tu ubicación y tu zona horaria cuenten la misma historia.

🔒 La privacidad, primero

🔹 Todo se ejecuta en tu dispositivo: GeoSpoof nunca envía tu ubicación real a un servidor.
🔹 Sin cuenta, sin rastreo, sin analíticas. Los ajustes se guardan en local.
🔹 Tus filtros y tus ubicaciones por sitio nunca salen de tu dispositivo. Las actualizaciones de los grupos de sitios descargan el catálogo completo, así que ninguna solicitud revela qué grupos elegiste.
🔹 Una lista desde un enlace se descarga directamente del sitio que la aloja, que ve tu dirección IP, como en cualquier descarga.
🔹 Código abierto: revisa en GitHub exactamente lo que hace.
🔹 Desactiva la protección y tus coordenadas reales vuelven intactas.

💡 Para quién es

◆ Personas que cuidan su privacidad y no quieren que los sitios registren dónde están.
◆ Desarrolladores que prueban funciones de ubicación, zona horaria y región.
◆ Quien quiera acceder a contenidos y servicios de una región concreta.
◆ Usuarios de VPN que quieren que la ubicación del navegador coincida con su nodo de salida.

❓ Preguntas frecuentes

📌 ¿Los sitios seguirán viendo mi ubicación real?
💡 No. Mientras la protección está activa, el navegador devuelve el lugar que elegiste.

📌 ¿Es una VPN?
💡 No. GeoSpoof cambia las coordenadas que comunica tu navegador, no tu IP. Combina perfectamente con una VPN y hasta puede sincronizarse con ella automáticamente.

📌 ¿Puedo fijar un punto exacto?
💡 Sí. Escribe la latitud y la longitud exactas, o busca una ciudad, para falsificar el GPS de forma limpia.

📌 ¿También cambia mi zona horaria?
💡 Sí. GeoSpoof falsifica tu zona horaria junto con tu ubicación para que siempre coincidan, un detalle que delata a las herramientas que solo cambian la ubicación.

📌 ¿Es solo un cambiador de ubicación?
💡 Es un cambiador de ubicación y mucho más. GeoSpoof pone una ubicación falsa y además ajusta tu zona horaria y bloquea las fugas de WebRTC para que nada la contradiga.

📌 ¿Funciona en Google Maps?
💡 Sí. GeoSpoof funciona en cualquier sitio que use la API de geolocalización del navegador.

📌 ¿Mis datos están seguros?
💡 Sí. GeoSpoof funciona en local, no recopila nada y es de código abierto. Nada sobre tu ubicación sale de tu dispositivo.

📌 ¿Una ubicación por sitio cambia mi IP o la región de mi cuenta?
💡 No. Cambia lo que las páginas de ese sitio leen de tu navegador: la ubicación, la zona horaria y el idioma si lo configuras para que siga tu ubicación. Tu IP y los datos de tu cuenta no cambian, así que, para un resultado más coherente, combínala con una salida VPN en el mismo lugar.

📌 ¿Puede un sitio saber que uso GeoSpoof?
💡 No se puede descartar. GeoSpoof supera las comprobaciones que hacen los scripts de fingerprinting reales y mantiene todas las señales coherentes, pero ninguna extensión puede borrar todas las huellas: los mecanismos internos del motor y los canales laterales de temporización quedan fuera de su alcance. Compruébalo tú mismo en geospoof.com/test.

📌 ¿Tengo que registrarme?
💡 Sin cuenta y sin configuración. Instálalo y empieza a cambiar tu ubicación al momento.

📲 Ahora también en iPhone, iPad y Mac.

Las ubicaciones por sitio, los grupos de sitios y Aleatorizar ubicación son gratis en Chrome. En Safari, Filtros, Ubicaciones por sitio y Aleatorizar ubicación forman parte de GeoSpoof Pro, y los grupos de sitios, las direcciones exactas y las listas desde un enlace todavía no están disponibles.

Instala GeoSpoof, pon una ubicación falsa y decide exactamente qué sabe la web sobre dónde estás.

Enlaces:
— geospoof.com
— github.com/GeoSpoof/geospoof

---

## (b) AMO detailed description (Markdown)

Same rules as the English AMO copy: Markdown, bold lines instead of headings. Feature 6
describes Firefox's protection, not Chrome's Engine-level Spoofing.

**🛡️ Falsifica tu geolocalización, tu zona horaria y cualquier otra señal de ubicación, con un clic.**

GeoSpoof es una extensión para Firefox que **falsifica tu geolocalización** y **cambia tu ubicación**, con la privacidad por delante. Activa un interruptor y todos los sitios leerán la ubicación falsa que elijas, no el lugar donde estás de verdad.

Un cambiador de ubicación básico solo mueve el pin del mapa. GeoSpoof va más allá: ajusta tu **zona horaria**, bloquea las **fugas de IP por WebRTC** y se sincroniza solo con tu **VPN**, para que cada señal coincida con el lugar que elegiste.

Elige una ciudad, escribe coordenadas exactas o deja que GeoSpoof se ajuste a tu VPN automáticamente. Desactívalo cuando quieras y tu ubicación real vuelve intacta.

**🆕 Novedades de la 2.3.0:** grupos de sitios, direcciones exactas y listas desde un enlace, tanto en Filtros como en Ubicaciones por sitio; Aleatorizar ubicación; y la pestaña Sitios y los Ajustes rediseñados.

**⭐ Por qué elegir GeoSpoof en lugar de un cambiador de ubicación básico**

1. **Pon una ubicación GPS falsa con un clic**: cualquier ciudad o coordenadas exactas.
2. **Sincronizar con VPN**: detecta la región de salida de tu VPN y ajusta tu ubicación a ella.
3. **Sincronización automática en segundo plano**: cambia de servidor VPN y tu ubicación lo sigue sola.
4. **También la zona horaria**: la hora y la fecha coinciden con tu ubicación, así no se contradicen.
5. **Bloquea las fugas de WebRTC**: tu IP real sigue oculta, incluso detrás de una VPN.
6. **Protección de zona horaria en workers**: cubre los workers y el arranque de la página, con la Protección de zona horaria instantánea opcional desde el primer script de la página.
7. **Antifingerprinting**: todas las señales se mantienen coherentes y superan las comprobaciones que hacen los scripts de fingerprinting reales.
8. **Ubicaciones por sitio**: da a un sitio su propia ubicación mientras los demás siguen con tu ubicación principal.
9. **Filtros**: elige Todos los sitios, una Lista de permitidos o una Lista de bloqueados para decidir dónde funciona GeoSpoof.
10. **Sin cuenta, sin rastreo, sin analíticas**: todo se queda en tu dispositivo.

**📍 Pon tu ubicación falsa como prefieras**

- Busca por ciudad o dirección y cae justo en el sitio.
- Escribe la latitud y la longitud exactas a mano para una posición GPS limpia.
- Ajusta la precisión, desde realista hasta un valor propio en metros.
- Guarda hasta 50 lugares favoritos y cambia entre ellos con un toque.
- Los **Ajustes**, en el engranaje ⚙, ahora muestran primero lo que ven los sitios, con las opciones Avanzado y General debajo.

**🎲 Aleatorizar ubicación**

Los sitios pueden recibir un punto aleatorio cerca de la ubicación que elegiste en lugar del lugar exacto: en un radio de 0,5 km, 2 km o 10 km. Mantén el mismo punto o elige uno nuevo en cada sesión del navegador, cada hora o cada día.

El punto siempre se toma alrededor de la ubicación que elegiste en GeoSpoof, nunca alrededor de la real, y tu zona horaria sigue la ubicación que elegiste. Un compromiso que conviene conocer: un punto que cambia es más difícil de reconocer entre visitas, pero un sitio que reúna varios puntos puede promediarlos.

**🧭 Decide dónde funciona, sitio por sitio**

La pestaña **Sitios** rediseñada muestra el sitio en el que estás y la ubicación que ve, con un botón para añadirlo a tu lista o quitarlo.

- **Filtros**: en Modo de filtro, elige Todos los sitios, **Lista de permitidos** (solo los sitios de tu lista) o **Lista de bloqueados** (todos los sitios menos los de tu lista).
- **Ubicaciones por sitio**: Twitch puede ver Ciudad de México y ChatGPT puede ver Dublín, mientras todos los demás sitios ven Tokio. Si coinciden varias entradas, gana la más específica.
- **Grupo de sitios**: una sola entrada cubre todos los dominios de un servicio, como Google, Netflix u OpenAI, o una región como Sitios de China. Unos 1.500 grupos salen de la [lista de dominios de v2fly](https://github.com/v2fly/domain-list-community), la que las herramientas de proxy llaman `geosite`, y GeoSpoof los actualiza más o menos una vez por semana.
- **Solo la dirección exacta**: coincide con `mail.example.com` y con ninguno de sus subdominios.
- **Lista desde un enlace**: pega un enlace `https://` a una lista de dominios que ya uses para tu proxy. GeoSpoof la descarga y la actualiza cada semana.

Los grupos de sitios, las direcciones exactas y las listas desde un enlace funcionan tanto en Filtros como en Ubicaciones por sitio.

**🌍 Falsifica tu geolocalización con o sin VPN**

Una VPN cambia tu IP. GeoSpoof reescribe las coordenadas que tu navegador comunica mediante la API de geolocalización, y puede sincronizar ambas cosas.

Úsalo solo o combínalo con tu VPN para que tu IP, tu ubicación y tu zona horaria cuenten la misma historia.

**🔒 La privacidad, primero**

- Todo se ejecuta en tu dispositivo: GeoSpoof nunca envía tu ubicación real a un servidor.
- Sin cuenta, sin rastreo, sin analíticas. Los ajustes se guardan en local.
- Tus filtros y tus ubicaciones por sitio nunca salen de tu dispositivo. Las actualizaciones de los grupos de sitios descargan el catálogo completo, así que ninguna solicitud revela qué grupos elegiste.
- Una lista desde un enlace se descarga directamente del sitio que la aloja, que ve tu dirección IP, como en cualquier descarga.
- _Código abierto_: revisa en [GitHub](https://github.com/GeoSpoof/geospoof) exactamente lo que hace.
- Desactiva la protección y tus coordenadas reales vuelven intactas.

**💡 Para quién es**

- Personas que cuidan su privacidad y no quieren que los sitios registren dónde están.
- Desarrolladores que prueban funciones de ubicación, zona horaria y región.
- Quien quiera acceder a contenidos y servicios de una región concreta.
- Usuarios de VPN que quieren que la ubicación del navegador coincida con su nodo de salida.

**❓ Preguntas frecuentes**

📌 **¿Los sitios seguirán viendo mi ubicación real?** No. Mientras la protección está activa, el navegador devuelve el lugar que elegiste.

📌 **¿Es una VPN?** No. GeoSpoof cambia las coordenadas que comunica tu navegador, no tu IP. Combina perfectamente con una VPN y hasta puede sincronizarse con ella automáticamente.

📌 **¿Puedo fijar un punto exacto?** Sí. Escribe la latitud y la longitud exactas, o busca una ciudad, para falsificar el GPS de forma limpia.

📌 **¿También cambia mi zona horaria?** Sí. GeoSpoof falsifica tu zona horaria junto con tu ubicación para que siempre coincidan, un detalle que delata a las herramientas que solo cambian la ubicación.

📌 **¿Es solo un cambiador de ubicación?** Es un cambiador de ubicación y mucho más. GeoSpoof pone una ubicación falsa y además ajusta tu zona horaria y bloquea las fugas de WebRTC para que nada la contradiga.

📌 **¿Funciona en Google Maps?** Sí. GeoSpoof funciona en cualquier sitio que use la API de geolocalización del navegador.

📌 **¿Mis datos están seguros?** Sí. GeoSpoof funciona en local, no recopila nada y es de código abierto. Nada sobre tu ubicación sale de tu dispositivo.

📌 **¿Una ubicación por sitio cambia mi IP o la región de mi cuenta?** No. Cambia lo que las páginas de ese sitio leen de tu navegador: la ubicación, la zona horaria y el idioma si lo configuras para que siga tu ubicación. Tu IP y los datos de tu cuenta no cambian, así que, para un resultado más coherente, combínala con una salida VPN en el mismo lugar.

📌 **¿Puede un sitio saber que uso GeoSpoof?** No se puede descartar. GeoSpoof supera las comprobaciones que hacen los scripts de fingerprinting reales y mantiene todas las señales coherentes, pero ninguna extensión puede borrar todas las huellas: los mecanismos internos del motor y los canales laterales de temporización quedan fuera de su alcance. Compruébalo tú mismo en [geospoof.com/test](https://geospoof.com/test).

📌 **¿Tengo que registrarme?** Sin cuenta y sin configuración. Instálalo y empieza a cambiar tu ubicación al momento.

**📲 Ahora también en iPhone, iPad y Mac.**

Las ubicaciones por sitio, los grupos de sitios y Aleatorizar ubicación son gratis en Firefox. En Safari, Filtros, Ubicaciones por sitio y Aleatorizar ubicación forman parte de GeoSpoof Pro, y los grupos de sitios, las direcciones exactas y las listas desde un enlace todavía no están disponibles.

Instala GeoSpoof, pon una ubicación falsa y decide exactamente qué sabe la web sobre dónde estás.

Enlaces:

- [geospoof.com](https://geospoof.com)
- [GitHub](https://github.com/GeoSpoof/geospoof)
