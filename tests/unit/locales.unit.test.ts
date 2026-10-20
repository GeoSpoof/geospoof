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
