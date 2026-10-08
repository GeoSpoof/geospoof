/**
 * VPN Sync Module
 * Detects the user's public IP, geolocates it, and provides coordinates
 * for the VPN exit region. Includes caching and rate limiting.
 */

import { createLogger } from "@/shared/utils/debug-logger";
import { sessionGet, sessionSet, sessionDelete, sessionClearNamespace } from "./session-cache";
import { EndpointCooldown, ENDPOINT_COOLDOWN_MS, looksRateLimited } from "./endpoint-cooldown";

const logger = createLogger("BG");

/**
 * Log a geo-service error at the appropriate level. The parallel-geolocation
 * orchestrator aborts the losing services once one wins (and aborts an entire
 * in-flight batch when a newer sync supersedes it), which surfaces here as
 * `AbortError` / "Sync cancelled". Those are expected, healthy control flow —
 * log them at debug so only genuine failures show up as errors in the console.
 */
function logGeoError(tag: string, err: Error & { code?: string; blocked?: boolean }): void {
  const expected = err.name === "AbortError" || err.message === "Sync cancelled";
  const detail = {
    name: err.name,
    message: err.message,
    code: err.code,
    blocked: err.blocked,
  };
  if (expected) {
    logger.debug(`${tag} cancelled (expected):`, detail);
  } else {
    logger.error(`${tag} Error:`, detail);
  }
}

// --- Constants ---
const GEOJS_URL = "https://get.geojs.io/v1/ip/geo/"; // Primary — CORS-friendly, no key, no rate limits
const FREEIPAPI_URL = "https://free.freeipapi.com/api/json/"; // Fallback #1
const REALLYFREEGEOIP_URL = "https://reallyfreegeoip.org/json/"; // Fallback #2
const IPINFO_URL = "https://ipinfo.io/"; // Fallback #3 — Google Cloud, different network from Cloudflare
const REQUEST_TIMEOUT = 10000; // 10 seconds (IP detection)
const GEO_TIMEOUT = 5000; // 5 seconds per geo service (all run in parallel, worst case = 5s)
const GEO_MAX_RETRIES = 2; // retry on network failure (e.g. VPN transition)
const MIN_REQUEST_INTERVAL = 2000; // 2 seconds between API calls

// --- Persistent IP Geo Cache ---

const IP_GEO_CACHE_KEY = "ipGeoCache";
const IP_GEO_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

/**
 * Session-cache key holding the public IP that the currently-applied spoofed
 * location was derived from. Written on every successful sync (startup auto-sync,
 * manual popup sync, and proxy-change-triggered re-sync) so the proxy-change
 * watcher can cheaply decide whether a proxy change actually moved the exit IP
 * before spending a geolocation API call. Cleared when sync mode is disabled.
 */
const SYNCED_IP_KEY = "lastSyncedIp";

/**
 * Record the public IP behind the currently-applied spoofed location.
 */
export async function setLastSyncedIp(ip: string): Promise<void> {
  await sessionSet(SYNCED_IP_KEY, ip);
}

/**
 * Read the public IP behind the currently-applied spoofed location, or
 * undefined if no sync has happened this session.
 */
export async function getLastSyncedIp(): Promise<string | undefined> {
  return sessionGet<string>(SYNCED_IP_KEY);
}

interface IpGeoCacheEntry {
  result: IpGeolocationResult;
  cachedAt: number;
}

type IpGeoCacheStore = Record<string, IpGeoCacheEntry>;

async function persistentCacheGet(ip: string): Promise<IpGeolocationResult | undefined> {
  try {
    const store = (await browser.storage.local.get(IP_GEO_CACHE_KEY))[IP_GEO_CACHE_KEY] as
      IpGeoCacheStore | undefined;
    if (!store) return undefined;
    const entry = store[ip];
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > IP_GEO_CACHE_TTL) {
      logger.debug("[IP-GEO-CACHE] Entry for", ip, "expired, ignoring");
      return undefined;
    }
    logger.debug("[IP-GEO-CACHE] Persistent cache hit for", ip);
    return entry.result;
  } catch {
    return undefined;
  }
}

async function persistentCacheSet(ip: string, result: IpGeolocationResult): Promise<void> {
  try {
    const existing = (await browser.storage.local.get(IP_GEO_CACHE_KEY))[IP_GEO_CACHE_KEY] as
      IpGeoCacheStore | undefined;
    const store: IpGeoCacheStore = existing ?? {};
    store[ip] = { result, cachedAt: Date.now() };
    await browser.storage.local.set({ [IP_GEO_CACHE_KEY]: store });
    logger.debug("[IP-GEO-CACHE] Persisted geo result for", ip);
  } catch (error) {
    logger.warn("[IP-GEO-CACHE] Failed to persist cache entry:", error);
  }
}

async function persistentCacheClear(): Promise<void> {
  try {
    await browser.storage.local.remove(IP_GEO_CACHE_KEY);
  } catch (error) {
    logger.warn("[IP-GEO-CACHE] Failed to clear persistent cache:", error);
  }
}

// --- Types ---
export interface IpGeolocationResult {
  latitude: number;
  longitude: number;
  city: string;
  country: string;
  ip: string;
  /**
   * IANA timezone identifier reported by the geo service (e.g. "Asia/Singapore"),
   * when present and well-formed. Used as a high-quality fallback for timezone
   * resolution when the offline browser-geo-tz boundary lookup fails (e.g. a CDN
   * range-request hiccup), ahead of the crude longitude estimate. Optional —
   * not every provider/response includes it.
   */
  timezone?: string;
}

