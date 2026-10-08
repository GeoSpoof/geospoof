# Contributing to GeoSpoof

## Requirements

Node.js 18+, npm 9+, Firefox 140+ or any Chromium-based browser

## Quick Start

```bash
git clone https://github.com/GeoSpoof/geospoof.git
cd geospoof
npm install
cp .env.example .env
```

## Building from Source

**Firefox:**

```bash
npm run build:firefox
npm run start:firefox   # launches Firefox with the extension loaded from dist/
```

**Chrome / Brave / Edge:**

```bash
npm run build:chromium
```

Then load `dist/` as an unpacked extension:

1. Go to `chrome://extensions` (or `brave://extensions`, `edge://extensions`)
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `dist/` folder

Or use `npm run start:chrome` / `npm run start:brave` to build and launch automatically.

## Day-to-Day Development

Open two terminals:

```bash
# Terminal 1 — watches your source files and rebuilds on every save
npm run dev

# Terminal 2 — launches Firefox with the extension loaded, auto-reloads on rebuild
npm start
```

Edit code, save, Firefox reloads. If something looks wrong, check the browser console (`about:debugging` → Inspect for background, F12 for content scripts).

For Chromium development, use `npm run start:chrome` or `npm run start:brave` instead.

## Scripts Reference

| Command                    | What it does                                                          |
| -------------------------- | --------------------------------------------------------------------- |
| `npm run dev`              | Watch mode — Vite rebuilds `dist/` on every file change               |
| `npm start`                | Launch Firefox with the extension loaded from `dist/`                 |
| `npm run build:dev`        | One-time dev build (source maps, console logs)                        |
| `npm run build:prod`       | One-time production build (minified, no logs)                         |
| `npm run build:firefox`    | Production build targeting Firefox                                    |
| `npm run build:chromium`   | Production build targeting Chrome/Brave/Edge                          |
| `npm test`                 | Run all tests                                                         |
| `npm run lint:ext`         | Lint the extension manifest and files                                 |
| `npm run validate`         | Type-check + lint + format check + tests (run before PRs)             |
| `npm run package`          | Firefox production build + zip for AMO submission                     |
| `npm run package:chromium` | Chromium production build + zip for Chrome Web Store                  |
| `npm run package:xpi`      | Production build + package as `.xpi` for sideloading                  |
| `npm run package:source`   | Zip source code for AMO review (excludes node_modules, dist, etc.)    |
| `npm run sign:xpi`         | Sign the built `.xpi` via AMO unlisted channel (requires credentials) |
| `npm run sign:xpi:amo`     | Sign the built `.xpi` via AMO listed channel (requires credentials)   |
| `npm run start:firefox`    | Launch Firefox with the extension loaded                              |
| `npm run start:chrome`     | Build for Chromium + launch Chrome                                    |
| `npm run start:brave`      | Build for Chromium + launch Brave                                     |
| `npm run start:android`    | Launch on Firefox for Android (USB, auto-detects device)              |

## Testing on Android

Requires `adb` (`brew install android-platform-tools`) and a USB-connected Android device with Firefox installed.

1. Enable Developer Options on your device (Settings → About Phone → tap Build Number 7 times)
2. Enable USB Debugging (Settings → Developer Options → USB Debugging)
3. In Firefox for Android: Settings → Remote debugging via USB → On
4. Connect via USB and run:

```bash
npm run build:dev
npm run start:android
```

The script auto-detects the first connected device via `adb`. To target a specific device, pass its ID manually:

```bash
npm run start:android -- <device-id>
```

You can find device IDs with `adb devices`.

## Project Structure

```
src/
├── background/          # Settings, geocoding, timezone resolution, VPN sync
├── build/               # Manifest generator (Firefox/Chromium targets)
├── content/
│   ├── index.ts         # Content script (bridge between background and injected)
│   └── injected/        # Page-context API overrides (12 modules)
├── popup/               # Extension popup UI
└── shared/              # Shared types and utilities
tests/
├── unit/                # Unit tests
├── integration/         # Integration tests
└── property/            # Property-based tests (fast-check)
```

## Adding User-Facing Strings

Two separate localization systems, because the extension and the native Safari app
have different runtimes. Both ship the same 12 languages and must agree on
terminology — the shared glossary is [`TRANSLATION.md`](TRANSLATION.md).

### Extension popup

Add the string to `_locales/en/messages.json` with a `message` and a
`description`, then reference it from markup via `data-i18n` (or
`data-i18n-placeholder` / `data-i18n-title` / `data-i18n-aria-label`) rather than
hardcoding English. See [`_locales/README.md`](_locales/README.md).

### Native app

The native iOS and macOS apps live in a separate private repository,
`geospoof-ios`, together with their String Catalog and the SwiftUI rules for
adding strings to it. See `CONTRIBUTING.md` and `TRANSLATION.md` there.

