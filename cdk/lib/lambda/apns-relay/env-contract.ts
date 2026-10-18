/**
 * The contract between the CDK construct (which writes the Lambda's environment)
 * and the relay at runtime (which reads it). Pure: imported by both sides, so it
 * must never import aws-cdk-lib or anything that would end up in the bundle
 * unnecessarily.
 *
 * Nothing secret travels through here. The APNs `.p8` and the session HMAC key
 * are referenced by Secrets Manager id only and fetched at runtime; the env holds
 * the ids plus the public identifiers the fetched secret must match.
 */

/** APNs host family. Matches the `environment` field of `POST /v1/push`. */
export type ApnsEnvironment = "sandbox" | "production";

/**
 * StoreKit environments whose signed material the relay verifies. Xcode and
 * LocalTesting are deliberately absent: the Apple library skips signature
 * verification entirely for them.
 */
export type StoreKitEnvironmentName = "Production" | "Sandbox";

export const APNS_ENVIRONMENTS: readonly ApnsEnvironment[] = ["sandbox", "production"];
export const STOREKIT_ENVIRONMENTS: readonly StoreKitEnvironmentName[] = ["Production", "Sandbox"];

/** Lambda environment variable names. */
export const RELAY_ENV = {
  bundleId: "RELAY_BUNDLE_ID",
  teamId: "RELAY_TEAM_ID",
  appAppleId: "RELAY_APP_APPLE_ID",
  storeKitEnvironments: "RELAY_STOREKIT_ENVIRONMENTS",
  apnsKeys: "RELAY_APNS_KEYS",
  sessionSecretId: "RELAY_SESSION_SECRET_ID",
} as const;

/** Which APNs key signs for one host family, and where its secret lives. */
export interface ApnsKeyRef {
  /** Apple Key ID; the fetched secret's own `keyId` must equal this. */
  readonly keyId: string;
  /** Secrets Manager name or ARN of `{keyId, teamId, p8}`. */
  readonly secretId: string;
}

export interface RelayRuntimeConfig {
  readonly bundleId: string;
  readonly teamId: string;
  readonly appAppleId: number;
  readonly storeKitEnvironments: readonly StoreKitEnvironmentName[];
  readonly apnsKeys: Partial<Record<ApnsEnvironment, ApnsKeyRef>>;
  readonly sessionSecretId: string;
}

/** A bad environment. Names the variable, never its value. */
export class ConfigError extends Error {
  constructor(
    readonly variable: string,
    detail: string
  ) {
    super(`${variable}: ${detail}`);
    this.name = "ConfigError";
  }
}

const APPLE_ID_RE = /^[A-Z0-9]{10}$/;
const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const MAX_SECRET_ID_LENGTH = 2048;

function checkAppleId(variable: string, value: unknown): string {
  if (typeof value !== "string" || !APPLE_ID_RE.test(value)) {
    throw new ConfigError(variable, "must be a 10-character Apple identifier");
  }
  return value;
}

function checkBundleId(value: unknown): string {
  if (typeof value !== "string" || value.length > 155 || !BUNDLE_ID_RE.test(value)) {
    throw new ConfigError(RELAY_ENV.bundleId, "must be a reverse-DNS bundle id");
  }
  return value;
}

function checkAppAppleId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(RELAY_ENV.appAppleId, "must be a positive integer");
  }
  return value;
}

function checkSecretId(variable: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SECRET_ID_LENGTH) {
    throw new ConfigError(variable, "must be a non-empty secret id");
  }
  return value;
}

function checkStoreKitEnvironments(values: readonly unknown[]): StoreKitEnvironmentName[] {
  if (values.length === 0) {
    throw new ConfigError(RELAY_ENV.storeKitEnvironments, "must name at least one environment");
  }
  const out: StoreKitEnvironmentName[] = [];
  for (const v of values) {
    if (!STOREKIT_ENVIRONMENTS.includes(v as StoreKitEnvironmentName)) {
      throw new ConfigError(
        RELAY_ENV.storeKitEnvironments,
        "only Production and Sandbox are accepted (Xcode/LocalTesting are never verified)"
      );
    }
    if (!out.includes(v as StoreKitEnvironmentName)) out.push(v as StoreKitEnvironmentName);
  }
  return out;
}