export interface VpnSyncError {
  error: "IP_DETECTION_FAILED" | "GEOLOCATION_FAILED" | "IP_BLOCKED" | "NETWORK";
  message: string;
}

export type VpnSyncResponse = IpGeolocationResult | VpnSyncError;

// --- FreeIPAPI Response Shape (internal) ---
interface FreeIpApiResponse {
  ipVersion: number;
  ipAddress: string;
  latitude: number;
  longitude: number;
  countryName: string;
  countryCode: string;
  cityName: string;
  regionName: string;
  continent: string;
  continentCode: string;
  isProxy: boolean;
  /**
   * FreeIPAPI returns `timeZones` (plural) — but it's the list of *all* IANA
   * zones in the IP's COUNTRY, alphabetical, not the zone for the city. For a
   * single-zone country it's a one-element array we can trust (e.g.
   * `["America/Caracas"]`); for a multi-zone country (US → 29 zones starting
   * with "America/Adak") the array can't disambiguate the actual location, so
   * it's unusable as a hint. We therefore only use it when length === 1. Older
   * responses occasionally use a singular `timeZone`; honor that too.
   */
  timeZones?: string[];
  timeZone?: string;
}

// --- geojs.io Response Shape (internal) ---
// Note: latitude and longitude are strings (historic API design)
interface GeoJsResponse {
  ip: string;
  city: string;
  country: string;
  latitude: string;
  longitude: string;
  timezone: string;
}

// --- reallyfreegeoip.org Response Shape (internal) ---
interface ReallyFreeGeoIpResponse {
  ip: string;
  city: string;
  country_name: string;
  latitude: number;
  longitude: number;
  time_zone: string;
}

// --- ipinfo.io Response Shape (internal) ---
// loc is "lat,lng" string e.g. "37.3861,-122.0839"
interface IpInfoResponse {
  ip: string;
  city: string;
  country: string;
  loc: string;
  timezone: string;
}
// --- Rate Limiting ---

async function throttle(): Promise<void> {
  const lastRequestTime = (await sessionGet<number>("vpnRateLimit")) ?? 0;
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL) {
    const waitTime = MIN_REQUEST_INTERVAL - elapsed;
    logger.debug("[THROTTLE] Waiting", waitTime, "ms (last request was", elapsed, "ms ago)");
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  } else {
    logger.debug("[THROTTLE] No wait needed (last request was", elapsed, "ms ago)");
  }
  await sessionSet("vpnRateLimit", Date.now());
}

// --- IP Validation ---

/**
 * Validate an IP address string (IPv4 or IPv6).
 */
export function isValidIpAddress(ip: string): boolean {
  if (typeof ip !== "string" || ip.length === 0) {
    return false;
  }

  // IPv4: four octets 0-255
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const ipv4Match = ip.match(ipv4);
  if (ipv4Match) {
    return ipv4Match.slice(1).every((octet) => {
      const n = parseInt(octet, 10);
      return n >= 0 && n <= 255;
    });
  }

  // IPv6: simplified check for colon-hex groups
  const ipv6 = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  return ipv6.test(ip);
}

// --- Public IP Detection ---

/**
 * An IP-echo endpoint: returns the requester's public (exit) IP. We deliberately
 * favor hyperscale CDN / cloud endpoints over small single-purpose services
 * (e.g. ipify), because the real rate-limit risk here isn't per-user volume —
 * it's *many users sharing one VPN exit IP* all hitting the same endpoint, so
 * the endpoint sees high volume from a single IP and may throttle it. Hyperscale
 * endpoints have the capacity to absorb that; ipify is kept only as a final,
 * independent fallback so we're never reliant on a single operator.
 *
 * Browsers can't do raw-UDP STUN (the native app's trick), so an HTTP echo is
 * the only option in the extension — but spreading across diverse operators
 * plus failover gets us the resilience STUN gives the app.
 */
interface IpEchoProvider {
  /** Short id for logs (the "winner"). */
  name: string;
  url: string;
  /** Extract the IP from the (plaintext) response body, or undefined if absent. */
  parse: (body: string) => string | undefined;
}

/**
 * Tried in order, first success wins (sequential failover, not a parallel race:
 * the happy path is a single request to the primary, which keeps total volume
 * minimal — only a failing/throttled provider costs an extra request). Ordered
 * by rate-limit resilience: AWS → Cloudflare → Akamai are all built for volume
 * and span three independent operators, so a throttle/outage at one doesn't
 * imply the others; ipify is the last-resort independent fallback.
 *
 * All return the IP as plaintext except Cloudflare's trace endpoint, which
 * returns `key=value` lines (we pull the `ip=` line).
 */
const IP_ECHO_PROVIDERS: IpEchoProvider[] = [
  {
    name: "aws",
    url: "https://checkip.amazonaws.com/",
    parse: (body) => body.trim(),
  },
  {
    name: "cloudflare",
    url: "https://www.cloudflare.com/cdn-cgi/trace",
    parse: (body) => {
      const line = body.split("\n").find((l) => l.startsWith("ip="));
      return line ? line.slice(3).trim() : undefined;
    },
  },
  {
    name: "akamai",
    url: "https://whatismyip.akamai.com/",
    parse: (body) => body.trim(),
  },
  {
    name: "ipify",
    url: "https://api.ipify.org/",
    parse: (body) => body.trim(),
  },
];