The two aren't independent. The app's catalog must cover exactly the languages
`_locales` covers here, and the app's glossary is _derived from_ these
translations — so changing an established feature term in this repo means
changing it there too, or the popup and the app end up with two words for one
thing. That constraint is enforced from the app side: it reads this repo's
`SUPPORTED_UI_LOCALES` through a submodule and checks the catalog against it
daily.

### Validation

`npm test` covers the extension side:

- `tests/unit/locales.unit.test.ts` — `_locales` key and placeholder parity.

## Project Configuration

### Path Aliases

Configured in `tsconfig.json` (for TypeScript/IDE) and `vite.config.ts` (for bundling). Prefer these over deep relative imports.

| Alias            | Maps to              |
| ---------------- | -------------------- |
| `@/*`            | `./src/*`            |
| `@/background/*` | `./src/background/*` |
| `@/content/*`    | `./src/content/*`    |
| `@/popup/*`      | `./src/popup/*`      |
| `@/shared/*`     | `./src/shared/*`     |

### Config Files

| File                 | Tool       | Purpose                                           |
| -------------------- | ---------- | ------------------------------------------------- |
| `tsconfig.json`      | TypeScript | Main config — strict mode, path aliases           |
| `tsconfig.node.json` | TypeScript | Build scripts (`vite.config.ts`)                  |
| `tsconfig.test.json` | TypeScript | Test files (includes `tests/`)                    |
| `vite.config.ts`     | Vite       | Multi-entry WebExtension build                    |
| `vitest.config.ts`   | Vitest     | Test config + coverage thresholds                 |
| `eslint.config.js`   | ESLint     | Flat config (TypeScript + Prettier)               |
| `.prettierrc`        | Prettier   | Formatting rules                                  |
| `.husky/pre-commit`  | Husky      | Runs lint-staged on commit                        |
| `.npmrc`             | npm        | Package manager settings (`audit-level=moderate`) |

Coverage thresholds: 80% lines, 80% functions, 75% branches, 80% statements.

## Dependency Policy

- **Security patches**: immediately (high/critical within 24h, moderate within a week).
- **Routine updates**: `npm outdated` → `npm update` → `npm run validate` → commit.
- **Major versions**: read the changelog, update on a branch, validate, fix breakage, test in Firefox + Chromium, PR.
- **Pinning**: TypeScript and Vite use tilde ranges (`~5.7`); other devDeps use caret ranges (`^x.y.z`). `package-lock.json` is committed for reproducibility.

## Building for Review

**Firefox (AMO):**

```bash
npm install
cp .env.example .env
npm run package
```

Produces `web-ext-artifacts/geospoof-<version>.zip` for AMO submission.

**Chromium (Chrome Web Store):**

```bash
npm install
cp .env.example .env
npm run package:chromium
```

Produces `web-ext-artifacts/geospoof-chromium-v<version>.zip`.

## Release Pipeline

A single `v*` tag push (e.g., `v1.18.0`) triggers the full release pipeline:

1. Build Firefox, package unsigned XPI and source zip
2. Inject build version (`1.18.0.{run}`) → sign unlisted (self-hosted)
3. Restore clean dist → strip `update_url` → sign listed (AMO) with source
4. Build Chromium
5. Create one GitHub Release with all artifacts (signed XPI, unsigned XPI, Chromium zip, source zip)
6. Publish `update.json` to `cdn.geospoof.com/firefox/` **and** to GitHub Pages, then fail the release if the two disagree

The unlisted XPI uses a 4-segment version (e.g., `1.18.0.42`) while the AMO submission uses the clean 3-segment version (`1.18.0`). This avoids AMO's version uniqueness constraint across channels.

**Required GitHub Actions secrets:**

| Secret           | Description              |
| ---------------- | ------------------------ |
| `AMO_JWT_ISSUER` | AMO API key (JWT issuer) |
| `AMO_JWT_SECRET` | AMO API secret           |

