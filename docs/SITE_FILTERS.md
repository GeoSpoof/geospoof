# Site Filters

Site Filters let you control **which sites GeoSpoof spoofs on**. Instead of spoofing everywhere, you can limit spoofing to a list of sites (or spoof everywhere _except_ a list). Filters live in the **Filters** tab of the popup.

This page is the complete reference for what you can add to a filter list: typed patterns, exact addresses, site groups, and lists from a link. The popup shows a short "What patterns can I use?" summary; this page covers every form, the exact matching rules, and the limitations.

The **Type** menu next to the add field picks what you're adding: **Site and its subdomains** (the default), **Exact address only**, **Subdomains only**, **Site group**, or **List from a link**. You can also just type: `=` at the start means an exact address, `*.` means subdomains only, `geosite:` means a site group, and `list:` (or an `https://` link to a `.txt`, `.list`, `.conf`, `.yaml` or `.yml` file) means a list from a link. A kind you pick in the menu is never changed by what you type.

## The three modes

| Mode          | What it does                                                           |
| ------------- | ---------------------------------------------------------------------- |
| **All**       | Spoof on every site (the default). Filter lists are ignored.           |
| **Allowlist** | Spoof **only** on sites that match a pattern in the list.              |
| **Denylist**  | Spoof on every site **except** those that match a pattern in the list. |

The master **Location Protection** toggle is still the on/off switch. Mode only decides _which_ sites are spoofed _when_ protection is on.

## Pattern quick reference

