import type { Location, Timezone, Settings } from "@/shared/types/settings";

/**
 * Validate an IANA timezone identifier format.
 *
 * Accepts standard Area/Location patterns (e.g. "America/Los_Angeles"),
 * Area/Location/Sublocation (e.g. "America/Argentina/Buenos_Aires"),
 * hyphenated locations (e.g. "America/Port-au-Prince", "Africa/Porto-Novo"),
 * "UTC", "GMT", and Etc/GMT offset patterns (e.g. "Etc/GMT", "Etc/GMT+5", "Etc/GMT-5").
 */
export function isValidIANATimezone(identifier: unknown): boolean {
  if (!identifier || typeof identifier !== "string") {
    return false;
  }

  // Standard IANA: Area/Location or Area/Location/Sublocation. A location may
  // join words with single hyphens, as tzdata does for Haiti, Benin,
  // Blanc-Sablon and Ust-Nera; it can't start or end with one.
  const ianaPattern =
    /^[A-Z][a-zA-Z_]+\/[A-Z][a-zA-Z_]+(?:-[a-zA-Z_]+)*(?:\/[A-Z][a-zA-Z_]+(?:-[a-zA-Z_]+)*)?$/;

  // Etc/GMT offset patterns: Etc/GMT, Etc/GMT+N, Etc/GMT-N
  const etcGmtPattern = /^Etc\/GMT([+-]\d{1,2})?$/;

  return (
    ianaPattern.test(identifier) ||
    identifier === "UTC" ||
    identifier === "GMT" ||
    etcGmtPattern.test(identifier)
  );
}

/**
 * Type guard that checks whether a value is a valid Location object.
 *
 * Validates latitude (-90 to 90), longitude (-180 to 180), and accuracy > 0.
 */
export function isValidLocation(value: unknown): value is Location {
  return (
    typeof value === "object" &&
    value !== null &&
    "latitude" in value &&
    "longitude" in value &&
    "accuracy" in value &&
    typeof (value as Location).latitude === "number" &&
    typeof (value as Location).longitude === "number" &&
    typeof (value as Location).accuracy === "number" &&
    (value as Location).latitude >= -90 &&
    (value as Location).latitude <= 90 &&
    (value as Location).longitude >= -180 &&
    (value as Location).longitude <= 180 &&
    (value as Location).accuracy > 0
  );
}

/**
 * Type guard that checks whether a value is a valid Timezone object.
 *
 * Validates identifier (valid IANA timezone), offset (number), and dstOffset (number).
 */
export function isValidTimezone(value: unknown): value is Timezone {
  return (
    typeof value === "object" &&
    value !== null &&
    "identifier" in value &&
    "offset" in value &&
    "dstOffset" in value &&
    typeof (value as Timezone).identifier === "string" &&
    typeof (value as Timezone).offset === "number" &&
    typeof (value as Timezone).dstOffset === "number" &&
    isValidIANATimezone((value as Timezone).identifier)
  );
}

/**
 * Type guard that checks whether a value is a valid Settings object.
 *
 * Validates all required fields: enabled, location, timezone, locationName,
 * webrtcProtection, onboardingCompleted, version, and lastUpdated.
 */
export function isValidSettings(value: unknown): value is Settings {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const s = value as Partial<Settings>;

  return (
    typeof s.enabled === "boolean" &&
    (s.location === null || isValidLocation(s.location)) &&
    (s.timezone === null || isValidTimezone(s.timezone)) &&
    (s.locationName === null || isValidLocationName(s.locationName)) &&
    typeof s.webrtcProtection === "boolean" &&
    typeof s.onboardingCompleted === "boolean" &&
    typeof s.version === "string" &&
    typeof s.lastUpdated === "number"
  );
}

/**
 * Check whether a value looks like a valid LocationName object.
 */
function isValidLocationName(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "displayName" in value &&
    typeof value.displayName === "string"
  );
}
