import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { ApnsRelayStack } from "../lib/stacks/apns-relay-stack";
import { environments, type ApnsRelayConfig, type EnvName } from "../lib/config/app";

const stacks: ApnsRelayStack[] = [];

// The feature flags in cdk.json (useLatestRuntimeVersion among them) only reach
// a bare `new cdk.App()` through the CLI. Load them here so the test
// synthesizes what `cdk synth` / `cdk deploy` actually would.
const cdkJsonContext = (
  JSON.parse(readFileSync(join(__dirname, "../cdk.json"), "utf8")) as {
    context: Record<string, unknown>;
  }
).context;

// alarmEmail is passed explicitly; never read from cdk/.env here.
function synth(
  envName: EnvName,
  alarmEmail: string | undefined,
  overrides: Partial<ApnsRelayConfig> = {},
  id = `TestApnsRelay-${envName}`
): Template {
  const env = environments[envName];
  const relay = env.apnsRelay as ApnsRelayConfig;
  if (!relay) throw new Error(`${envName} is expected to configure apnsRelay`);
  const app = new cdk.App({ context: cdkJsonContext });
  const stack = new ApnsRelayStack(app, id, {
    envName,
    relay: { ...relay, ...overrides },
    alarmEmail,
    env: { account: env.account, region: env.region },
  });
  stacks.push(stack);
  return Template.fromStack(stack);
}

// dev's certificateArn is filled in once its out-of-band cert is ISSUED (cdk/README.md, "Custom
// domain"). Until then the domain tests synthesize dev with a same-account placeholder ARN, so they
// pin exactly what filling it in will produce; afterwards they use the configured ARN.
const devDomainConfig = environments.dev.apnsRelay?.customDomain;
const PLACEHOLDER_DEV_CERT_ARN =
  "arn:aws:acm:us-east-1:898565151814:certificate/00000000-0000-0000-0000-000000000000";
const devCertArn = devDomainConfig?.certificateArn
  ? devDomainConfig.certificateArn
  : PLACEHOLDER_DEV_CERT_ARN;
const DEV_WITH_DOMAIN = "TestApnsRelay-dev-domain";
const DEV_NO_DOMAIN = "TestApnsRelay-dev-nodomain";

const dev = synth("dev", "alerts@example.com");
const devNoEmail = synth("dev", undefined);
const prod = synth("prod", "alerts@example.com");
const devWithDomain = synth(
  "dev",
  "alerts@example.com",
  { customDomain: { domainName: "push-dev.geospoof.com", certificateArn: devCertArn } },
  DEV_WITH_DOMAIN
);
const devNoDomain = synth("dev", "alerts@example.com", { customDomain: undefined }, DEV_NO_DOMAIN);

const stackNamed = (id: string): ApnsRelayStack => {
  const found = stacks.filter((s) => s.node.id === id);
  expect(found).toHaveLength(1);
  return found[0];
};

const warningsOf = (stack: cdk.Stack): unknown[] =>
  Annotations.fromStack(stack)
    .findWarning("*", Match.anyValue())
    .map((w) => w.entry.data);

// The one warning dev may raise: its hostname is configured, its cert ARN not yet.
const devPendingCertWarnings = devDomainConfig?.certificateArn
  ? []
  : [expect.stringMatching(/^customDomain\.domainName "push-dev\.geospoof\.com" .*certificateArn/)];

const onlyResource = (t: Template, type: string): Record<string, unknown> => {
  const all = Object.values(t.findResources(type));
  expect(all).toHaveLength(1);
  return (all[0] as { Properties: Record<string, unknown> }).Properties;
};

const functionEnv = (t: Template): Record<string, string> =>
  (onlyResource(t, "AWS::Lambda::Function").Environment as { Variables: Record<string, string> })
    .Variables;