function checkApnsKeys(value: unknown): Partial<Record<ApnsEnvironment, ApnsKeyRef>> {
  const variable = RELAY_ENV.apnsKeys;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(variable, "must be an object keyed by APNs environment");
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new ConfigError(variable, "must configure at least one APNs environment");
  }
  const out: Partial<Record<ApnsEnvironment, ApnsKeyRef>> = {};
  for (const [env, ref] of entries) {
    if (!APNS_ENVIRONMENTS.includes(env as ApnsEnvironment)) {
      throw new ConfigError(variable, "keys must be 'sandbox' or 'production'");
    }
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      throw new ConfigError(variable, "each entry must be {keyId, secretId}");
    }
    const { keyId, secretId, ...rest } = ref as Record<string, unknown>;
    if (Object.keys(rest).length > 0) {
      throw new ConfigError(variable, "each entry must be exactly {keyId, secretId}");
    }
    out[env as ApnsEnvironment] = {
      keyId: checkAppleId(variable, keyId),
      secretId: checkSecretId(variable, secretId),
    };
  }
  return out;
}

/**
 * Serialize config into Lambda environment variables. Used by CDK at synth
 * time, so it validates eagerly (a bad config fails the synth, not a request).
 * `sessionSecretId` may be an unresolved CDK token string; it is only checked
 * for being non-empty.
 */
export function encodeRelayEnv(cfg: RelayRuntimeConfig): Record<string, string> {
  return {
    [RELAY_ENV.bundleId]: checkBundleId(cfg.bundleId),
    [RELAY_ENV.teamId]: checkAppleId(RELAY_ENV.teamId, cfg.teamId),
    [RELAY_ENV.appAppleId]: String(checkAppAppleId(cfg.appAppleId)),
    [RELAY_ENV.storeKitEnvironments]: checkStoreKitEnvironments(cfg.storeKitEnvironments).join(","),
    [RELAY_ENV.apnsKeys]: JSON.stringify(checkApnsKeys(cfg.apnsKeys)),
    [RELAY_ENV.sessionSecretId]: checkSecretId(RELAY_ENV.sessionSecretId, cfg.sessionSecretId),
  };
}

/** Parse and validate the Lambda environment. Throws `ConfigError` naming the bad variable. */
export function parseRelayEnv(env: Record<string, string | undefined>): RelayRuntimeConfig {
  const read = (name: string): string => {
    const v = env[name];
    if (v === undefined || v === "") throw new ConfigError(name, "is not set");
    return v;
  };

  const appAppleIdRaw = read(RELAY_ENV.appAppleId);
  if (!/^[0-9]{1,15}$/.test(appAppleIdRaw)) {
    throw new ConfigError(RELAY_ENV.appAppleId, "must be a positive integer");
  }

  let apnsKeysRaw: unknown;
  try {
    apnsKeysRaw = JSON.parse(read(RELAY_ENV.apnsKeys));
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(RELAY_ENV.apnsKeys, "is not valid JSON");
  }

  return {
    bundleId: checkBundleId(read(RELAY_ENV.bundleId)),
    teamId: checkAppleId(RELAY_ENV.teamId, read(RELAY_ENV.teamId)),
    appAppleId: checkAppAppleId(Number(appAppleIdRaw)),
    storeKitEnvironments: checkStoreKitEnvironments(
      read(RELAY_ENV.storeKitEnvironments).split(",")
    ),
    apnsKeys: checkApnsKeys(apnsKeysRaw),
    sessionSecretId: checkSecretId(RELAY_ENV.sessionSecretId, read(RELAY_ENV.sessionSecretId)),
  };
}
