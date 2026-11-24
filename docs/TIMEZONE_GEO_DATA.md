# Timezone Boundary Data — Architecture & Runbook

How GeoSpoof turns spoofed coordinates into a real IANA timezone, where the
boundary data is hosted (CloudFront + S3, provisioned by CDK), why the URL is
version-scoped, and the exact steps to update the dataset or the infrastructure
without breaking installed clients.

## Why This Exists

When GeoSpoof spoofs a location, it must also report a matching timezone —
otherwise `Date` / `Intl` / `Temporal` / EXSLT keep leaking the user's **real**
zone, which is exactly the inconsistency a fingerprinting script looks for. The
extension resolves coordinates → IANA zone offline using
[`browser-geo-tz`](https://www.npmjs.com/package/browser-geo-tz) against the
[`geo-tz`](https://www.npmjs.com/package/geo-tz) boundary dataset.

That dataset is large (~29 MB) and is fetched at runtime, so where and how it's
hosted is load-bearing for the protection working at all.

## The Two Files

`browser-geo-tz` reads the boundary data as a **pair** of files that must stay
in lockstep:

| File                           | Size    | Fetched as                                | Role                                                              |
| ------------------------------ | ------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `timezones.geojson.index.json` | ~915 KB | one full GET (compressed ~210 KB on wire) | Table of contents: "region X lives at bytes A..B of the `.dat`."  |
| `timezones.geojson.geo.dat`    | ~29 MB  | HTTP `Range` requests (206)               | The boundary polygons, addressed by the byte offsets in the index |

Per-lookup the library fetches the index once (then it's `immutable`-cached) and
issues small range requests for only the shards a coordinate touches — typically
a few hundred bytes each. **Per-user lifetime transfer is roughly the ~210 KB
compressed index (once) plus a handful of tiny shards** — cost scales with new
installs, not with how often a user spoofs.

We use the **full** `timezones.geojson` dataset, not the `-1970` variant — the
1970 variant lands coastal/boundary points in fingerprintable `Etc/GMT±N`
buckets instead of a real named zone.

## Hosting (Canonical: CloudFront + S3)

The data is served from **`cdn.geospoof.com`** (prod) — a CloudFront
distribution in front of a **private** S3 bucket (read via Origin Access
Control; the bucket is never public). All of it is provisioned as code by the
CDK app in [`cdk/`](../cdk). Dev has its own parallel stack at
`cdn-dev.geospoof.com`.

| Environment | Account        | Custom domain          | CloudFront distribution         |
| ----------- | -------------- | ---------------------- | ------------------------------- |
| prod        | `682844365870` | `cdn.geospoof.com`     | `d1nrwnnk6h4gh4.cloudfront.net` |
| dev         | `898565151814` | `cdn-dev.geospoof.com` | `d12khxa80ym5av.cloudfront.net` |

Both stacks live in `us-east-1` (where CloudFront's ACM certificate must also
live). CloudFront is the global layer — it caches at ~600 edge locations
worldwide, so a single-region origin bucket serves every user from a nearby
edge. No multi-region origin is needed for a static, immutable, read-only
dataset.

**What the CDK stack configures (see `cdk/lib/constructs/geo-tz-cdn.ts`):**

- Private S3 bucket (SSE-S3, `BlockPublicAccess.BLOCK_ALL`, `enforceSSL`).
- CloudFront with the managed **CachingOptimized** policy, which honors `Range`
  requests and caches byte ranges (exactly how `browser-geo-tz` reads the
  `.dat`). HTTP/2+3, IPv6, `redirect-to-https`.
- A `ResponseHeadersPolicy` emitting CORS (`Access-Control-Allow-Origin: *`,
  expose-headers `*`) so the extension's cross-origin background fetch and the
  same-site verify page both work. Single-range requests (`bytes=a-b`) are
  CORS-safelisted, so no preflight is required.
- A `BucketDeployment` that uploads **only** the two full-dataset files under a
  version-scoped prefix (`geo-tz/<version>/`) with
  `Cache-Control: public, max-age=31536000, immutable`, `prune: false` (so other
  versions' prefixes are never touched).

**Why a custom domain per account:** an ACM cert lives in one account and a
CloudFront distribution can only use a cert from its own account, and a hostname
can only point at one distribution. So prod owns `cdn.geospoof.com` (cert in
`682844365870`) and dev owns `cdn-dev.geospoof.com` (cert in `898565151814`).

**Why not jsdelivr (the original setup):** jsdelivr **truncated** the large
`.dat`, serving ~24.3 MB of the real ~29.3 MB file while the index still
referenced offsets up to ~29.3 MB. Range requests past the truncation point
returned `416`, the lookup silently fell back to an `Etc/GMT` bucket, and
because we refuse to persist `Etc/GMT` zones the timezone ended up `null` — so
the extension spoofed the location but leaked the real zone. CloudFront serves
the full, intact file (`content-range` total `29259572`) with consistent `206`
range support.

### DNS (Namecheap)

`geospoof.com` DNS is hosted at **Namecheap** (BasicDNS,
`dns1/dns2.registrar-servers.com`), not Route 53. So certs are validated and
domains pointed via Namecheap CNAME records, not the automatic Route 53 path.
For each environment there are **two** records:

1. **ACM validation** CNAME (`_<token>.cdn[-dev]` → `…acm-validations.aws`).
   **Leave these in place permanently** — ACM reuses them to auto-renew the
   certs every year.
2. **Traffic** CNAME (`cdn` / `cdn-dev` → the CloudFront distribution domain).

### Caching

CloudFront serves both files with the bucket's
`Cache-Control: public, max-age=31536000, immutable` and adds edge caching on
top. Immutable caching keeps this cheap and fast — and is also the reason the
path **must** be versioned (next section).

## Legacy Vercel Path (`geospoof.com/geo-tz`) — Keep It Serving

Before this migration the data was served same-origin from
`https://geospoof.com/geo-tz/<version>/…` (Vercel static assets). **Already-
installed extensions that shipped pointing at `geospoof.com/geo-tz` keep
requesting it** until users update. That path **must stay live on Vercel** until
those versions have aged out of the field — removing it would break timezone
lookups for existing users (manual-location spoofs with no `ianaHint` would fall
back to `null` and leak the real zone).

Only **new** extension builds (and the current `/verify` page) request
`cdn.geospoof.com`. The Vercel hosting (`geospoof-site:public/geo-tz/`,
regenerated by `geospoof-site:scripts/copy-geo-tz-data.mjs`) therefore remains as
backward-compat. It
can be retired later — see [Cleanup](#cleanup-later).

## Why the Path Is Versioned

This is the single most important invariant in this system.

The index and the `.dat` are fetched separately and cached `immutable` for a
year. If the data ever changed under a **stable** URL, a returning client could
pair a **stale cached index** (old byte offsets) with **freshly-fetched `.dat`
ranges** from the new file. The offsets no longer line up, and the lookup
silently returns garbage or `null` — no error, no crash, just a wrong/absent
timezone and a leak.

Scoping the URL by the `geo-tz` data version (`/geo-tz/8.1.6/…`) guarantees new
data lands at a **new URL**, so a cached index and the `.dat` it indexes can
never disagree. Old clients keep using the old path; new clients use the new
one.

### Single Source of Truth + Build Guards

The version lives in places that must agree, enforced at build/synth time in
**two** independent guards:

| Where                                                                         | Consumer                                                                    |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| The installed `geo-tz` package version (node_modules)                         | What data we actually upload/serve                                          |
| `src/shared/geo-tz-data.json`                                                 | The **extension** builds its CDN URL from it (`src/background/timezone.ts`) |
| `GEO_TZ_DATA_VERSION` in `geospoof-site:src/lib/verification/geo-timezone.ts` | The **verify page** builds its URL from it                                  |

- **CDK guard** — `cdk/lib/util/geo-tz-data.ts` (`resolveGeoTzData()`) refuses
  to synth unless the installed `geo-tz` version (from `cdk/node_modules/geo-tz`)
  equals `src/shared/geo-tz-data.json`. This is what pins the uploaded data to
  the version the extension requests.
- **Site guard** — two halves. `geospoof-site:scripts/copy-geo-tz-data.mjs`
  refuses to build unless the installed `geo-tz` and the site literal match.
  `geospoof-site:src/lib/verification/geo-tz-version.parity.test.ts` checks both
  against this repo's `src/shared/geo-tz-data.json`, read through the site's
  `extension` submodule, which its CI resolves to this repo's `main` on every run
  and daily. The extension half can't run in the build: Vercel sees the submodule
  only at its recorded commit, which drifts by design.

Note the two guards now read `geo-tz` from **different** `node_modules`: the CDK
from its own, the site from its own. That's deliberate — each project declares the
dependency it uses rather than reaching into a sibling's install tree, which is
what broke when the site moved to its own repository. The invariant is unchanged,
because both still compare against the extension's canonical version.

Both turn "someone bumped `geo-tz` and forgot to version the path" from a
silent, user-facing data-corruption bug into a loud, local failure.

## Dependency Pinning

To stop the served data from changing accidentally, the relevant packages are
pinned to **exact** versions (no `^`) and installs are reproducible:

- `geo-tz` → exact in `cdk/package.json` (the data the CDK upload reads from
  `cdk/node_modules/geo-tz/data`) and exact in `geospoof-site:package.json` (what
  the legacy Vercel copy serves). **Both must be the same version**, and both must
  match `src/shared/geo-tz-data.json`.
- `browser-geo-tz` → exact in both `geospoof-site:package.json` and root
  `package.json` (the reader; must stay format-compatible with the data).
- Lockfiles are committed.

## Runbook: First-Time / Re-Provisioning the CDN

Prerequisites: AWS SSO profiles `geospoof-dev` / `geospoof-prod` (see
`~/.aws/config`), and the `geo-tz` data present under `cdk/node_modules`
(`npm install` in `cdk/`).

1. **Bootstrap** each account once:
   `npx cdk bootstrap aws://898565151814/us-east-1 --profile geospoof-dev`
   `npx cdk bootstrap aws://682844365870/us-east-1 --profile geospoof-prod`
2. **ACM certs** — requested per account in `us-east-1`, DNS-validated by adding
   the validation CNAME at Namecheap (see [DNS](#dns-namecheap)). The issued ARNs
   are wired into `cdk/lib/config/app.ts` (`customDomain.certificateArn`). If a
   cert isn't supplied, the stack deploys on the `*.cloudfront.net` domain and
   logs a warning.
3. **Deploy** — `npm run deploy:dev` / `npm run deploy:prod` (in `cdk/`). Each
   runs `build:full` (format, lint, test, tsc) then
   `cdk deploy --all --context env=<env> --profile geospoof-<env>`. The account
   is pinned per env, so a deploy under the wrong profile fails fast.
4. **Traffic CNAME** — point `cdn[-dev].geospoof.com` at the distribution domain
   from the stack's `DistributionDomainName` output (Namecheap CNAME).
5. **Verify** (see [Quick Diagnostics](#quick-diagnostics)).

## Runbook: Updating the Boundary Data

Do this only when you intentionally want fresher timezone boundaries. Because
clients cache the old path's data for up to a year, the update **must** land at
a new versioned path — never overwrite an existing version's files.

A version bump now spans **two repositories**. Do all of it, or a guard will stop
you — which is the design, but the CDK guard and the site guard live in different
repos and neither can see the other's lockfile.

In this repository:

1. Bump `geo-tz` to the new **exact** version in `cdk/package.json`, then
   `npm install` in `cdk/` to update `cdk/package-lock.json`. Commit the lock.
2. Set the same version in `src/shared/geo-tz-data.json` (extension).
3. Sanity-check: `npx cdk synth` in `cdk/` must succeed — it runs the CDK guard.

In `geospoof-site`:

4. Bump `geo-tz` to the **same exact** version in `package.json` and commit the
   lock, set the same version in `GEO_TZ_DATA_VERSION` in
   `src/lib/verification/geo-timezone.ts`, then check
   `node scripts/copy-geo-tz-data.mjs` prints `data version <new> verified…`.
5. **Deploy the CDN**: `npm run deploy:prod` (and `deploy:dev`) in `cdk/`. The
   `BucketDeployment` uploads the new `geo-tz/<new>/…` prefix; existing prefixes
   are left untouched (`prune: false`), so clients on older versions keep
   working.
6. Ship a **new extension build** so installed clients request the new path. Old
   clients keep requesting the old path (on CloudFront and/or the legacy Vercel
   path) until they update.
7. Deploy the site (keeps the verify page + legacy Vercel path in sync).

> Keep older versioned prefixes live as long as extensions pinned to them are in
> the field. They're static and cheap; removing one breaks any client still
> requesting it.

## Failure Modes & Behavior

The extension's `getTimezoneForCoordinates()` (`src/background/timezone.ts`)
degrades deliberately when the boundary lookup fails (network error, range
hiccup, service-worker suspension mid-fetch):

1. **Boundary lookup succeeds** → real IANA zone, cached for the session.
2. **Lookup fails / returns nothing / returns `Etc/GMT`** → prefer the
   geo-service `ianaHint` (VPN-sync path only) — a real named zone with DST.
3. **No usable hint** → crude longitude estimate (`Etc/GMT±N`), `fallback: true`,
   **not cached** and saved as `null` by the caller so the real lookup is retried
   on the next sync. We never persist or serve an `Etc/GMT` zone — it's a
   fingerprintable, DST-less bucket and exactly the leak we're preventing.

Because of this, **origin/CDN availability affects correctness, not just
convenience**: a prolonged outage means manual locations (no hint) fall back to
`null` and leak the real zone. The VPN-sync `ianaHint` path mitigates synced
locations.

## Quick Diagnostics

Verify the live endpoints behave (replace the version as needed):

```sh
# Index: expect 200, content-type application/json, access-control-allow-origin: *
curl -sI -H "Origin: https://geospoof.com" \
  https://cdn.geospoof.com/geo-tz/8.1.6/timezones.geojson.index.json

# Data range: must be a GET (HEAD returns 200). Expect 206 + content-range …/29259572.
curl -s -o /dev/null -D - -H "Range: bytes=0-100" \
  https://cdn.geospoof.com/geo-tz/8.1.6/timezones.geojson.geo.dat
```

In the extension background console, a healthy lookup logs:

```
Timezone resolved: { identifier: "Asia/Baku", offset: 240, dstOffset: 0 }
```

A leak-risk fallback instead logs a `WARN` about using a fallback / `Etc/GMT`.

## Cleanup (Later)

Once extension versions that point at the legacy `geospoof.com/geo-tz` path have
aged out of the field:

- Drop the `geospoof.com/geo-tz` serving from the site
  (`geospoof-site:public/geo-tz/` and the `/geo-tz/` rule in
  `geospoof-site:vercel.json`).
- The `geospoof-site:scripts/copy-geo-tz-data.mjs` script can stop copying into
  `public/geo-tz/`, but keep its **version-drift guard** (or fold the
  equivalent into the CDK synth guard) — it's still the cheapest place to catch
  a `geo-tz` bump that wasn't version-pathed.

## Related Files

| Path                                                 | Role                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `src/background/timezone.ts`                         | Extension: resolution + fallback ladder; builds the CDN URL |
| `src/shared/geo-tz-data.json`                        | Canonical data version (extension URL)                      |
| `cdk/package.json`                                   | Pins the exact `geo-tz` the CDN uploads                     |
| `geospoof-site:src/lib/verification/geo-timezone.ts` | Verify page: resolution + version literal                   |
| `geospoof-site:scripts/copy-geo-tz-data.mjs`         | Legacy Vercel copy + version-drift guard                    |
| `geospoof-site:vercel.json`                          | Legacy `/geo-tz/` cache headers (backward-compat)           |
| `cdk/lib/constructs/geo-tz-cdn.ts`                   | S3 + CloudFront + versioned data upload (the CDN)           |
| `cdk/lib/config/app.ts`                              | Per-env accounts, region, domains, cert ARNs                |
| `cdk/lib/util/geo-tz-data.ts`                        | CDK-side version-drift guard + data source resolution       |

See also: [VPN_SYNC.md](VPN_SYNC.md) (where the `ianaHint` comes from) and
[API.md](API.md) (the `getTimezoneForCoordinates` contract).
