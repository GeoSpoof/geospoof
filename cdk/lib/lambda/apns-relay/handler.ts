/**
 * Lambda entry for the APNs relay (API Gateway HTTP API, payload format 2.0).
 *
 * Everything expensive lives at module scope so warm invokes reuse it: the
 * parsed config, the fetched secrets (and the parsed APNs key), the provider
 * JWT (~50 min), the HTTP/2 session to APNs, and the Apple verifiers. All of
 * it is lazy - importing this module does no I/O and cannot throw, so a bad
 * environment surfaces as `500 relay_misconfigured` plus a RelayFault metric
 * on each request rather than as an init crash with no metric at all.
 */
import { ApnsClient } from "./apns-client";
import { createAppleVerifiers, type EntitlementVerifier } from "./entitlement";
import { parseRelayEnv, type ApnsEnvironment, type RelayRuntimeConfig } from "./env-contract";
import { emfSink, logFailure } from "./metrics";
import { ProviderTokenCache } from "./provider-token";
import { createRelay } from "./relay";
import {
  awsSecretFetcher,
  parseApnsSecret,
  parseSessionSecret,
  RelayFault,
  SecretCache,
} from "./secrets";

let config: RelayRuntimeConfig | undefined;
function loadConfig(): RelayRuntimeConfig {
  if (config) return config;
  try {
    config = parseRelayEnv(process.env);
  } catch {
    throw new RelayFault("config_invalid");
  }
  return config;
}

let verifiers: readonly EntitlementVerifier[] | undefined;
function loadVerifiers(): readonly EntitlementVerifier[] {
  if (verifiers) return verifiers;
  try {
    verifiers = createAppleVerifiers(loadConfig());
  } catch (e) {
    throw e instanceof RelayFault ? e : new RelayFault("config_invalid");
  }
  return verifiers;
}

const secrets = new SecretCache(awsSecretFetcher());

async function apnsKey(env: ApnsEnvironment) {
  const cfg = loadConfig();
  const ref = cfg.apnsKeys[env];
  if (!ref) throw new RelayFault("config_invalid");
  return secrets.get(ref.secretId, (raw) =>
    parseApnsSecret(raw, { keyId: ref.keyId, teamId: cfg.teamId })
  );
}

export const handler = createRelay({
  config: loadConfig,
  nowMs: Date.now,
  apnsKey,
  sessionKey: () => secrets.get(loadConfig().sessionSecretId, parseSessionSecret),
  verifiers: loadVerifiers,
  providerTokens: new ProviderTokenCache(),
  apns: new ApnsClient(),
  metrics: emfSink(),
  log: logFailure,
});
