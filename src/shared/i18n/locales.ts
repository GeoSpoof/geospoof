/**
 * Supported popup UI locales — the single source of truth shared by the popup
 * (language picker + override loader in src/popup/i18n.ts) and the background
 * settings validator (src/background/settings.ts).
 *
 * `code` is the `_locales/<code>/messages.json` directory name, using the
 * WebExtension convention of underscore region tags (e.g. `pt_BR`, `zh_CN`).
 * `endonym` is the language's own name, shown verbatim in the picker and
 * intentionally never translated (a Russian option reads "Русский" in every
 * UI language).
 *
 * Keep this list in sync with the directories under `_locales/`. The
 * locale-parity unit test guards message-key parity; this constant governs
 * which locales the popup actually offers as an override.
 */
export interface SupportedLocale {
  /** `_locales/<code>` directory name (WebExtension locale code). */
  code: string;
  /** The language's own name, displayed as-is in the picker. */
  endonym: string;
}

export const SUPPORTED_UI_LOCALES: readonly SupportedLocale[] = [
  { code: "en", endonym: "English" },
  { code: "de", endonym: "Deutsch" },
  { code: "es", endonym: "Español" },
  { code: "fr", endonym: "Français" },
  { code: "id", endonym: "Bahasa Indonesia" },
  { code: "ja", endonym: "日本語" },
  { code: "nl", endonym: "Nederlands" },
  { code: "pt_BR", endonym: "Português (Brasil)" },
  { code: "ru", endonym: "Русский" },
  { code: "sv", endonym: "Svenska" },
  { code: "vi", endonym: "Tiếng Việt" },
  { code: "zh_CN", endonym: "简体中文" },
  { code: "zh_TW", endonym: "繁體中文" },
] as const;

const LOCALE_CODES: readonly string[] = SUPPORTED_UI_LOCALES.map((l) => l.code);

/**
 * Map a `_locales` code to the language code Apple uses in the native app's
 * String Catalog (`geospoof-ios:app/Shared (App)/Resources/Localizable.xcstrings`).
 *
 * The two platforms spell the same languages differently: WebExtensions use
 * underscore region tags, while Apple uses hyphens and keys Chinese by *script*
 * rather than region. Only three of the thirteen differ:
 *
 *   `pt_BR` → `pt-BR`      (separator only)
 *   `zh_CN` → `zh-Hans`    (region → script)
 *   `zh_TW` → `zh-Hant`    (region → script)
 *
 * This lives here, beside the locale list itself, because it is the only bridge
 * between the extension's locale vocabulary and the native app's. Kept in one
 * place so the two cannot drift; consumed by the native-catalog parity test.
 * Nothing at runtime needs it — the extension never reads the native catalog and
 * the native app never reads `_locales`.
 */
export function toAppleLocaleCode(code: string): string {
  if (code === "zh_CN") return "zh-Hans";
  if (code === "zh_TW") return "zh-Hant";
  return code.replace("_", "-");
}

/** Whether `code` is a supported `_locales` directory code. */
export function isSupportedLocale(code: string): boolean {
  return LOCALE_CODES.includes(code);
}

/**
 * Pick the Chinese catalog for the subtags after `zh` (canonical: lowercased,
 * `_`-separated). A script subtag decides first (`hant` → Traditional, `hans`
 * → Simplified); otherwise Taiwan, Hong Kong and Macau get Traditional, and
 * everything else (bare `zh`, `zh_cn`, `zh_sg`) gets Simplified.
 */
function chineseLocaleFor(subtags: readonly string[]): "zh_TW" | "zh_CN" {
  if (subtags.includes("hant")) return "zh_TW";
  if (subtags.includes("hans")) return "zh_CN";
  return subtags.some((s) => s === "tw" || s === "hk" || s === "mo") ? "zh_TW" : "zh_CN";
}

/**
 * Map an arbitrary language tag (e.g. `"pt-BR"`, `"en_US"`, `"ru"`,
 * `"zh-Hans-CN"`, `"zh-HK"`) to a supported `_locales` code, or `null` when
 * none applies.
 *
 * Tries a region-qualified match first (so `"pt-BR"` → `"pt_BR"`), then falls
 * back to the base language (so `"pt"` and `"pt-PT"` also resolve to `"pt_BR"`,
 * the only Portuguese we ship). Chinese picks a script instead: `"zh-HK"`,
 * `"zh-MO"` and `"zh-Hant-*"` resolve to `"zh_TW"`, while `"zh"`, `"zh-SG"` and
 * `"zh-Hans-*"` resolve to `"zh_CN"`. Case- and separator-insensitive.
 */
export function normalizeToSupportedLocale(tag: string | null | undefined): string | null {
  if (!tag) return null;

  // Canonicalize to the `_locales` separator/casing space: "pt-BR" -> "pt_br".
  const canonical = tag.replace(/-/g, "_").toLowerCase();

  const exact = LOCALE_CODES.find((code) => code.toLowerCase() === canonical);
  if (exact) return exact;

  const subtags = canonical.split("_");
  const base = subtags[0];

  // Two Chinese catalogs share the primary subtag, so choose by script/region.
  if (base === "zh") {
    const chinese = chineseLocaleFor(subtags.slice(1));
    if (LOCALE_CODES.includes(chinese)) return chinese;
  }

  // Base-language fallback: compare the primary subtag on both sides so
  // "en_US" -> "en", "pt_pt" -> "pt" -> "pt_BR".
  return LOCALE_CODES.find((code) => code.toLowerCase().split("_")[0] === base) ?? null;
}

/**
 * Resolve the effective popup UI locale. An explicit, still-supported user
 * override wins; otherwise fall back to the browser UI language; otherwise
 * English. Always returns a supported code.
 *
 * @param override    The user's stored `uiLanguage` (`""`/unset means "follow
 *                    the browser").
 * @param browserTag  The browser UI language (e.g. `browser.i18n.getUILanguage()`).
 */
export function resolveUiLocale(
  override: string | null | undefined,
  browserTag: string | null | undefined
): string {
  return normalizeToSupportedLocale(override) ?? normalizeToSupportedLocale(browserTag) ?? "en";
}