| You type               | It matches                                                                    |
| ---------------------- | ----------------------------------------------------------------------------- |
| `example.com`          | the site **and** all its subdomains (`www.example.com`, `app.example.com`, …) |
| `*.example.com`        | subdomains only — **not** `example.com` itself                                |
| `*.ru`                 | any site ending in `.ru` (`example.ru`, `a.b.ru`, …)                          |
| `*`                    | any host                                                                      |
| `localhost`            | `localhost` on any port                                                       |
| `localhost:3000`       | `localhost`, port 3000 only                                                   |
| `127.0.0.1:8080`       | that IP address and port                                                      |
| `example.com/app/*`    | that path and everything under it                                             |
| `https://example.com`  | `https` only                                                                  |
| `*://example.com`      | any scheme                                                                    |
| `=mail.example.com`    | that exact address only, **not** its subdomains                               |
| `geosite:google`       | every site in the Google [site group](#site-groups)                           |
| `geosite:google@cn`    | only the Google group's sites tagged `cn`                                     |
| `list:https://…/x.txt` | every site in a [list from a link](#lists-from-a-link)                        |

A typed pattern has the shape `[scheme://]host[:port][/path]`. Only the `host` is required; everything else is optional. Site groups and lists from a link match by host only.

## Host matching

### Plain domains cover subdomains

A bare domain matches the domain **and every subdomain beneath it**:

- `example.com` matches `example.com`, `www.example.com`, `app.example.com`, `a.b.example.com`.

This is the most common form and usually what you want.

### `*.` matches subdomains only (this is the one to remember)

A leading `*.` matches subdomains but **excludes the apex**:

- `*.example.com` matches `www.example.com` and `app.example.com`, but **not** `example.com` itself.

> **The key gotcha.** `example.com` includes the apex; `*.example.com` does not. If you want the whole site, use the plain form `example.com`. Use `*.example.com` only when you deliberately want to leave the bare domain out.

### Wildcard TLDs and suffixes

Because `*.` matches any suffix, you can scope an entire top-level domain:

- `*.ru` matches `example.ru`, `shop.example.ru`, `a.b.ru` — any host that ends in `.ru`.

Handy for scoping traffic to whole country-code TLDs (`*.ru`, `*.cn`, `*.ir`, …).

### Any host

- `*` matches every host. In an allowlist it means "spoof everywhere" (same as All mode); in a denylist it means "spoof nowhere." Most useful combined with a path, e.g. `*/checkout/*`.

### localhost and IP addresses

Local development hosts work as first-class patterns:

- `localhost` — matches `localhost` on any port.
- `127.0.0.1` — matches that IPv4 address.

(Single-label hosts other than `localhost`, e.g. `intranet`, are **not** accepted — a bare label with no dot is rejected to avoid a stray word matching an entire TLD.)

### Internationalized domain names (IDN)

Non-ASCII (internationalized) domains work like any other host:

- `münchen.de` matches `münchen.de` and its subdomains.
- `*.рф` matches any host under the `.рф` top-level domain.

You type — and see — the domain in its normal Unicode form. GeoSpoof stores it that way and converts it to the DNS "Punycode" form (`xn--…`) internally when matching, so it lines up with how the browser reports the site's address. An already-encoded form like `xn--mnchen-3ya.de` is also accepted and kept as-is.

> **Look-alike domains.** GeoSpoof does not warn about mixed-script or "look-alike" (homograph) domains; a pattern matches by its encoded form regardless of script. Add internationalized patterns only for sites you recognize.

## Ports

Add `:port` to match a specific port. This is the main reason a plain domain filter used to fail for dev servers:

- `localhost:3000` matches `localhost` on port 3000 only.
- `example.com:8443` matches that host on port 8443 only.
- Omit the port (`localhost`) to match **any** port.

## Paths (sub-routes)

Add a path to scope spoofing to part of a site. Paths use `*` as a wildcard and match against the URL's path only:

- `example.com/app/*` matches `/app/`, `/app/dashboard`, `/app/x/y` — anything under `/app/`.
- `example.com/checkout` matches only the exact path `/checkout` (no trailing `*` means no prefix match).
- A pattern with no path (`example.com`) matches **any** path.

Common uses: spoof only on a mapping sub-route (`example.com/maps/*`), or, in denylist mode, suppress spoofing on a tracking sub-route (`example.com/analytics/*`).

## Schemes

By default a pattern matches both `http` and `https` (and nothing else — GeoSpoof only runs on `http`/`https` pages). You can pin the scheme:

- `https://example.com` — `https` only.
- `http://localhost:3000` — `http` only.
- `*://example.com` — any scheme.

## What is _not_ supported

- **Regular expressions.** `*` is the only wildcard. Patterns like `example\.(com|net)` or `/user/\d+` are rejected. This is deliberate — it keeps patterns readable and avoids a class of performance problems.
- **Wildcards inside a label.** `ap*.example.com` or `example.*` are rejected. `*` is allowed only as the whole host, as a leading `*.`, or inside a path.
- **Query strings and hash routes.** Path matching looks at the URL path only. `?query=…` and `#/hash/route` are ignored, so you can't filter on them.
- **IPv6 literals** (e.g. `[::1]:3000`) are not accepted in this version.

Anything invalid is rejected inline when you add it, so a bad pattern is never silently stored.

## Exact addresses

Pick **Exact address only**, or start the entry with `=`, to match one host and nothing beneath it:

- `=mail.example.com` matches `mail.example.com`, but **not** `example.com` or `a.mail.example.com`.
- `=localhost` matches `localhost` on any port.
- Scheme, port and path work as for other patterns: `=https://mail.example.com:8443`, `=example.com/app/*`.

The host can't contain `*`, because a wildcard isn't an exact address. An IP address is already exact, so `=127.0.0.1` is stored as `127.0.0.1`.

## Site groups

A site group is a ready-made list of the domains one service or category uses, such as every domain Google, Netflix or OpenAI serves from. Adding one entry covers all of them, and the list is kept up to date for you. The groups come from the [v2fly domain list](https://github.com/v2fly/domain-list-community) (MIT license), the same lists proxy tools such as v2ray, Xray and mihomo call `geosite`.

**Adding a group.** Pick **Site group** in the Type menu and start typing. The picker shows **Popular** groups first (Google, YouTube, Netflix, OpenAI, Anthropic, AI services, GitHub, and others, plus **China sites** and **Sites outside China**), then **All site groups**, about 1,500 in total. Each one shows how many sites it covers. Arrow keys, Enter and Escape work as in any search list.

**Typing it yourself.** `geosite:netflix` adds the Netflix group without opening the picker. Names use the v2fly spelling: lowercase letters, digits, `-` and `!` (`geosite:geolocation-!cn`).

**Tags.** Some sites in a group carry tags, such as `@cn` for a service's China domains or `@ads` for its ad domains. `geosite:google@cn` keeps only the Google sites tagged `cn`. Several tags must all be present: `geosite:apple@ads@cn` keeps only sites tagged both `ads` and `cn`. A tag that leaves nothing is rejected when you add it.

**Skipped rules.** A few upstream rules are regular expressions or keyword rules. GeoSpoof doesn't run those (typed patterns don't allow regex either), so they're skipped. The row's count ("964 sites") covers only the rules GeoSpoof uses, and a built-in group's row doesn't mention the skipped ones, since there's nothing you can do about them; a [list from a link](#lists-from-a-link) does show its skipped count. Everything else in the group matches as written: a plain entry covers the domain and its subdomains, and an upstream `full:` entry covers only that exact host.

**Updates.** GeoSpoof ships with a copy of the lists. While you use at least one group or list from a link, it checks for newer lists about once a week, and **Update now** under the list checks right away. The status line shows the date of the lists in use. If an update fails, the status line says so, and the lists already on your device stay in use. If a newer release drops a group you use or leaves it empty, GeoSpoof keeps using that group's last good copy; the row doesn't point this out.

**"Not available".** If a group's data is missing, the row shows **Not available** and the group matches no site. After browser storage was cleared, GeoSpoof rebuilds the data on its own at the next startup or update. On a browser where site groups aren't supported yet (Safari, for now), the entry stays **Not available** and matches no site until they are. While it matches nothing, an allowlist doesn't spoof that group's sites, and a denylist does spoof them. Your entry is never deleted.

## Lists from a link

Pick **List from a link** and paste an `https://` link to a domain list you already use, such as a Loyalsoldier `direct-list.txt` or a Clash rule provider. GeoSpoof downloads it when you add it and again every week. The row shows the file's name and how many sites it covers, for example "direct-list · 110,197 sites · from raw.githubusercontent.com". Hover over it for the full link.

**Accepted formats**, one rule per line, `#` comments allowed:

| Line                                | Means                                                  |
| ----------------------------------- | ------------------------------------------------------ |
| `example.com`, `domain:example.com` | the domain and its subdomains                          |
| `full:example.com`                  | that exact host only                                   |
| `DOMAIN-SUFFIX,example.com`         | the domain and its subdomains (Clash)                  |
| `DOMAIN,example.com`                | that exact host only (Clash)                           |
| `+.example.com`                     | the domain and its subdomains (mihomo)                 |
| a YAML file with a `payload:` list  | the same rules, unwrapped (Clash and mihomo providers) |

**mihomo files.** If any line uses `+.`, the file is in mihomo's domain format, where a plain line means that exact host only. GeoSpoof follows that rule, so in such a file `example.com` doesn't cover `www.example.com`.

**Skipped rules.** `regexp:`, `keyword:`, `DOMAIN-KEYWORD,`, `DOMAIN-REGEX,`, other rule types (such as `IP-CIDR,`), wildcard forms and invalid hosts are skipped and counted on the row.

**Limits.** A list can be up to 10 MB and 250,000 sites. The link must use `https://`, and after any redirects the download must end on an `https://` address. A link with no usable sites, a failed download, or a list over the limit is rejected, and nothing is stored. If a weekly re-download fails, the last good copy stays in use and the row says "Couldn't update this list".

**Memory with Instant timezone protection (Firefox).** To set the time zone before a page's first script runs, GeoSpoof copies the sites of your groups and lists into the early script Firefox runs in pages. Each open site's page process holds that copy: in our tests, a 110,000-site list made each page process about 25 MB larger. Firefox gives each site its own process, so the cost grows with the number of sites you have open. Small groups cost little, and with Instant timezone protection off there is no copy.

**Who sees the request.** The download goes from your browser straight to the link's host, without cookies. That host sees your IP address and that someone fetched the list, as with any download.

## Limitations and behavior notes

- **Site groups follow the tab, not each request.** Proxy tools apply a geosite list to every connection, so a Google font loaded on another site goes through the Google rule. GeoSpoof decides once per tab, from the address-bar host: on `example.com`, a Google group in your list doesn't apply to the Google content embedded there. Groups (and lists from a link) match the top-level page's host only, never its path, port or scheme.
- **The decision is made from the tab's top-level (address-bar) URL.** Every frame in the tab — including cross-origin iframes and embedded widgets — inherits the top-level page's decision. An iframe's own URL is never evaluated separately. A page Chrome prerenders in the background is judged by its own URL, the one it shows once opened. One exception on Firefox: a SharedWorker for which Firefox reports neither a tab nor the frames above it is judged by the document that started it, so one that an embedded frame starts can be spoofed on a page your Filters exclude, or left unspoofed on one they include (Known Limitation 12 in [API.md](API.md#known-limitations)).
- **Single-page apps (path filters).** When a site changes route without a full page load (History API), GeoSpoof re-evaluates and turns spoofing on/off for new activity. However, overrides already applied to objects the page created while in scope stay in effect until the page reloads. If you rely on path filtering on a heavy single-page app, a reload gives the cleanest result.
- **Trailing slash / `:*`.** `example.com/` is treated the same as `example.com` (whole site), and `example.com:*` the same as `example.com` (any port).
- **Case.** Scheme and host are case-insensitive; the path is case-sensitive.

## Per-site locations

The **Per-site locations** list at the bottom of the Filters tab gives specific sites their own location. It's a second, separate setting, not a kind of filter:

| Setting                | Decides                                               |
| ---------------------- | ----------------------------------------------------- |
| **Filters** (mode)     | **Whether** GeoSpoof is on for a site                 |
| **Per-site locations** | **Which** location it reports on a site where it's on |

Filters are checked first. If they keep GeoSpoof off for a site, its own location doesn't apply. Otherwise the matching location replaces the main location and time zone (and, with Reported Language on **Match my location**, the language); every other site keeps your main location, if you've set one. Neither setting changes your IP address. See [Per-site locations in the User Guide](USER_GUIDE.md#per-site-locations) for what that means in practice.

**Patterns are host-only.** Per-site locations use the same pattern language as filters, minus two forms:

- **No paths.** `example.com/app/*` is rejected: a page's location can't change with its path, and every frame in a tab already follows the top-level page.
- **No bare `*`.** `*`, `*://*`, and `*:8080` are rejected: per-site locations name specific sites, and your main location already covers "everything else".

Everything else works the same: `example.com` covers the site and its subdomains, `*.example.com` subdomains only, `*.ru` a whole TLD, `=mail.example.com` that exact address, plus ports (`localhost:3000`), schemes (`https://example.com`), internationalized domains, [site groups](#site-groups) and [lists from a link](#lists-from-a-link). Every entry accepted here is also a valid filter entry. The editor shows a location's sites as chips with the same Type menu as Filters. One location can list up to 10 entries, and a site group or a list from a link counts as one of them; you can have up to 50 locations. An entry can belong to only one of them, and the Unicode and `xn--` spellings of a domain (`münchen.de`, `xn--mnchen-3ya.de`) count as the same entry.

**The most specific entry wins**, whatever the order of the list, a bit like CSS specificity. Anything you typed beats any group, and a narrower group beats a broader one:

1. **A typed entry beats a site group or list from a link.** If `youtube.com` has one location and `geosite:google` another, YouTube pages get the `youtube.com` one.
2. Between typed entries, more host labels win: `www.example.com` beats `*.example.com`, which beats `*.com`.
3. For the same host, an exact `=example.com` beats `*.example.com` (subdomains only), which beats `example.com`.
4. Then an explicit `https://` or `http://` beats no scheme, which beats `*://`.
5. Then an explicit port beats none.
6. Between groups and lists from a link, the smaller one wins (fewer sites). `youtube.com` is in `geosite:youtube` (about 180 sites), `geosite:google` (about 960) and `geosite:geolocation-!cn` (about 25,000), so with a location on each, YouTube pages get the YouTube group's location, other Google sites get Google's, and the rest of the world outside China gets the third.

So on `https://www.example.com/`, a location set for `www.example.com` beats one for `*.example.com`, which beats one for `example.com`, which beats a group that contains `example.com`. A group whose data is missing ("Not available") matches nothing.

## Privacy

Your filter lists **never leave your device**. GeoSpoof evaluates them entirely in the extension background and only ever tells a page whether spoofing is on or off for it — it never sends the page your list. (Even the little site icons in the list are generated locally, so no favicon request reveals your list to anyone.)

Site groups add network requests, so here is exactly what they send:

- **Site group updates** go to `cdn.geospoof.com`, the developer's own CDN, about once a week and only while you use at least one group or list from a link (or press **Update now**). GeoSpoof downloads a small pointer file and, when there's a newer release, the **whole** catalog of every group. No request names a group, so nobody can tell from them which groups you picked. Like any request, it carries your IP address. No request is made if you use no groups.
- **Lists from a link** are downloaded from the link's own host, without cookies, when you add one and then weekly. That host sees your IP address.
- **Matching happens on your device.** No request ever names the site you're visiting.

## Availability

Site Filters work on Firefox, Chrome, and Safari and require no extra permissions. On iOS/macOS, per-site filtering is a **GeoSpoof Pro** feature — without Pro, spoofing applies everywhere (All mode). The core one-click spoofing path is always free.

Exact addresses, site groups and lists from a link are free on Firefox and Chrome. They're **not in Safari yet**: the Type menu there offers only typed patterns until the GeoSpoof app supports the new entries. When they arrive in Safari, they'll be part of GeoSpoof Pro, like the rest of Site Filters there.

## Examples

| Goal                                          | Mode      | Pattern(s)                                   |
| --------------------------------------------- | --------- | -------------------------------------------- |
| Spoof only on one site (and its subdomains)   | Allowlist | `example.com`                                |
| Spoof on every `.ru` site                     | Allowlist | `*.ru`                                       |
| Spoof everywhere except your bank             | Denylist  | `mybank.com`                                 |
| Spoof only your local dev server              | Allowlist | `localhost:3000`                             |
| Spoof only inside a site's app section        | Allowlist | `example.com/app/*`                          |
| Spoof everywhere except a tracking sub-route  | Denylist  | `example.com/analytics/*`                    |
| Spoof only on subdomains, not the apex        | Allowlist | `*.example.com`                              |
| Spoof only on one address, not its subdomains | Allowlist | `=mail.example.com`                          |
| Spoof only on streaming and AI services       | Allowlist | `geosite:netflix`, `geosite:category-ai-!cn` |
| Spoof everywhere except sites in China        | Denylist  | `geosite:cn`                                 |
| Spoof only on the sites in your proxy list    | Allowlist | `list:https://example.com/proxy-list.txt`    |
