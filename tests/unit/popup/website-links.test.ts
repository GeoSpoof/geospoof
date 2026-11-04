/**
 * Unit tests for the popup's outbound-link localizer (src/popup/website-links.ts).
 *
 * Two surfaces:
 *   - `localizeWebsiteHref` — the pure URL rewrite, exercised across the locale
 *     map (identity locales, the separator-mapped ones, and the site-unsupported
 *     ones that must fall back to English), non-geospoof hosts, and untranslated
 *     paths.
 *   - `localizeWebsiteLinks` — the DOM walker, exercised for idempotency (the
 *     whole reason it stashes the original English href): switching languages
 *     repeatedly must always resolve from English, never re-prefix an already
 *     localized URL.
 *
 * Guards against drift with geospoof-site:src/lib/i18n/locale-data.mjs — if the website
 * gains or drops a locale, the map here (and these expectations) should move
 * with it.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { localizeWebsiteHref, localizeWebsiteLinks } from "@/popup/website-links";

const VERIFY =
  "https://www.geospoof.com/verify?utm_source=extension&utm_medium=popup&utm_campaign=verify";
const SUPPORT =
  "https://www.geospoof.com/support?utm_source=extension&utm_medium=popup&utm_campaign=support";

describe("localizeWebsiteHref — locales the site serves get a prefix", () => {
  test("identity-mapped locales prefix the path", () => {
    expect(localizeWebsiteHref(VERIFY, "fr")).toBe(
      "https://www.geospoof.com/fr/verify?utm_source=extension&utm_medium=popup&utm_campaign=verify"
    );
    expect(localizeWebsiteHref(SUPPORT, "de")).toBe(
      "https://www.geospoof.com/de/support?utm_source=extension&utm_medium=popup&utm_campaign=support"
    );
    expect(localizeWebsiteHref(VERIFY, "es")).toContain("/es/verify");
    expect(localizeWebsiteHref(VERIFY, "id")).toContain("/id/verify");
    expect(localizeWebsiteHref(VERIFY, "ja")).toContain("/ja/verify");
    expect(localizeWebsiteHref(VERIFY, "ru")).toContain("/ru/verify");
  });

  test("underscore extension codes map to the site's hyphen segments", () => {
    // The extension uses WebExtension underscores; the site uses BCP-47 hyphens.
    expect(localizeWebsiteHref(VERIFY, "pt_BR")).toContain("/pt-BR/verify");
    expect(localizeWebsiteHref(VERIFY, "zh_CN")).toContain("/zh-CN/verify");
    expect(localizeWebsiteHref(VERIFY, "zh_TW")).toContain("/zh-TW/verify");
  });

  test("the UTM query string is preserved verbatim", () => {
    const out = new URL(localizeWebsiteHref(VERIFY, "fr"));
    expect(out.searchParams.get("utm_source")).toBe("extension");
    expect(out.searchParams.get("utm_medium")).toBe("popup");
    expect(out.searchParams.get("utm_campaign")).toBe("verify");
  });

  test("the apex host is handled too, not just www", () => {
    expect(localizeWebsiteHref("https://geospoof.com/verify", "fr")).toBe(
      "https://geospoof.com/fr/verify"
    );
  });

  test("a trailing slash still matches and is normalized away", () => {
    expect(localizeWebsiteHref("https://www.geospoof.com/verify/", "fr")).toBe(
      "https://www.geospoof.com/fr/verify"
    );
  });
});

describe("localizeWebsiteHref — English and site-unsupported locales stay bare", () => {
  test("English (the site default) is left at the bare path", () => {
    expect(localizeWebsiteHref(VERIFY, "en")).toBe(VERIFY);
  });

  test("locales the extension ships but the site does not fall back to English", () => {
    // nl/sv/vi have popup translations but no website — must not build /nl/verify.
    for (const locale of ["nl", "sv", "vi"]) {
      expect(localizeWebsiteHref(VERIFY, locale)).toBe(VERIFY);
    }
  });

  test("an unknown/garbage locale is left unchanged (defensive)", () => {
    expect(localizeWebsiteHref(VERIFY, "xx")).toBe(VERIFY);
    expect(localizeWebsiteHref(VERIFY, "")).toBe(VERIFY);
  });
});

describe("localizeWebsiteHref — only geospoof.com + translated paths are touched", () => {
  test("non-geospoof hosts pass through unchanged", () => {
    const store =
      "https://chromewebstore.google.com/detail/geospoof/abc/reviews?utm_source=extension";
    const apple = "https://apps.apple.com/app/apple-store/id6765719745?pt=128299974";
    expect(localizeWebsiteHref(store, "fr")).toBe(store);
    expect(localizeWebsiteHref(apple, "fr")).toBe(apple);
  });

  test("a lookalike host is not treated as geospoof.com", () => {
    const evil = "https://geospoof.com.evil.example/verify";
    expect(localizeWebsiteHref(evil, "fr")).toBe(evil);
  });

  test("geospoof.com paths the site does not localize are left bare", () => {
    // /gps and /pro aren't in the popup's localized set, so no prefix.
    const gps = "https://www.geospoof.com/gps?utm_source=extension";
    expect(localizeWebsiteHref(gps, "fr")).toBe(gps);
  });

  test("a non-absolute href (e.g. the '#' review trigger) is left unchanged", () => {
    expect(localizeWebsiteHref("#", "fr")).toBe("#");
  });
});

describe("localizeWebsiteLinks — DOM walker", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <a id="verify" href="${VERIFY}" data-localize-href>Verify</a>
      <a id="support" href="${SUPPORT}" data-localize-href>Help</a>
      <a id="store" href="https://apps.apple.com/app/id1?x=1">Store</a>
      <a id="untagged" href="${VERIFY}">Verify (untagged)</a>
    `;
  });

  const hrefOf = (id: string) =>
    (document.getElementById(id) as HTMLAnchorElement).getAttribute("href");

  test("rewrites only tagged geospoof.com anchors", () => {
    localizeWebsiteLinks("fr");
    expect(hrefOf("verify")).toContain("/fr/verify");
    expect(hrefOf("support")).toContain("/fr/support");
    // Untagged and non-geospoof anchors are never touched.
    expect(hrefOf("store")).toBe("https://apps.apple.com/app/id1?x=1");
    expect(hrefOf("untagged")).toBe(VERIFY);
  });

  test("is idempotent across language switches (recomputes from English)", () => {
    localizeWebsiteLinks("fr");
    localizeWebsiteLinks("de");
    // Must be /de/verify, NOT /de/fr/verify — the original English href is the
    // basis every time.
    expect(hrefOf("verify")).toContain("/de/verify");
    expect(hrefOf("verify")).not.toContain("/fr/");
  });

  test("switching back to English restores the bare path", () => {
    localizeWebsiteLinks("fr");
    localizeWebsiteLinks("en");
    expect(hrefOf("verify")).toBe(VERIFY);
  });

  test("switching to a site-unsupported locale restores the bare English path", () => {
    localizeWebsiteLinks("fr");
    localizeWebsiteLinks("sv");
    expect(hrefOf("verify")).toBe(VERIFY);
  });
});
