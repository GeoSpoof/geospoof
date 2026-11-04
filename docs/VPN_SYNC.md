# VPN Sync & Auto-Resync Architecture

How GeoSpoof keeps the spoofed location aligned with a VPN's exit region — on demand, on startup, and automatically as the exit node changes.

## Why This Exists

A VPN changes the one location signal GeoSpoof cannot touch from a content script: the public IP (see [BACKGROUND.md](BACKGROUND.md)). Fingerprinting scripts cross-check the IP's geolocated country/region against the browser-reported coordinates and timezone, so a spoofed location that doesn't match the VPN exit is itself a detectable inconsistency.

VPN Sync closes that gap: it detects the current public (exit) IP, geolocates it, and sets the spoofed coordinates + timezone to match. Auto-resync keeps them matched as the user connects, disconnects, or switches exit nodes — without polling.

## Module Map

| Module                                | Responsibility                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/background/vpn-sync.ts`          | Public-IP detection, IP→geo resolution, caching, the `syncVpnLocation()` orchestrator                      |
| `src/background/endpoint-cooldown.ts` | Per-endpoint rate-limit isolation shared by both endpoint pools                                            |
| `src/background/resync-core.ts`       | The shared re-sync gate: debounce, min-interval floor, switch-settle guard, circuit breaker, IP-diff check |
| `src/background/proxy-watcher.ts`     | `proxy.settings.onChange` push trigger (proxy-API VPNs)                                                    |
| `src/background/activity-watcher.ts`  | `tabs.onUpdated` + `idle.onStateChanged` triggers (everything else)                                        |
| `src/background/timezone.ts`          | Offline timezone resolution, with the geo-service IANA hint as a high-quality fallback                     |
| `src/background/messages.ts`          | `SYNC_VPN` / `DISABLE_VPN_SYNC` handlers and `handleSetLocation`                                           |
| `src/background/index.ts`             | Startup auto-sync + synchronous top-level install of both watchers                                         |

## Public IP Detection

`detectPublicIp()` resolves the exit IP by trying a pool of HTTP IP-echo endpoints in order, first success wins (sequential failover, not a parallel race — the happy path is a single request to the primary).

| Order | Provider     | Endpoint                                   | Parse                          |
| ----- | ------------ | ------------------------------------------ | ------------------------------ |
| 1     | `aws`        | `https://checkip.amazonaws.com/`           | plaintext body                 |
| 2     | `cloudflare` | `https://www.cloudflare.com/cdn-cgi/trace` | `ip=` line of `key=value` body |
| 3     | `akamai`     | `https://whatismyip.akamai.com/`           | plaintext body                 |
| 4     | `ipify`      | `https://api.ipify.org/`                   | plaintext body                 |

Design rules:

- **Hyperscale endpoints are favored over small single-purpose services.** The real rate-limit risk isn't per-user volume — it's _many users sharing one VPN exit IP_ all hitting the same endpoint, so the endpoint sees high volume from a single IP and may throttle it. AWS / Cloudflare / Akamai span three independent operators built for that volume; ipify is the last-resort independent fallback so we're never reliant on one operator.
- Browsers can't do raw-UDP STUN (the native app's trick), so an HTTP echo is the only option in the extension — diversity + failover recovers the resilience STUN would give.
- Each attempt has a `REQUEST_TIMEOUT` (10s) and is fetched with `cache: "no-store"`, `credentials: "omit"`.
- A `403`/`429` from a provider parks _that provider_ in the IP-echo cooldown (see below) and fails over to the next; the HTTP status is preserved in the thrown error so the resync gate's circuit breaker can recognize a _total_ throttle.
- When every provider fails, the error carries `code: "IP_DETECTION_FAILED"` with the per-provider reasons joined in.

## IP Geolocation

Once the IP is known, `syncVpnLocation()` resolves it to coordinates by racing a pool of geo services in parallel via `Promise.any` — first success wins, the rest are aborted.

| Service           | Endpoint                                   | Notes                                                                                                |
| ----------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `geojs` (primary) | `https://get.geojs.io/v1/ip/geo/{ip}.json` | CORS-friendly, no key, no rate limits; lat/lng are strings                                           |
| `freeipapi`       | `https://free.freeipapi.com/api/json/{ip}` | fallback #1                                                                                          |
| `reallyfreegeoip` | `https://reallyfreegeoip.org/json/{ip}`    | fallback #2                                                                                          |
| `ipinfo`          | `https://ipinfo.io/{ip}/json`              | fallback #3 — Google Cloud network (different from Cloudflare-hosted siblings); `loc` is `"lat,lng"` |

