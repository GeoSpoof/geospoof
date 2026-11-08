# Store Listing Copy — Brazilian Portuguese

Brazilian Portuguese copy for the Chrome Web Store and AMO. It mirrors the English copy
in [`listing-copy.md`](listing-copy.md), section for section, with the same emoji. The
terms follow `_locales/pt_BR/messages.json` (falsificar, geolocalização, fuso horário,
Sincronizar com VPN, Sites, Filtros, Modo de filtro, Lista de permissões／Lista de
bloqueio, Localizações por site, Localização principal, Aleatorizar localização, Grupo
de sites, Somente o endereço exato, Lista de um link, Spoofing em nível de mecanismo,
Proteção instantânea de fuso horário) and its "você". It was written from the English,
not translated through another language, and **still needs review by a native
speaker**. When the English copy changes, update this file in the same commit.

## Where each field comes from

| Store | Field                | Source                                                  | What to do                                                                                       |
| ----- | -------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| CWS   | Title                | `src/build/manifest.ts` (chromium override, English)    | Nothing. The Chromium manifest uses a literal English title, so every listing language shows it. |
| CWS   | Short description    | `src/build/manifest.ts` (chromium override, English)    | Nothing, for the same reason.                                                                    |
| CWS   | Detailed description | Section (a) below                                       | Paste it by hand under the Portuguese (Brazil) listing language in the Developer Dashboard.      |
| AMO   | Name                 | `_locales/pt_BR/messages.json` (`extensionName`)        | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Summary              | `_locales/pt_BR/messages.json` (`extensionDescription`) | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Detailed description | Section (b) below                                       | Paste it by hand into the pt-BR locale in the AMO Developer Hub.                                 |

---

## (a) Chrome Web Store detailed description (plain text)

🛡️ Falsifique sua geolocalização, seu fuso horário e qualquer outro sinal de localização, com um clique.

O GeoSpoof é uma extensão para Chrome que falsifica sua geolocalização e muda sua localização, com a privacidade em primeiro lugar. Ligue um único botão e todo site passa a ler a localização falsa que você escolher, e não onde você realmente está.

Um mudador de localização comum só move o alfinete no mapa. O GeoSpoof vai além: ajusta seu fuso horário, bloqueia vazamentos de IP via WebRTC e se sincroniza sozinho com sua VPN, para que cada sinal combine com o lugar escolhido.

Escolha uma cidade, digite coordenadas exatas ou deixe o GeoSpoof acompanhar sua VPN automaticamente. Desligue quando quiser e sua localização real volta intacta.

🆕 Novidades da 2.3.0: grupos de sites, endereços exatos e listas de um link, tanto em Filtros quanto em Localizações por site; Aleatorizar localização; e a aba Sites e os Ajustes redesenhados.

⭐ Por que escolher o GeoSpoof em vez de um mudador de localização comum

1️⃣ Defina uma localização GPS falsa com um clique: qualquer cidade ou coordenadas exatas.
2️⃣ Sincronizar com VPN: detecta a região de saída da sua VPN e ajusta sua localização a ela.
3️⃣ Sincronização automática em segundo plano: troque de servidor VPN e sua localização acompanha sozinha.
4️⃣ Fuso horário também: hora e data combinam com sua localização, sem contradição entre os dois.
5️⃣ Bloqueie vazamentos de WebRTC: seu IP real continua oculto, mesmo atrás de uma VPN.
6️⃣ Spoofing em nível de mecanismo: o próprio mecanismo do navegador aplica seu fuso horário, inclusive em workers e frames de outros sites, o mais cedo que o Chrome permite.
7️⃣ Antifingerprinting: todos os sinais continuam coerentes e passam nas verificações que scripts de fingerprinting reais fazem.
8️⃣ Localizações por site: dê a um site sua própria localização enquanto todos os outros mantêm sua localização principal.
9️⃣ Filtros: escolha Todos os sites, uma Lista de permissões ou uma Lista de bloqueio para decidir onde o GeoSpoof atua.
🔟 Sem conta, sem rastreamento, sem análises: tudo fica no seu dispositivo.

