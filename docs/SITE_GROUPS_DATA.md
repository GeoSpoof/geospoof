# Site Groups Data — Architecture & Runbook

Where the site-group lists come from, how they're converted, bundled and
published to `cdn.geospoof.com`, how installed extensions refresh them, and the
steps to deploy the publishing role or refresh the bundled copy. For what users
see, read [SITE_FILTERS.md](SITE_FILTERS.md#site-groups); for the entry grammar
and the messages, read [API.md](API.md#filter-and-site-location-entry-forms).

## Source and License

The lists are [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community),
the data behind `geosite.dat` in v2ray, Xray, sing-box and mihomo. It's MIT
licensed; the notice is in [NOTICE](../NOTICE) and the picker shows a one-line
attribution. Each upstream release has a
`dlc.dat_plain.yml` asset (every list with its `include:` rules already
resolved) and a matching `.sha256sum` asset.

The bundled copy is release `20261108011013` (published 2026-11-08T01:10:25Z,
upstream sha256 `186e7764…cb580f5`): 1,555 lists, 113,478 rule lines, 375 skipped
rules, 1,927,425 bytes (about 540 KB gzipped).

## Catalog Format

One JSON file, written compactly so the same input always gives the same bytes
(`scripts/site-groups/build-catalog.ts`; the type is `SiteGroupCatalog` in
`src/shared/site-groups/catalog.ts`):

```json
{
  "format": 1,
  "source": "https://github.com/v2fly/domain-list-community",
  "license": "MIT",
  "release": "20261104112839",
  "releasedAt": "2026-11-04T11:28:50Z",
  "upstreamSha256": "cd21da98…",
  "lists": {
    "google": { "rules": "0emm.com\n1e100.net\n…\n265.com@cn\n…", "skipped": ["cn", "cn"] }
  }
}
```

- `rules` holds one rule per line, `[=]host[@attr]...`. `=` marks an upstream
  `full:` rule (that host only); any other line is a `domain:` rule (the host and
  its subdomains). Attrs are deduped and sorted.
- `regexp:` and `keyword:` rules are dropped. `skipped` keeps each dropped rule's
  attrs joined by `@` (`""` when it had none), so `geosite:google@cn` can report
  how many of _its_ rules were skipped.
- The client validates every catalog strictly (`validateCatalog`): list names
  match `[a-z0-9!-]{1,64}`, every rule line matches the grammar above, and there
  are at most 5,000 lists, 400,000 rule lines and 10,000 skipped items.

## Pointer Format

`site-groups/v1/latest.json` names the current catalog:

```json
{
  "format": 1,
  "release": "20261104112839",
  "releasedAt": "2026-11-04T11:28:50Z",
  "path": "site-groups/v1/catalog-20261104112839.json",
  "sha256": "f506110ca3884600108a92e4ef760add87d9be510db11ea9bfe8d914be2b6459",
  "bytes": 1921467,
  "lists": 1555,
  "rules": 113175
}
```

The client requires `format: 1`, a 14-digit `release`, `path` equal to
`site-groups/v1/catalog-<release>.json`, a lowercase hex `sha256`, and `bytes`
between 1 and 8 MB. `lists` and `rules` are for people reading the file.

## Why the Paths Are Versioned

Two reasons, as for the [geo-tz data](TIMEZONE_GEO_DATA.md#why-the-path-is-versioned):

- **`catalog-<release>.json` is immutable.** Its name carries the release, so it's
  uploaded with `public, max-age=31536000, immutable` and never rewritten. A
  client that has a pointer always finds the file it names, and a cached copy is
  never stale. Only the pointer moves; it's uploaded with `public, max-age=3600`
  and invalidated on each publish.
- **`v1/` is the format version.** A future incompatible catalog format goes to
  `v2/`, and installed extensions keep reading `v1/` until they update. Keep
  publishing `v1/` for as long as extensions that read it are in the field.

## The Publish Pipeline

`.github/workflows/site-groups-catalog.yml` runs every Monday at 06:17 UTC and
on manual dispatch from `main`:

1. Read the latest upstream release with `gh api`. The tag must be 14 digits and
   the asset must have an API `digest`.
2. Download `dlc.dat_plain.yml` and its `.sha256sum`, run `sha256sum -c`, and
   compare against the API digest too.
3. Convert with `build-catalog.ts`, which also writes the pointer. The parser is
   strict: an unexpected line, a rule type it doesn't know, an invalid host or a
   wrong `length:` fails the run.
4. Fetch the published pointer. If it already names this release, stop: nothing
   is uploaded and no role is assumed. Otherwise fetch the published catalog and
   rerun the converter with `--guard-against`, which refuses a release with more
   than 10% fewer lists or 20% fewer rule lines. The `force` input skips this
   guard for a shrink that's known to be legitimate. A 404 or 403 on the pointer
   is treated as the first publish (S3 behind Origin Access Control answers 403
   for a missing key).
5. Assume the `SiteGroupsCatalog` role over GitHub OIDC
   (`vars.SITE_GROUPS_PUBLISH_ROLE_ARN`).
6. Upload the catalog, then the pointer, so the pointer never names a missing
   file.
7. Invalidate `/site-groups/v1/latest.json`.
8. Fetch the pointer from the CDN (with retries) and diff it against the one
   just generated.

The role trusts only `repo:*/geospoof@1170325630:ref:refs/heads/main`, can write
only `site-groups/*`, and can invalidate the distribution. The job has no
`environment:`, because an environment changes the OIDC `sub` and the role would
refuse it. See [cdk/README.md](../cdk/README.md#site-groups-catalog-publishing).

## Client Refresh and Integrity

`src/background/site-groups.ts`:

- **Bundled first.** The extension ships the catalog as
  `dist/site-groups/catalog.json`, read with `fetch(runtime.getURL(...))` and
  never imported into a JS bundle, so the first add of any group works offline
  and the AMO build downloads nothing. A newer CDN catalog is kept in
  `storage.local.siteGroupCatalog`; the newer of the two is used.
- **Only referenced data is stored.** Adding `geosite:google` builds that token's
  entries from the catalog and stores them in `storage.local.siteGroupData`
  before the settings write, so an entry never exists without its data. Only
  tokens some entry references are kept, at most 5,000,000 characters in total.
- **No request unless a group is in use.** A `site-groups-refresh` alarm exists
  only while some token is referenced. It fires weekly, with the first run spread
  over a random 0–6 hours so installs don't all ask at once. "Update now" runs the
  same refresh on demand.
- **One file for everyone.** A refresh fetches the pointer (`cache: "no-cache"`,
  at most 64 KB) and, when it names a newer release, the whole catalog (at most
  8 MB). No request names a group, so the CDN can't learn which groups a user
  picked. Every download omits credentials, times out after 30 s, and must end on
  https.
- **Integrity.** The catalog's sha256 must equal the pointer's, its `release` must
  equal the pointer's, and it must pass `validateCatalog`. Anything else is an
  `INVALID` refresh and nothing changes.
- **Last good copy.** A token is rebuilt only from a newer release. If the newer
  release lacks the list or leaves it empty, the old entries stay and the token
  is flagged `missingUpstream`. A link whose re-download fails keeps its entries
  and records `lastError`. The popup's row shows a link's `lastError` ("Couldn't
  update this list"); `missingUpstream` is kept in storage but not shown.
- **Delivery.** When some token's entries changed, the data is written inside a
  Firefox bootstrap write window, as a settings write is: the early scripts
  built from the old data are removed first and the new ones registered after.
  Then the background re-broadcasts to tabs, updates the badge and re-syncs
  Engine-level Spoofing. An add that builds data for a token another entry
  already references uses the same window.
- **Safari.** `siteGroupsAvailable()` is false there, so none of this runs: no
  alarm and no request.

## Failure Modes

| What fails                          | What users get                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| CDN unreachable                     | `lastError: "NETWORK"`; the status line says the update failed; the catalog and data in use stay             |
| CDN serves a bad pointer or catalog | `lastError: "INVALID"`; same as above                                                                        |
| Upstream drops or empties a list    | Its last good copy stays, flagged `missingUpstream`                                                          |
| Upstream shrinks past the guard     | The workflow fails and publishes nothing; clients keep the published catalog until someone checks and forces |
| Upstream format changes             | The strict parser fails the workflow; nothing is published                                                   |
| A token's stored data is lost       | It matches nothing and the row shows "Not available" until startup or the next refresh rebuilds it           |
| A link's host is down               | `LINK_FAILED` on add (nothing stored); on refresh the last good copy stays                                   |

None of these leave a page with a wrong location: a token without data matches
nothing, the same way as a typed pattern that can't compile.

## Runbook: Deploying the Publish Role

Nothing in CI deploys the CDK stack. From `cdk/`:

1. `npm ci && npm run build:full`.
2. `aws sso login --profile geospoof-prod`, then `npm run diff:prod`. The only
   additions should be the `SiteGroupsCatalog` role, its policy and the
   `SiteGroupsPublishRoleArn` / `SiteGroupsPointerUrl` outputs.
3. `npm run deploy:prod`.
4. Set the repository variable `SITE_GROUPS_PUBLISH_ROLE_ARN` to the
   `SiteGroupsPublishRoleArn` output. `EXT_CDN_BUCKET` and
   `EXT_CDN_DISTRIBUTION_ID` are already set for the release workflow. Until
   this variable exists the workflow's job is skipped, so the weekly schedule
   stays quiet between the merge and the deploy.
5. Dispatch "Site groups catalog" from `main`.
6. Check that `curl -sI https://cdn.geospoof.com/site-groups/v1/latest.json`
   returns 200 with `content-type: application/json`, and that the sha256 of the
   file at the pointer's `path` equals its `sha256`.

## Refreshing the Bundled Copy

Before a release, so a fresh install starts from recent lists:

```sh
npm run site-groups:update   # download the latest release, verify, convert
git diff --stat assets/site-groups/catalog.json
```

The script checks the download against the `.sha256sum` asset and the API digest,
and prints the list, rule and skipped counts. Compare them with the previous
ones (the pointer's `lists` and `rules`, or the numbers above), then commit the
catalog in the release PR. The build copies it to `dist/site-groups/` as is; it
must never be downloaded at build time.

To reproduce a committed catalog byte for byte from a saved upstream file:

```sh
node scripts/site-groups/build-catalog.ts --input dlc.dat_plain.yml \
  --release <tag> --released-at <published_at> --upstream-sha256 <sha256> \
  --out /tmp/catalog.json --pointer /tmp/latest.json
cmp /tmp/catalog.json assets/site-groups/catalog.json
```

## Related Files

| Path                                        | Role                                                            |
| ------------------------------------------- | --------------------------------------------------------------- |
| `scripts/site-groups/build-catalog.ts`      | Converter, pointer writer, shrink guard, `--download` mode      |
| `assets/site-groups/catalog.json`           | The bundled catalog (generated, committed)                      |
| `src/shared/site-groups/catalog.ts`         | Catalog type, strict validator, per-token builder, picker index |
| `src/shared/site-groups/tokens.ts`          | `geosite:` and `list:` token grammar, link display names        |
| `src/shared/site-groups/matcher.ts`         | Framed `d`/`f` strings and the host check                       |
| `src/shared/site-groups/list-formats.ts`    | Parser for lists from a link                                    |
| `src/shared/site-groups/availability.ts`    | The Safari gate                                                 |
| `src/background/site-groups.ts`             | Bundled and CDN catalogs, refresh, links, handlers              |
| `src/background/site-groups-store.ts`       | Stored token data and the in-memory lookup                      |
| `tests/fixtures/site-group-vectors.json`    | Cross-language cases for the grammar, matcher and precedence    |
| `.github/workflows/site-groups-catalog.yml` | Weekly publish                                                  |
| `cdk/lib/constructs/site-groups-catalog.ts` | The publish role and its outputs                                |
| `cdk/lib/config/app.ts`                     | `siteGroupsCatalog.githubSubjectPatterns` (prod only)           |
