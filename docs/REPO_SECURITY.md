# Repository & Release Security

How this repository, its CI, its releases, and the accounts that publish GeoSpoof are protected, and why each control exists. This covers the software supply chain. For reporting a vulnerability in the extension itself, see [`.github/SECURITY.md`](../.github/SECURITY.md). For keeping dependencies and tooling current, see [`MAINTENANCE.md`](MAINTENANCE.md).

The guiding rule: **anything that can put bytes in front of users must be gated, minimally privileged, and verifiable.** For a privacy extension, a compromised update is the worst outcome, worse than any bug.

## Threat model in one table

| Attack                                               | Control                                                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Push malicious code straight to `main`               | Ruleset: PRs only, required checks, signed commits, no bypass                       |
| Re-point a release tag or swap a release asset       | Tag ruleset + immutable releases                                                    |
| A compromised npm package steals release credentials | Release split by privilege; secrets never share a job with `npm ci` install scripts |
| A poisoned CI cache reaches a release                | No setup-node cache in the release workflow                                         |
| A malicious or unpinned GitHub Action                | Org-enforced full-SHA pinning; zizmor audits workflows                              |
| A stolen Chrome Web Store login ships an update      | Verified CRX uploads: uploads must be signed with a key held offline                |
| A vulnerable dependency gets merged                  | Dependency review blocks high+ advisories at PR time                                |
| A tampered download                                  | Build provenance + SBOM attestations, verifiable by anyone                          |

## Accounts (the highest-value targets)

Recent extension supply-chain attacks (e.g. Cyberhaven, December 2024) phished a **store account**, not the code. These accounts should use phishing-resistant 2FA (passkeys or a hardware key):

- Google account behind the Chrome Web Store
- Mozilla AMO
- Apple Developer
- AWS root
- GitHub (the `GeoSpoof` org **requires** 2FA for all members)

**Chrome Web Store verified CRX uploads** are on. The store rejects any upload not signed by our private key, so a stolen Google login alone can't publish. The key lives outside the repo, backed up in a password manager and offline. Losing it means contacting Chrome Web Store support before you can update. CI never holds it, so upload signing is a manual step; see [CONTRIBUTING, Chrome Web Store upload](../.github/CONTRIBUTING.md#chrome-web-store-upload).

## Repository settings

All set on `GeoSpoof/geospoof` and checkable through the API.

**`main` ruleset ("Protect main", id `24738788`), no bypass actors:**

