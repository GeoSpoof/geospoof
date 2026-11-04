/**
 * Unit tests for the shared supported-locales module: tag normalization and
 * effective-locale resolution used by the popup language picker and the
 * background settings validator.
 */

import { describe, test, expect } from "vitest";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import {
  SUPPORTED_UI_LOCALES,
  isSupportedLocale,
  normalizeToSupportedLocale,
  resolveUiLocale,
  toAppleLocaleCode,
} from "@/shared/i18n/locales";

const LOCALES_DIR = join(__dirname, "../../../_locales");

describe("SUPPORTED_UI_LOCALES", () => {
  test("every supported code has a matching _locales directory", () => {
    const dirs = new Set(
      readdirSync(LOCALES_DIR).filter((e) => {
        try {
          return statSync(join(LOCALES_DIR, e)).isDirectory();
        } catch {
          return false;
        }
      })
    );
    for (const { code } of SUPPORTED_UI_LOCALES) {
      expect(dirs.has(code)).toBe(true);
    }
  });

  test("codes are unique and every entry has a non-empty endonym", () => {
    const codes = SUPPORTED_UI_LOCALES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const { endonym } of SUPPORTED_UI_LOCALES) {
      expect(endonym.trim().length).toBeGreaterThan(0);
    }
  });

  test("English is offered", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("xx")).toBe(false);
  });
});

describe("normalizeToSupportedLocale", () => {
  test("returns null for empty/unknown tags", () => {
    expect(normalizeToSupportedLocale("")).toBeNull();
    expect(normalizeToSupportedLocale(null)).toBeNull();
    expect(normalizeToSupportedLocale(undefined)).toBeNull();
    expect(normalizeToSupportedLocale("xx")).toBeNull();
    expect(normalizeToSupportedLocale("klingon")).toBeNull();
  });

  test("matches region-qualified tags to underscore codes", () => {
    expect(normalizeToSupportedLocale("pt-BR")).toBe("pt_BR");
    expect(normalizeToSupportedLocale("pt_BR")).toBe("pt_BR");
    expect(normalizeToSupportedLocale("zh-CN")).toBe("zh_CN");
  });

  test("falls back to the base language", () => {
    expect(normalizeToSupportedLocale("en-US")).toBe("en");
    expect(normalizeToSupportedLocale("ru")).toBe("ru");
    // Only pt_BR ships, so any Portuguese resolves to it.
    expect(normalizeToSupportedLocale("pt")).toBe("pt_BR");
    expect(normalizeToSupportedLocale("pt-PT")).toBe("pt_BR");
    // Extended tags fall back to the primary subtag.
    expect(normalizeToSupportedLocale("zh-Hans-CN")).toBe("zh_CN");
  });

  test("is case-insensitive", () => {
    expect(normalizeToSupportedLocale("PT-br")).toBe("pt_BR");
    expect(normalizeToSupportedLocale("RU")).toBe("ru");
  });

  test("Chinese picks Traditional by script first, then by region", () => {
    expect(normalizeToSupportedLocale("zh-TW")).toBe("zh_TW");
    expect(normalizeToSupportedLocale("zh_TW")).toBe("zh_TW");
    for (const tag of ["zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW", "zh-Hant-HK", "ZH-hant"]) {
      expect(normalizeToSupportedLocale(tag)).toBe("zh_TW");
    }
  });

  test("other Chinese tags stay on Simplified", () => {
    for (const tag of ["zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN", "zh-Hans-HK", "zh"]) {
      expect(normalizeToSupportedLocale(tag)).toBe("zh_CN");
    }
  });
});

describe("toAppleLocaleCode", () => {
  test("keys Chinese by script and swaps the separator elsewhere", () => {
    expect(toAppleLocaleCode("zh_TW")).toBe("zh-Hant");
    expect(toAppleLocaleCode("zh_CN")).toBe("zh-Hans");
    expect(toAppleLocaleCode("pt_BR")).toBe("pt-BR");
    expect(toAppleLocaleCode("ja")).toBe("ja");
  });
});

describe("resolveUiLocale", () => {
  test("a supported override wins over the browser tag", () => {
    expect(resolveUiLocale("ru", "en-US")).toBe("ru");
    expect(resolveUiLocale("pt-BR", "de")).toBe("pt_BR");
    expect(resolveUiLocale("zh_TW", "zh-CN")).toBe("zh_TW");
    expect(resolveUiLocale("zh_CN", "zh-TW")).toBe("zh_CN");
  });

  test("falls back to the browser tag when there is no override", () => {
    expect(resolveUiLocale("", "ru-RU")).toBe("ru");
    expect(resolveUiLocale(null, "ja")).toBe("ja");
    expect(resolveUiLocale(undefined, "zh-CN")).toBe("zh_CN");
    expect(resolveUiLocale(undefined, "zh-TW")).toBe("zh_TW");
    expect(resolveUiLocale(undefined, "zh-HK")).toBe("zh_TW");
  });

  test("falls back to English when neither is supported", () => {
    expect(resolveUiLocale("", "")).toBe("en");
    expect(resolveUiLocale("xx", "yy")).toBe("en");
    expect(resolveUiLocale(null, null)).toBe("en");
  });

  test("an unsupported override still defers to a supported browser tag", () => {
    expect(resolveUiLocale("xx", "fr-FR")).toBe("fr");
  });
});
