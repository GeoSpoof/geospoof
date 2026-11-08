/**
 * Store listing copy checks.
 *
 * The Chrome Web Store and AMO detailed descriptions are pasted by hand from
 * `assets/store-listings/listing-copy*.md` (neither dashboard has an API for
 * them). These checks keep one listing file per UI locale and keep each CWS
 * detailed description under the dashboard's 16,000-character limit.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(__dirname, "../..");
const LOCALES_DIR = join(ROOT, "_locales");
const LISTINGS_DIR = join(ROOT, "assets/store-listings");

/** The CWS dashboard rejects a detailed description longer than this. */
const CWS_DESCRIPTION_LIMIT = 16_000;

const CWS_HEADING =
  /^## (?:\(a\) Chrome Web Store detailed description|Detailed description \(paste into the Web Store dashboard)/;
const AMO_HEADING = /^## (?:\(b\) AMO detailed description|Detailed description \(paste into AMO)/;

function uiLocales(): string[] {
  return readdirSync(LOCALES_DIR)
    .filter((entry) => {
      const full = join(LOCALES_DIR, entry);
      return statSync(full).isDirectory() && existsSync(join(full, "messages.json"));
    })
    .sort();
}

/** `_locales` directory name → listing file name (`pt_BR` → `listing-copy.pt-BR.md`). */
function listingFile(locale: string): string {
  return locale === "en" ? "listing-copy.md" : `listing-copy.${locale.replace("_", "-")}.md`;
}

/** The text under the first heading matching `heading`, up to the next `---` line. */
function section(markdown: string, heading: RegExp): string | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim() === "---");
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

describe("Store listing copy", () => {
  const locales = uiLocales();

  test("there are UI locales to check", () => {
    expect(locales).toContain("en");
    expect(locales.length).toBeGreaterThan(1);
  });

  describe.each(locales)("%s", (locale) => {
    const path = join(LISTINGS_DIR, listingFile(locale));

    test(`has ${listingFile(locale)}`, () => {
      expect(existsSync(path)).toBe(true);
    });

    test("has a CWS detailed description under the store limit", () => {
      const cws = section(readFileSync(path, "utf-8"), CWS_HEADING);
      expect(cws).not.toBeNull();
      expect(cws!.length).toBeGreaterThan(1000);
      // String length counts UTF-16 code units, which is at least the code
      // point count, so this errs on the strict side for emoji.
      expect(cws!.length).toBeLessThan(CWS_DESCRIPTION_LIMIT);
    });

    test("has an AMO detailed description", () => {
      const amo = section(readFileSync(path, "utf-8"), AMO_HEADING);
      expect(amo).not.toBeNull();
      expect(amo!.length).toBeGreaterThan(1000);
    });
  });
});