/**
 * Per-provider cooldown for the IP-echo endpoints. When a provider rate-limits
 * us (429/403 — most likely because many users share one VPN exit IP all
 * hitting the same endpoint), park it briefly and fail over to its siblings on
 * subsequent calls instead of re-hitting it every time.
 */
const ipEchoCooldown = new EndpointCooldown(ENDPOINT_COOLDOWN_MS, "IP-ECHO");

/**
 * Fetch one IP-echo provider with a per-attempt timeout. Resolves to the parsed,
 * validated IP, or throws (so the caller can fail over to the next provider).
 * The thrown error preserves HTTP 403/429 in its message so the resync gate's
 * rate-limit detector (`looksRateLimited`) can back off if *every* provider is
 * throttled.
 */
async function fetchPublicIpFrom(provider: IpEchoProvider): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  const start = Date.now();
  try {
    const response = await fetch(provider.url, {
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = await response.text();
    const ip = provider.parse(body)?.trim();
    if (!ip || !isValidIpAddress(ip)) {
      throw new Error("Invalid IP address in response");
    }
    logger.debug(`[IP-DETECT] ${provider.name} → ${ip} (${Date.now() - start}ms)`);
    return ip;
  } catch (error) {
    clearTimeout(timeoutId);
    const err = error instanceof Error ? error : new Error(String(error));
    const reason = err.name === "AbortError" ? "timeout" : err.message;
    throw new Error(reason);
  }
}

/**
 * Detect the user's public (exit) IP, trying each provider in order until one
 * answers. Logs the winning provider and how many failovers it took — mirroring
 * the "winner" logging on the geolocation race.
 * @throws Error with code IP_DETECTION_FAILED when every provider fails
 */
export async function detectPublicIp(): Promise<string> {
  const overallStart = Date.now();
  const failures: string[] = [];
  const providers = ipEchoCooldown.filterAvailable(IP_ECHO_PROVIDERS, (p) => p.name);

  for (const provider of providers) {
    try {
      const ip = await fetchPublicIpFrom(provider);
      if (failures.length === 0) {
        logger.info(
          `[IP-DETECT] Winner: ${provider.name} → ${ip} (${Date.now() - overallStart}ms)`
        );
      } else {
        logger.info(
          `[IP-DETECT] Winner: ${provider.name} → ${ip} (${Date.now() - overallStart}ms` +
            `, after ${failures.length} failover(s): ${failures.join(", ")})`
        );
      }
      return ip;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Park a provider that's actively throttling us so the next call fails
      // over to a sibling instead of re-hitting it.
      if (looksRateLimited(reason)) {
        ipEchoCooldown.markCoolingDown(provider.name);
      }
      failures.push(`${provider.name}: ${reason}`);
      logger.warn(`[IP-DETECT] ${provider.name} failed: ${reason}`);
    }
  }

  // Every provider failed. Preserve the per-provider reasons (including any
  // "HTTP 429"/"HTTP 403") so the resync gate can recognize a rate-limit and
  // back off the automatic path.
  const detail = failures.join("; ");
  logger.error(
    `[IP-DETECT] All ${providers.length} providers failed in ${Date.now() - overallStart}ms:`,
    detail
  );
  throw Object.assign(new Error(`IP detection failed (${detail})`), {
    code: "IP_DETECTION_FAILED",
  });
}

// --- IP Geolocation ---

/**
 * Normalize a geo-service-supplied timezone field to a trimmed non-empty string,
 * or undefined. Full IANA validation happens later (at the resolution site) via
 * `isValidIANATimezone`; here we only reject obviously absent/blank values.
 */
function normalizeTimezone(tz: unknown): string | undefined {
  if (typeof tz !== "string") return undefined;
  const trimmed = tz.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Fetch a geo service URL with custom User-Agent, timeout, and exponential backoff retry.
 * Custom User-Agent forces a fresh TCP connection (bypasses stale connection pool after VPN switch).
/**
 * Fetch a geo service URL with custom User-Agent, timeout, and exponential backoff retry.
 * Custom User-Agent forces a fresh TCP connection (bypasses stale connection pool after VPN switch).
 * externalSignal is the sync-level AbortSignal — if it fires, the entire sync was cancelled.
 */
async function fetchGeoWithRetry(
  url: string,
  timeoutMs: number,
  externalSignal: AbortSignal
): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= GEO_MAX_RETRIES; attempt++) {
    // Bail immediately if the sync was cancelled before we even start this attempt
    if (externalSignal.aborted) {
      throw Object.assign(new Error("Sync cancelled"), { code: "GEOLOCATION_FAILED" });
    }
    const controller = new AbortController();
    // Abort this attempt if either our per-attempt timeout fires OR the sync is cancelled
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: "no-store",
        mode: "cors",
        credentials: "omit",
      });
      clearTimeout(timeoutId);
      externalSignal.removeEventListener("abort", onExternalAbort);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      externalSignal.removeEventListener("abort", onExternalAbort);
      lastError = error instanceof Error ? error : new Error(String(error));
      // Don't retry on the last attempt, or if the sync was externally cancelled.
      // DO retry on AbortError from our own per-attempt timeout — a 0-bytes-sent abort
      // means the browser never dispatched the request (fetch queue stall). Retrying after
      // a short delay gives the browser a chance to clear the stall.
      if (attempt === GEO_MAX_RETRIES || externalSignal.aborted) {
        throw lastError;
      }
      const delay = 1000 * (attempt + 1);
      logger.debug(
        "[GEO-FETCH] Attempt",
        attempt + 1,
        "failed, retrying in",
        delay,
        "ms:",
        lastError.message
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError ?? new Error("Fetch failed");
}