To generate credentials: go to the [AMO API Keys page](https://addons.mozilla.org/en-US/developers/addon/api/key/) and sign in with the Mozilla account that owns the extension listing.

**Required GitHub Actions variables** (not secrets — none of these authenticate anything; publishing uses OIDC with no stored credentials):

| Variable                  | Description                                           |
| ------------------------- | ----------------------------------------------------- |
| `EXT_PUBLISH_ROLE_ARN`    | IAM role the release assumes to publish `update.json` |
| `EXT_CDN_BUCKET`          | CDN origin bucket                                     |
| `EXT_CDN_DISTRIBUTION_ID` | CloudFront distribution to invalidate                 |

### Self-hosted update path: migrating off GitHub Pages

**Why this exists.** `update_url` is compiled into every shipped copy of the extension (`src/build/manifest.ts`). Firefox keeps polling whatever URL the installed copy carries, and [an existing install cannot be told about a new one](https://extensionworkshop.com/documentation/manage/updating-your-extension/). It historically pointed at `anthonysgro.github.io/geospoof/update.json`, which tied every self-hosted install's update path to a personal GitHub username — and a repo's github.io path does not survive a transfer to another owner. Moving this repo with that URL baked in would have stranded those installs on their current version, silently, since a failed update check is invisible to the user.

**Where it stands now.** As of v2.2.1 the shipped `update_url` points at `https://cdn.geospoof.com/firefox/update.json`, a domain we own, and the release workflow publishes only there — the GitHub Pages publish was retired once the installed base had rolled forward (v2.2.1 and v2.2.2 shipped over roughly three weeks and the signed-asset downloads plateaued in the normal release band). Installs from v2.2.1 on poll the CDN and are unaffected by any repo move.

**Measuring the rollout** (used before retiring Pages; kept for reference). Auto-updates download the XPI via `update_link`, so a release's signed-asset download count is the migration counter:

```bash
# Note the camelCase: `gh release view --json` uses downloadCount, while the REST
# API uses download_count. Getting it wrong returns null rather than an error.
gh release view v2.2.1 --json assets \
  --jq '.assets[] | select(.name|test("-signed")) | .downloadCount'
```

A fast climb then a plateau is a completed cycle. For scale, v2.1.5 reached ~141.

**Transfer checklist** — the Pages publish is already gone (step 1, done), so what remains is the move itself:

1. ~~Remove the GitHub Pages publish steps and `pages: write` from `.github/workflows/release.yml`.~~ **Done.** The workflow now publishes the manifest only to the CDN.
2. Transfer the repo to the `GeoSpoof` org.
3. **Immediately** run the `CDN publish preflight` workflow. Transferring a repo flips GitHub's OIDC subject to the immutable id-based format, which breaks name-based trust policies — see `cdk/README.md`, "Who may publish". The publish role already trusts both forms, so this should pass; run it to be sure rather than finding out at the next release.
4. In `cdk/lib/config/app.ts`, remove the now-dead legacy entry `"repo:anthonysgro/geospoof:*"` from `extensionUpdates.githubSubjectPatterns`, leaving only the immutable `"repo:*/geospoof@1170325630:*"`, and redeploy. Confirm the live value first with:
   ```bash
   gh api repos/GeoSpoof/geospoof/actions/oidc/customization/sub \
     --jq '{immutable:.use_immutable_subject,prefix:.sub_claim_prefix}'
   ```
5. Update remaining `anthonysgro/geospoof` references.

**Do not** create anything at the old `anthonysgro/geospoof` path. Manifests published before the transfer point `update_link` at `github.com/anthonysgro/geospoof/releases/...`, and that redirect to the new location survives only while the old path stays unused.

An install that never checked for updates between v2.2.1 shipping and the transfer stays pinned to the old github.io URL, which stops resolving once the repo moves; recovery is a manual reinstall. AMO users are unaffected throughout — the listed build has `update_url` stripped.

**Releasing:**

```bash
npm run validate
npm version patch   # or minor/major
git push origin main --tags
```

`npm version` bumps package.json, commits, and creates the `v*` tag automatically.

**Local signing (testing):**

```bash
# Unlisted (self-hosted)
npm run build:firefox
npm run package:xpi
npm run sign:xpi

# Listed (AMO)
npm run build:firefox
npm run package:source
npm run sign:xpi:amo
```

Both require `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` in your `.env`.

## Useful Git Commands

```bash
git tag                      # list all tags
git tag -d v1.2.0            # delete a local tag
git push origin :v1.2.0      # delete a remote tag
git log --oneline --decorate # see commits with tags
```

## License & Contribution Terms

Everything in this repository — the browser extension, site, docs, and assets — is licensed under [MIT](LICENSE). The native iOS and macOS apps are developed separately, are proprietary, and are not part of this repository, so contributions here are MIT throughout.

By submitting a contribution (a pull request, patch, or any code, docs, or other material), you agree that:

1. Your contribution is licensed under the [MIT License](LICENSE).
2. You have the right to submit the work under that license, and you grant the maintainer the rights described below.
3. You sign off on the [Developer Certificate of Origin](https://developercertificate.org/) for each commit (add a `Signed-off-by:` line with `git commit -s`), certifying you authored the contribution or otherwise have the right to submit it under these terms.

To allow the project's licensing to be maintained over time, you also grant the maintainer a perpetual, irrevocable, worldwide, royalty-free license to use, relicense, and sublicense your contribution as part of GeoSpoof. If you cannot agree to these terms for a particular contribution, note it in your pull request so it can be handled separately.
