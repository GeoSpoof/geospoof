import { join } from "node:path";
import { Construct } from "constructs";
import { Annotations, CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { ApnsRelayConfig, EnvName } from "../config/app";
import {
  encodeRelayEnv,
  type ApnsEnvironment,
  type ApnsKeyRef,
} from "../lambda/apns-relay/env-contract";
import { METRIC_NAMESPACE } from "../lambda/apns-relay/metrics";

export interface ApnsRelayProps {
  readonly envName: EnvName;
  readonly relay: ApnsRelayConfig;
  /** Alarm + budget notifications. Without it the topic has no subscriber and no budget is created. */
  readonly alarmEmail?: string;
}

const SESSION_ROUTE_KEY = "POST /v1/session";

/**
 * The APNs relay for Live Activity push: an HTTP API with two routes in front
 * of one Lambda (one function keeps the cached key, provider JWT and HTTP/2
 * session in a single warm context).
 *
 * Wire formats: geospoof-ios:.kiro/specs/live-activity-push/design.md is the
 * authority, and this repo mirrors nothing.
 *
 * Secrets:
 * - The APNs signing key is IMPORTED by name, never created. The `.p8` cannot
 *   be re-downloaded from Apple, so nothing here may be able to delete or
 *   replace it: an import creates no CloudFormation resource, so a destroy or a
 *   construct-id rename cannot touch it. Its value never enters the template;
 *   the Lambda gets the name and fetches at runtime.
 * - The session HMAC key IS owned here, as a separate generated secret (see below).
 *
 * HTTP API rather than a Function URL: per-stage/route throttling is what turns
 * the cost ceiling into arithmetic (see the comment in lib/config/app.ts).
 */
export class ApnsRelay extends Construct {
  readonly httpApi: apigwv2.HttpApi;
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: ApnsRelayProps) {
    super(scope, id);
    const { envName, relay, alarmEmail } = props;

    // 1. The APNs keys: imported, never owned.
    const apnsSecrets = Object.entries(relay.apnsKeys).map(([env, key]) => ({
      env: env as ApnsEnvironment,
      key,
      secret: secretsmanager.Secret.fromSecretNameV2(this, `ApnsSigningKey-${env}`, key.secretName),
    }));

    // 2. The session-token HMAC key. CDK-owned on purpose: design.md calls it
    // "configuration, not state". Losing it costs every agent one re-auth
    // (401, then /v1/session), which is recoverable - unlike losing the .p8.
    // RETAIN would buy nothing (a construct-id rename makes a new secret either
    // way), and no fixed name means a destroy + recreate never collides with a
    // secret still pending deletion. Secrets Manager generates the value, so it
    // never passes through the template.
    const sessionSecret = new secretsmanager.Secret(this, "SessionSigningKey", {
      description: `GeoSpoof APNs relay session-token HMAC key (${envName}). Rotating it forces one re-auth per agent.`,
      generateSecretString: { passwordLength: 64, excludePunctuation: true, includeSpace: false },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // 3. Explicit log retention. Logs are failures only (whitelisted fields)
    // plus EMF metric lines.
    const logGroup = new logs.LogGroup(this, "FunctionLogs", {
      retention: relay.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // 4. The function. Runtime is NODEJS_LATEST via the
    // @aws-cdk/aws-lambda-nodejs:useLatestRuntimeVersion flag in cdk.json.
    // System log level WARN drops START/END/REPORT ("failures only"); the
    // application level must stay INFO or the level-less EMF lines are filtered.
    const apnsKeyRefs: Partial<Record<ApnsEnvironment, ApnsKeyRef>> = {};
    for (const { env, key } of apnsSecrets) {
      apnsKeyRefs[env] = { keyId: key.keyId, secretId: key.secretName };
    }
    this.fn = new NodejsFunction(this, "Function", {
      entry: join(__dirname, "../lambda/apns-relay/handler.ts"),
      handler: "handler",
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      description: `GeoSpoof APNs relay (${envName})`,
      // Ids only - never a secret value.
      environment: encodeRelayEnv({
        bundleId: relay.bundleId,
        teamId: relay.teamId,
        appAppleId: relay.appAppleId,
        storeKitEnvironments: relay.storeKitEnvironments,
        apnsKeys: apnsKeyRefs,
        sessionSecretId: sessionSecret.secretArn,
      }),
      bundling: {
        minify: true,
        sourceMap: false,
        target: "node24",
        // The Lambda Node.js runtimes provide AWS SDK v3, so it stays out of the
        // bundle (and is a devDependency, for types and tests only). Stated
        // explicitly because CDK bundles EVERYTHING by default when the runtime
        // is NODEJS_LATEST, which it treats as a variable runtime.
        externalModules: ["@aws-sdk/*", "@smithy/*"],
      },
    });
    // Both warnings are about NODEJS_LATEST being a moving target. The only
    // externals are @aws-sdk/* and @smithy/*, which every Lambda Node.js runtime
    // since nodejs18.x ships; the stack test asserts the SDK stays external.
    const sdkInRuntime =
      "Only @aws-sdk/* and @smithy/* are external; every Lambda Node.js runtime since nodejs18.x ships AWS SDK v3.";
    Annotations.of(this).acknowledgeWarning(
      "@aws-cdk/aws-lambda-nodejs:variableRuntimeExternals",
      sdkInRuntime
    );
    Annotations.of(this).acknowledgeWarning(
      "@aws-cdk/aws-lambda-nodejs:sdkV3NotInRuntime",
      sdkInRuntime
    );

    // 5. Read access to exactly these secrets.
    for (const { secret } of apnsSecrets) secret.grantRead(this.fn);
    sessionSecret.grantRead(this.fn);

    // 6. The HTTP API and its two routes. No CORS: the only client is the
    // desktop agent, never a browser.
    this.httpApi = new apigwv2.HttpApi(this, "Api", {
      apiName: `geospoof-apns-relay-${envName}`,
      description: `GeoSpoof APNs relay for Live Activity push (${envName})`,
      createDefaultStage: false,
    });
    const integration = new HttpLambdaIntegration("Relay", this.fn);
    const sessionRoutes = this.httpApi.addRoutes({
      path: "/v1/session",
      methods: [apigwv2.HttpMethod.POST],
      integration,
    });
    this.httpApi.addRoutes({ path: "/v1/push", methods: [apigwv2.HttpMethod.POST], integration });

    // 7. Throttling. The stage default applies to EACH route, so /v1/push gets
    // relay.throttle and /v1/session is overridden lower; the ceiling is their
    // sum. No access logs: they would record client IPs (same reasoning that
    // keeps CloudFront logging off).
    const stage = new apigwv2.HttpStage(this, "DefaultStage", {
      httpApi: this.httpApi,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: relay.throttle.rateLimit, burstLimit: relay.throttle.burstLimit },
    });
    (stage.node.defaultChild as apigwv2.CfnStage).routeSettings = {
      [SESSION_ROUTE_KEY]: {
        ThrottlingRateLimit: relay.sessionThrottle.rateLimit,
        ThrottlingBurstLimit: relay.sessionThrottle.burstLimit,
      },
    };
    // The stage names the route in RouteSettings, so the route must exist first.
    stage.node.addDependency(...sessionRoutes);

    // 8. Alarms, on their own topic (no coupling to the CDN stack).
    this.addMonitoring(envName, alarmEmail);

    // 9. The budget, scoped to this component's cost-allocation tag.
    if (alarmEmail) this.addBudget(envName, alarmEmail, relay.monthlyBudgetUsd);

    // 10. Outputs.
    new CfnOutput(this, "ApnsRelayUrl", {
      value: stage.url,
      description: "Relay base URL (execute-api $default stage). POST v1/session, v1/push.",
    });
    new CfnOutput(this, "ApnsRelayApiId", { value: this.httpApi.apiId });
  }

  private addMonitoring(envName: EnvName, alarmEmail: string | undefined): void {
    const topic = new sns.Topic(this, "AlarmTopic", {
      displayName: `geospoof APNs relay alarms (${envName})`,
    });
    if (alarmEmail) topic.addSubscription(new subscriptions.EmailSubscription(alarmEmail));
    const action = new cwActions.SnsAction(topic);
    const period = Duration.minutes(5);

    // (a) Elevated APNs non-2xx. The volume guard keeps a handful of ordinary
    // 410s (ended activities) at low traffic from paging.
    const total = new cloudwatch.Metric({
      namespace: METRIC_NAMESPACE,
      metricName: "ApnsResponse",
      statistic: "Sum",
      period,
    });
    const bad = new cloudwatch.Metric({
      namespace: METRIC_NAMESPACE,
      metricName: "ApnsNon2xx",
      statistic: "Sum",
      period,
    });
    new cloudwatch.Alarm(this, "Non2xxRateAlarm", {
      alarmName: `geospoof-apns-relay-${envName}-non2xx-rate`,
      alarmDescription:
        "More than 20% of APNs pushes returned non-2xx (or timed out / failed to connect) for 15 min, " +
        "with at least 10 pushes per 5 min. Check the ApnsResponse metric by Status.",
      metric: new cloudwatch.MathExpression({
        expression: "IF(total >= 10, 100 * bad / total, 0)",
        usingMetrics: { total, bad },
        period,
        label: "APNs non-2xx %",
      }),
      threshold: 20,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(action);

    // (b) Any relay fault: a key mismatch, an unreadable secret or an APNs 403
    // breaks every push, so one is enough to page.
    new cloudwatch.Alarm(this, "FaultAlarm", {
      alarmName: `geospoof-apns-relay-${envName}-faults`,
      alarmDescription:
        "The relay hit a fault (key_mismatch, secret_unavailable, secret_malformed, config_invalid, " +
        "apns_auth or internal). Check the RelayFault metric by Reason.",
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: "RelayFault",
        statistic: "Sum",
        period,
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(action);

    // (c) Crashes and timeouts, which emit no metric of their own.
    new cloudwatch.Alarm(this, "LambdaErrorsAlarm", {
      alarmName: `geospoof-apns-relay-${envName}-lambda-errors`,
      alarmDescription: "The relay Lambda errored or timed out.",
      metric: this.fn.metricErrors({ period, statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(action);
  }

  /**
   * Same notifications as the CDN budget (80% actual, 100% forecast), but
   * scoped to `component=apns-relay`: the accounts now hold two components, so
   * an account-wide budget no longer tracks this one. The CDN's account-wide
   * budget stays as the aggregate backstop. Reads $0 until `component` is an
   * ACTIVE cost-allocation tag in the account (see cdk/README.md).
   */
  private addBudget(envName: EnvName, alarmEmail: string, limitUsd: number): void {
    const subscriber = { subscriptionType: "EMAIL", address: alarmEmail };
    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: `geospoof-apns-relay-${envName}-monthly`,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: limitUsd, unit: "USD" },
        costFilters: { TagKeyValue: ["user:component$apns-relay"] },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: 80,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [subscriber],
        },
        {
          notification: {
            notificationType: "FORECASTED",
            comparisonOperator: "GREATER_THAN",
            threshold: 100,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [subscriber],
        },
      ],
    });
  }
}