📍 Defina sua localização falsa do jeito que preferir

▸ Pesquise por cidade ou endereço e caia exatamente no ponto certo.
▸ Digite latitude e longitude precisas à mão para uma posição GPS limpa.
▸ Ajuste a precisão, do realista a um valor próprio em metros.
▸ Salve até 50 lugares favoritos e alterne entre eles com um toque.
▸ Os Ajustes, na engrenagem ⚙, agora mostram primeiro o que os sites veem, com as opções Avançado e Geral logo abaixo.

🎲 Aleatorizar localização

Os sites podem receber um ponto aleatório perto da localização que você escolheu, em vez do lugar exato: em um raio de 0,5 km, 2 km ou 10 km. Mantenha o mesmo ponto ou escolha um novo a cada sessão do navegador, a cada hora ou a cada dia.

O ponto é sempre sorteado ao redor da localização que você escolheu no GeoSpoof, nunca ao redor da sua localização real, e seu fuso horário continua seguindo a localização escolhida. Uma troca que vale conhecer: um ponto que muda é mais difícil de reconhecer entre visitas, mas um site que junta vários pontos pode tirar a média deles.

🧭 Decida onde ele atua, site por site

A aba Sites redesenhada mostra o site em que você está e a localização que ele vê, com um botão para colocá-lo na sua lista ou tirá-lo dela.

▸ Filtros: em Modo de filtro, escolha Todos os sites, Lista de permissões (só os sites da sua lista) ou Lista de bloqueio (todos os sites, menos os da sua lista).
▸ Localizações por site: o Twitch pode ver a Cidade do México e o ChatGPT, Dublin, enquanto todos os outros sites veem Tóquio. Quando várias entradas combinam, vence a mais específica.
▸ Grupo de sites: uma única entrada cobre todos os domínios de um serviço, como Google, Netflix ou OpenAI, ou uma região como Sites da China. Cerca de 1.500 grupos vêm da lista de domínios do v2fly, que as ferramentas de proxy chamam de geosite, e o GeoSpoof os atualiza mais ou menos uma vez por semana.
▸ Somente o endereço exato: corresponde a mail.example.com e a nenhum dos seus subdomínios.
▸ Lista de um link: cole um link https:// para uma lista de domínios que você já usa no seu proxy. O GeoSpoof baixa a lista e a atualiza toda semana.

Grupos de sites, endereços exatos e listas de um link funcionam tanto em Filtros quanto em Localizações por site.

🌍 Falsifique sua geolocalização com ou sem VPN

Uma VPN muda seu IP. O GeoSpoof reescreve as coordenadas que seu navegador informa pela API de geolocalização, e pode sincronizar as duas coisas.

Use sozinho ou junto com sua VPN, para que seu IP, sua localização e seu fuso horário contem a mesma história.

🔒 Privacidade em primeiro lugar

🔹 Tudo roda no seu dispositivo: o GeoSpoof nunca envia sua localização real a um servidor.
🔹 Sem conta, sem rastreamento, sem análises. Os ajustes ficam salvos localmente.
🔹 Seus filtros e suas localizações por site nunca saem do seu dispositivo. As atualizações dos grupos de sites baixam o catálogo inteiro, então nenhuma solicitação revela quais grupos você escolheu.
🔹 Uma lista de um link é baixada direto do site que a hospeda, e esse site vê seu endereço IP, como em qualquer download.
🔹 Código aberto: confira no GitHub exatamente o que ele faz.
🔹 Desligue a proteção e suas coordenadas reais voltam intactas.

💡 Para quem é

◆ Pessoas que se preocupam com privacidade e não querem que os sites registrem onde elas estão.
◆ Desenvolvedores que testam recursos de localização, fuso horário e região.
◆ Quem quer acessar conteúdos e serviços de uma região específica.
◆ Usuários de VPN que querem que a localização do navegador combine com o nó de saída.

❓ Perguntas frequentes