/**
 * Geolocate an IP address to coordinates via FreeIPAPI (HTTPS).
 * @param ip - IPv4 or IPv6 address
 * @throws Error with code GEOLOCATION_FAILED or NETWORK
 */
async function geolocateWithFreeIpApi(
  ip: string,
  externalSignal: AbortSignal
): Promise<IpGeolocationResult> {
  const url = `${FREEIPAPI_URL}${ip}`;
  logger.debug("[IP-GEO] Fetching from:", url);

  try {
    const fetchStart = Date.now();
    const response = await fetchGeoWithRetry(url, GEO_TIMEOUT, externalSignal);
    logger.debug(
      "[IP-GEO] Fetch response received in",
      Date.now() - fetchStart,
      "ms, status:",
      response.status
    );

    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}`), {
        code: "GEOLOCATION_FAILED",
        blocked: response.status === 403,
      });
    }

    let data: FreeIpApiResponse;
    try {
      const jsonStart = Date.now();
      data = (await response.json()) as FreeIpApiResponse;
      logger.debug("[IP-GEO] JSON parsed in", Date.now() - jsonStart, "ms");
    } catch {
      throw Object.assign(new Error("Failed to parse geolocation response"), {
        code: "GEOLOCATION_FAILED",
      });
    }

    if (!data.ipAddress || !isValidIpAddress(data.ipAddress)) {
      throw Object.assign(new Error("Invalid IP address in geolocation response"), {
        code: "GEOLOCATION_FAILED",
      });
    }

    const { latitude, longitude } = data;
    if (
      typeof latitude !== "number" ||
      typeof longitude !== "number" ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw Object.assign(new Error("Invalid coordinates from geolocation service"), {
        code: "GEOLOCATION_FAILED",
      });
    }

    return {
      latitude,
      longitude,
      city: typeof data.cityName === "string" ? data.cityName : "",
      country: typeof data.countryName === "string" ? data.countryName : "",
      ip: data.ipAddress,
      // Only trust freeipapi's country zone list when it's unambiguous (a
      // single-zone country); a multi-zone list can't pinpoint the city, and
      // its alphabetical first entry (e.g. America/Adak for any US IP) would be
      // a wrong hint worse than none.
      timezone: normalizeTimezone(
        Array.isArray(data.timeZones) && data.timeZones.length === 1
          ? data.timeZones[0]
          : data.timeZone
      ),
    };
  } catch (error) {
    const err = error as Error & { code?: string; blocked?: boolean };
    logGeoError("[IP-GEO]", err);

    if (err.code === "GEOLOCATION_FAILED") {
      throw err;
    }

    if (err.name === "AbortError") {
      throw Object.assign(new Error("Geolocation request timed out"), {
        code: "GEOLOCATION_FAILED",
      });
    }

    throw Object.assign(new Error(err.message || "Network error during geolocation"), {
      code: "NETWORK",
    });
  }
}

/**
 * Geolocate an IP address to coordinates via geojs.io (PRIMARY service).
 * CORS-friendly, no API key, no rate limits.
 * Note: lat/lng returned as strings.
 * @param ip - IPv4 or IPv6 address
 * @throws Error with code GEOLOCATION_FAILED or NETWORK
 */
async function geolocateWithGeoJs(
  ip: string,
  externalSignal: AbortSignal
): Promise<IpGeolocationResult> {
  const url = `${GEOJS_URL}${ip}.json`;
  logger.debug("[IP-GEO-GEOJS] Fetching from:", url);

  try {
    const fetchStart = Date.now();
    const response = await fetchGeoWithRetry(url, GEO_TIMEOUT, externalSignal);
    logger.debug(
      "[IP-GEO-GEOJS] Fetch response received in",
      Date.now() - fetchStart,
      "ms, status:",
      response.status
    );

    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}`), {
        code: "GEOLOCATION_FAILED",
        blocked: response.status === 403,
      });
    }

    let data: GeoJsResponse;
    try {
      data = (await response.json()) as GeoJsResponse;
    } catch {
      throw Object.assign(new Error("Failed to parse geolocation response"), {
        code: "GEOLOCATION_FAILED",
      });
    }

    if (!data.ip || !isValidIpAddress(data.ip)) {
      throw Object.assign(new Error("Invalid IP address in geolocation response"), {
        code: "GEOLOCATION_FAILED",
      });
    }

    // geojs returns lat/lng as strings
    const latitude = parseFloat(data.latitude);
    const longitude = parseFloat(data.longitude);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw Object.assign(new Error("Invalid coordinates from geolocation service"), {
        code: "GEOLOCATION_FAILED",
      });
    }

    return {
      latitude,
      longitude,
      city: typeof data.city === "string" ? data.city : "",
      country: typeof data.country === "string" ? data.country : "",
      ip: data.ip,
      timezone: normalizeTimezone(data.timezone),
    };
  } catch (error) {
    const err = error as Error & { code?: string; blocked?: boolean };
    logGeoError("[IP-GEO-GEOJS]", err);

    if (err.code === "GEOLOCATION_FAILED") throw err;
    if (err.name === "AbortError") {
      throw Object.assign(new Error("Geolocation request timed out"), {
        code: "GEOLOCATION_FAILED",
      });
    }
    throw Object.assign(new Error(err.message || "Network error during geolocation"), {
      code: "NETWORK",
    });
  }
}