- No deletion, no force pushes
- Pull request required; review threads must be resolved; **squash merge only**
- Required status checks, branch must be up to date (strict): `Build & Test`, `Dependency review`
- Code scanning gate: CodeQL, blocking new `error` alerts and `high`+ security alerts
- **Signed commits required.** GitHub signs squash merges and Dependabot signs its own commits; contributors sign with SSH or GPG (see [Commit signing](#commit-signing))

**Tag ruleset ("Protect release tags", id `24778692`)** on `refs/tags/v*`: no deletion, no update, no force push. Tags can be created, never moved.

**Immutable releases** are on. A published release's assets and tag can't change. The fix for a bad release is the next patch version, never a re-tag.

**Actions policy:** full-length SHA pinning required for every action, including actions called by other actions. Default `GITHUB_TOKEN` is read-only, workflows can't approve PRs, and fork PRs from all outside contributors need approval before workflows run.

**Security features:** Dependabot alerts and security updates, secret scanning with push protection, private vulnerability reporting, and code scanning (CodeQL, zizmor, Scorecard). Secret scanning validity checks need GitHub's paid Secret Protection and are off.

**Merging:** merged branches are deleted automatically.

## Workflow hardening

Every workflow follows the same rules, enforced by zizmor on any change under `.github/`:

- `permissions: contents: read` at the top. Jobs escalate only what they need, with a comment saying why.
- Every action pinned to a full commit SHA with a `# vX.Y.Z` comment. Dependabot bumps pins weekly. zizmor's `ref-version-mismatch` audit catches a comment that doesn't match its SHA.
- `actions/checkout` always has `persist-credentials: false`, so the token never sits in `.git/config`.
- No `${{ }}` expressions inside `run:` scripts; values pass through `env:`.
- Runners pinned to `ubuntu-24.04` (not `ubuntu-latest`) so the OS changes only when we choose.
- `concurrency` on every workflow. The release uses `cancel-in-progress: false` so it's never killed mid-publish.

| Workflow                    | Purpose                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                    | Type-check, lint, format, build, `web-ext lint`, unit tests, `npm audit signatures`. Required (`Build & Test`).              |
| `cdk-ci.yml`                | Same gate for `cdk/`. Path-filtered, so it can't be a required check.                                                        |
| `codeql.yml`                | CodeQL `security-and-quality` on shipped code (`tests/**` and `scripts/**` excluded via `.github/codeql/codeql-config.yml`). |
| `dependency-review.yml`     | Blocks PRs that add a high+ severity vulnerable dependency. Required.                                                        |
| `zizmor.yml`                | Static analysis of workflows; findings go to code scanning.                                                                  |
| `scorecard.yml`             | OpenSSF Scorecard; publishes results and the README badge.                                                                   |
| `dependabot-auto-merge.yml` | Narrow auto-merge; see [MAINTENANCE](MAINTENANCE.md#auto-merge-policy).                                                      |
| `release.yml`               | The release pipeline below.                                                                                                  |
| `cdn-publish-preflight.yml` | Manually proves the CDN publish role is assumable.                                                                           |
| `stale.yml`                 | Issue and PR housekeeping.                                                                                                   |

## Release trust chain

A `v*` tag runs `release.yml` as three jobs, split by privilege so no third-party code runs next to a publishing credential:

| Job       | Runs                                                     | Holds                                                            |
| --------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| `build`   | `npm ci` (install scripts run), builds, source zip, SBOM | Read-only token, no secrets                                      |
| `sign`    | `npm ci --ignore-scripts`, then web-ext                  | AMO secrets, from the `release` environment                      |
| `publish` | No npm install at all                                    | `contents: write`, the OIDC token for the CDN role, attestations |

Supporting decisions:

- **No npm cache** in any release job: the cache is shared with PR runs, so restoring it would let a poisoned entry reach a release.
- **The tag is validated** as `vX.Y.Z` and must match `package.json` before anything uses it.
- **`release` environment**: the AMO secrets exist only there, and it accepts deployments from `v*` tags only. No branch or PR workflow can read them.
- **`publish` has no environment on purpose.** An environment changes the OIDC `sub` claim, which would break the CDN role's trust. The role trusts only the immutable subject `repo:*/geospoof@1170325630:*`; see `cdk/README.md`, "Who may publish".
- **No third-party action holds the write token**: the release is created with the runner's own `gh` CLI, as draft → upload → publish, which immutable releases require.
- **Re-runs are safe**: the publish step finishes a draft, or checks a published release's assets, then continues to the CDN.

**Verifiable outputs** (attached to every release):

- `geospoof-v<version>.intoto.jsonl`: SLSA build provenance for every asset, also in GitHub's attestation store. It's attached as a file because Scorecard's Signed-Releases check reads release assets ([ossf/scorecard#4667](https://github.com/ossf/scorecard/issues/4667)).
- `geospoof-v<version>.cdx.json`: a CycloneDX SBOM from `npm sbom`, attested against the XPIs and the Chromium zip. It covers the full tree, because npm's `--omit dev` drops runtime packages that also appear under a dev dependency (tr46 and punycode, via jsdom).

```bash
gh attestation verify <file> --repo GeoSpoof/geospoof
gh attestation verify <file> --repo GeoSpoof/geospoof --predicate-type https://cyclonedx.org/bom
```

## Commit signing

Required on `main`. Each machine you commit from needs its own key registered on GitHub as a **signing key**, with a commit email that's verified on the account:

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
git config --global tag.gpgsign true
gh auth refresh -h github.com -s admin:ssh_signing_key
gh ssh-key add ~/.ssh/id_ed25519.pub --type signing --title "<machine>"
```

A PR with an unsigned commit can't merge, even when every check passes. Don't try to rescue it with a rebase; re-create it as one signed commit on a fresh branch.

## Licensing and trademark

Apache-2.0, copyright GeoSpoof LLC. `LICENSE` is the unmodified apache.org text, so tools detect it. `NOTICE` carries the copyright line, the trademark statement, and the MIT notices required for code contributed under MIT. Section 6 of the license withholds the GeoSpoof name and logo. Releases up to v2.2.3 were MIT, and copies obtained under those terms keep them. The proprietary products (native apps, GPS desktop core, geospoof.com) live in separate private repos.

## Scorecard: what's maxed, and the honest ceilings

Scorecard runs weekly and on `main`. The remaining gaps are deliberate and are documented as dismissed alerts:

| Check                                 | Why it isn't 10                                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code-Review, Branch-Protection (4/10) | Need a second human approver. GitHub never lets an author approve their own PR, and faking review defeats the check. Revisit when a co-maintainer joins. |
| Contributors                          | Needs contributors from several organizations.                                                                                                           |
| CII-Best-Practices                    | The OpenSSF Best Practices badge is a self-assessment at bestpractices.dev, not yet submitted. Likely achievable at the "passing" level.                 |
| Packaging                             | Looks for a registry publish (npm etc.). This is an application shipped through stores, not a library.                                                   |

Do not chase these with metric theater (sock-puppet reviewers, an npm package nobody installs). The score should reflect substance.

## Accepted risks and deferred work

- **node-forge** (GHSA-86w9-cpqp-85rv): dev-only, via web-ext → adbkit, with no fix released. Recorded in `osv-scanner.toml` with an expiry, and dismissed in Dependabot as tolerable risk. See [MAINTENANCE](MAINTENANCE.md#dated-items).
- **CodeQL alerts in tests and dev scripts** are out of scope by configuration. Shipped code under `src/` is always scanned.
- **A detection-hardening item for the page-context overrides** is tracked in a private draft security advisory, because describing it publicly would hand out a detection recipe. It's pinned until it can be live-tested in all three engines.
- The extension-level limits on spoofing (the initialization race, workers, engine internals) are documented in `src/content/injected/index.ts` and [`BACKGROUND.md`](BACKGROUND.md). They're product limits, not repository controls.