describe("ApnsRelayStack: secrets", () => {
  it("creates exactly one secret - the generated session key, never the APNs key", () => {
    const props = onlyResource(dev, "AWS::SecretsManager::Secret");
    expect(props.GenerateSecretString).toMatchObject({
      PasswordLength: 64,
      ExcludePunctuation: true,
      IncludeSpace: false,
    });
    expect(props.SecretString).toBeUndefined();
    expect(props.Name).not.toBe("geospoof/apns/signing-key");
    expect(props.Name).toBeUndefined();
  });

  it("puts no key material in the template", () => {
    for (const t of [dev, devNoEmail, prod]) {
      const json = JSON.stringify(t.toJSON());
      expect(json).not.toContain("PRIVATE KEY");
      expect(json).not.toContain("BEGIN");
      expect(json).not.toContain("p8");
    }
  });

  it("grants secret read on exactly the imported signing key (by name) and the session key", () => {
    const [sessionSecretId] = Object.keys(dev.findResources("AWS::SecretsManager::Secret"));
    dev.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"],
            Resource: [
              Match.stringLikeRegexp(
                "^arn:aws:secretsmanager:us-east-1:898565151814:secret:geospoof/apns/signing-key-\\?{6}$"
              ),
              { Ref: sessionSecretId },
            ],
          }),
        ]),
      }),
    });
  });

  it("grants nothing broader than secrets read on secretsmanager", () => {
    const json = JSON.stringify(Object.values(dev.findResources("AWS::IAM::Policy")));
    const actions = [...json.matchAll(/"secretsmanager:[A-Za-z]+"/g)].map((m) => m[0]);
    expect(new Set(actions)).toEqual(
      new Set(['"secretsmanager:GetSecretValue"', '"secretsmanager:DescribeSecret"'])
    );
    expect(json).not.toContain("kms:");
  });
});

describe("ApnsRelayStack: function", () => {
  it("is an arm64 Node runtime with explicit sizing", () => {
    const fn = onlyResource(dev, "AWS::Lambda::Function");
    expect(fn.Runtime).toMatch(/^nodejs\d+\.x$/);
    // NODEJS_LATEST via the cdk.json flag; the bundle targets node24, so never older.
    expect(Number(/^nodejs(\d+)\.x$/.exec(fn.Runtime as string)?.[1])).toBeGreaterThanOrEqual(24);
    expect(fn.Architectures).toEqual(["arm64"]);
    expect(fn.MemorySize).toBe(256);
    expect(fn.Timeout).toBe(10);
  });

  it("logs JSON, application INFO (so EMF survives), system WARN", () => {
    const fn = onlyResource(dev, "AWS::Lambda::Function");
    expect(fn.LoggingConfig).toMatchObject({
      LogFormat: "JSON",
      ApplicationLogLevel: "INFO",
      SystemLogLevel: "WARN",
    });
  });

  it("is configured with ids only", () => {
    const env = functionEnv(dev);
    expect(env.RELAY_APNS_KEYS).toContain("A3TWAYM427");
    expect(env.RELAY_APNS_KEYS).toContain("sandbox");
    expect(env.RELAY_APNS_KEYS).not.toContain("production");
    expect(env.RELAY_STOREKIT_ENVIRONMENTS).toBe("Production,Sandbox");
    expect(env.RELAY_BUNDLE_ID).toBe("com.moonloaf.geospoof");
    expect(env.RELAY_TEAM_ID).toBe("9445Q654K8");
    expect(env.RELAY_APP_APPLE_ID).toBe("6765719745");
    for (const v of Object.values(env)) expect(JSON.stringify(v)).not.toContain("BEGIN");
  });

  it("has an explicit log group with 14-day retention", () => {
    dev.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 14 });
    const fn = onlyResource(dev, "AWS::Lambda::Function");
    expect(fn.LoggingConfig).toHaveProperty("LogGroup");
  });

  it("carries the project, component and env tags", () => {
    const tags = onlyResource(dev, "AWS::Lambda::Function").Tags as {
      Key: string;
      Value: string;
    }[];
    expect(tags).toEqual(
      expect.arrayContaining([
        { Key: "component", Value: "apns-relay" },
        { Key: "project", Value: "geospoof" },
        { Key: "env", Value: "dev" },
      ])
    );
  });
});