/**
 * Geolocate an IP address via reallyfreegeoip.org (Fallback #2).
 * No API key, no rate limits, HTTPS.
 */
async function geolocateWithReallyFreeGeoIp(
  ip: string,
  externalSignal: AbortSignal
): Promise<IpGeolocationResult> {
  const url = `${REALLYFREEGEOIP_URL}${ip}`;
  logger.debug("[IP-GEO-RFGI] Fetching from:", url);

  try {
    const fetchStart = Date.now();
    const response = await fetchGeoWithRetry(url, GEO_TIMEOUT, externalSignal);
    logger.debug(
      "[IP-GEO-RFGI] Fetch response received in",
      Date.now() - fetchStart,
      "ms, status:",
      response.status
    );

    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}`), {
        code: "GEOLOCATION_FAILED",
        blocked: response.status === 403,
      });
    }

    let data: ReallyFreeGeoIpResponse;
    try {
      data = (await response.json()) as ReallyFreeGeoIpResponse;
    } catch {
      throw Object.assign(new Error("Failed to parse geolocation response"), {
        code: "GEOLOCATION_FAILED",
      });
    }

    if (!data.ip || !isValidIpAddress(data.ip)) {
      throw Object.assign(new Error("Invalid IP address in geolocation response"), {
        code: "GEOLOCATION_FAILED",
      });
    }

    const { latitude, longitude } = data;
    if (
      typeof latitude !== "number" ||
      typeof longitude !== "number" ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw Object.assign(new Error("Invalid coordinates from geolocation service"), {
        code: "GEOLOCATION_FAILED",
      });
    }

    return {
      latitude,
      longitude,
      city: typeof data.city === "string" ? data.city : "",
      country: typeof data.country_name === "string" ? data.country_name : "",
      ip: data.ip,
      timezone: normalizeTimezone(data.time_zone),
    };
  } catch (error) {
    const err = error as Error & { code?: string; blocked?: boolean };
    logGeoError("[IP-GEO-RFGI]", err);

    if (err.code === "GEOLOCATION_FAILED") throw err;
    if (err.name === "AbortError") {
      throw Object.assign(new Error("Geolocation request timed out"), {
        code: "GEOLOCATION_FAILED",
      });
    }
    throw Object.assign(new Error(err.message || "Network error during geolocation"), {
      code: "NETWORK",
    });
  }
}

/**
 * Geolocate an IP address via ipinfo.io (Fallback #3).
 * Google Cloud network — different IP range from the Cloudflare-hosted primary/fallback #1.
 * Free tier: 50k requests/month. No API key required for basic fields.
 * Response: { ip, city, country, loc: "lat,lng" }
 */
async function geolocateWithIpInfo(
  ip: string,
  externalSignal: AbortSignal
): Promise<IpGeolocationResult> {
  const url = `${IPINFO_URL}${ip}/json`;
  logger.debug("[IP-GEO-IPINFO] Fetching from:", url);

  try {
    const fetchStart = Date.now();
    const response = await fetchGeoWithRetry(url, GEO_TIMEOUT, externalSignal);
    logger.debug(
      "[IP-GEO-IPINFO] Fetch response received in",
      Date.now() - fetchStart,
      "ms, status:",
      response.status
    );

    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}`), {
        code: "GEOLOCATION_FAILED",
        blocked: response.status === 403 || response.status === 429,
      });
    }

    let data: IpInfoResponse;
    try {
      data = (await response.json()) as IpInfoResponse;
    } catch {
      throw Object.assign(new Error("Failed to parse geolocation response"), {
        code: "GEOLOCATION_FAILED",
      });
    }

    if (!data.ip || !isValidIpAddress(data.ip)) {
      throw Object.assign(new Error("Invalid IP address in geolocation response"), {
        code: "GEOLOCATION_FAILED",
      });
    }

    // loc is "lat,lng"
    const parts = typeof data.loc === "string" ? data.loc.split(",") : [];
    const latitude = parseFloat(parts[0] ?? "");
    const longitude = parseFloat(parts[1] ?? "");
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw Object.assign(new Error("Invalid coordinates from geolocation service"), {
        code: "GEOLOCATION_FAILED",
      });
    }

    return {
      latitude,
      longitude,
      city: typeof data.city === "string" ? data.city : "",
      country: typeof data.country === "string" ? data.country : "",
      ip: data.ip,
      timezone: normalizeTimezone(data.timezone),
    };
  } catch (error) {
    const err = error as Error & { code?: string; blocked?: boolean };
    logGeoError("[IP-GEO-IPINFO]", err);

    if (err.code === "GEOLOCATION_FAILED") throw err;
    if (err.name === "AbortError") {
      throw Object.assign(new Error("Geolocation request timed out"), {
        code: "GEOLOCATION_FAILED",
      });
    }
    throw Object.assign(new Error(err.message || "Network error during geolocation"), {
      code: "NETWORK",
    });
  }
}