📌 Os sites ainda vão ver minha localização real?
💡 Não. Enquanto a proteção estiver ligada, o navegador informa o lugar que você escolheu.

📌 Isto é uma VPN?
💡 Não. O GeoSpoof muda as coordenadas que seu navegador informa, não seu IP. Ele combina perfeitamente com uma VPN e pode até se sincronizar com ela automaticamente.

📌 Posso definir um ponto exato?
💡 Pode. Digite latitude e longitude precisas, ou pesquise uma cidade, para falsificar o GPS de forma limpa.

📌 Ele também muda meu fuso horário?
💡 Sim. O GeoSpoof falsifica seu fuso horário junto com sua localização para que os dois sempre combinem, um detalhe que entrega as ferramentas que só mudam a localização.

📌 É só um mudador de localização?
💡 É um mudador de localização e muito mais. O GeoSpoof define uma localização falsa e também ajusta seu fuso horário e bloqueia vazamentos de WebRTC para que nada a contradiga.

📌 Funciona no Google Maps?
💡 Sim. O GeoSpoof funciona em qualquer site que use a API de geolocalização do navegador.

📌 Meus dados estão seguros?
💡 Sim. O GeoSpoof roda localmente, não coleta nada e tem código aberto. Nada sobre sua localização sai do seu dispositivo.

📌 Uma localização por site muda meu IP ou a região da minha conta?
💡 Não. Ela muda o que as páginas daquele site leem do seu navegador: a localização, o fuso horário e o idioma, se você configurá-lo para acompanhar a localização. Seu IP e os dados da sua conta continuam os mesmos, então, para o resultado mais coerente, combine com uma saída de VPN no mesmo lugar.

📌 Um site consegue saber que eu uso o GeoSpoof?
💡 Não dá para descartar. O GeoSpoof passa nas verificações que scripts de fingerprinting reais fazem e mantém todos os sinais coerentes, mas nenhuma extensão consegue apagar todos os rastros: os mecanismos internos do motor do navegador e os canais laterais de tempo ficam fora do seu alcance. Confira você mesmo em geospoof.com/test.

📌 Preciso me cadastrar?
💡 Sem conta e sem configuração. Instale e comece a mudar sua localização na hora.

📲 Agora também no iPhone, iPad e Mac.

Localizações por site, grupos de sites e Aleatorizar localização são gratuitos no Chrome. No Safari, Filtros, Localizações por site e Aleatorizar localização fazem parte do GeoSpoof Pro, e grupos de sites, endereços exatos e listas de um link ainda não estão disponíveis.

Instale o GeoSpoof, defina uma localização falsa e decida exatamente o que a web sabe sobre onde você está.

Links:
— geospoof.com
— github.com/GeoSpoof/geospoof

---

## (b) AMO detailed description (Markdown)

Same rules as the English AMO copy: Markdown, bold lines instead of headings. Feature 6
describes Firefox's protection, not Chrome's Engine-level Spoofing.

**🛡️ Falsifique sua geolocalização, seu fuso horário e qualquer outro sinal de localização, com um clique.**

O GeoSpoof é uma extensão para Firefox que **falsifica sua geolocalização** e **muda sua localização**, com a privacidade em primeiro lugar. Ligue um único botão e todo site passa a ler a localização falsa que você escolher, e não onde você realmente está.

Um mudador de localização comum só move o alfinete no mapa. O GeoSpoof vai além: ajusta seu **fuso horário**, bloqueia **vazamentos de IP via WebRTC** e se sincroniza sozinho com sua **VPN**, para que cada sinal combine com o lugar escolhido.

Escolha uma cidade, digite coordenadas exatas ou deixe o GeoSpoof acompanhar sua VPN automaticamente. Desligue quando quiser e sua localização real volta intacta.

**🆕 Novidades da 2.3.0:** grupos de sites, endereços exatos e listas de um link, tanto em Filtros quanto em Localizações por site; Aleatorizar localização; e a aba Sites e os Ajustes redesenhados.