describe("ApnsRelayStack: API", () => {
  it("is an HTTP API with exactly the two POST routes", () => {
    dev.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
    dev.hasResourceProperties("AWS::ApiGatewayV2::Api", { ProtocolType: "HTTP" });
    const routes = Object.values(dev.findResources("AWS::ApiGatewayV2::Route")).map(
      (r) => (r as { Properties: { RouteKey: string } }).Properties.RouteKey
    );
    expect(routes.sort()).toEqual(["POST /v1/push", "POST /v1/session"]);
    dev.resourceCountIs("AWS::Lambda::Url", 0);
  });

  it("throttles the $default stage at 10/20 with /v1/session overridden to 2/10, no access logs", () => {
    const stage = onlyResource(dev, "AWS::ApiGatewayV2::Stage");
    expect(stage.StageName).toBe("$default");
    expect(stage.AutoDeploy).toBe(true);
    expect(stage.DefaultRouteSettings).toEqual({
      ThrottlingRateLimit: 10,
      ThrottlingBurstLimit: 20,
    });
    expect(stage.RouteSettings).toEqual({
      "POST /v1/session": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 10 },
    });
    expect(stage.AccessLogSettings).toBeUndefined();
  });

  it("creates the stage after the session route it names", () => {
    const [stage] = Object.values(dev.findResources("AWS::ApiGatewayV2::Stage")) as {
      DependsOn?: string[];
    }[];
    const sessionRouteId = Object.entries(dev.findResources("AWS::ApiGatewayV2::Route")).find(
      ([, r]) =>
        (r as { Properties: { RouteKey: string } }).Properties.RouteKey === "POST /v1/session"
    )?.[0];
    expect(stage.DependsOn).toContain(sessionRouteId);
  });

  it("outputs the relay URL", () => {
    expect(Object.keys(dev.findOutputs("*")).some((k) => k.includes("ApnsRelayUrl"))).toBe(true);
  });
});

describe("ApnsRelayStack: alarms and budget", () => {
  it("has three alarms, all notifying the relay's topic, one a guarded non-2xx rate", () => {
    const alarms = Object.values(dev.findResources("AWS::CloudWatch::Alarm")).map(
      (a) => (a as { Properties: Record<string, unknown> }).Properties
    );
    expect(alarms).toHaveLength(3);
    const [topicId] = Object.keys(dev.findResources("AWS::SNS::Topic"));
    for (const a of alarms) expect(a.AlarmActions).toEqual([{ Ref: topicId }]);
    const math = alarms.filter((a) => JSON.stringify(a.Metrics ?? "").includes("IF("));
    expect(math).toHaveLength(1);
    expect(math[0]).toMatchObject({ Threshold: 20, EvaluationPeriods: 3, DatapointsToAlarm: 3 });
    const names = alarms.map((a) => a.AlarmName).sort();
    expect(names).toEqual([
      "geospoof-apns-relay-dev-faults",
      "geospoof-apns-relay-dev-lambda-errors",
      "geospoof-apns-relay-dev-non2xx-rate",
    ]);
    for (const a of alarms) expect(a.TreatMissingData).toBe("notBreaching");
  });

  it("with an alarm email: subscribes it and adds a $10 budget scoped to component=apns-relay", () => {
    dev.resourceCountIs("AWS::SNS::Subscription", 1);
    const budget = onlyResource(dev, "AWS::Budgets::Budget").Budget as Record<string, unknown>;
    expect(budget.BudgetLimit).toEqual({ Amount: 10, Unit: "USD" });
    expect(budget.CostFilters).toEqual({ TagKeyValue: ["user:component$apns-relay"] });
    expect(budget.BudgetName).toBe("geospoof-apns-relay-dev-monthly");
  });

  it("without an alarm email: no subscription and no budget", () => {
    devNoEmail.resourceCountIs("AWS::SNS::Subscription", 0);
    devNoEmail.resourceCountIs("AWS::Budgets::Budget", 0);
    devNoEmail.resourceCountIs("AWS::CloudWatch::Alarm", 3);
  });
});

describe("ApnsRelayStack: the bundled Lambda", () => {
  // cdk-ci runs build:full but never `cdk synth`, so this is where CI sees the bundle.
  const [stack] = stacks;
  const assembly = (stack.node.root as cdk.App).synth();
  const bundles = readdirSync(assembly.directory)
    .filter((d) => d.startsWith("asset."))
    .map((d) => join(assembly.directory, d, "index.js"))
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f, "utf8"));
  const [bundle] = bundles;

  it("is one bundle that contains the relay", () => {
    expect(bundles).toHaveLength(1);
    expect(bundle).toContain("GeoSpoof/ApnsRelay");
  });

  it("leaves the AWS SDK to the runtime instead of bundling it", () => {
    expect(bundle).toMatch(/require\("@aws-sdk\/client-secrets-manager"\)/);
    expect(bundle).not.toMatch(/class SecretsManagerClient\b/);
  });

  it("bundles Apple's verifier library and carries no key material", () => {
    expect(bundle).toContain("1.2.840.113635.100.6.11.1");
    expect(bundle).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/]{20}/);
  });

  it("raises no synth warnings or errors (beyond a still-missing domain cert ARN)", () => {
    // Exactly no warnings once dev's certificateArn is configured.
    expect(warningsOf(stack)).toEqual(devPendingCertWarnings);
    Annotations.fromStack(stack).hasNoError("*", Match.anyValue());
    Annotations.fromStack(stackNamed(DEV_WITH_DOMAIN)).hasNoWarning("*", Match.anyValue());
  });
});

