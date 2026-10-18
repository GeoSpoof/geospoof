import { Duration } from "aws-cdk-lib";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ApnsEnvironment, StoreKitEnvironmentName } from "../lambda/apns-relay/env-contract";

export type EnvName = "dev" | "prod";

export interface HostedZoneConfig {
  readonly hostedZoneId: string;
  readonly zoneName: string;
}

export interface CustomDomainConfig {
  /** FQDN to serve the data from, e.g. "cdn.geospoof.com". */
  readonly domainName: string;

  /**
   * ARN of a pre-existing, already-validated ACM certificate in us-east-1 that
   * covers `domainName`. Use this when DNS for the domain is NOT in Route 53
   * (e.g. it lives at Vercel): create + validate the cert once by hand, then
   * paste its ARN here. Mutually exclusive with `hostedZone`.
   */
  readonly certificateArn?: string;

  /**
   * Route 53 hosted zone for `domainName`. Use this when DNS IS in Route 53 —
   * CDK will create + DNS-validate the cert and the alias records for you.
   * Mutually exclusive with `certificateArn`.
   */
  readonly hostedZone?: HostedZoneConfig;
}

/**
 * Lets a private GitHub repo's CI publish the GeoSpoof GPS `.dmg` to the CDN
 * bucket (under the `gps/` prefix) via GitHub OIDC — no long-lived AWS keys.
 * When set, the stack provisions a scoped IAM role the release workflow assumes.
 */
export interface GpsReleaseConfig {
  /**
   * OIDC `sub` claim patterns allowed to publish. NOT plain "owner/repo" - see
   * `GpsDownloadsProps.githubSubjectPatterns`, because GitHub's current subject
   * embeds numeric owner and repo ids and will not match a hand-written name.
   */
  readonly githubSubjectPatterns: readonly string[];
  /**
   * ARN of an EXISTING GitHub Actions OIDC provider in this account, if one is
   * already present. Leave undefined to have CDK create it. Note: an account
   * can hold only ONE provider for token.actions.githubusercontent.com, so if
   * you (or another stack) already created it, import it here by ARN.
   */
  readonly oidcProviderArn?: string;
}

/**
 * Lets the extension repo's release workflow publish the Firefox self-hosted
 * update manifest to the CDN (under the `firefox/` prefix) via GitHub OIDC.
 *
 * This exists so `update_url` names a domain we own instead of a personal
 * github.io path. See `ExtensionUpdates` for why that matters: the URL is
 * compiled into every installed copy, an install cannot be told about a new one,
 * and GitHub does not redirect Pages on a repo transfer.
 */
export interface ExtensionUpdatesConfig {
  /**
   * OIDC `sub` claim patterns allowed to publish the update manifest. Same
   * caveat as `GpsReleaseConfig.githubSubjectPatterns` - these are full `sub`
   * patterns, not "owner/repo".
   */
  readonly githubSubjectPatterns: readonly string[];
  // No oidcProviderArn here on purpose: the stack threads the GPS publisher's
  // provider object through instead, since an account may hold only one provider
  // for token.actions.githubusercontent.com.
}

/** One APNs signing key: its public Key ID, and where the secret holding it lives. */
export interface ApnsKeyConfig {
  /** Apple Key ID. The secret's own `keyId` must equal this or the relay signs nothing. */
  readonly keyId: string;
  /**
   * Secrets Manager NAME of `{keyId, teamId, p8}`. Created out of band and
   * imported by name: CDK must never own it (the `.p8` cannot be re-downloaded
   * from Apple), and its value never passes through CDK.
   */
  readonly secretName: string;
}

export interface ThrottleConfig {
  readonly rateLimit: number;
  readonly burstLimit: number;
}

