#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { environments, EnvName } from "./config/app";
import { GeoTzCdnStack } from "./stacks/geo-tz-cdn-stack";
import { ApnsRelayStack } from "./stacks/apns-relay-stack";

const app = new cdk.App();

// Select the environment via `-c env=dev|prod` (what deploy:dev / deploy:prod
// pass). With no env context we instantiate every environment, which keeps a
// plain `cdk synth` / CI diff working. Each env's account is pinned, so a
// `--all` deploy under a single profile only succeeds for the matching env.
const requested = app.node.tryGetContext("env") as string | undefined;

const selected: EnvName[] = requested
  ? [requested as EnvName]
  : (Object.keys(environments) as EnvName[]);

for (const name of selected) {
  const envConfig = environments[name];
  if (!envConfig) {
    throw new Error(
      `Unknown env "${name}" (from -c env=...). Valid values: ${Object.keys(environments).join(", ")}`
    );
  }
  new GeoTzCdnStack(app, `GeoSpoofGeoTzCdn-${envConfig.name}`, {
    envConfig,
    env: { account: envConfig.account, region: envConfig.region },
    description: `GeoSpoof geo-tz boundary data CDN (${envConfig.name})`,
  });
  // A separate stack, so a relay deploy never touches the CDN. Note that the
  // deploy:* scripts run `cdk deploy --all` and so include it; deploy it alone
  // with `npx cdk deploy GeoSpoofApnsRelay-<env> --context env=<env> ...`.
  if (envConfig.apnsRelay) {
    new ApnsRelayStack(app, `GeoSpoofApnsRelay-${envConfig.name}`, {
      envName: envConfig.name,
      relay: envConfig.apnsRelay,
      alarmEmail: envConfig.alarmEmail,
      env: { account: envConfig.account, region: envConfig.region },
      description: `GeoSpoof APNs relay for Live Activity push (${envConfig.name})`,
    });
  }
}

app.synth();