**⭐ Por que escolher o GeoSpoof em vez de um mudador de localização comum**

1. **Defina uma localização GPS falsa com um clique**: qualquer cidade ou coordenadas exatas.
2. **Sincronizar com VPN**: detecta a região de saída da sua VPN e ajusta sua localização a ela.
3. **Sincronização automática em segundo plano**: troque de servidor VPN e sua localização acompanha sozinha.
4. **Fuso horário também**: hora e data combinam com sua localização, sem contradição entre os dois.
5. **Bloqueie vazamentos de WebRTC**: seu IP real continua oculto, mesmo atrás de uma VPN.
6. **Proteção de fuso horário em workers**: cobre os workers e o início da página, com a Proteção instantânea de fuso horário opcional desde o primeiro script da página.
7. **Antifingerprinting**: todos os sinais continuam coerentes e passam nas verificações que scripts de fingerprinting reais fazem.
8. **Localizações por site**: dê a um site sua própria localização enquanto todos os outros mantêm sua localização principal.
9. **Filtros**: escolha Todos os sites, uma Lista de permissões ou uma Lista de bloqueio para decidir onde o GeoSpoof atua.
10. **Sem conta, sem rastreamento, sem análises**: tudo fica no seu dispositivo.

**📍 Defina sua localização falsa do jeito que preferir**

- Pesquise por cidade ou endereço e caia exatamente no ponto certo.
- Digite latitude e longitude precisas à mão para uma posição GPS limpa.
- Ajuste a precisão, do realista a um valor próprio em metros.
- Salve até 50 lugares favoritos e alterne entre eles com um toque.
- Os **Ajustes**, na engrenagem ⚙, agora mostram primeiro o que os sites veem, com as opções Avançado e Geral logo abaixo.

**🎲 Aleatorizar localização**

Os sites podem receber um ponto aleatório perto da localização que você escolheu, em vez do lugar exato: em um raio de 0,5 km, 2 km ou 10 km. Mantenha o mesmo ponto ou escolha um novo a cada sessão do navegador, a cada hora ou a cada dia.

O ponto é sempre sorteado ao redor da localização que você escolheu no GeoSpoof, nunca ao redor da sua localização real, e seu fuso horário continua seguindo a localização escolhida. Uma troca que vale conhecer: um ponto que muda é mais difícil de reconhecer entre visitas, mas um site que junta vários pontos pode tirar a média deles.

**🧭 Decida onde ele atua, site por site**

A aba **Sites** redesenhada mostra o site em que você está e a localização que ele vê, com um botão para colocá-lo na sua lista ou tirá-lo dela.