// --- Orchestrator ---

/**
 * An IP-geolocation service. Services are grouped into tiers (see
 * GEO_SERVICES_PRIMARY / GEO_SERVICES_FALLBACK) and raced within a tier. Each is
 * an independent third-party endpoint with its own rate-limit behavior, so each
 * gets its own cooldown: when one returns 429/403 (or otherwise signals it's
 * blocking the IP), it's dropped from the next race rather than poisoning the
 * whole sync path.
 */
interface GeoService {
  name: string;
  fn: (ip: string, signal: AbortSignal) => Promise<IpGeolocationResult>;
}

/**
 * Primary tier — providers that resolve VPN/hosting exit IPs to their actual
 * deployment city, raced in parallel. freeipapi and geojs are current,
 * MaxMind/GeoLite2-class sources that agree on real exit locations.
 *
 * ipinfo is deliberately NOT here: without an API token it reports the IP
 * range's *registration* location rather than its deployment, which is wrong
 * for VPN exits. Observed in the field on Datacamp VPN range 212.97.65.8 — a
 * Caracas exit that geojs/freeipapi/reallyfreegeoip all place in Caracas, but
 * keyless ipinfo places in Miami (the range's registration city). Because the
 * race takes the first city-level result and ipinfo is fast (Google Cloud), it
 * kept winning and pinning the wrong city into the 30-day cache. It now lives
 * in the fallback tier so it can only answer when every primary provider fails.
 */
const GEO_SERVICES_PRIMARY: GeoService[] = [
  { name: "freeipapi", fn: geolocateWithFreeIpApi },
  { name: "geojs", fn: geolocateWithGeoJs },
];

/**
 * Fallback tier — only consulted if every primary service fails, so nothing
 * here can win on latency alone and override a more accurate primary result.
 *
 * - reallyfreegeoip: a public freegeoip/GeoLite2-derived mirror prone to stale
 *   data on reassigned VPN exit ranges (reports registration, not deployment).
 * - ipinfo: keyless, returns registration-level location on VPN/hosting ranges
 *   (see GEO_SERVICES_PRIMARY). Kept only as a last resort on a different
 *   network (Google Cloud) so we still have an answer if everything else is
 *   down or blocked.
 */
const GEO_SERVICES_FALLBACK: GeoService[] = [
  { name: "reallyfreegeoip", fn: geolocateWithReallyFreeGeoIp },
  { name: "ipinfo", fn: geolocateWithIpInfo },
];

const geoCooldown = new EndpointCooldown(ENDPOINT_COOLDOWN_MS, "IP-GEO");

/**
 * Run one geo service, marking it as cooling down if it rate-limits / blocks
 * us before re-throwing so the failure still propagates into the Promise.any
 * aggregate.
 */
function runGeoService(
  svc: GeoService,
  ip: string,
  signal: AbortSignal
): Promise<IpGeolocationResult> {
  return svc.fn(ip, signal).catch((error: unknown) => {
    const err = error as Error & { blocked?: boolean };
    if (err.blocked === true || looksRateLimited(err.message ?? "")) {
      geoCooldown.markCoolingDown(svc.name);
    }
    throw error;
  });
}

/**
 * Does this result carry a usable city? An empty city is the tell-tale sign of
 * a country-only resolution — the provider couldn't place the IP and fell back
 * to the country centroid (e.g. geojs returns the US geographic center,
 * 37.751/-97.822, with `accuracy: 1000` km and no city for IPv6 ranges it can't
 * resolve). We treat a result with a city as strictly better than one without.
 */
function hasCity(result: IpGeolocationResult): boolean {
  return typeof result.city === "string" && result.city.trim().length > 0;
}

/**
 * Quality-aware geolocation race. Unlike a plain `Promise.any` (first *success*
 * wins, regardless of quality), this prefers a result that actually resolved to
 * a city over a country-only centroid:
 *
 *   - The first service to return a result WITH a city wins immediately — the
 *     common case stays as fast as the old race.
 *   - A city-less (country-centroid) result is held as a fallback; we keep
 *     waiting for a better answer instead of accepting it.
 *   - Only if every service finishes without a city do we return the held
 *     fallback. If every service *failed*, we reject with an AggregateError of
 *     their errors (matching the old `Promise.any` failure shape so the caller's
 *     IP_BLOCKED / timeout handling still works).
 *
 * The wait is bounded by each service's own GEO_TIMEOUT, so the worst case is no
 * slower than before.
 */