/** The APNs relay for Live Activity push (`ApnsRelayStack`). */
export interface ApnsRelayConfig {
  readonly bundleId: string;
  readonly teamId: string;
  /** The app's numeric App Store id; the Production StoreKit verifier requires it. */
  readonly appAppleId: number;
  /**
   * Which APNs host families this deployment serves, and the key for each. A
   * request for an environment absent here gets `400 environment_unsupported`
   * and is never forwarded.
   */
  readonly apnsKeys: Partial<Record<ApnsEnvironment, ApnsKeyConfig>>;
  /** StoreKit environments whose signed entitlements are verified. Never Xcode/LocalTesting. */
  readonly storeKitEnvironments: readonly StoreKitEnvironmentName[];
  /** Stage default route throttle; governs POST /v1/push. See the cost comment below. */
  readonly throttle: ThrottleConfig;
  /** Route override for POST /v1/session. */
  readonly sessionThrottle: ThrottleConfig;
  readonly logRetention: RetentionDays;
  /** Monthly cost budget in USD, scoped to `component=apns-relay`. Only created when alarmEmail is set. */
  readonly monthlyBudgetUsd: number;
}

export interface GeoTzCdnEnv {
  readonly name: EnvName;
  readonly account: string;
  readonly region: string;
  /** PRICE_CLASS_ALL (full global edge coverage) vs PRICE_CLASS_100 (NA+EU, cheaper). */
  readonly priceClassAll: boolean;
  /** RETAIN the data bucket on stack delete (prod) vs DESTROY + auto-delete (dev). */
  readonly retainBucket: boolean;
  /** Optional custom domain. Until a cert/zone is supplied, we serve on the *.cloudfront.net domain. */
  readonly customDomain?: CustomDomainConfig;
  /**
   * Optional: when set, provisions an OIDC-assumable IAM role so the named
   * private repo's CI can publish the GPS `.dmg` to this CDN. Prod-only in
   * practice (the public /gps page downloads from prod).
   */
  readonly gpsRelease?: GpsReleaseConfig;
  /**
   * When set, the stack provisions a scoped IAM role the extension's release
   * workflow assumes to publish the Firefox update manifest. PROD ONLY in
   * practice: `update_url` in shipped extensions points at prod.
   */
  readonly extensionUpdates?: ExtensionUpdatesConfig;
  /**
   * Email for the 5xx alarm + cost-budget notifications. Sourced from the
   * GEOSPOOF_ALARM_EMAIL env var so it stays out of this public repo. If unset,
   * the alarm topic is still created (no subscriber) and the budget is skipped.
   */
  readonly alarmEmail?: string;
  /** Monthly cost-budget limit in USD. Only created when alarmEmail is set. */
  readonly monthlyBudgetUsd?: number;
  /**
   * When set, `lib/app.ts` also deploys `GeoSpoofApnsRelay-<env>`: a separate
   * stack (its own lifecycle and blast radius) holding the Live Activity push
   * relay. It shares only this env's account, region and alarm email.
   */
  readonly apnsRelay?: ApnsRelayConfig;
}

/** Public identifiers of the iOS app. Nothing here is secret. */
export const APPLE_APP = {
  bundleId: "com.moonloaf.geospoof",
  teamId: "9445Q654K8",
  // apps.apple.com/app/id6765719745
  appAppleId: 6765719745,
} as const;

// Cost ceiling, by arithmetic, not estimate (us-east-1 list prices, checked 2026-10-18 against
// aws.amazon.com/api-gateway/pricing, aws.amazon.com/lambda/pricing and
// aws.amazon.com/cloudwatch/pricing; 30-day month = 2,592,000 s; free tier ignored).
// HTTP API "default route settings" apply to EACH route, so the ceiling is the sum over routes:
//   POST /v1/push      10 req/s (stage default; burst 20 is bucket depth, adds nothing per month)
//   POST /v1/session    2 req/s (route override)
//   => 12 req/s x 2,592,000 s = 31,104,000 invocations/month
// API Gateway HTTP API   $1.00 / million                                         $31.10
// Lambda requests        $0.20 / million                                          $6.22
// Lambda duration        arm64 $0.0000133334/GB-s x 0.25 GB x 0.1 s              $10.37
// CloudWatch Logs        <= ~600 B/invoke (EMF + failure line) = 18.7 GB x $0.50  $9.33
// Custom metrics         <= 31 streams x $0.30 (14 ApnsResponse, 1 ApnsNon2xx,    $9.30
//                        8 RelayRejected, 7 RelayFault, 1 SessionIssued)
// Alarms + session secret  4 alarm metrics x $0.10 + 1 secret x $0.40            ~$0.80
// CEILING ~= $67/month. Expected (~1 push/min per active route, ~240k/month) ~= $2.
// Each +1 req/s on either route adds ~= $4.75/month. Changing these numbers is a cost decision.
// Duration assumes a responsive APNs; a hung upstream is bounded by the 10 s timeout x concurrency,
// which reserved concurrency would cap (not set: account quota unverified, see cdk/README.md).
export const APNS_RELAY_THROTTLE: ThrottleConfig = { rateLimit: 10, burstLimit: 20 };
export const APNS_RELAY_SESSION_THROTTLE: ThrottleConfig = { rateLimit: 2, burstLimit: 10 };

