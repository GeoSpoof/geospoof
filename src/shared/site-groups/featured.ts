/**
 * Site groups shown first in the picker, under "Popular", in this order:
 * location-sensitive services (streaming, AI, social) plus the two China split
 * lists that proxy users rely on. Every name exists in the bundled catalog
 * (`tests/unit/scripts/build-catalog.test.ts` checks it).
 *
 * Brand names aren't translated (`label`). The three descriptive names come
 * from locale keys (`labelKey`). Aliases only affect search. Groups not listed
 * here show their slug as the name.
 */
export interface FeaturedSiteGroup {
  /** The catalog list name (the part after `geosite:`). */
  name: string;
  /** Untranslated brand label. */
  label?: string;
  /** Locale key for a descriptive label. */
  labelKey?: string;
  /** Extra search terms. */
  aliases?: readonly string[];
}

export const FEATURED_SITE_GROUPS: readonly FeaturedSiteGroup[] = [
  { name: "google", label: "Google" },
  { name: "youtube", label: "YouTube" },
  { name: "netflix", label: "Netflix" },
  { name: "openai", label: "OpenAI", aliases: ["chatgpt"] },
  { name: "anthropic", label: "Anthropic", aliases: ["claude"] },
  { name: "category-ai-!cn", labelKey: "siteGroups_nameAi", aliases: ["ai"] },
  { name: "github", label: "GitHub" },
  { name: "microsoft", label: "Microsoft" },
  { name: "apple", label: "Apple" },
  { name: "amazon", label: "Amazon" },
  { name: "primevideo", label: "Prime Video", aliases: ["prime"] },
  { name: "disney", label: "Disney" },
  { name: "hbo", label: "HBO", aliases: ["max"] },
  { name: "bbc", label: "BBC", aliases: ["iplayer"] },
  { name: "spotify", label: "Spotify" },
  { name: "tiktok", label: "TikTok" },
  { name: "x", label: "X (Twitter)", aliases: ["twitter"] },
  { name: "meta", label: "Meta", aliases: ["facebook", "instagram"] },
  { name: "twitch", label: "Twitch" },
  { name: "telegram", label: "Telegram" },
  { name: "cn", labelKey: "siteGroups_nameChina", aliases: ["china"] },
  { name: "geolocation-!cn", labelKey: "siteGroups_nameOutsideChina" },
];
