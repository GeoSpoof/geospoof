/**
 * Locale parity tests.
 *
 * Ensures every `_locales/<lang>/messages.json` stays in sync with the
 * source-of-truth `en` locale. Translations that drift silently cause
 * UI bugs: extra keys are dead weight, missing placeholders break
 * runtime substitution (e.g. `$IP$` becoming literal "Detected IP: $IP$").
 *
 * Missing keys fall back to English at runtime, so they're only a
 * warning in the output — not a test failure. Extra keys and
 * placeholder mismatches fail the test.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

type MessageEntry = {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string; example?: string }>;
};

type MessagesFile = Record<string, MessageEntry>;

const LOCALES_DIR = resolve(__dirname, "../../_locales");
const SOURCE_LOCALE = "en";

/** Extract every `$PLACEHOLDER$` token from a message string, lowercased. */
function extractPlaceholders(message: string): Set<string> {
  const result = new Set<string>();
  const regex = /\$([A-Za-z0-9_]+)\$/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(message)) !== null) {
    result.add(match[1].toLowerCase());
  }
  return result;
}

function loadLocale(locale: string): MessagesFile {
  const path = join(LOCALES_DIR, locale, "messages.json");
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as MessagesFile;
}

function listLocales(): string[] {
  return readdirSync(LOCALES_DIR)
    .filter((entry) => {
      const full = join(LOCALES_DIR, entry);
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

describe("Locale parity", () => {
  const source = loadLocale(SOURCE_LOCALE);
  const sourceKeys = new Set(Object.keys(source));
  const sourcePlaceholdersByKey = new Map<string, Set<string>>();
  for (const [key, entry] of Object.entries(source)) {
    sourcePlaceholdersByKey.set(key, extractPlaceholders(entry.message));
  }

  const translatedLocales = listLocales().filter((l) => l !== SOURCE_LOCALE);

  test("at least one translated locale exists", () => {
    expect(translatedLocales.length).toBeGreaterThan(0);
  });

  test(`source locale '${SOURCE_LOCALE}' contains keys`, () => {
    expect(sourceKeys.size).toBeGreaterThan(0);
  });

  describe.each(translatedLocales)("%s", (locale) => {
    let file: MessagesFile;

    beforeAll(() => {
      file = loadLocale(locale);
    });

    test("parses as valid JSON", () => {
      // Handled by loadLocale above; assert file was populated.
      expect(file).toBeDefined();
      expect(typeof file).toBe("object");
    });

    test("does not introduce keys not in source", () => {
      const fileKeys = new Set(Object.keys(file));
      const extra = [...fileKeys].filter((k) => !sourceKeys.has(k));
      expect(extra).toEqual([]);
    });

    test("placeholder references match source for every shared key", () => {
      const mismatches: string[] = [];
      for (const [key, entry] of Object.entries(file)) {
        if (!sourceKeys.has(key)) continue;
        const sourceSet = sourcePlaceholdersByKey.get(key) ?? new Set<string>();
        const translatedSet = extractPlaceholders(entry.message);

        const missingPh = [...sourceSet].filter((p) => !translatedSet.has(p));
        const extraPh = [...translatedSet].filter((p) => !sourceSet.has(p));

        if (missingPh.length > 0) {
          mismatches.push(`"${key}" missing placeholder(s): ${missingPh.join(", ")}`);
        }
        if (extraPh.length > 0) {
          mismatches.push(`"${key}" has unexpected placeholder(s): ${extraPh.join(", ")}`);
        }
      }
      expect(mismatches).toEqual([]);
    });

    // Missing keys are intentionally a soft warning rather than a failure.
    // A partial translation is better than no translation — the browser
    // transparently falls back to `en` when a key is absent.
    test("missing keys (reported, not failed)", () => {
      const fileKeys = new Set(Object.keys(file));
      const missing = [...sourceKeys].filter((k) => !fileKeys.has(k));
      if (missing.length > 0) {
        console.warn(
          `[locales] ${locale} is missing ${missing.length} key(s) ` +
            `(will fall back to English): ${missing.slice(0, 5).join(", ")}` +
            (missing.length > 5 ? `, ... (+${missing.length - 5} more)` : "")
        );
      }
      // Always passes — this is informational only.
      expect(Array.isArray(missing)).toBe(true);
    });
  });
});

/**
 * Advanced Filtering (task 16): the syntax-reference panel strings are
 * user-facing in every language, so unlike the soft "missing keys" warning
 * above we hard-assert their presence with a non-empty message in every locale.
 */
describe("Advanced Filtering syntax keys are present in every locale", () => {
  const REQUIRED_KEYS = [
    "filters_help",
    "filters_syntaxDomain",
    "filters_syntaxSubdomains",
    "filters_syntaxTld",
    "filters_syntaxPort",
    "filters_syntaxPath",
    "filters_syntaxIdn",
    "filters_syntaxNotes",
  ];

  describe.each(listLocales())("%s", (locale) => {
    const file = loadLocale(locale);
    test.each(REQUIRED_KEYS)("has a non-empty %s", (key) => {
      expect(typeof file[key]?.message).toBe("string");
      expect(file[key].message.trim().length).toBeGreaterThan(0);
    });
  });
});

/**
 * Per-site locations (GeoSpoof/geospoof#177): every new string is user-facing
 * in every language, and "Per-site locations" / "Main location" are glossary
 * terms the native app derives from these files.
 */
describe("Per-site locations keys are present in every locale", () => {
  const REQUIRED_KEYS = [
    "siteLocation_statusSite",
    "siteLocation_useMain",
    "siteLocation_addToAllowlist",
    "siteLocation_hintVpn",
    "siteLocation_reloadHint",
    "siteLocation_sitesLabel",
    "siteLocation_searchLabel",
    "siteLocation_favorites",
    "siteLocation_explain",
    "siteLocation_save",
    "siteLocation_cancel",
    "siteLocation_errorPattern",
    "siteLocation_errorInUse",
    "siteLocation_editOwner",
    "siteLocation_errorCapacity",
    "siteLocation_errorTooManySites",
    "siteLocation_errorTimezone",
    "siteLocation_errorNoLocation",
    "siteLocation_sectionTitle",
    "siteLocation_sectionDesc",
    "siteLocation_add",
    "siteLocation_setForSite",
    "siteLocation_newLocation",
    "siteLocation_srcSite",
    "siteLocation_srcMain",
    "siteLocation_srcEntry",
    "siteLocation_useHereAria",
    "siteLocation_changeAria",
    "siteLocation_countLocations",
    "siteLocation_countLocationsOne",
    "siteLocation_noLocations",
    "siteLocation_notUsed",
    "siteLocation_notUsedOn",
    "siteLocation_somePages",
    "siteLocation_somePagesOn",
    "siteLocation_sitesAndMore",
    "siteLocation_edit",
    "siteLocation_editAriaLabel",
    "siteLocation_removeAriaLabel",
    "siteLocation_listAriaLabel",
    "siteLocation_proNote",
    "details_siteLocation",
    "badge_titleSiteLocation",
  ];

  describe.each(listLocales())("%s", (locale) => {
    const file = loadLocale(locale);
    test.each(REQUIRED_KEYS)("has a non-empty %s", (key) => {
      expect(typeof file[key]?.message).toBe("string");
      expect(file[key].message.trim().length).toBeGreaterThan(0);
    });
  });

  test("every data-i18n* key in the Filters and Per-site locations popup regions exists in en", () => {
    const html = readFileSync(resolve(__dirname, "../../assets/popup.html"), "utf-8");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const regions = [
      doc.getElementById("siteLocationLine"),
      doc.getElementById("filtersRoot"),
      doc.getElementById("scopeListScreen"),
      doc.getElementById("siteLocationsScreen"),
      doc.getElementById("siteLocationEditorScreen"),
      doc.getElementById("detailSiteLocationSection"),
    ];
    const source = loadLocale(SOURCE_LOCALE);
    const attrs = ["data-i18n", "data-i18n-placeholder", "data-i18n-aria-label", "data-i18n-title"];
    const keys: string[] = [];
    for (const region of regions) {
      expect(region).not.toBeNull();
      for (const attr of attrs) {
        region!.querySelectorAll(`[${attr}]`).forEach((node) => {
          keys.push(node.getAttribute(attr) ?? "");
        });
        if (region!.hasAttribute(attr)) keys.push(region!.getAttribute(attr) ?? "");
      }
    }
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => !(key in source))).toEqual([]);
  });

  // The feature's name is a glossary term: the list's accessible name and the
  // Pro note use the section title's exact words in every language.
  test.each(listLocales())("%s names the feature the same way everywhere", (locale) => {
    const file = loadLocale(locale);
    const title = file.siteLocation_sectionTitle.message;
    expect(file.siteLocation_listAriaLabel.message).toBe(title);
    expect(file.siteLocation_proNote.message.toLowerCase()).toContain(title.toLowerCase());
  });

  // Per-site strings use each locale's established words. Vietnamese says
  // "trang web" for a site, as Filters do ("trang" alone reads as "page"), and
  // both Chinese locales say 伪造/偽造 for spoofing, not 伪装/偽裝 ("disguise").
  test("vi says 'trang web' for a site, as its Sites tab does", () => {
    const vi = loadLocale("vi");
    expect(vi.filters_heading.message.toLowerCase()).toContain("trang web");
    expect(vi.siteLocation_sectionTitle.message).toMatch(/trang web$/);
    expect(vi.details_siteLocation.message).toContain("trang web");
  });

  test("zh_CN per-site strings say 伪造 for spoofing, as Details does", () => {
    const zh = loadLocale("zh_CN");
    expect(zh.details_spoofedLocation.message).toContain("伪造");
    expect(REQUIRED_KEYS.filter((key) => zh[key].message.includes("伪装"))).toEqual([]);
  });

  test("zh_TW per-site strings say 偽造 for spoofing, as Details does", () => {
    const zh = loadLocale("zh_TW");
    expect(zh.details_spoofedLocation.message).toContain("偽造");
    expect(REQUIRED_KEYS.filter((key) => zh[key].message.includes("偽裝"))).toEqual([]);
  });

  // German "Zulassungsliste" can't break, so its segment would grow and the
  // three come out unequal; a soft hyphen lets it break, in the segment only.
  test("de breaks the Allowlist segment with a soft hyphen, and only there", () => {
    const de = loadLocale("de");
    expect(de.filters_modeAllowlist.message).toBe("Zulassungs\u00ADliste");
    expect(de.filters_allowlistName.message).toBe("Zulassungsliste");
    for (const locale of listLocales()) {
      const file = loadLocale(locale);
      const withSoftHyphen = Object.keys(file).filter((key) =>
        file[key].message.includes("\u00AD")
      );
      expect(withSoftHyphen, locale).toEqual(locale === "de" ? ["filters_modeAllowlist"] : []);
    }
  });

  // The segments keep their short labels; a list used as a noun takes the
  // list's name. They differ in two locales, and match everywhere else.
  test("a list used as a noun takes the list's name, which differs from the segment in nl and vi", () => {
    const nouns: Record<string, [string, string]> = {
      nl: ["Toegestane sites", "Blokkeerlijst"],
      vi: ["Danh sách cho phép", "Danh sách chặn"],
    };
    for (const locale of listLocales()) {
      const file = loadLocale(locale);
      const allow = file.filters_allowlistName.message;
      const deny = file.filters_denylistName.message;
      if (locale in nouns) {
        expect([allow, deny], locale).toEqual(nouns[locale]);
        expect(allow).not.toBe(file.filters_modeAllowlist.message);
        expect(deny).not.toBe(file.filters_modeDenylist.message);
      } else {
        expect(allow, locale).toBe(file.filters_modeAllowlist.message.replace("\u00AD", ""));
        expect(deny, locale).toBe(file.filters_modeDenylist.message);
      }
    }
  });

  // The Per-site mark names the Sites tab (tab_filters) with the tab's own word.
  test.each(listLocales())("%s marks name the Sites tab with its tab label", (locale) => {
    const file = loadLocale(locale);
    const tab = file.tab_filters.message.toLowerCase();
    for (const key of ["siteLocation_notUsed", "siteLocation_notUsedOn"]) {
      expect(file[key].message.toLowerCase(), `${locale} ${key}`).toContain(tab.slice(0, 5));
    }
  });

  // Keys that lose their last use get removed, so translators aren't asked to
  // maintain strings nobody sees.
  test("every Per-site locations key in en is used", () => {
    const tsFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts")) tsFiles.push(full);
      }
    };
    walk(resolve(__dirname, "../../src"));
    const sources = [
      readFileSync(resolve(__dirname, "../../assets/popup.html"), "utf-8"),
      ...tsFiles.map((file) => readFileSync(file, "utf-8")),
    ];
    const keys = Object.keys(loadLocale(SOURCE_LOCALE)).filter((key) =>
      /^(siteLocation_|details_siteLocation|badge_titleSiteLocation)/.test(key)
    );
    expect(keys.length).toBeGreaterThan(0);
    const quoted = (key: string) => new RegExp(`["'\`]${key}["'\`]`);
    expect(keys.filter((key) => !sources.some((source) => quoted(key).test(source)))).toEqual([]);
  });
});

describe("Location precision cadence keys are present in every locale", () => {
  const REQUIRED_KEYS = [
    "advanced_precisionCadence",
    "advanced_precisionCadence_never",
    "advanced_precisionCadence_session",
    "advanced_precisionCadence_hour",
    "advanced_precisionCadence_day",
  ];

  test("all 13 locales are covered", () => {
    expect(listLocales()).toHaveLength(13);
  });

  describe.each(listLocales())("%s", (locale) => {
    const file = loadLocale(locale);
    test.each(REQUIRED_KEYS)("has a non-empty %s", (key) => {
      expect(typeof file[key]?.message).toBe("string");
      expect(file[key].message.trim().length).toBeGreaterThan(0);
    });
  });
});
