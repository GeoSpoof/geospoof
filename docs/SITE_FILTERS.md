# Site Filters

Site Filters let you control **which sites GeoSpoof spoofs on**. Instead of spoofing everywhere, you can limit spoofing to a list of sites (or spoof everywhere _except_ a list). Filters live in the **Filters** tab of the popup.

This page is the complete reference for the pattern language you type into a filter list. The popup shows a short "What patterns can I use?" summary; this page covers every form, the exact matching rules, and the limitations.

## The three modes

| Mode          | What it does                                                           |
| ------------- | ---------------------------------------------------------------------- |
| **All**       | Spoof on every site (the default). Filter lists are ignored.           |
| **Allowlist** | Spoof **only** on sites that match a pattern in the list.              |
| **Denylist**  | Spoof on every site **except** those that match a pattern in the list. |

The master **Location Protection** toggle is still the on/off switch. Mode only decides _which_ sites are spoofed _when_ protection is on.

## Pattern quick reference

| You type              | It matches                                                                    |
| --------------------- | ----------------------------------------------------------------------------- |
| `example.com`         | the site **and** all its subdomains (`www.example.com`, `app.example.com`, …) |
| `*.example.com`       | subdomains only — **not** `example.com` itself                                |
| `*.ru`                | any site ending in `.ru` (`example.ru`, `a.b.ru`, …)                          |
| `*`                   | any host                                                                      |
| `localhost`           | `localhost` on any port                                                       |
| `localhost:3000`      | `localhost`, port 3000 only                                                   |
| `127.0.0.1:8080`      | that IP address and port                                                      |
| `example.com/app/*`   | that path and everything under it                                             |
| `https://example.com` | `https` only                                                                  |
| `*://example.com`     | any scheme                                                                    |

A pattern has the shape `[scheme://]host[:port][/path]`. Only the `host` is required; everything else is optional.

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

## Limitations and behavior notes

- **The decision is made from the tab's top-level (address-bar) URL.** Every frame in the tab — including cross-origin iframes and embedded widgets — inherits the top-level page's decision. An iframe's own URL is never evaluated separately.
- **Single-page apps (path filters).** When a site changes route without a full page load (History API), GeoSpoof re-evaluates and turns spoofing on/off for new activity. However, overrides already applied to objects the page created while in scope stay in effect until the page reloads. If you rely on path filtering on a heavy single-page app, a reload gives the cleanest result.
- **Trailing slash / `:*`.** `example.com/` is treated the same as `example.com` (whole site), and `example.com:*` the same as `example.com` (any port).
- **Case.** Scheme and host are case-insensitive; the path is case-sensitive.

## Per-site locations

The **Per-site locations** list at the bottom of the Filters tab gives specific sites their own location. It's a second, separate setting, not a kind of filter:

| Setting                | Decides                                               |
| ---------------------- | ----------------------------------------------------- |
| **Filters** (mode)     | **Whether** GeoSpoof is on for a site                 |
| **Per-site locations** | **Which** location it reports on a site where it's on |

Filters are checked first. If they keep GeoSpoof off for a site, its own location doesn't apply. Otherwise the matching location replaces the main location and time zone (and, with Reported Language on **Match my location**, the language); every other site keeps your main location. Neither setting changes your IP address. See [Per-site locations in the User Guide](USER_GUIDE.md#per-site-locations) for what that means in practice.

**Patterns are host-only.** Per-site locations use the same pattern language as filters, minus two forms:

- **No paths.** `example.com/app/*` is rejected: a page's location can't change with its path, and every frame in a tab already follows the top-level page.
- **No bare `*`.** `*`, `*://*`, and `*:8080` are rejected: per-site locations name specific sites, and your main location already covers "everything else".

Everything else works the same: `example.com` covers the site and its subdomains, `*.example.com` subdomains only, `*.ru` a whole TLD, plus ports (`localhost:3000`), schemes (`https://example.com`), and internationalized domains. Every pattern accepted here is also a valid filter pattern. One location can list up to 10 sites, separated by commas, and you can have up to 50. A pattern can belong to only one of them.

**The most specific pattern wins.** When several per-site locations match a page, the most specific pattern decides, whatever the order of the list:

1. More host labels win: `www.example.com` beats `*.example.com`, which beats `*.com`.
2. For the same host, `*.example.com` (subdomains only) beats `example.com`.
3. Then an explicit `https://` or `http://` beats no scheme, which beats `*://`.
4. Then an explicit port beats none.

So on `https://www.example.com/`, a location set for `www.example.com` beats one for `*.example.com`, which beats one for `example.com`.

## Privacy

Your filter lists **never leave your device**. GeoSpoof evaluates them entirely in the extension background and only ever tells a page whether spoofing is on or off for it — it never sends the page your list. (Even the little site icons in the list are generated locally, so no favicon request reveals your list to anyone.)

## Availability

Site Filters work on Firefox, Chrome, and Safari and require no extra permissions. On iOS/macOS, per-site filtering is a **GeoSpoof Pro** feature — without Pro, spoofing applies everywhere (All mode). The core one-click spoofing path is always free.

## Examples

| Goal                                         | Mode      | Pattern(s)                |
| -------------------------------------------- | --------- | ------------------------- |
| Spoof only on one site (and its subdomains)  | Allowlist | `example.com`             |
| Spoof on every `.ru` site                    | Allowlist | `*.ru`                    |
| Spoof everywhere except your bank            | Denylist  | `mybank.com`              |
| Spoof only your local dev server             | Allowlist | `localhost:3000`          |
| Spoof only inside a site's app section       | Allowlist | `example.com/app/*`       |
| Spoof everywhere except a tracking sub-route | Denylist  | `example.com/analytics/*` |
| Spoof only on subdomains, not the apex       | Allowlist | `*.example.com`           |
