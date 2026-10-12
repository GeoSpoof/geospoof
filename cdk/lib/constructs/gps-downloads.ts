import { Construct } from "constructs";
import { CfnOutput, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { githubActionsPrincipal, githubOidcProvider, grantCdnPublish } from "./github-oidc";

export interface GpsDownloadsProps {
  /** The existing CDN origin bucket (shared with the geo-tz data). */
  readonly bucket: s3.IBucket;
  /** The existing CloudFront distribution fronting the bucket. */
  readonly distribution: cloudfront.IDistribution;
  /**
   * `sub` claim patterns whose GitHub Actions tokens may assume the publish
   * role, matched with StringLike (so a list is OR, and `*` is a wildcard).
   * Written out in full rather than assembled from an "owner/repo" string,
   * because the shape of this claim is NOT what you would guess.
   *
   * DO NOT WRITE `repo:<owner>/<repo>:*` FROM MEMORY. GitHub now issues an
   * IMMUTABLE subject that embeds the numeric owner and repo ids:
   *
   *   repo:GeoSpoof@320249603/geospoof-gps@1291874641:ref:refs/tags/gps-v0.2.2
   *
   * Repos created after 2026-07-15, and any repo RENAMED OR TRANSFERRED after
   * that date, use this format; older untouched repos keep the classic
   * name-based one until opted in. Transferring geospoof-gps to the GeoSpoof
   * org flipped it, and a name-based policy silently stopped matching - the
   * failure is an unassumable role at publish time, long after the build.
   *
   * Get the current value from the repo itself rather than reconstructing it:
   *
   *   gh api repos/OWNER/REPO/actions/oidc/customization/sub \
   *     --jq .sub_claim_prefix
   *
   * The owner segment is wildcarded here so a future transfer needs no change
   * (a transfer alters the owner id, never the repo id). That is safe WITHOUT
   * any `repository_id` condition precisely because the immutable subject
   * embeds the repo id: only tokens minted for repo 1291874641 can match, and
   * repo ids are globally unique and never reused. Which matters, because AWS
   * has only reliably honored `sub` and `aud` from GitHub tokens, so a policy
   * leaning on a custom `repository_id` claim risks denying every publish.
   *
   * A LIST because a format migration or an owner move can need two entries
   * trusted at once; keep it at one whenever nothing is in flight.
   */
  readonly githubSubjectPatterns: readonly string[];
  /**
   * ARN of an existing GitHub Actions OIDC provider to import. If omitted, one
   * is created. (Only ONE provider for token.actions.githubusercontent.com may
   * exist per account.)
   */
  readonly oidcProviderArn?: string;
  /** Key prefix the DMG + pointers live under. Defaults to "gps". */
  readonly prefix?: string;
}

/**
 * Lets the private geospoof-gps release workflow publish the signed, notarized
 * DMG to the CDN, using GitHub OIDC (no long-lived AWS access keys).
 *
 * It provisions a single IAM role, trusted only by the named repo's Actions,
 * whose permissions are scoped to exactly what a publish needs:
 *   - s3:PutObject under `<prefix>/*` on the CDN bucket
 *   - cloudfront:CreateInvalidation on this one distribution
 *
 * The workflow uploads these objects under `<prefix>/`:
 *   - GeoSpoof-GPS-v<version>.dmg  (immutable, versioned archive)
 *   - latest.dmg                   (stable download URL; short TTL + invalidated)
 *   - latest.json                  (version pointer for the /gps page UI)
 *   - appcast.xml                  (Sparkle auto-update feed; short TTL + invalidated,
 *                                   EdDSA-signed, enclosure points at the versioned DMG)
 *
 * No extra IAM is needed for the appcast: it lives under `<prefix>/`, so the
 * `s3:PutObject` on `<prefix>/*` and the distribution `CreateInvalidation` grant
 * below already cover uploading and invalidating it.
 */
export class GpsDownloads extends Construct {
  readonly publishRole: iam.Role;
  readonly prefix: string;
  /**
   * This account's GitHub Actions OIDC provider, exposed so a SECOND publisher
   * (e.g. the extension update manifest) can import it. An account may hold only
   * one provider for `token.actions.githubusercontent.com`, so a second
   * publisher must reuse this one rather than create its own.
   */
  readonly oidcProvider: iam.IOpenIdConnectProvider;

  constructor(scope: Construct, id: string, props: GpsDownloadsProps) {
    super(scope, id);
    this.prefix = props.prefix ?? "gps";

    // Construct ids below ("GithubOidc", "PublishRole") are load-bearing: a CDK
    // logical id derives from the construct path, and this role's ARN is recorded
    // in the geospoof-gps repo variable GPS_PUBLISH_ROLE_ARN. Renaming either id,
    // or nesting them under a new parent, replaces the role and breaks publishing
    // silently at release time.
    const provider = githubOidcProvider(this, "GithubOidc", {
      existingArn: props.oidcProviderArn,
    });
    this.oidcProvider = provider;

    const publishRole = new iam.Role(this, "PublishRole", {
      // Patterns are scoped to publishing refs (see `gpsRelease` in config/app.ts),
      // not `:*`, so a workflow on an arbitrary branch cannot assume this role.
      assumedBy: githubActionsPrincipal("GpsDownloads", provider, props.githubSubjectPatterns),
      description: `GitHub Actions publish role for GPS DMG -> CDN (${props.githubSubjectPatterns.length} trusted subject pattern(s))`,
    });

    // Least privilege: write only under the gps/ prefix, and invalidate only
    // this distribution, so the moving pointers (latest.dmg / latest.json) go
    // live immediately instead of after their TTL.
    grantCdnPublish(publishRole, {
      bucketArnForPrefix: props.bucket.arnForObjects(`${this.prefix}/*`),
      distributionArn: `arn:aws:cloudfront::${Stack.of(this).account}:distribution/${props.distribution.distributionId}`,
    });

    this.publishRole = publishRole;

    // Outputs to paste into the geospoof-gps repo's Actions variables.
    new CfnOutput(this, "GpsPublishRoleArn", {
      value: publishRole.roleArn,
      description: "geospoof-gps repo variable GPS_PUBLISH_ROLE_ARN (role-to-assume).",
    });
    new CfnOutput(this, "GpsCdnBucket", {
      value: props.bucket.bucketName,
      description: "geospoof-gps repo variable GPS_CDN_BUCKET.",
    });
    new CfnOutput(this, "GpsCdnDistributionId", {
      value: props.distribution.distributionId,
      description: "geospoof-gps repo variable GPS_CDN_DISTRIBUTION_ID.",
    });
  }
}