// CloudFront certificates MUST live in us-east-1, which is also where we keep
// the origin bucket, so a single-region deployment covers everything.
export const ACM_REGION = "us-east-1";

export const DEFAULT_CACHE_MAX_AGE = Duration.days(365);

// Notification target for alarms + budgets, per environment. Kept out of the
// (public) repo: sourced from environment variables, optionally via a gitignored
// cdk/.env file loaded below. Per-env so dev and prod alerts go to different
// inboxes (e.g. the +geospoof-dev / +geospoof-prod account aliases).
//
//   GEOSPOOF_ALARM_EMAIL_DEV / GEOSPOOF_ALARM_EMAIL_PROD   (preferred)
//   GEOSPOOF_ALARM_EMAIL                                   (shared fallback)
const envFile = resolve(__dirname, "../../.env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

function alarmEmailFor(name: EnvName): string | undefined {
  return (
    process.env[`GEOSPOOF_ALARM_EMAIL_${name.toUpperCase()}`] ?? process.env.GEOSPOOF_ALARM_EMAIL
  );
}

export const environments: Record<EnvName, GeoTzCdnEnv> = {
  dev: {
    name: "dev",
    account: "898565151814",
    region: "us-east-1",
    priceClassAll: false, // NA+EU edges are plenty for dev
    retainBucket: false, // data is reproducible from the pinned npm package
    alarmEmail: alarmEmailFor("dev"),
    monthlyBudgetUsd: 5,
    customDomain: {
      domainName: "cdn-dev.geospoof.com",
      // DNS for geospoof.com is hosted at Namecheap (not Route 53), so the cert
      // is created + DNS-validated out of band and imported here by ARN.
      certificateArn:
        "arn:aws:acm:us-east-1:898565151814:certificate/6569c8dd-e974-45e5-92bd-e065fe16af67",
    },
    // Dev serves the APNs SANDBOX host with the dev account's environment-scoped
    // key, so a misrouted push fails at the credential layer.
    apnsRelay: {
      ...APPLE_APP,
      apnsKeys: {
        // arn:aws:secretsmanager:us-east-1:898565151814:secret:geospoof/apns/signing-key-wvGpnO
        // (reference only). Created out of band; CDK imports by name and must never own it.
        sandbox: { keyId: "A3TWAYM427", secretName: "geospoof/apns/signing-key" },
      },
      // Both fully verified; TestFlight purchases are StoreKit Sandbox.
      storeKitEnvironments: ["Production", "Sandbox"],
      throttle: APNS_RELAY_THROTTLE,
      sessionThrottle: APNS_RELAY_SESSION_THROTTLE,
      logRetention: RetentionDays.TWO_WEEKS,
      monthlyBudgetUsd: 10,
    },
  },
  prod: {
    name: "prod",
    account: "682844365870",
    region: "us-east-1",
    priceClassAll: true, // full global edge coverage for a global service
    retainBucket: true, // never let a stack delete nuke served data
    alarmEmail: alarmEmailFor("prod"),
    monthlyBudgetUsd: 5,
    customDomain: {
      domainName: "cdn.geospoof.com",
      // DNS for geospoof.com is hosted at Namecheap (not Route 53), so the cert
      // is created + DNS-validated out of band and imported here by ARN.
      certificateArn:
        "arn:aws:acm:us-east-1:682844365870:certificate/b30009e9-6b97-4ce5-a893-ab59fd22b51d",
    },
    // The private geospoof-gps repo's release workflow publishes the signed,
    // notarized DMG to this (prod) CDN under gps/. If the account already has a
    // GitHub OIDC provider, add its ARN as `oidcProviderArn` to import it.
    gpsRelease: {
      // GeoSpoof/geospoof-gps, addressed by its IMMUTABLE subject: repo id
      // 1291874641. The owner segment is a wildcard so a future transfer needs
      // no change here, which is safe because the repo id is in the subject and
      // is globally unique - see githubSubjectPatterns for the full reasoning.
      //
      // Verify against the repo rather than editing this by hand:
      //   gh api repos/GeoSpoof/geospoof-gps/actions/oidc/customization/sub \
      //     --jq .sub_claim_prefix
      //
      // Scoped to the refs that actually publish, not `:*`. With `:*`, a workflow
      // pushed to ANY branch (e.g. with a stolen token) could overwrite latest.dmg,
      // latest-Setup.exe and the update feeds. Publishing happens only from:
      //   - a `gps-v*` tag push (the normal release; tags are ruleset-protected), and
      //   - a `publish_release` workflow_dispatch from `main` (signed, ruleset-protected).
      // The publish jobs deliberately have no `environment:`, so their `sub` is
      // `...:ref:<ref>`. If a publish job ever gains an environment, add
      // `...:environment:<name>` here in the same change.
      githubSubjectPatterns: [
        "repo:*/geospoof-gps@1291874641:ref:refs/tags/gps-v*",
        "repo:*/geospoof-gps@1291874641:ref:refs/heads/main",
      ],
    },
    // The extension repo publishes the Firefox self-hosted update manifest here,
    // so `update_url` names a domain we own rather than a github.io path that
    // dies when the repo moves. The repo now lives at GeoSpoof/geospoof and
    // presents the IMMUTABLE subject format, which embeds the numeric repo id;
    // the owner is wildcarded so a future transfer needs no change here (the
    // repo id is immutable, the owner id is not). The legacy
    // `repo:anthonysgro/geospoof:*` form was dropped after the transfer, having
    // been verified dead — GitHub only ever presents the immutable form now.
    // Verify the live value with:
    //   gh api repos/GeoSpoof/geospoof/actions/oidc/customization/sub \
    //     --jq '{immutable:.use_immutable_subject,prefix:.sub_claim_prefix}'
    //
    // Scoped to the refs that use the role, not `:*`: the release job runs on `v*`
    // tag pushes (ruleset-protected), and the CDN publish preflight is dispatched
    // from `main`. Any other branch can no longer write the update manifest.
    extensionUpdates: {
      githubSubjectPatterns: [
        "repo:*/geospoof@1170325630:ref:refs/tags/v*",
        "repo:*/geospoof@1170325630:ref:refs/heads/main",
      ],
    },
    // Prod serves the APNs PRODUCTION host with the prod account's key.
    apnsRelay: {
      ...APPLE_APP,
      apnsKeys: {
        // arn:aws:secretsmanager:us-east-1:682844365870:secret:geospoof/apns/signing-key-xXA4wx
        // (reference only). Created out of band; CDK imports by name and must never own it.
        production: { keyId: "Y7QSB5K2Y6", secretName: "geospoof/apns/signing-key" },
      },
      // Both fully verified; TestFlight purchases are StoreKit Sandbox.
      storeKitEnvironments: ["Production", "Sandbox"],
      throttle: APNS_RELAY_THROTTLE,
      sessionThrottle: APNS_RELAY_SESSION_THROTTLE,
      logRetention: RetentionDays.TWO_WEEKS,
      monthlyBudgetUsd: 10,
    },
  },
};
