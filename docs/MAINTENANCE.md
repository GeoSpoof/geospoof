# Maintenance & Quality

How this repository stays current, healthy, and low-effort to run. It covers dependency policy, quality gates, alert triage, and the dated items that need a human. For the security controls themselves, see [`REPO_SECURITY.md`](REPO_SECURITY.md).

Principles:

- **Automate the routine, review the risky.** Patches flow; majors and anything that ships get a human.
- **Fix the cause, not the warning.** Don't silence a deprecation, scanner finding, or failing check unless it's a documented false positive.
- **Every exception has a reason and an end date.** Ignores, dismissals, and holds are written down where they're configured.
- **Low maintenance is a feature.** No tooling whose upkeep costs more than it saves.

## Dependencies

**What we depend on:** four runtime packages in the extension (`browser-geo-tz`, `tr46`, `urlpattern-polyfill`, `webextension-polyfill`). Everything else is build, lint, and test tooling. `cdk/` is a separate project with its own lockfile.

**Version pinning:** exact pins for anything whose output we ship or test against (`vite`, `vitest`, `esbuild`, `jsdom`, runtime packages, `geo-tz`); caret ranges for low-risk tooling. Lockfiles are always committed, and CI installs with `npm ci`.

**Integrity:** CI runs `npm audit signatures` to verify registry signatures and provenance for every installed package. `overrides` in `package.json` force patched transitive versions when upstream hasn't caught up; each one should go once its parent package ships the fix.

**Node:** `engines.node` is `>=24.15.0` in both projects, `.nvmrc` pins it, and CI uses Node 24. `@types/node` tracks the runtime major, not the latest Node.

## Dependabot

Configured in [`.github/dependabot.yml`](../.github/dependabot.yml). Version updates run **weekly (Monday)** with a **7-day cooldown**, so a new release must age a week before Dependabot proposes it. Malicious npm publishes are usually caught within hours. Security updates ignore both the schedule and the cooldown, and arrive as soon as an advisory lands.

Three blocks, so a failure in one project never blocks another: `github-actions`, `npm /`, and `npm /cdk`. Group rules are **first match wins**, in this order:

| Group                   | Contents                                               | Update types      | Why                                                                     |
| ----------------------- | ------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------- |
| `vitest`                | `vitest`, `@vitest/*`, `vite` (root)                   | all, incl. majors | Lockstep: these must move together or `npm ci` fails on a peer conflict |
| `eslint`                | `eslint`, `@eslint/*`, `eslint-*`, `typescript-eslint` | all, incl. majors | Lockstep                                                                |
| `aws-cdk` (cdk)         | `aws-cdk`, `aws-cdk-lib`, `constructs`                 | minor, patch      | The CLI must understand what the library emits; majors are migrations   |
| `runtime` (root)        | production deps                                        | minor, patch      | Ships to users, so it's always its own reviewed PR                      |
| `dev-patch` (root)      | dev deps                                               | patch             | The only group that auto-merges                                         |
| `dev-minor` (root)      | dev deps, except `esbuild` and `prettier`              | minor             | Reviewed by hand                                                        |
| `dev-minor-patch` (cdk) | dev deps, except `prettier`                            | minor, patch      | Not auto-merged (CDK CI isn't a required check)                         |

Anything unmatched (a major outside a lockstep family, `esbuild` minors, `prettier` minors) gets its own PR. `esbuild` is 0.x, so its minors are breaking. `prettier` minors reformat code and need a `npm run format` commit.

**Ignores, and when to lift them:**

| Ignore                      | Reason                                                                               | Lift when                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `geo-tz` (cdk), all updates | Cross-repo contract with `src/shared/geo-tz-data.json`, and synth refuses a mismatch | Never automatically; bump deliberately per [`TIMEZONE_GEO_DATA.md`](TIMEZONE_GEO_DATA.md) |
| `@types/node` majors        | Types must match the Node 24 runtime                                                 | When `engines`, `.nvmrc`, and CI move to the next Node major                              |
| `typescript` `>=6.1.0`      | `typescript-eslint`'s peer range is `<6.1.0`                                         | When `typescript-eslint` widens its range; raise the bound                                |

### Auto-merge policy

`dependabot-auto-merge.yml` enables auto-merge only for root devDependency **patch** updates: the `dev-patch` group, or an ungrouped `direct:development` patch. It checks the PR author, not `github.actor`, which is spoofable. Auto-merge never bypasses the rules: every required check, the code-scanning gate, and signed commits still apply. Everything else needs a human: runtime deps, minors, majors, Actions bumps, and anything in `cdk/`.

### Handling a Dependabot PR

1. **Green, and a patch or minor:** read the changelog, merge.
2. **A major:** read the migration notes. If CI is red, fix the cause on the PR branch. For example, TypeScript 6 deprecated `baseUrl`; the fix was removing it, not adding `ignoreDeprecations`, which only defers the break.
3. **Several PRs at once:** strict up-to-date checks mean each merge makes the rest "behind". Merge one, update the next branch, wait for green, repeat.

## Quality gates

Required on every PR into `main`: `Build & Test` (type-check, ESLint, Prettier check, production build, `web-ext lint`, the full Vitest suite, `npm audit signatures`) and `Dependency review`, plus the CodeQL code-scanning gate. `CDK lint, test, synth` runs whenever `cdk/` changes. Run the same gate locally with `npm run validate`.

**Tests:** around 2,000 unit and property tests. Coverage thresholds live in `vitest.config.ts`. Behavior changes and bug fixes come with a test that fails without the fix; the Math.random isolation test is the model.

**Pre-commit:** husky + lint-staged run ESLint and Prettier on staged files. Commits must be signed (see [REPO_SECURITY](REPO_SECURITY.md#commit-signing)).

**Docs are part of the change.** When behavior changes, update the relevant `/docs` page in the same PR.

## Alert triage

| Source           | Where                    | Default action                                                                                                                                                                                         |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dependabot alert | Security → Dependabot    | Merge the security PR. With no fix available: assess reachability, add an `overrides` entry if a patched transitive exists, else dismiss with a reason and add it to `osv-scanner.toml` with an expiry |
| CodeQL           | Security → Code scanning | Fix shipped code. A genuine false positive gets a dismissal with a written reason. Never hand-wave it: the original "insecure randomness" alert was real for an anti-fingerprinting override           |
| zizmor           | Code scanning            | Fix the workflow. Findings mean a real CI weakness                                                                                                                                                     |
| Scorecard        | Code scanning / badge    | Fix if it's substance. Solo-maintainer ceilings stay dismissed with a reason ([REPO_SECURITY](REPO_SECURITY.md#scorecard-whats-maxed-and-the-honest-ceilings))                                         |

`osv-scanner.toml` is the record of reviewed, accepted advisories. Scorecard's Vulnerabilities check and OSV-Scanner both read it. Every entry needs a `reason` and an `ignoreUntil`.

## Dated items

Things that won't happen on their own. Check this list when you cut a release.

| When                                          | Item                                                                                                                                                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **2027-01-15**                                | `osv-scanner.toml` node-forge entry expires. Re-check web-ext/adbkit; drop the entry if fixed, otherwise extend it with a fresh review                                                                                     |
| **Oct–Nov 2026**                              | `ubuntu-latest` moves to 26.04. We're pinned to `ubuntu-24.04`, so nothing breaks, but plan the move: bump every `runs-on` (Dependabot doesn't touch runner labels), then run CI, a release dry run, and the CDN preflight |
| When typescript-eslint supports TS ≥ 6.1      | Raise the `typescript` ignore bound in `dependabot.yml`                                                                                                                                                                    |
| Next Node major (Node 24 LTS ends April 2028) | Bump `engines`, `.nvmrc`, and CI together, then lift the `@types/node` major ignore for one PR                                                                                                                             |
| When `geo-tz` publishes new data              | A coordinated two-repo bump per [`TIMEZONE_GEO_DATA.md`](TIMEZONE_GEO_DATA.md)                                                                                                                                             |
| When a co-maintainer joins                    | Require 1 approval, enable last-push approval, and un-dismiss the Code-Review and Branch-Protection Scorecard alerts                                                                                                       |

## Releasing

The procedure, from the version-bump PR to the Chrome Web Store CRX upload, is in [CONTRIBUTING, Release Pipeline](../.github/CONTRIBUTING.md#release-pipeline). After each release, watch the run to the end, check that the CDN manifest matches, verify an asset's attestation, and smoke-test the XPI and the Chrome build on geospoof.com/test.
