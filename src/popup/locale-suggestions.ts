/**
 * Typeahead suggestions for the Reported Language control.
 *
 * These are SUGGESTIONS, not a whitelist. The control is a text input backed by
 * a `<datalist>`, so any well-formed BCP47 tag the host engine supports can be
 * typed — this list just spares the common cases from being typed in full, which
 * is what makes "choose any language" workable inside a 350px popup instead of
 * needing an 800-entry picker.
 *
 * Each entry carries both the English name and the endonym (the language's own
 * name), because a `<datalist>` matches against the option's `value` and its
 * displayed text: including both means someone typing "French" and someone
 * typing "Français" both find `fr-FR`.
 *
 * The list is deliberately region-qualified. A bare `fr` leaves the region
 * implicit, and `Intl` then derives formats from a likely-subtag guess; naming
 * the region makes the number/date formats the site sees unambiguous.
 */

export interface LocaleSuggestion {
  /** Canonical BCP47 tag, e.g. "fr-FR". */
  tag: string;
  /** English name, e.g. "French (France)". */
  english: string;
  /** The language's own name, e.g. "Français (France)". */
  endonym: string;
}

/**
 * Common locales, ordered roughly by global web usage so the most likely picks
 * surface first in the dropdown before any filtering is applied.
 */
export const LOCALE_SUGGESTIONS: readonly LocaleSuggestion[] = [
  { tag: "en-US", english: "English (United States)", endonym: "English (United States)" },
  { tag: "en-GB", english: "English (United Kingdom)", endonym: "English (United Kingdom)" },
  { tag: "es-ES", english: "Spanish (Spain)", endonym: "Español (España)" },
  { tag: "es-MX", english: "Spanish (Mexico)", endonym: "Español (México)" },
  { tag: "es-AR", english: "Spanish (Argentina)", endonym: "Español (Argentina)" },
  { tag: "fr-FR", english: "French (France)", endonym: "Français (France)" },
  { tag: "fr-CA", english: "French (Canada)", endonym: "Français (Canada)" },
  { tag: "de-DE", english: "German (Germany)", endonym: "Deutsch (Deutschland)" },
  { tag: "de-AT", english: "German (Austria)", endonym: "Deutsch (Österreich)" },
  { tag: "de-CH", english: "German (Switzerland)", endonym: "Deutsch (Schweiz)" },
  { tag: "pt-BR", english: "Portuguese (Brazil)", endonym: "Português (Brasil)" },
  { tag: "pt-PT", english: "Portuguese (Portugal)", endonym: "Português (Portugal)" },
  { tag: "it-IT", english: "Italian (Italy)", endonym: "Italiano (Italia)" },
  { tag: "nl-NL", english: "Dutch (Netherlands)", endonym: "Nederlands (Nederland)" },
  { tag: "pl-PL", english: "Polish (Poland)", endonym: "Polski (Polska)" },
  { tag: "ru-RU", english: "Russian (Russia)", endonym: "Русский (Россия)" },
  { tag: "uk-UA", english: "Ukrainian (Ukraine)", endonym: "Українська (Україна)" },
  { tag: "tr-TR", english: "Turkish (Türkiye)", endonym: "Türkçe (Türkiye)" },
  { tag: "ar-SA", english: "Arabic (Saudi Arabia)", endonym: "العربية (السعودية)" },
  { tag: "ar-EG", english: "Arabic (Egypt)", endonym: "العربية (مصر)" },
  { tag: "he-IL", english: "Hebrew (Israel)", endonym: "עברית (ישראל)" },
  { tag: "fa-IR", english: "Persian (Iran)", endonym: "فارسی (ایران)" },
  { tag: "hi-IN", english: "Hindi (India)", endonym: "हिन्दी (भारत)" },
  { tag: "bn-BD", english: "Bengali (Bangladesh)", endonym: "বাংলা (বাংলাদেশ)" },
  { tag: "ta-IN", english: "Tamil (India)", endonym: "தமிழ் (இந்தியா)" },
  { tag: "th-TH", english: "Thai (Thailand)", endonym: "ไทย (ไทย)" },
  { tag: "vi-VN", english: "Vietnamese (Vietnam)", endonym: "Tiếng Việt (Việt Nam)" },
  { tag: "id-ID", english: "Indonesian (Indonesia)", endonym: "Indonesia (Indonesia)" },
  { tag: "ms-MY", english: "Malay (Malaysia)", endonym: "Melayu (Malaysia)" },
  { tag: "ja-JP", english: "Japanese (Japan)", endonym: "日本語 (日本)" },
  { tag: "ko-KR", english: "Korean (South Korea)", endonym: "한국어 (대한민국)" },
  { tag: "zh-CN", english: "Chinese, Simplified (China)", endonym: "简体中文 (中国)" },
  { tag: "zh-TW", english: "Chinese, Traditional (Taiwan)", endonym: "繁體中文 (台灣)" },
  { tag: "zh-HK", english: "Chinese, Traditional (Hong Kong)", endonym: "繁體中文 (香港)" },
  { tag: "sv-SE", english: "Swedish (Sweden)", endonym: "Svenska (Sverige)" },
  { tag: "da-DK", english: "Danish (Denmark)", endonym: "Dansk (Danmark)" },
  { tag: "nb-NO", english: "Norwegian Bokmål (Norway)", endonym: "Norsk bokmål (Norge)" },
  { tag: "fi-FI", english: "Finnish (Finland)", endonym: "Suomi (Suomi)" },
  { tag: "cs-CZ", english: "Czech (Czechia)", endonym: "Čeština (Česko)" },
  { tag: "sk-SK", english: "Slovak (Slovakia)", endonym: "Slovenčina (Slovensko)" },
  { tag: "hu-HU", english: "Hungarian (Hungary)", endonym: "Magyar (Magyarország)" },
  { tag: "ro-RO", english: "Romanian (Romania)", endonym: "Română (România)" },
  { tag: "bg-BG", english: "Bulgarian (Bulgaria)", endonym: "Български (България)" },
  { tag: "el-GR", english: "Greek (Greece)", endonym: "Ελληνικά (Ελλάδα)" },
  { tag: "hr-HR", english: "Croatian (Croatia)", endonym: "Hrvatski (Hrvatska)" },
  { tag: "sr-RS", english: "Serbian (Serbia)", endonym: "Српски (Србија)" },
  { tag: "sl-SI", english: "Slovenian (Slovenia)", endonym: "Slovenščina (Slovenija)" },
  { tag: "lt-LT", english: "Lithuanian (Lithuania)", endonym: "Lietuvių (Lietuva)" },
  { tag: "lv-LV", english: "Latvian (Latvia)", endonym: "Latviešu (Latvija)" },
  { tag: "et-EE", english: "Estonian (Estonia)", endonym: "Eesti (Eesti)" },
  { tag: "en-AU", english: "English (Australia)", endonym: "English (Australia)" },
  { tag: "en-CA", english: "English (Canada)", endonym: "English (Canada)" },
  { tag: "en-IN", english: "English (India)", endonym: "English (India)" },
  { tag: "en-ZA", english: "English (South Africa)", endonym: "English (South Africa)" },
  { tag: "af-ZA", english: "Afrikaans (South Africa)", endonym: "Afrikaans (Suid-Afrika)" },
  { tag: "sw-KE", english: "Swahili (Kenya)", endonym: "Kiswahili (Kenya)" },
  { tag: "ca-ES", english: "Catalan (Spain)", endonym: "Català (Espanya)" },
  { tag: "eu-ES", english: "Basque (Spain)", endonym: "Euskara (Espainia)" },
  { tag: "gl-ES", english: "Galician (Spain)", endonym: "Galego (España)" },
];

/**
 * A suggested tag's own name for its language (its endonym), matched
 * case-insensitively, or `null` for a tag that isn't in the list.
 */
export function endonymForTag(tag: string): string | null {
  const match = LOCALE_SUGGESTIONS.find((s) => s.tag.toLowerCase() === tag.toLowerCase());
  return match ? match.endonym : null;
}

/**
 * Human label for a tag, when it happens to be one of the suggestions.
 *
 * Returns `null` for anything not in the list — a freely typed tag is shown as
 * the bare tag rather than guessed at, since inventing a label for an arbitrary
 * locale would risk showing something wrong.
 */
export function labelForTag(tag: string): string | null {
  const match = LOCALE_SUGGESTIONS.find((s) => s.tag.toLowerCase() === tag.toLowerCase());
  if (!match) return null;
  // Show the endonym alongside the English name only when they differ, so
  // English locales don't read "English (France) — English (France)".
  return match.english === match.endonym ? match.english : `${match.english} — ${match.endonym}`;
}