function raceGeoForBestResult(
  services: GeoService[],
  ip: string,
  signal: AbortSignal
): Promise<IpGeolocationResult> {
  return new Promise<IpGeolocationResult>((resolve, reject) => {
    const errors: Array<Error & { blocked?: boolean }> = [];
    let fallback: IpGeolocationResult | undefined;
    let remaining = services.length;
    let settled = false;

    const finishIfDone = () => {
      if (settled || remaining > 0) return;
      settled = true;
      if (fallback !== undefined) {
        logger.debug("[VPN-SYNC] No city-level result; using country-only fallback");
        resolve(fallback);
      } else {
        reject(new AggregateError(errors));
      }
    };

    for (const svc of services) {
      runGeoService(svc, ip, signal).then(
        (result) => {
          remaining--;
          if (settled) return;
          if (hasCity(result)) {
            settled = true;
            resolve(result);
            return;
          }
          // Country-only centroid — keep it only as a last resort and wait for
          // a service that can actually pinpoint a city.
          logger.debug(
            `[VPN-SYNC] ${svc.name} returned a country-only result; holding as fallback`
          );
          if (fallback === undefined) fallback = result;
          finishIfDone();
        },
        (error: unknown) => {
          remaining--;
          errors.push(error as Error & { blocked?: boolean });
          finishIfDone();
        }
      );
    }
  });
}

/**
 * Tiered geolocation. The primary tier (accurate, frequently-updated providers)
 * is raced for the best result. The fallback tier (GeoLite2-derived mirrors that
 * can report stale registration-country data on reassigned VPN exit ranges) is
 * consulted ONLY if every primary service fails — so a stale provider can never
 * win on latency alone and override a more accurate answer.
 *
 * Failures from both tiers are merged into a single AggregateError so the
 * caller's existing IP_BLOCKED / GEOLOCATION_FAILED handling is unchanged.
 */
async function geolocateTiered(ip: string, signal: AbortSignal): Promise<IpGeolocationResult> {
  const primary = geoCooldown.filterAvailable(GEO_SERVICES_PRIMARY, (s) => s.name);
  logger.info(
    "[VPN-SYNC] Geolocating IP:",
    ip,
    `(racing ${primary.length} primary service(s) in parallel: ${primary
      .map((s) => s.name)
      .join(", ")})`
  );

  try {
    return await raceGeoForBestResult(primary, ip, signal);
  } catch (primaryErr) {
    // If the batch was aborted (e.g. a newer sync started), don't burn the
    // fallback tier — just propagate.
    if (signal.aborted) throw primaryErr;

    const fallback = geoCooldown.filterAvailable(GEO_SERVICES_FALLBACK, (s) => s.name);
    logger.warn(
      `[VPN-SYNC] All primary geo services failed; falling back to: ${fallback
        .map((s) => s.name)
        .join(", ")}`
    );

    try {
      return await raceGeoForBestResult(fallback, ip, signal);
    } catch (fallbackErr) {
      throw new AggregateError([...flattenAggregate(primaryErr), ...flattenAggregate(fallbackErr)]);
    }
  }
}

/** Expand an AggregateError into its constituent errors; pass anything else through as a singleton. */
function flattenAggregate(error: unknown): unknown[] {
  return error instanceof AggregateError ? (error.errors as unknown[]) : [error];
}

/**
 * Clear all per-endpoint cooldowns (IP-echo + geo services). Called on a
 * user-initiated manual sync — the user is explicitly asking us to try now, so
 * we drop any "park this endpoint" state and give every endpoint a fresh shot.
 */
export function clearEndpointCooldowns(): void {
  ipEchoCooldown.clear();
  geoCooldown.clear();
}

// In-flight sync promise — deduplicates concurrent calls so multiple rapid button presses
// don't saturate the browser's per-host connection pool with redundant parallel fetches.
let _syncInFlight: Promise<VpnSyncResponse> | null = null;
// AbortController for the current in-flight geo fetch batch — cancelled when a new sync starts.
let _geoAbortController: AbortController | null = null;

/**
 * Perform a full VPN sync: detect public IP, geolocate it, return result.
 * Runs geojs.io, freeipapi, and reallyfreegeoip in parallel — first success wins.
 * Concurrent calls are deduplicated — if a sync is already in flight, the same
 * promise is returned rather than starting a new one (forceRefresh overrides this).
 * @param forceRefresh - bypass cache and any in-flight deduplication (used by Re-sync button)
 */
export async function syncVpnLocation(forceRefresh: boolean): Promise<VpnSyncResponse> {
  // If a sync is already running and this isn't a forced refresh, piggyback on it
  if (!forceRefresh && _syncInFlight !== null) {
    logger.debug("[VPN-SYNC] Deduplicating concurrent sync call — returning in-flight promise");
    return _syncInFlight;
  }

  // Cancel any stuck in-flight geo fetches from a previous sync before starting fresh.
  // This unblocks the browser's fetch queue so new requests aren't queued behind stale ones.
  if (_geoAbortController !== null) {
    logger.debug("[VPN-SYNC] Aborting previous in-flight geo fetches before starting new sync");
    _geoAbortController.abort();
    _geoAbortController = null;
  }

  const geoAbort = new AbortController();
  _geoAbortController = geoAbort;

  _syncInFlight = _doSyncVpnLocation(forceRefresh, geoAbort).finally(() => {
    _syncInFlight = null;
    if (_geoAbortController === geoAbort) _geoAbortController = null;
  });
  return _syncInFlight;
}