Design rules:

- Parallel race (not sequential) because geolocation is the latency-sensitive step; worst case is `GEO_TIMEOUT` (5s) per service, all overlapping.
- Each service is fetched with a custom path/User-Agent and `GEO_MAX_RETRIES` (2) exponential-backoff retries; a custom User-Agent forces a fresh TCP connection so a stale pooled connection from before a VPN switch isn't reused.
- All services validate the returned IP and clamp coordinates to valid lat/lng ranges; an invalid response is treated as a failure and the service is dropped from the aggregate.
- Each service can return an IANA `timezone` field, normalized to a trimmed non-empty string (or `undefined`). This becomes the timezone hint (see below).
- A `403`/`429` (or a `blocked` flag) parks _that service_ in the geo cooldown.
- If the whole race fails: if any service got a real HTTP response (the network is fine but this exit IP is rejected), the error is `IP_BLOCKED`; if everything timed out, it's `GEOLOCATION_FAILED`.

### Result Caching

Three layers, keyed by exit IP:

- **Session cache** (`browser.storage.session`, `ipGeo:{ip}`) — instant in-session repeat lookups.
- **Persistent cache** (`browser.storage.local`, `ipGeoCache`) — 30-day TTL; a previously-seen exit IP resolves without any geolocation request (this is what makes auto-resync to a known node nearly free). On a hit it warms the session cache.
- **`lastSyncedIp`** (`browser.storage.session`) — the exit IP behind the currently-applied spoofed location. Written on every successful sync (startup, manual, watcher-triggered); read by the resync gate to decide whether an exit IP actually moved before spending a geolocation call. Cleared when sync is disabled.

`forceRefresh: true` (the manual Re-sync button) bypasses the session and persistent caches and the in-flight dedup.

### Concurrency

A single in-flight sync promise deduplicates concurrent calls — rapid button presses piggyback on the running sync rather than saturating the per-host connection pool. Starting a new forced sync aborts any stuck in-flight geo fetches first (via an `AbortController`) to unblock the browser's fetch queue.

## Per-Endpoint Rate-Limit Isolation

`endpoint-cooldown.ts` provides one small in-memory `EndpointCooldown` per pool (IP-echo and geo). When a single endpoint returns `429`/`403` (`looksRateLimited()` matches a standalone 429 or 403), only _that_ endpoint is parked for `ENDPOINT_COOLDOWN_MS` (1 min) and dropped from the next failover/race; its siblings keep serving.

- If _every_ endpoint in a pool is parked, `filterAvailable()` returns the full list unchanged — degraded-but-alive, never an empty set.
- State is in-memory only and not persisted: an MV3 service-worker restart clears it, which is harmless (a cooldown is only an optimization).
- A user-initiated manual sync (`SYNC_VPN`) calls `clearEndpointCooldowns()` first, so every endpoint gets a fresh shot.

## The Shared Re-Sync Gate (`resync-core.ts`)

Every "the network might have just changed" trigger funnels into one gate, `triggerResyncCheck(reason)`, so they share one debounce, one rate-limit floor, one in-flight guard, and one IP-diff check. There is deliberately **no interval timer** — an idle browser does zero work; a stale spoofed location only matters when a page reads geolocation, which only happens while the browser is active, which is exactly when the triggers fire.

Sequence of a check:

1. **Debounce** `RESYNC_DEBOUNCE_MS` (1.5s) — coalesces the burst of triggers a single reconnect/navigation produces, and lets an exit-node switch settle before sampling.
2. Bail unless `vpnSyncEnabled`.
3. **Circuit breaker** — if a previous _total_ failure set a backoff window (`RATE_LIMIT_BACKOFF_MS`, 1 min), skip.
4. **Steady-state floor** `MIN_CHECK_INTERVAL_MS` (10s) — a chatty trigger (frantic navigation, a misbehaving VPN) can't drive the IP-detection dependency into throttle territory. (The rate-limited geo services are protected separately by the IP-diff gate + 30-day cache, so they only fire on an actual exit-IP change.)
5. One cheap `detectPublicIp()`. On a `429`/`403` here, trip the circuit breaker and back off the automatic path. On any other failure (e.g. the kill-switch window mid-switch), log at debug and let the next trigger retry.
6. **IP-diff gate** — if the IP equals `getLastSyncedIp()`, stop: no geolocation request, no location change.
7. **Switch-settle guard** `SWITCH_SETTLE_MS` (2.5s) — on a _changed_ IP, wait and re-detect; require the same value twice before applying. During an exit-node switch the real ISP IP can briefly surface (the kill-switch window), and this prevents ever syncing the spoofed location to the user's _real_ location mid-switch.
8. Only on a confirmed, genuinely-changed exit IP: `syncVpnLocation(true)` (cache-first via the 30-day persistent cache) + `handleSetLocation({ fromVpnSync: true, onlyWhileVpnSync: true, timezoneHint, locationName })`. The write re-checks `vpnSyncEnabled`, so a manual location or Disable set during the check is kept and the check writes nothing.
9. If the sync returns `IP_BLOCKED` or looks rate-limited, trip the circuit breaker too.

The circuit breaker is the **last line only** — the per-endpoint cooldowns absorb a single endpoint throttling; the breaker trips only on a _total_ failure (every IP-echo provider rate-limited, or a sync returning `IP_BLOCKED`). It's kept short because it's exit-IP-specific: a VPN switch to a fresh IP should resume syncing quickly. Manual and startup syncs bypass the gate entirely.

## Triggers

There is **no browser push event for "the public exit IP changed."** This was verified empirically against every candidate (`networkStatus` is privileged/unshippable; `captivePortal` fired ~1-in-9 switches; `online`/`offline` and a `webRequest` reset-burst detector fired ~never for transparently-rerouting VPNs). The only reliable detector is actually checking the IP — so GeoSpoof drives that cheap check off the two signals it _can_ observe.

### Proxy-Change Watcher (`proxy-watcher.ts`)

A browser-extension VPN (e.g. the Proton VPN extension, or NordVPN on Chromium) routes traffic by setting the browser proxy. When it connects or switches nodes it mutates `proxy.settings`, and the browser fires `proxy.settings.onChange` to every extension holding the `proxy` permission — including ours, even though a _different_ extension made the change (details carry `levelOfControl: "controlled_by_other_extensions"`). The handler hands off to the shared gate.

- **Observe-only**: never calls `proxy.settings.set()`, so it can't interfere with the VPN extension's proxy control.
- Only fires for VPNs that drive `proxy.settings`. VPNs that route via `proxy.onRequest` (Firefox NordVPN / Mozilla VPN extensions) and OS/desktop VPNs never touch it — the activity watcher covers those.

### Activity Watcher (`activity-watcher.ts`)

Drives the IP check off real browser activity, covering the VPN classes the proxy watcher can't see:

- `tabs.onUpdated` (status `"loading"`) — if the exit IP moved, the next page load goes through the new node, which is exactly when an accurate spoofed location matters.
- `idle.onStateChanged` → `active` — the laptop woke up, possibly on a new network/VPN exit.

The two watchers coexist: on Chromium + a proxy-API VPN, `proxy.settings.onChange` resyncs first and the activity triggers that follow just hit the IP-diff check and no-op.

### Install Lifecycle

Both watchers are installed by `installResyncWatchers()` called **synchronously at the top level** of `index.ts` (not inside `initialize()`). On a non-persistent MV3 background (Firefox event page, Chromium service worker) the background is torn down when idle and respawned by ordinary events (e.g. an incoming message) _without_ firing `onStartup` — so anything wired up only inside `initialize()` is lost on the first respawn. Top-level install + idempotent install functions keep the watchers alive across the lifecycle. Both self-gate on `vpnSyncEnabled` at fire time, so toggling sync off doesn't require tearing listeners down.

## Engine Support

| Engine                             | Proxy watcher (`proxy.settings.onChange`)                                                                                | Activity watcher (`tabs.onUpdated` / `idle`)                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Chromium (Chrome/Brave/Edge/Opera) | Active (`ChromeSetting`). The `proxy` permission's warning is already covered by `<all_urls>`, so no new install prompt. | Both active                                                    |
| Firefox desktop                    | Active (`BrowserSetting`, FF 60+)                                                                                        | Both active                                                    |
| Firefox for Android                | Not supported → feature-detects to no-op                                                                                 | `tabs` active; `idle` active                                   |
| Safari (macOS/iOS/iPadOS)          | No proxy API → no-op (`proxy` permission filtered out of the Safari build)                                               | `tabs` active; `idle` filtered out of the Safari build → no-op |

