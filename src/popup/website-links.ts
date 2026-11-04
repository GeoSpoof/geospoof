/**
 * Website Link Localization
 *
 * The popup links out to a handful of geospoof.com pages (e.g. "Verify
 * Protection", "Need help?"). Those pages exist in every language the marketing
 * site ships, served under a locale path prefix (`/fr/verify`, `/de/support`,
 * …) with English at the bare path (`/verify`). This module rewrites the popup's
 * outbound links so a visitor who reads the popup in French lands on the French
 * page instead of English.
 *
 * The rewrite is deliberately conservative: it only touches geospoof.com links
 * whose base path the site actually translates, and only for locales the site
 * actually renders. Anything else (store links, untranslated pages, locales the
 * site doesn't ship) is left exactly as authored — English at the bare path.
 *
 * Wiring: `localizeWebsiteLinks(locale)` is called from the popup init/language
 * paths (src/popup/index.ts) right after `applyI18n()`, so links track the same
 * effective UI locale as the translated text.
 */

/**
 * Extension `_locales` code → geospoof.com URL locale segment.
 *
 * `null` means "no prefix": either English (the site's default, served bare) or
 * a language the extension ships but the website does not, in which case we fall
 * back to the English page rather than link to a 404.
 *
 * The extension ships more UI locales than the site renders — `nl`, `sv`, and
 * `vi` have popup translations but no website, so they map to `null`. Note the
 * separator difference too: the extension uses WebExtension underscores
 * (`pt_BR`, `zh_CN`, `zh_TW`) while the site uses BCP-47 hyphen segments
 * (`pt-BR`, `zh-CN`, `zh-TW`), so this can't be a naive string transform — it's
 * an explicit map.
 *
 * Source of truth for the site side: geospoof-site:src/lib/i18n/locale-data.mjs
 * (`localeList`). Keep this in sync when the website gains or drops a locale.
 */
const SITE_LOCALE_SEGMENT: Readonly<Record<string, string | null>> = {
  en: null, // site default — served at the bare path, no prefix
  de: "de",
  es: "es",
  fr: "fr",
  id: "id",
  ja: "ja",
  nl: null, // no website locale — fall back to English
  pt_BR: "pt-BR",
  ru: "ru",
  sv: null, // no website locale — fall back to English
  vi: null, // no website locale — fall back to English
  zh_CN: "zh-CN",
  zh_TW: "zh-TW",
};

/**
 * Base paths the website serves a translated variant of. Only links whose path
 * is in this set get a locale prefix; any other geospoof.com link is left at the
 * bare (English) path so we never prefix a page that isn't actually localized.
 *
 * Mirrors the subset of `localizedBasePaths` in
 * geospoof-site:src/lib/i18n/locale-data.mjs that the popup actually links to. Add an
 * entry here when the popup gains a link to another localized site page.
 */
const SITE_LOCALIZED_PATHS: ReadonlySet<string> = new Set(["/verify", "/support"]);

/** True for `geospoof.com` and any subdomain (e.g. `www.geospoof.com`). */
function isGeospoofHost(hostname: string): boolean {
  return hostname === "geospoof.com" || hostname.endsWith(".geospoof.com");
}

/**
 * Rewrite a geospoof.com URL to the given extension locale's localized path,
 * preserving host, query string, and hash. Returns the input unchanged when the
 * link shouldn't be localized:
 *   - not a geospoof.com URL (store/review links, third parties)
 *   - the locale maps to `null` (English, or a site-unsupported language)
 *   - the path isn't one the site translates
 *   - the href isn't a parseable absolute URL
 *
 * @param href      The authored (English) link, e.g. `https://www.geospoof.com/verify?...`.
 * @param extLocale An extension `_locales` code, e.g. `"fr"`, `"pt_BR"`.
 */
export function localizeWebsiteHref(href: string, extLocale: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href; // relative/anchor href (e.g. the "#" review trigger) — leave it
  }

  if (!isGeospoofHost(url.hostname)) return href;

  const segment = SITE_LOCALE_SEGMENT[extLocale] ?? null;
  if (!segment) return href; // English/default or a locale the site doesn't serve

  // Normalize a trailing slash so "/verify" and "/verify/" match the set, but
  // don't let "/" collapse to "".
  const basePath = url.pathname.replace(/\/+$/, "") || "/";
  if (!SITE_LOCALIZED_PATHS.has(basePath)) return href;

  url.pathname = `/${segment}${basePath}`;
  return url.toString();
}

/**
 * Rewrite every `<a data-localize-href>` under `root` to the localized target
 * for `extLocale`. Idempotent: the first pass stashes each anchor's original
 * English href in `data-href-en`, and every pass recomputes from that, so
 * switching languages repeatedly always resolves from the canonical English URL
 * rather than a previously-localized one.
 *
 * @param extLocale An extension `_locales` code (as returned by `resolveUiLocale`).
 * @param root      Subtree to scan; defaults to the whole document.
 */
export function localizeWebsiteLinks(extLocale: string, root: ParentNode = document): void {
  const anchors = Array.from(root.querySelectorAll<HTMLAnchorElement>("a[data-localize-href]"));
  for (const anchor of anchors) {
    const original = anchor.dataset.hrefEn ?? anchor.getAttribute("href") ?? "";
    if (!original) continue;
    if (!anchor.dataset.hrefEn) anchor.dataset.hrefEn = original;
    anchor.setAttribute("href", localizeWebsiteHref(original, extLocale));
  }
}
