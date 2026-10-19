/**
 * Runtime secret access. CDK never sees these values: it hands the Lambda a
 * secret id and IAM read access, and the value is fetched here, once per
 * container, and cached at module scope.
 *
 * - The APNs signing key (`geospoof/apns/signing-key`, JSON {keyId, teamId, p8})
 *   was created out of band and is NOT owned by CDK; the `.p8` cannot be
 *   re-downloaded from Apple. Its own keyId/teamId must equal the configured
 *   ones, or nothing is signed (a mismatch fails loudly rather than minting a
 *   JWT APNs would reject).
 * - The session HMAC key is a separate, CDK-generated secret.
 *
 * Errors carry a fault reason and never a value.
 */
import { createPrivateKey, type KeyObject } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export type SecretFetcher = (secretId: string) => Promise<string>;

export type RelayFaultReason =
  | "config_invalid"
  | "secret_unavailable"
  | "key_mismatch"
  | "secret_malformed"
  | "apns_auth"
  | "internal";

/** A relay-side failure that is not the client's fault. The message names only the reason. */
export class RelayFault extends Error {
  constructor(readonly reason: RelayFaultReason) {
    super(`relay fault: ${reason}`);
    this.name = "RelayFault";
  }
}

/** One lazily constructed SDK client per container (the runtime provides SDK v3). */
export function awsSecretFetcher(): SecretFetcher {
  let client: SecretsManagerClient | undefined;
  return async (secretId) => {
    client ??= new SecretsManagerClient({});
    const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (typeof out.SecretString !== "string") throw new Error("secret has no SecretString");
    return out.SecretString;
  };
}

export interface ApnsSigningKey {
  readonly keyId: string;
  readonly teamId: string;
  readonly key: KeyObject;
}

/** Parse `{keyId, teamId, p8}`, check it is the key config expects, and load the P-256 key. */
export function parseApnsSecret(
  raw: string,
  expected: { keyId: string; teamId: string }
): ApnsSigningKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RelayFault("secret_malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RelayFault("secret_malformed");
  }
  const { keyId, teamId, p8 } = parsed as Record<string, unknown>;
  if (typeof keyId !== "string" || typeof teamId !== "string" || typeof p8 !== "string") {
    throw new RelayFault("secret_malformed");
  }
  if (keyId !== expected.keyId || teamId !== expected.teamId) {
    throw new RelayFault("key_mismatch");
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(p8);
  } catch {
    throw new RelayFault("secret_malformed");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new RelayFault("secret_malformed");
  }
  return { keyId, teamId, key };
}

/** The session HMAC key: the generated secret string itself, at least 32 characters. */
export function parseSessionSecret(raw: string): Buffer {
  if (typeof raw !== "string" || raw.length < 32) throw new RelayFault("secret_malformed");
  return Buffer.from(raw, "utf8");
}

/** Transient (fetch) failures are retried after 30 s; permanent (parse) ones after 300 s. */
export const SECRET_RETRY_TRANSIENT_MS = 30_000;
export const SECRET_RETRY_PERMANENT_MS = 300_000;

type Entry =
  { kind: "ok"; value: unknown } | { kind: "failed"; fault: RelayFault; untilMs: number };

/**
 * A memo per secret id for the container's lifetime, with a negative cache:
 * without it a broken secret would call GetSecretValue on every request
 * (about $155/month at the throttle ceiling). Rotation = put the new value,
 * then redeploy or recycle containers (see cdk/README.md).
 */
export class SecretCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly fetch: SecretFetcher,
    private readonly nowMs: () => number = Date.now
  ) {}

  async get<T>(secretId: string, parse: (raw: string) => T): Promise<T> {
    const entry = this.entries.get(secretId);
    if (entry?.kind === "ok") return entry.value as T;
    if (entry?.kind === "failed" && this.nowMs() < entry.untilMs) throw entry.fault;

    const pending = this.inflight.get(secretId);
    if (pending) return pending as Promise<T>;
    const load = this.load(secretId, parse).finally(() => this.inflight.delete(secretId));
    this.inflight.set(secretId, load);
    return load;
  }

  private async load<T>(secretId: string, parse: (raw: string) => T): Promise<T> {
    let raw: string;
    try {
      raw = await this.fetch(secretId);
    } catch {
      return this.fail(new RelayFault("secret_unavailable"), SECRET_RETRY_TRANSIENT_MS, secretId);
    }
    try {
      const value = parse(raw);
      this.entries.set(secretId, { kind: "ok", value });
      return value;
    } catch (e) {
      const fault = e instanceof RelayFault ? e : new RelayFault("secret_malformed");
      return this.fail(fault, SECRET_RETRY_PERMANENT_MS, secretId);
    }
  }

  private fail(fault: RelayFault, forMs: number, secretId: string): never {
    this.entries.set(secretId, { kind: "failed", fault, untilMs: this.nowMs() + forMs });
    throw fault;
  }
}
