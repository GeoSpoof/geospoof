import { Duration } from "aws-cdk-lib";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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
}

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
      githubSubjectPatterns: ["repo:*/geospoof-gps@1291874641:*"],
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
    extensionUpdates: {
      githubSubjectPatterns: ["repo:*/geospoof@1170325630:*"],
    },
  },
};
