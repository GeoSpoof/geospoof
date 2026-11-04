import { Construct } from "constructs";
import { CfnOutput, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { githubActionsPrincipal, githubOidcProvider, grantCdnPublish } from "./github-oidc";
export interface SiteGroupsCatalogProps {
  /** The existing CDN origin bucket (shared with geo-tz data, GPS and the update manifest). */
  readonly bucket: s3.IBucket;
  /** The existing CloudFront distribution fronting the bucket. */
  readonly distribution: cloudfront.IDistribution;
  /**
   * OIDC `sub` claim patterns allowed to publish the catalog, matched with
   * StringLike. NOT plain "owner/repo" - see `cdk/README.md`, "Who may
   * publish: the OIDC subject is not a repo name".
   */
  readonly githubSubjectPatterns: readonly string[];
  /**
   * The account's existing GitHub Actions OIDC provider. An account may hold
   * only ONE provider for `token.actions.githubusercontent.com`, so when the GPS
   * publisher is also in the stack this MUST be its provider rather than a new
   * one.
   */
  readonly oidcProvider?: iam.IOpenIdConnectProvider;
  /** Key prefix the catalog lives under. Defaults to "site-groups". */
  readonly prefix?: string;
}
/**
 * Serves the site-groups catalog (v2fly domain-list-community, converted by
 * `scripts/site-groups/build-catalog.ts`) so installed extensions get new and
 * changed groups weekly instead of only with an extension release.
 *
 * The weekly workflow (`.github/workflows/site-groups-catalog.yml`) uploads two
 * objects under `<prefix>/v1/`, catalog first:
 *   - catalog-<release>.json  (immutable; `public, max-age=31536000, immutable`)
 *   - latest.json             (moving pointer; `public, max-age=3600` + invalidated)
 *
 * The pointer MUST keep its short `Cache-Control`: the distribution's default
 * behaviour honours the origin header, and a long one would pin a stale pointer
 * at the edge. The client checks the catalog's sha256 against the pointer, so a
 * mismatched pair is rejected rather than used. See docs/SITE_GROUPS_DATA.md.
 */
export class SiteGroupsCatalog extends Construct {
  readonly publishRole: iam.Role;
  readonly prefix: string;
  constructor(scope: Construct, id: string, props: SiteGroupsCatalogProps) {
    super(scope, id);
    this.prefix = props.prefix ?? "site-groups";
    const provider = githubOidcProvider(this, "GithubOidc", {
      existing: props.oidcProvider,
    });
    const publishRole = new iam.Role(this, "PublishRole", {
      assumedBy: githubActionsPrincipal("SiteGroupsCatalog", provider, props.githubSubjectPatterns),
      description: `GitHub Actions publish role for the site-groups catalog -> CDN (${props.githubSubjectPatterns.length} trusted subject pattern(s))`,
    });
    // Least privilege: this role can write ONLY under the site-groups prefix. It
    // cannot touch geo-tz data, the GPS artifacts or the Firefox update manifest.
    grantCdnPublish(publishRole, {
      bucketArnForPrefix: props.bucket.arnForObjects(`${this.prefix}/*`),
      distributionArn: `arn:aws:cloudfront::${Stack.of(this).account}:distribution/${props.distribution.distributionId}`,
    });
    this.publishRole = publishRole;
    // Bucket and distribution ids are already output by ExtensionUpdates
    // (EXT_CDN_BUCKET / EXT_CDN_DISTRIBUTION_ID); the workflow reuses them.
    new CfnOutput(this, "SiteGroupsPublishRoleArn", {
      value: publishRole.roleArn,
      description: "extension repo variable SITE_GROUPS_PUBLISH_ROLE_ARN",
    });
    new CfnOutput(this, "SiteGroupsPointerUrl", {
      value: `https://cdn.geospoof.com/${this.prefix}/v1/latest.json`,
      description: "The pointer installed extensions poll for catalog updates.",
    });
  }
}