async function _doSyncVpnLocation(
  forceRefresh: boolean,
  geoAbort: AbortController
): Promise<VpnSyncResponse> {
  const geoAbortSignal = geoAbort.signal;
  const syncStart = Date.now();
  logger.info("[VPN-SYNC] Starting sync, forceRefresh:", forceRefresh);

  try {
    const throttleStart = Date.now();
    await throttle();
    logger.debug("[VPN-SYNC] Throttle completed in", Date.now() - throttleStart, "ms");

    const ipStart = Date.now();
    logger.info("[VPN-SYNC] Detecting public IP...");
    let ip: string;
    try {
      ip = await detectPublicIp();
    } catch (ipErr) {
      // IP detection can fail instantly right after a VPN location switch (kill switch window).
      // Retry once after a short delay before giving up.
      const err = ipErr as Error & { code?: string };
      if (err.code === "IP_DETECTION_FAILED") {
        logger.warn(
          "[VPN-SYNC] IP detection failed, retrying in 2s (VPN may still be switching)..."
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
        ip = await detectPublicIp(); // let this throw naturally if it fails again
      } else {
        throw ipErr;
      }
    }
    logger.info("[VPN-SYNC] IP detection completed in", Date.now() - ipStart, "ms, IP:", ip);

    // Check cache unless force refresh
    if (!forceRefresh) {
      const cached = await sessionGet<IpGeolocationResult>("ipGeo:" + ip);
      if (cached !== undefined) {
        logger.debug("[VPN-SYNC] Session cache hit, total time:", Date.now() - syncStart, "ms");
        await setLastSyncedIp(ip);
        return cached;
      }
      const persistent = await persistentCacheGet(ip);
      if (persistent !== undefined) {
        // Warm the session cache so subsequent lookups are instant
        await sessionSet("ipGeo:" + ip, persistent);
        logger.debug("[VPN-SYNC] Persistent cache hit, total time:", Date.now() - syncStart, "ms");
        await setLastSyncedIp(ip);
        return persistent;
      }
    }

    const geoStart = Date.now();

    let result: IpGeolocationResult;
    try {
      result = await geolocateTiered(ip, geoAbortSignal);
      // We have our answer — abort any still-running services so they don't keep
      // retrying in the background.
      geoAbort.abort();
    } catch (aggregateErr) {
      // All services failed — AggregateError contains each individual error
      const errors: Array<Error & { blocked?: boolean }> =
        aggregateErr instanceof AggregateError
          ? (aggregateErr.errors as Array<Error & { blocked?: boolean }>)
          : [];

      logger.error(
        "[VPN-SYNC] All geo services failed:",
        errors.map((e) => e.message)
      );

      // If any service got a real HTTP response (even a 403), the network is fine
      // but this IP is being rejected — tell the user to switch VPN location.
      // Note: timed-out requests are re-thrown as plain Error("Geolocation request timed out")
      // with name "Error" (not "AbortError"), so we must also exclude them here.
      const TIMEOUT_MSG = "Geolocation request timed out";
      const anyServiceResponded = errors.some(
        (e) =>
          e.blocked === true ||
          (e.name !== "AbortError" &&
            e.message !== "Failed to fetch" &&
            e.message !== TIMEOUT_MSG &&
            (e as Error & { code?: string }).code !== "GEOLOCATION_FAILED" &&
            (e as Error & { code?: string }).code !== "NETWORK")
      );

      if (anyServiceResponded) {
        throw Object.assign(
          new Error(
            "Could not detect your VPN location. Your browser may still be reconnecting — wait a moment and try again."
          ),
          { code: "IP_BLOCKED" }
        );
      }

      // All timed out — network/VPN issue
      throw Object.assign(
        new Error(
          "Could not detect your VPN location. Your browser may still be reconnecting — wait a moment and try again."
        ),
        { code: "GEOLOCATION_FAILED" }
      );
    }

    logger.info("[VPN-SYNC] Geolocation completed in", Date.now() - geoStart, "ms");
    logger.debug("[VPN-SYNC] Geolocation result:", result);

    // Cache the result in both session and persistent storage
    await sessionSet("ipGeo:" + ip, result);
    await persistentCacheSet(ip, result);
    await setLastSyncedIp(ip);

    logger.info("[VPN-SYNC] Total sync time:", Date.now() - syncStart, "ms");
    return result;
  } catch (error) {
    const err = error as Error & { code?: string };
    const errorCode =
      err.code === "IP_DETECTION_FAILED"
        ? "IP_DETECTION_FAILED"
        : err.code === "IP_BLOCKED"
          ? "IP_BLOCKED"
          : err.code === "GEOLOCATION_FAILED"
            ? "GEOLOCATION_FAILED"
            : "NETWORK";

    logger.error("[VPN-SYNC] Error after", Date.now() - syncStart, "ms:", {
      errorCode,
      message: err.message,
      name: err.name,
    });
    return {
      error: errorCode,
      message: err.message || "A network error occurred. Please try again.",
    };
  }
}

/**
 * Clear the IP geolocation cache (called when user disables sync mode).
 */
export async function clearIpGeoCache(): Promise<void> {
  await sessionClearNamespace("ipGeo");
  await sessionDelete(SYNCED_IP_KEY);
  await persistentCacheClear();
}

// Exported for testing
export { MIN_REQUEST_INTERVAL, REQUEST_TIMEOUT, GEO_TIMEOUT };

/**
 * Reset the rate limiter timestamp (for testing).
 */
export async function resetRateLimiter(): Promise<void> {
  await sessionDelete("vpnRateLimit");
}
