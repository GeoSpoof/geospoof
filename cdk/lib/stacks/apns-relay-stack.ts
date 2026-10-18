import { Stack, StackProps, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import { ApnsRelayConfig, EnvName } from "../config/app";
import { ApnsRelay } from "../constructs/apns-relay";

export interface ApnsRelayStackProps extends StackProps {
  readonly envName: EnvName;
  readonly relay: ApnsRelayConfig;
  readonly alarmEmail?: string;
}

/**
 * The APNs relay, as its own stack beside GeoTzCdnStack (design.md "AWS side"):
 * a different lifecycle and blast radius, and no reason a relay deploy should
 * ever churn the CloudFront distribution. Deploy it alone with
 * `npx cdk deploy GeoSpoofApnsRelay-<env> --context env=<env> --profile geospoof-<env>`.
 */
export class ApnsRelayStack extends Stack {
  constructor(scope: Construct, id: string, props: ApnsRelayStackProps) {
    super(scope, id, props);

    new ApnsRelay(this, "ApnsRelay", {
      envName: props.envName,
      relay: props.relay,
      alarmEmail: props.alarmEmail,
    });

    // `component` is also what the relay's cost budget filters on.
    Tags.of(this).add("project", "geospoof");
    Tags.of(this).add("component", "apns-relay");
    Tags.of(this).add("env", props.envName);
  }
}