- **Filtros**: em Modo de filtro, escolha Todos os sites, **Lista de permissões** (só os sites da sua lista) ou **Lista de bloqueio** (todos os sites, menos os da sua lista).
- **Localizações por site**: o Twitch pode ver a Cidade do México e o ChatGPT, Dublin, enquanto todos os outros sites veem Tóquio. Quando várias entradas combinam, vence a mais específica.
- **Grupo de sites**: uma única entrada cobre todos os domínios de um serviço, como Google, Netflix ou OpenAI, ou uma região como Sites da China. Cerca de 1.500 grupos vêm da [lista de domínios do v2fly](https://github.com/v2fly/domain-list-community), que as ferramentas de proxy chamam de `geosite`, e o GeoSpoof os atualiza mais ou menos uma vez por semana.
- **Somente o endereço exato**: corresponde a `mail.example.com` e a nenhum dos seus subdomínios.
- **Lista de um link**: cole um link `https://` para uma lista de domínios que você já usa no seu proxy. O GeoSpoof baixa a lista e a atualiza toda semana.

Grupos de sites, endereços exatos e listas de um link funcionam tanto em Filtros quanto em Localizações por site.

**🌍 Falsifique sua geolocalização com ou sem VPN**

Uma VPN muda seu IP. O GeoSpoof reescreve as coordenadas que seu navegador informa pela API de geolocalização, e pode sincronizar as duas coisas.

Use sozinho ou junto com sua VPN, para que seu IP, sua localização e seu fuso horário contem a mesma história.

**🔒 Privacidade em primeiro lugar**

- Tudo roda no seu dispositivo: o GeoSpoof nunca envia sua localização real a um servidor.
- Sem conta, sem rastreamento, sem análises. Os ajustes ficam salvos localmente.
- Seus filtros e suas localizações por site nunca saem do seu dispositivo. As atualizações dos grupos de sites baixam o catálogo inteiro, então nenhuma solicitação revela quais grupos você escolheu.
- Uma lista de um link é baixada direto do site que a hospeda, e esse site vê seu endereço IP, como em qualquer download.
- _Código aberto_: confira no [GitHub](https://github.com/GeoSpoof/geospoof) exatamente o que ele faz.
- Desligue a proteção e suas coordenadas reais voltam intactas.

**💡 Para quem é**

- Pessoas que se preocupam com privacidade e não querem que os sites registrem onde elas estão.
- Desenvolvedores que testam recursos de localização, fuso horário e região.
- Quem quer acessar conteúdos e serviços de uma região específica.
- Usuários de VPN que querem que a localização do navegador combine com o nó de saída.

**❓ Perguntas frequentes**

📌 **Os sites ainda vão ver minha localização real?** Não. Enquanto a proteção estiver ligada, o navegador informa o lugar que você escolheu.

📌 **Isto é uma VPN?** Não. O GeoSpoof muda as coordenadas que seu navegador informa, não seu IP. Ele combina perfeitamente com uma VPN e pode até se sincronizar com ela automaticamente.

📌 **Posso definir um ponto exato?** Pode. Digite latitude e longitude precisas, ou pesquise uma cidade, para falsificar o GPS de forma limpa.

📌 **Ele também muda meu fuso horário?** Sim. O GeoSpoof falsifica seu fuso horário junto com sua localização para que os dois sempre combinem, um detalhe que entrega as ferramentas que só mudam a localização.

📌 **É só um mudador de localização?** É um mudador de localização e muito mais. O GeoSpoof define uma localização falsa e também ajusta seu fuso horário e bloqueia vazamentos de WebRTC para que nada a contradiga.

📌 **Funciona no Google Maps?** Sim. O GeoSpoof funciona em qualquer site que use a API de geolocalização do navegador.

📌 **Meus dados estão seguros?** Sim. O GeoSpoof roda localmente, não coleta nada e tem código aberto. Nada sobre sua localização sai do seu dispositivo.

📌 **Uma localização por site muda meu IP ou a região da minha conta?** Não. Ela muda o que as páginas daquele site leem do seu navegador: a localização, o fuso horário e o idioma, se você configurá-lo para acompanhar a localização. Seu IP e os dados da sua conta continuam os mesmos, então, para o resultado mais coerente, combine com uma saída de VPN no mesmo lugar.

📌 **Um site consegue saber que eu uso o GeoSpoof?** Não dá para descartar. O GeoSpoof passa nas verificações que scripts de fingerprinting reais fazem e mantém todos os sinais coerentes, mas nenhuma extensão consegue apagar todos os rastros: os mecanismos internos do motor do navegador e os canais laterais de tempo ficam fora do seu alcance. Confira você mesmo em [geospoof.com/test](https://geospoof.com/test).

📌 **Preciso me cadastrar?** Sem conta e sem configuração. Instale e comece a mudar sua localização na hora.

**📲 Agora também no iPhone, iPad e Mac.**

Localizações por site, grupos de sites e Aleatorizar localização são gratuitos no Firefox. No Safari, Filtros, Localizações por site e Aleatorizar localização fazem parte do GeoSpoof Pro, e grupos de sites, endereços exatos e listas de um link ainda não estão disponíveis.

Instale o GeoSpoof, defina uma localização falsa e decida exatamente o que a web sabe sobre onde você está.

Links:

- [geospoof.com](https://geospoof.com)
- [GitHub](https://github.com/GeoSpoof/geospoof)