Engines without a working trigger fall back to the startup auto-sync only. An OS-level-only VPN (no browser extension) changes nothing the browser can observe; on engines with the activity watcher, the next navigation still drives an IP check.

### Permissions

The `proxy` and `idle` permissions are declared in the shared manifest (`src/build/manifest.ts`) and **filtered out of the Safari build** (alongside `privacy`). On Chromium the `proxy` warning adds no new install prompt because `<all_urls>` already triggers it.

## Timezone Hint Resolution

`getTimezoneForCoordinates(lat, lng, ianaHint?)` resolves timezone in this priority order:

1. **Offline `browser-geo-tz` boundary lookup** — precise polygon match against `timezones.geojson` (full land coverage, always a proper IANA id), pinned to a specific geo-tz version so the index and data file stay in sync.
2. **`ianaHint`** — the IANA identifier from the winning geo service on the VPN-sync path. Used when the boundary lookup throws (e.g. a CDN range-request `416`) or returns nothing. Validated by format (`isValidIANATimezone`) then guarded with a `try/catch` around `Intl` (the hint is external/untrusted, so a format-valid but non-existent zone is treated as unusable). Because it's a real named zone with DST, it is safe to cache for the session.
3. **Longitude estimate** (`Etc/GMT±N`) — crude last resort. **Never cached**, so a transient CDN failure retries on the next call rather than pinning a wrong no-DST offset for the whole session. A fallback timezone is also never persisted to storage (`handleSetLocation` saves `null` instead), so the next browser session retries the real lookup.

Manual map-pin locations carry no hint and behave as before.

For how the boundary data is hosted, version-scoped, and updated, see [TIMEZONE_GEO_DATA.md](TIMEZONE_GEO_DATA.md).

## The Three Sync Paths

| Path                  | Trigger                                                           | Cache                                                             | Gate                                                         | Endpoint cooldowns                         |
| --------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| **Startup auto-sync** | `initialize()` on `onStartup`/`onInstalled` when `vpnSyncEnabled` | `syncVpnLocation(false)` — cache-first                            | bypasses the resync gate                                     | respected                                  |
| **Manual sync**       | `SYNC_VPN` message (popup "Sync Now" / Re-sync)                   | `forceRefresh` per payload                                        | bypasses the resync gate                                     | cleared first (`clearEndpointCooldowns()`) |
| **Auto-resync**       | proxy-change / tab-nav / idle→active                              | `syncVpnLocation(true)` — cache-first via 30-day persistent cache | full gate (debounce, floor, IP-diff, switch-settle, breaker) | respected                                  |

All three apply the result through `handleSetLocation({ fromVpnSync: true, … })`, which resolves the timezone (with the hint), persists settings, and broadcasts to content scripts. The startup sync and the auto-resync add `onlyWhileVpnSync`, so they write only if VPN sync is still on when the write runs. `SYNC_VPN` adds `enableVpnSync`, which stores the location and `vpnSyncEnabled: true` in one write.

## Settings Interaction

- `SYNC_VPN` success stores the location and `vpnSyncEnabled: true` in one write (so does the app's VPN snapshot on Safari). The startup sync and the auto-resync store their location only if `vpnSyncEnabled` is still true when the write runs, so a manual location or a Disable made during their network calls is never overwritten.
- Setting a **manual** location while sync is active disables sync (`vpnSyncEnabled: false`) and clears the IP-geo cache — `handleSetLocation` skips this only when called with `fromVpnSync: true`.
- `DISABLE_VPN_SYNC` clears the IP-geo cache and `lastSyncedIp`, and nulls `location` / `timezone` / `locationName`.

## Error Codes

`VpnSyncError.error` is one of:

| Code                  | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `IP_DETECTION_FAILED` | Every IP-echo provider failed                                                     |
| `GEOLOCATION_FAILED`  | Geo race failed with no real HTTP response (timeouts / network)                   |
| `IP_BLOCKED`          | A geo service responded but rejected this exit IP — user should switch VPN region |
| `NETWORK`             | Generic network error                                                             |
