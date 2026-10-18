# GeoSpoof CDK

Infrastructure-as-code for GeoSpoof's AWS footprint. Two stacks per
environment. `GeoSpoofGeoTzCdn-<env>` provisions:

- **geo-tz boundary-data CDN** — a private S3 bucket fronted by CloudFront
  (OAC), serving timezone data at `cdn.geospoof.com/geo-tz/<version>/` for the
  extension. Includes a 5xx alarm and a monthly cost budget.
- **GeoSpoof GPS downloads** (prod only) — reuses the same bucket + distribution
  to serve the signed, notarized macOS DMG under `cdn.geospoof.com/gps/`,
  published by the private `geospoof-gps` repo's CI via GitHub OIDC (no stored
  AWS keys). See [GPS DMG publishing](#gps-dmg-publishing) below.

`GeoSpoofApnsRelay-<env>` is the **APNs relay** for Live Activity push: an HTTP
API and one Lambda. It is a separate stack so a relay deploy never churns the
CDN. See [APNs relay](#apns-relay) below.

## Layout

| Path                              | What                                                    |
| --------------------------------- | ------------------------------------------------------- |
| `lib/app.ts`                      | CDK app entry; instantiates the stacks per env          |
| `lib/config/app.ts`               | Per-env config (accounts, domain, GPS release, relay)   |
| `lib/stacks/geo-tz-cdn-stack.ts`  | The CDN stack                                           |
| `lib/constructs/geo-tz-cdn.ts`    | S3 + CloudFront + monitoring for the geo-tz data        |
| `lib/constructs/gps-downloads.ts` | OIDC role letting geospoof-gps CI publish the DMG       |
| `lib/stacks/apns-relay-stack.ts`  | The APNs relay stack                                    |
| `lib/constructs/apns-relay.ts`    | HTTP API + Lambda + secrets + alarms + budget           |
| `lib/lambda/apns-relay/`          | The relay Lambda's source (self-contained; no CDK code) |
| `test/`, `test/apns-relay/`       | Vitest unit/assertion tests                             |

## Prerequisites

- **Node.js 18+** and npm
- **AWS CLI v2** (`aws --version`) — needed for SSO login and querying envs
- CDK is pinned as a dev dependency (`aws-cdk`), so use `npx cdk` or the npm
  scripts; no global install required.

```sh
npm install
```

## AWS access (SSO)

Access is via AWS IAM Identity Center (SSO). Deploys and queries run under two
named profiles — `geospoof-dev` and `geospoof-prod` — that the npm scripts
already reference.

### 1. Configure the profiles (one time)

Add these to `~/.aws/config` (fill in the two placeholders from your Identity
Center portal — the start URL and the SSO region; the role name is whatever
permission set you're granted, e.g. `AdministratorAccess`):

```ini
[sso-session geospoof]
sso_start_url = https://<your-portal>.awsapps.com/start
sso_region = <your-sso-region>        # e.g. us-east-1
sso_registration_scopes = sso:account:access

[profile geospoof-dev]
sso_session = geospoof
sso_account_id = 898565151814
sso_role_name = <YourPermissionSet>
region = us-east-1
output = json

[profile geospoof-prod]
sso_session = geospoof
sso_account_id = 682844365870
sso_role_name = <YourPermissionSet>
region = us-east-1
output = json
```

Alternatively run `aws configure sso` and follow the prompts (name the profiles
`geospoof-dev` / `geospoof-prod`).

### 2. Log in (per session — SSO tokens expire)

```sh
aws sso login --profile geospoof-prod   # or geospoof-dev
```

### 3. Verify you're pointed at the right account

```sh
aws sts get-caller-identity --profile geospoof-prod
# Account should be 682844365870 (prod) / 898565151814 (dev)
```

## Environments

| Env  | Account        | Profile         | Region      | Domain                 | Stacks                                            |
| ---- | -------------- | --------------- | ----------- | ---------------------- | ------------------------------------------------- |
| dev  | `898565151814` | `geospoof-dev`  | `us-east-1` | `cdn-dev.geospoof.com` | `GeoSpoofGeoTzCdn-dev`, `GeoSpoofApnsRelay-dev`   |
| prod | `682844365870` | `geospoof-prod` | `us-east-1` | `cdn.geospoof.com`     | `GeoSpoofGeoTzCdn-prod`, `GeoSpoofApnsRelay-prod` |

The environment is selected with `-c env=dev|prod` (the npm scripts pass this).
Each env's account is pinned, so a deploy only succeeds against the matching
account/profile.

## Common commands

Build / quality (what `build:full` chains before every deploy):

```sh
npm run build          # tsc compile
npm run test           # vitest
npm run lint           # eslint
npm run format:check   # prettier --check   (npm run format to fix)
```

Preview + deploy (these wrap `--context env` and `--profile` for you):

```sh
# Always log in first:
aws sso login --profile geospoof-dev      # or geospoof-prod

npm run diff:dev       # cdk diff  against dev
npm run deploy:dev     # build:full + cdk deploy --all (dev)

npm run diff:prod      # cdk diff  against prod
npm run deploy:prod    # build:full + cdk deploy --all (prod)
```

Running the CDK CLI directly (equivalent to the scripts, handy for one-offs):

```sh
npx cdk synth  --context env=prod --profile geospoof-prod
npx cdk diff   --all --context env=prod --profile geospoof-prod
npx cdk deploy --all --context env=prod --profile geospoof-prod
```

## Querying the deployed environments

Read stack outputs (role ARN, bucket, distribution id, data version, base URL):

```sh
aws cloudformation describe-stacks \
  --stack-name GeoSpoofGeoTzCdn-prod \
  --profile geospoof-prod \
  --query "Stacks[0].Outputs" --output table
```

Inspect the CDN bucket and objects:

```sh
# Bucket name comes from the BucketName / GpsCdnBucket output above.
aws s3 ls "s3://<bucket>/gps/"            --profile geospoof-prod
aws s3 ls "s3://<bucket>/geo-tz/"         --profile geospoof-prod
```

List CloudFront distributions / check invalidations:

```sh
aws cloudfront list-distributions \
  --profile geospoof-prod \
  --query "DistributionList.Items[].{Id:Id,Domain:DomainName,Aliases:Aliases.Items}" \
  --output table
```

## Configuration

- **Alarm + budget email** is kept out of the repo. Set it via env var (or a
  gitignored `cdk/.env`): `GEOSPOOF_ALARM_EMAIL_PROD` / `GEOSPOOF_ALARM_EMAIL_DEV`
  (or the shared `GEOSPOOF_ALARM_EMAIL`). Without it, the alarm topic is created
  with no subscriber and the budget is skipped. See `.env.example`.
- **Custom-domain certificates** are ACM certs in `us-east-1`, created and
  DNS-validated out of band (DNS lives at Namecheap, not Route 53) and imported
  by ARN in `lib/config/app.ts`. The CDN's are CloudFront certs. The APNs
  relay's are REGIONAL API Gateway certs and must live in the API's own account,
  so the two can't be shared (see [Custom domain](#custom-domain)).

## GPS DMG publishing

Prod serves the GeoSpoof GPS DMG from `cdn.geospoof.com/gps/`. The private
`geospoof-gps` repo's release workflow uploads it using GitHub OIDC against an
IAM role this stack creates — no long-lived AWS keys.

To wire it up after a prod deploy:

1. `npm run deploy:prod` and note these stack outputs:
   - `GpsDownloadsGpsPublishRoleArn`
   - `GpsDownloadsGpsCdnBucket`
   - `GpsDownloadsGpsCdnDistributionId`
2. In the **geospoof-gps** repo → Settings → Secrets and variables → Actions →
   **Variables**, set:
   - `GPS_PUBLISH_ROLE_ARN` = the role ARN
   - `GPS_CDN_BUCKET` = the bucket name
   - `GPS_CDN_DISTRIBUTION_ID` = the distribution id
3. Cut a GPS release; the workflow publishes `GeoSpoof-GPS-v<version>.dmg`,
   `latest.dmg`, and `latest.json`, then invalidates the moving pointers.

> **OIDC provider gotcha:** an AWS account may hold only ONE GitHub Actions OIDC
> provider (`token.actions.githubusercontent.com`). If the prod account already
> has one, importing it — not creating a second — is required: set
> `gpsRelease.oidcProviderArn` in `lib/config/app.ts` to the existing provider's
> ARN and redeploy.

### Who may publish: the OIDC subject is not a repo name

`gpsRelease.githubSubjectPatterns` in `lib/config/app.ts` decides whose workflow
may write to the CDN. It looks like it should hold `repo:GeoSpoof/geospoof-gps:*`.
**That value cannot match.** GitHub issues an _immutable_ subject claim that embeds
numeric owner and repo ids:

```
repo:GeoSpoof@320249603/geospoof-gps@1291874641:ref:refs/tags/gps-v0.2.2
```

Repos created after 2026-07-15 — and **any repo renamed or transferred after that
date** — use this format. Untouched older repos keep the classic name-based one
until an admin opts in. See
[GitHub's OIDC docs](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-google-cloud-platform).

Never reconstruct the string. Read it from the repo:

```sh
gh api repos/OWNER/REPO/actions/oidc/customization/sub --jq .sub_claim_prefix
```

The configured pattern wildcards the **owner** segment and pins the **repo**
segment, so a future transfer needs no change here: a move changes the owner id,
never the repo id. That is safe with no `repository_id` condition, because the repo
id is inside the subject and repo ids are globally unique and never reused — only
tokens minted for that one repo can match. Which matters, because AWS has only
reliably honored `sub` and `aud` from GitHub tokens, so a trust policy leaning on a
custom claim is a good way to deny every publish.

> **Transferring or renaming the GPS repo is a two-provider change.** Entra holds
> the matching federated credentials for Windows code signing
> (`geospoof-gps:scripts/setup-windows-signing.ps1`) and they must agree with this
> policy. Nothing compiles both. When `geospoof-gps` moved to the GeoSpoof org, the
> transfer itself flipped the subject format and broke credentials that had been
> verified working an hour earlier — invisibly to both AWS and Entra, because the
> format is only observable in a real token.
>
> Prove it before trusting a release to it. The GPS Windows workflow's preflight
> step exchanges the real subject in seconds, ahead of the ~13-minute build:
>
> ```sh
> gh workflow run release-windows.yml --repo GeoSpoof/geospoof-gps --ref main \
>   -f sign=true -f publish_release=false
> ```
>
> A green preflight means the subject matched. That only covers Entra, though —
> `Configure AWS credentials (OIDC)` is skipped unless `publish_release` is on, so
> the trust policy above is exercised only by a real `gps-v*` tag. It fails closed.

## APNs relay

`GeoSpoofApnsRelay-<env>` lets the GPS desktop agent update a Live Activity on
a locked iPhone while the app isn't running. Two routes on one Lambda:

- `POST /v1/session` exchanges Apple-signed StoreKit entitlement material for an
  8-hour session token bound to a hash of one push token. The entitlement is
  verified offline and discarded. Nothing about it is stored or logged.
- `POST /v1/push` takes that token as `Authorization: Bearer`, validates the
  request strictly per `kind`, builds the APNs request and forwards the outcome.
  `202 {"apns_id"}` means APNs **accepted** the push, not that it reached the
  device.

**The wire formats belong to `geospoof-ios:.kiro/specs/live-activity-push/design.md`.
This repo mirrors none of them.** If the code here and that file disagree, the
file is right.

### Cross-repo couplings

None of these is visible from inside this repo, and nothing compiles both sides.

- The `content-state` keys the relay emits are the Swift property names of
  `RouteActivityAttributes.ContentState` in
  `geospoof-ios:app/Shared (App)/RouteActivityAttributes.swift`. That type
  declares no `CodingKeys`, so renaming a Swift property changes the wire
  format. The relay's request is snake_case. `lib/lambda/apns-relay/push-schema.ts`
  translates it and turns durations into Unix-epoch absolutes from its own clock.
- The Apple-facing code (ES256 JWT with `ieee-p1363`, headers, payload shape) is
  ported from `geospoof-ios:scripts/apns-push.mjs`, which is hardware-proven.
- The Pro rule and the embedded Apple Root CA - G3 mirror the GPS agent
  (`geospoof-gps:agent/src/entitlement.rs`, `agent/assets/AppleRootCA-G3.cer`).
  The relay accepts StoreKit Production and Sandbox, never Xcode or LocalTesting.
- The client is the GPS agent (Phase 3 of that spec).

### Key custody: CDK does not own the APNs key

The APNs signing key secret `geospoof/apns/signing-key` (JSON
`{keyId, teamId, p8}`) was created out of band in each account. **Apple will not
let you download a `.p8` again**, so the stack imports the secret by name
(`Secret.fromSecretNameV2` plus `grantRead`). An import creates no
CloudFormation resource, so `cdk destroy` or a construct-id rename can't delete
or replace it. The value never passes through CDK, so it never lands in a
template, `cdk.out/` or the CloudFormation console. The Lambda gets the name and
fetches the value at runtime. If the secret's `keyId`/`teamId` don't match
`lib/config/app.ts`, it signs nothing and raises a `RelayFault{key_mismatch}`
alarm.

| Stack                    | Serves `environment` | APNs host                    | Key ID       |
| ------------------------ | -------------------- | ---------------------------- | ------------ |
| `GeoSpoofApnsRelay-dev`  | `sandbox`            | `api.sandbox.push.apple.com` | `A3TWAYM427` |
| `GeoSpoofApnsRelay-prod` | `production`         | `api.push.apple.com`         | `Y7QSB5K2Y6` |

A push for the other environment gets `400 environment_unsupported` and is never
sent. Whether one relay must serve both hosts depends on
`geospoof-ios` tasks.md 1.3 (the 6.2b token-family split on production-signed
builds). If it must, add the second key to `apnsKeys`. The code already supports
that, but cross-account IAM doesn't exist yet.

To check that the secret exists, use `describe-secret`. **Never run
`get-secret-value`.**

```sh
aws secretsmanager describe-secret --secret-id geospoof/apns/signing-key \
  --profile geospoof-dev --query '{ARN:ARN,Deleted:DeletedDate}'
```

Rotating the APNs key means a new `.p8`, which means a new Key ID. Write the JSON
to a private temp file so the key never touches a command line. Then update
`keyId` in `lib/config/app.ts` and deploy:

```sh
umask 077; T=$(mktemp -d)
jq -n --arg keyId NEWKEYID --arg teamId 9445Q654K8 --rawfile p8 AuthKey_NEWKEYID.p8 \
  '{keyId: $keyId, teamId: $teamId, p8: $p8}' > "$T/secret.json"
aws secretsmanager put-secret-value --secret-id geospoof/apns/signing-key \
  --secret-string "file://$T/secret.json" --profile geospoof-dev
rm -rf "$T"
```

Warm containers cache the parsed key for their lifetime. After changing a secret,
redeploy, or recycle containers by updating the function's configuration. The
**session HMAC key** is a separate, CDK-generated secret. Rotating it signs every
agent out once (each gets a `401` and calls `/v1/session` again), which is
recoverable.

### Deploying only this stack

```sh
aws sso login --profile geospoof-dev
npx cdk diff   GeoSpoofApnsRelay-dev --context env=dev --profile geospoof-dev
npx cdk deploy GeoSpoofApnsRelay-dev --context env=dev --profile geospoof-dev
```

> **`npm run deploy:dev` / `deploy:prod` run `cdk deploy --all`, so they now
> include the relay.** The next `deploy:prod` will create
> `GeoSpoofApnsRelay-prod`, which signs with the production key. Use the
> single-stack command above when you mean only one stack. No CI workflow
> deploys CDK, so merging deploys nothing.

Read the base URL from the `ApnsRelayUrl` output. Smoke tests that need no
credentials:

```sh
URL=https://push-dev.geospoof.com
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$URL/v1/push" -d '{}'      # 401
curl -sS -X POST "$URL/v1/session" -H 'content-type: application/json' \
  -d '{"push_token":"00000000000000000000000000000000","app_transaction":"a.b.c"}'  # 403 entitlement_invalid
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$URL/v1/nope"               # 404
```

The base is `https://<api-id>.execute-api.us-east-1.amazonaws.com` only while
the env has no `certificateArn` configured. Once it has one, execute-api is
closed and answers `403`.

### Custom domain

| Stack                    | Hostname                | Cert lives in (us-east-1) |
| ------------------------ | ----------------------- | ------------------------- |
| `GeoSpoofApnsRelay-dev`  | `push-dev.geospoof.com` | `898565151814`            |
| `GeoSpoofApnsRelay-prod` | `push.geospoof.com`     | `682844365870`            |

**The agent embeds only these hostnames, never an execute-api URL.** That URL
embeds the API id, which changes if the API is ever replaced. Once an env's
`apnsRelay.customDomain.certificateArn` is set in `lib/config/app.ts`, the stack
disables execute-api, so the custom domain is the only door and anything
pointed at execute-api fails at once. Until it is set, the env serves on
execute-api only and `cdk synth` warns. Both doors reach the same `$default`
stage, so the throttles and the cost ceiling are the same through either.

**Prod is hostname-only for now, on purpose**: it has no cert, so its synth
warns about `push.geospoof.com`. That is expected until prod ships.

CDK never creates the certificate. DNS is at Namecheap, so a CDK-created cert
would block the deploy on DNS validation. The stack imports it by ARN, so a
destroy can't delete it either. API Gateway needs a REGIONAL cert in the API's
own account and region, so the CDN's certs can't be reused.

To enable an env, shown for prod. For dev, use `--profile geospoof-dev`,
account `898565151814`, `push-dev.geospoof.com`, token `pushdevgeospoof` and
`Value=dev`.

1. Request the cert, reusing one if it already exists:

   ```sh
   aws sso login --profile geospoof-prod
   aws sts get-caller-identity --profile geospoof-prod --query Account --output text   # 682844365870
   aws acm list-certificates --region us-east-1 --profile geospoof-prod \
     --certificate-statuses PENDING_VALIDATION ISSUED \
     --query "CertificateSummaryList[?DomainName=='push.geospoof.com'].[CertificateArn,Status]" --output text
   # only if none was listed:
   aws acm request-certificate --region us-east-1 --profile geospoof-prod \
     --domain-name push.geospoof.com --validation-method DNS --key-algorithm RSA_2048 \
     --idempotency-token pushgeospoof \
     --tags Key=project,Value=geospoof Key=component,Value=apns-relay Key=env,Value=prod \
     --query CertificateArn --output text
   aws acm describe-certificate --region us-east-1 --profile geospoof-prod --certificate-arn "<ARN>" \
     --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
   ```

   `ResourceRecord` can be `null` for a few seconds after the request. Re-run
   the describe if so.

2. Add the validation record at Namecheap (geospoof.com → Advanced DNS), then
   wait for `ISSUED`. API Gateway rejects a cert that isn't issued, so never
   deploy before this.

   ```sh
   aws acm wait certificate-validated --region us-east-1 --profile geospoof-prod \
     --certificate-arn "<ARN>"
   ```

3. Set `certificateArn` under that env's `apnsRelay.customDomain` in
   `lib/config/app.ts`. A config test checks the ARN is in that env's own
   account and region.
4. Diff and deploy only the relay stack (see
   [Deploying only this stack](#deploying-only-this-stack)). Expect
   `[+] AWS::ApiGatewayV2::DomainName`, `[+] AWS::ApiGatewayV2::ApiMapping`,
   `[~] AWS::ApiGatewayV2::Api` (`DisableExecuteApiEndpoint` only) and the
   output changes. No `AWS::CertificateManager::Certificate` should appear, and
   nothing should be replaced.
5. Add the serving record at Namecheap, pointing at the new
   `ApnsRelayDomainTarget` output.

The two Namecheap records per env, all with TTL Automatic:

| Purpose         | Type    | Host                                                            | Value                                                              |
| --------------- | ------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| Cert validation | `CNAME` | the record's `Name` minus `.geospoof.com.`, e.g. `_abc123.push` | the record's `Value` (`_….acm-validations.aws.`)                   |
| Serving         | `CNAME` | `push` (prod) / `push-dev` (dev)                                | `ApnsRelayDomainTarget`, `d-….execute-api.us-east-1.amazonaws.com` |

Keep the validation record after issuance. ACM uses it to renew the cert.

Before the serving CNAME exists, test through the domain anyway. curl still
checks the cert against the hostname:

```sh
TARGET=d-xxxxxxxxxx.execute-api.us-east-1.amazonaws.com   # the ApnsRelayDomainTarget output
curl -sS -o /dev/null -w '%{http_code}\n' --connect-to push-dev.geospoof.com:443:$TARGET:443 \
  -X POST https://push-dev.geospoof.com/v1/push -d '{}'    # 401
```

### Cost, metrics, alarms

- **Cost ceiling.** The per-route throttles (`/v1/push` 10 req/s burst 20,
  `/v1/session` 2 req/s burst 10) make the worst case arithmetic: about $67 a
  month. Expected cost is about $2. The sum is written out beside
  `APNS_RELAY_THROTTLE` in `lib/config/app.ts`, so a change to the throttle is
  a visible cost decision.
- **Budget.** The $10 monthly budget filters on `user:component$apns-relay`, so it
  reads $0 until `component` is an **active** cost-allocation tag in the account.
  Check with `aws ce list-cost-allocation-tags --tag-keys component`. The CDN's
  account-wide budget is the aggregate backstop.
- **Metrics** live in `GeoSpoof/ApnsRelay` as EMF: `ApnsResponse` by APNs
  `Status` (or `timeout`/`network`), `ApnsNon2xx`, `RelayRejected` by `Reason`,
  `RelayFault` by `Reason`, and `SessionIssued`.
- **Alarms** go to the relay's own SNS topic:
  - non-2xx rate above 20% for 15 min, at ≥10 pushes per 5 min
  - any `RelayFault` (key mismatch, unreadable secret, APNs 403)
  - Lambda errors
- **Logs** hold failures only, with whitelisted fields (route, error code, APNs
  status, reason enum, apns-id). The entitlement JWS, push token, session token
  and provider JWT are credentials and are never logged. There are no API
  access logs, because they would record client IPs.

### Follow-ups

- **Reserved concurrency** isn't set, because the account quotas are unverified,
  and reserving on a 10-concurrency account fails the deploy. Once the quota is
  known, reserving a small number caps the cost of a hung upstream.

## First-time account bootstrap

Each account/region must be CDK-bootstrapped once before the first deploy:

```sh
aws sso login --profile geospoof-prod
npx cdk bootstrap aws://682844365870/us-east-1 --profile geospoof-prod
# dev: aws://898565151814/us-east-1 --profile geospoof-dev
```

## Notes

- **CloudFront access logging is intentionally OFF** — it records client IPs,
  which conflicts with a location-privacy product. Aggregate CloudWatch metrics
  carry no PII.
- The prod data bucket is **retained** on stack delete (dev is destroyed +
  auto-emptied), so a `cdk destroy` in prod won't nuke served data.
