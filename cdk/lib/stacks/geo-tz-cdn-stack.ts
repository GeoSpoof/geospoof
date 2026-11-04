import { Stack, StackProps, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import { GeoTzCdnEnv } from "../config/app";
import { GeoTzCdn } from "../constructs/geo-tz-cdn";
import { GpsDownloads } from "../constructs/gps-downloads";
import { ExtensionUpdates } from "../constructs/extension-updates";
import { SiteGroupsCatalog } from "../constructs/site-groups-catalog";

export interface GeoTzCdnStackProps extends StackProps {
  readonly envConfig: GeoTzCdnEnv;
}

export class GeoTzCdnStack extends Stack {
  constructor(scope: Construct, id: string, props: GeoTzCdnStackProps) {
    super(scope, id, props);

    const cdn = new GeoTzCdn(this, "GeoTzCdn", { env: props.envConfig });

    // Reuse the same bucket + distribution to also serve the GeoSpoof GPS DMG,
    // published from the private geospoof-gps repo's CI via GitHub OIDC.
    let gps: GpsDownloads | undefined;
    if (props.envConfig.gpsRelease) {
      gps = new GpsDownloads(this, "GpsDownloads", {
        bucket: cdn.bucket,
        distribution: cdn.distribution,
        githubSubjectPatterns: props.envConfig.gpsRelease.githubSubjectPatterns,
        oidcProviderArn: props.envConfig.gpsRelease.oidcProviderArn,
      });
    }

    // And the Firefox self-hosted update manifest, so `update_url` names a domain
    // we own instead of a personal github.io path that a repo transfer kills.
    //
    // The provider is threaded through from GpsDownloads rather than created
    // again: an account may hold only ONE OIDC provider for
    // token.actions.githubusercontent.com, so a second one would fail the deploy.
    if (props.envConfig.extensionUpdates) {
      new ExtensionUpdates(this, "ExtensionUpdates", {
        bucket: cdn.bucket,
        distribution: cdn.distribution,
        githubSubjectPatterns: props.envConfig.extensionUpdates.githubSubjectPatterns,
        oidcProvider: gps?.oidcProvider,
      });
    }

    // And the site-groups catalog the extension refreshes weekly. Same provider
    // threading, for the same one-provider-per-account reason.
    if (props.envConfig.siteGroupsCatalog) {
      new SiteGroupsCatalog(this, "SiteGroupsCatalog", {
        bucket: cdn.bucket,
        distribution: cdn.distribution,
        githubSubjectPatterns: props.envConfig.siteGroupsCatalog.githubSubjectPatterns,
        oidcProvider: gps?.oidcProvider,
      });
    }

    Tags.of(this).add("project", "geospoof");
    Tags.of(this).add("component", "geo-tz-cdn");
    Tags.of(this).add("env", props.envConfig.name);
  }
}
