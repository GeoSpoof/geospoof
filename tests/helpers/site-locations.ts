/**
 * Shared Site locations fixtures: the main location (Tokyo) and two entries
 * (Dublin for chatgpt.com + openai.com, Mexico City for twitch.tv), matching
 * the scenario in the original feature request.
 */
import type { Location, LocationName, SiteLocation, Timezone } from "@/shared/types/settings";

export const TOKYO: Location = { latitude: 35.6762, longitude: 139.6503, accuracy: 45 };
export const TOKYO_TZ: Timezone = { identifier: "Asia/Tokyo", offset: 540, dstOffset: 0 };
export const TOKYO_NAME: LocationName = {
  city: "Tokyo",
  country: "Japan",
  displayName: "Tokyo, Japan",
};

export const DUBLIN: Location = { latitude: 53.3498, longitude: -6.2603, accuracy: 45 };
export const DUBLIN_TZ: Timezone = { identifier: "Europe/Dublin", offset: 0, dstOffset: 60 };
export const DUBLIN_NAME: LocationName = {
  city: "Dublin",
  country: "Ireland",
  displayName: "Dublin, Ireland",
};

export const MEXICO_CITY: Location = { latitude: 19.4326, longitude: -99.1332, accuracy: 45 };
export const MEXICO_CITY_TZ: Timezone = {
  identifier: "America/Mexico_City",
  offset: -360,
  dstOffset: 0,
};
export const MEXICO_CITY_NAME: LocationName = {
  city: "Mexico City",
  country: "Mexico",
  displayName: "Mexico City, Mexico",
};

/** Build a valid SiteLocation; overrides win. */
export function makeSiteLocation(overrides: Partial<SiteLocation> = {}): SiteLocation {
  return {
    id: "1700000000000",
    kind: "location",
    patterns: ["example.com"],
    location: DUBLIN,
    timezone: DUBLIN_TZ,
    locationName: DUBLIN_NAME,
    label: null,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Entry A: Dublin on chatgpt.com and openai.com. */
export const ENTRY_DUBLIN: SiteLocation = makeSiteLocation({
  id: "1700000000001",
  patterns: ["chatgpt.com", "openai.com"],
});

/** Entry B: Mexico City on twitch.tv. */
export const ENTRY_MEXICO_CITY: SiteLocation = makeSiteLocation({
  id: "1700000000002",
  patterns: ["twitch.tv"],
  location: MEXICO_CITY,
  timezone: MEXICO_CITY_TZ,
  locationName: MEXICO_CITY_NAME,
});