describe("ApnsRelayStack: prod", () => {
  it("synthesizes with the production key and only that", () => {
    const env = functionEnv(prod);
    expect(env.RELAY_APNS_KEYS).toContain("Y7QSB5K2Y6");
    expect(env.RELAY_APNS_KEYS).toContain("production");
    expect(env.RELAY_APNS_KEYS).not.toContain("sandbox");
    expect(env.RELAY_APNS_KEYS).not.toContain("A3TWAYM427");
    prod.resourceCountIs("AWS::SecretsManager::Secret", 1);
    const budget = onlyResource(prod, "AWS::Budgets::Budget").Budget as Record<string, unknown>;
    expect(budget.BudgetName).toBe("geospoof-apns-relay-prod-monthly");
  });

  it("throttles the $default stage at 10/20 with /v1/session overridden to 2/10", () => {
    const stage = onlyResource(prod, "AWS::ApiGatewayV2::Stage");
    expect(stage.DefaultRouteSettings).toEqual({
      ThrottlingRateLimit: 10,
      ThrottlingBurstLimit: 20,
    });
    expect(stage.RouteSettings).toEqual({
      "POST /v1/session": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 10 },
    });
  });
});

describe("ApnsRelayStack: custom domain", () => {
  const logicalId = (t: Template, type: string): string => {
    const ids = Object.keys(t.findResources(type));
    expect(ids).toHaveLength(1);
    return ids[0];
  };
  const outputsNamed = (t: Template, name: string): { Value: unknown }[] =>
    Object.entries(t.findOutputs("*"))
      .filter(([k]) => k.includes(name))
      .map(([, o]) => o as { Value: unknown });

  it("creates a regional DomainName for push-dev.geospoof.com with the configured cert", () => {
    const props = onlyResource(devWithDomain, "AWS::ApiGatewayV2::DomainName");
    expect(props.DomainName).toBe("push-dev.geospoof.com");
    expect(props.DomainNameConfigurations).toEqual([
      { CertificateArn: devCertArn, EndpointType: "REGIONAL", SecurityPolicy: "TLS_1_2" },
    ]);
  });

  it("maps the domain root to the one $default stage, after the stage exists", () => {
    const mapping = Object.values(devWithDomain.findResources("AWS::ApiGatewayV2::ApiMapping"));
    expect(mapping).toHaveLength(1);
    const { Properties, DependsOn } = mapping[0] as {
      Properties: Record<string, unknown>;
      DependsOn?: string[];
    };
    expect(Properties).toEqual({
      ApiId: { Ref: logicalId(devWithDomain, "AWS::ApiGatewayV2::Api") },
      DomainName: { Ref: logicalId(devWithDomain, "AWS::ApiGatewayV2::DomainName") },
      Stage: "$default",
    });
    expect(Properties.ApiMappingKey).toBeUndefined();
    expect(DependsOn).toContain(logicalId(devWithDomain, "AWS::ApiGatewayV2::Stage"));
  });

  it("keeps the stage throttles unchanged behind the domain", () => {
    const stage = onlyResource(devWithDomain, "AWS::ApiGatewayV2::Stage");
    expect(stage.StageName).toBe("$default");
    expect(stage.DefaultRouteSettings).toEqual({
      ThrottlingRateLimit: 10,
      ThrottlingBurstLimit: 20,
    });
    expect(stage.RouteSettings).toEqual({
      "POST /v1/session": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 10 },
    });
  });

  it("disables the execute-api endpoint once the domain is enabled", () => {
    expect(onlyResource(devWithDomain, "AWS::ApiGatewayV2::Api").DisableExecuteApiEndpoint).toBe(
      true
    );
  });

  it("outputs the domain URL and the CNAME target", () => {
    const domainId = logicalId(devWithDomain, "AWS::ApiGatewayV2::DomainName");
    expect(outputsNamed(devWithDomain, "ApnsRelayDomainTarget")).toEqual([
      expect.objectContaining({ Value: { "Fn::GetAtt": [domainId, "RegionalDomainName"] } }),
    ]);
    expect(outputsNamed(devWithDomain, "ApnsRelayUrl")).toEqual([
      expect.objectContaining({ Value: "https://push-dev.geospoof.com/" }),
    ]);
  });

  it("never creates an ACM certificate", () => {
    for (const t of [dev, devNoEmail, prod, devWithDomain, devNoDomain]) {
      t.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    }
  });

  it("prod as configured: push.geospoof.com with its own cert, execute-api closed, no warnings", () => {
    const prodCertArn = environments.prod.apnsRelay?.customDomain?.certificateArn;
    expect(prodCertArn).toMatch(/^arn:aws:acm:us-east-1:682844365870:certificate\//);
    prod.resourceCountIs("AWS::ApiGatewayV2::DomainName", 1);
    prod.resourceCountIs("AWS::ApiGatewayV2::ApiMapping", 1);
    const domain = onlyResource(prod, "AWS::ApiGatewayV2::DomainName");
    expect(domain.DomainName).toBe("push.geospoof.com");
    expect(domain.DomainNameConfigurations).toEqual([
      expect.objectContaining({ CertificateArn: prodCertArn, EndpointType: "REGIONAL" }),
    ]);
    expect(onlyResource(prod, "AWS::ApiGatewayV2::Api").DisableExecuteApiEndpoint).toBe(true);
    expect(outputsNamed(prod, "ApnsRelayDomainTarget")).toHaveLength(1);
    expect(outputsNamed(prod, "ApnsRelayUrl")).toEqual([
      expect.objectContaining({ Value: "https://push.geospoof.com/" }),
    ]);
    expect(warningsOf(stackNamed("TestApnsRelay-prod"))).toEqual([]);
  });

  it("dev as configured: on its domain once the cert ARN is set, on execute-api until then", () => {
    const enabled = Boolean(devDomainConfig?.certificateArn);
    dev.resourceCountIs("AWS::ApiGatewayV2::DomainName", enabled ? 1 : 0);
    dev.resourceCountIs("AWS::ApiGatewayV2::ApiMapping", enabled ? 1 : 0);
    expect(onlyResource(dev, "AWS::ApiGatewayV2::Api").DisableExecuteApiEndpoint).toBe(enabled);
    expect(warningsOf(stacks[0])).toEqual(devPendingCertWarnings);
  });

  it("dev with the domain removed: no domain, execute-api open, no warnings", () => {
    devNoDomain.resourceCountIs("AWS::ApiGatewayV2::DomainName", 0);
    devNoDomain.resourceCountIs("AWS::ApiGatewayV2::ApiMapping", 0);
    expect(onlyResource(devNoDomain, "AWS::ApiGatewayV2::Api").DisableExecuteApiEndpoint).toBe(
      false
    );
    Annotations.fromStack(stackNamed(DEV_NO_DOMAIN)).hasNoWarning("*", Match.anyValue());
    Annotations.fromStack(stackNamed(DEV_NO_DOMAIN)).hasNoError("*", Match.anyValue());
  });

  it("config: hostnames per env, and every cert ARN is in its own env's account and region", () => {
    expect(environments.dev.apnsRelay?.customDomain?.domainName).toBe("push-dev.geospoof.com");
    expect(environments.prod.apnsRelay?.customDomain?.domainName).toBe("push.geospoof.com");
    for (const env of Object.values(environments)) {
      const arn = env.apnsRelay?.customDomain?.certificateArn;
      if (arn === undefined) continue;
      expect(arn).toMatch(new RegExp(`^arn:aws:acm:${env.region}:${env.account}:certificate/`));
    }
    expect(PLACEHOLDER_DEV_CERT_ARN).toMatch(
      new RegExp(`^arn:aws:acm:${environments.dev.region}:${environments.dev.account}:certificate/`)
    );
  });
});
