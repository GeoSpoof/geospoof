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
    "filters_syntaxTitle",
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
 * Site locations (GeoSpoof/geospoof#177): every new string is user-facing in
 * every language, and "Site locations" / "Main location" are glossary terms
 * the native app derives from these files.
 */
describe("Site locations keys are present in every locale", () => {
  const REQUIRED_KEYS = [
    "siteLocation_statusSite",
    "siteLocation_useMain",
    "siteLocation_hintAllowlist",
    "siteLocation_addToAllowlist",
    "siteLocation_hintDenylist",
    "siteLocation_hintVpn",
    "siteLocation_reloadHint",
    "siteLocation_sitesLabel",
    "siteLocation_sitesHint",
    "siteLocation_searchLabel",
    "siteLocation_favoriteLabel",
    "siteLocation_favoriteNone",
    "siteLocation_chosenNone",
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

  test("every data-i18n* key in the Site locations popup regions exists in en", () => {
    const html = readFileSync(resolve(__dirname, "../../assets/popup.html"), "utf-8");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const regions = [
      doc.getElementById("siteLocationLine"),
      doc.getElementById("siteLocationsDisclosure"),
      doc.getElementById("siteLocationEditor"),
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

  // Keys that lose their last use get removed, so translators aren't asked to
  // maintain strings nobody sees.
  test("every Site locations key in en is used", () => {
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

  test("all 12 locales are covered", () => {
    expect(listLocales()).toHaveLength(12);
  });

  describe.each(listLocales())("%s", (locale) => {
    const file = loadLocale(locale);
    test.each(REQUIRED_KEYS)("has a non-empty %s", (key) => {
      expect(typeof file[key]?.message).toBe("string");
      expect(file[key].message.trim().length).toBeGreaterThan(0);
    });
  });
});
