import { describe, it, expect } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { GeoTzCdnStack } from "../lib/stacks/geo-tz-cdn-stack";
import { environments } from "../lib/config/app";

describe("GeoTzCdnStack (dev)", () => {
  const app = new cdk.App();
  const env = environments.dev;
  const stack = new GeoTzCdnStack(app, "TestStack", {
    envConfig: env,
    env: { account: env.account, region: env.region },
  });
  const template = Template.fromStack(stack);

  it("creates exactly one S3 bucket, private and encrypted", () => {
    template.resourceCountIs("AWS::S3::Bucket", 1);
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.anyValue(),
      }),
    });
  });

  it("serves the bucket via CloudFront with the custom domain", () => {
    const customDomain = env.customDomain;
    if (!customDomain?.certificateArn) {
      throw new Error("dev env is expected to have a custom domain with a certificate");
    }
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: [customDomain.domainName],
        ViewerCertificate: Match.objectLike({
          AcmCertificateArn: customDomain.certificateArn,
          SslSupportMethod: "sni-only",
        }),
      }),
    });
  });

  it("reaches the origin with Origin Access Control (not a public bucket)", () => {
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
  });

  it("uploads data under a versioned prefix with immutable cache headers", () => {
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      DestinationBucketKeyPrefix: Match.stringLikeRegexp("^geo-tz/"),
      Prune: false,
      SystemMetadata: Match.objectLike({
        "cache-control": Match.stringLikeRegexp("immutable"),
      }),
    });
  });

  it("emits CORS response headers for the extension's cross-origin fetch", () => {
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        CorsConfig: Match.objectLike({
          AccessControlAllowOrigins: { Items: ["*"] },
        }),
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.objectLike({ Override: true }),
          ContentTypeOptions: Match.objectLike({ Override: true }),
        }),
      }),
    });
  });

  it("alarms on the distribution's 5xx error rate", () => {
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/CloudFront",
      MetricName: "5xxErrorRate",
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
    });
  });

  it("synthesizes the GeoTzBaseUrl output for the extension to consume", () => {
    const outputs = template.findOutputs("*", {});
    const keys = Object.keys(outputs);
    expect(keys.some((k) => k.includes("GeoTzBaseUrl"))).toBe(true);
  });
});

describe("GeoTzCdnStack (prod) — CDN publish roles", () => {
  // The publish roles exist only on prod (dev has no gpsRelease/extensionUpdates).
  // These trust policies are the sole gate on who may write to the CDN bucket, so
  // they are asserted here rather than left to be discovered at deploy time. The
  // subjects are GitHub's IMMUTABLE OIDC format (repo id embedded, owner
  // wildcarded) — a plain owner/repo name would silently never match.
  const app = new cdk.App();
  const env = environments.prod;
  const stack = new GeoTzCdnStack(app, "ProdStack", {
    envConfig: env,
    env: { account: env.account, region: env.region },
  });
  const template = Template.fromStack(stack);

  it("extension-updates role trusts only the immutable geospoof subject, via GitHub OIDC", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      Description: Match.stringLikeRegexp("extension update manifest"),
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              },
              StringLike: {
                "token.actions.githubusercontent.com:sub": ["repo:*/geospoof@1170325630:*"],
              },
            },
          }),
        ]),
      }),
    });
  });

  it("gps-downloads role trusts only the immutable geospoof-gps subject, via GitHub OIDC", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      Description: Match.stringLikeRegexp("GPS DMG"),
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              },
              StringLike: {
                "token.actions.githubusercontent.com:sub": ["repo:*/geospoof-gps@1291874641:*"],
              },
            },
          }),
        ]),
      }),
    });
  });

  it("extension-updates write access is scoped to the firefox/ prefix only", () => {
    // The publish role must not be able to touch geo-tz data or GPS artifacts in
    // the shared bucket. Assert the s3:PutObject grant targets firefox/* alone.
    template.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "s3:PutObject",
              Resource: Match.objectLike({
                "Fn::Join": Match.arrayWith([
                  Match.arrayWith([Match.stringLikeRegexp("/firefox/\\*$")]),
                ]),
              }),
            }),
          ]),
        }),
      })
    );
  });

  it("creates exactly one GitHub OIDC provider shared by both publish roles", () => {
    // An account may hold only ONE provider for token.actions.githubusercontent.com,
    // so the second publish role must import the first's — not create a duplicate.
    template.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 1);
  });
});
