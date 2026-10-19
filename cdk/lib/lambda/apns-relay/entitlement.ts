/**
 * Pro entitlement for `POST /v1/session`, mirroring the GPS agent's release
 * policy exactly (geospoof-gps:agent/src/entitlement.rs, `verify_pro`):
 *
 * - Verify with Apple's own `SignedDataVerifier` (never hand-rolled ECDSA chain
 *   validation), offline, against the embedded Apple Root CA - G3, for bundle
 *   id com.moonloaf.geospoof. One verifier per StoreKit environment, tried
 *   Production then Sandbox. TestFlight is StoreKit Sandbox, so both are real.
 * - NEVER Xcode or LocalTesting: the library skips signature verification for
 *   those environments entirely. The agent accepts them only in DEBUG builds;
 *   the relay has no DEBUG.
 * - Pro = founder (signed AppTransaction whose originalApplicationVersion's
 *   leading digits are below build 40) OR a verified, unrevoked lifetime
 *   transaction OR a verified, unrevoked monthly/annual transaction whose
 *   expiresDate is after the RELAY's now. One artifact that verifies and
 *   grants is enough; material that fails verification contributes nothing.
 *
 * VERIFY AND DISCARD. Nothing about the entitlement is stored or logged, not
 * even a hashed transaction id. This module logs nothing at all and swallows
 * every verification error rather than letting one carry JWS detail upward.
 */
import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import { appleRootCertificates } from "./apple-root-ca";
import type { RelayRuntimeConfig } from "./env-contract";

const PRODUCT_MONTHLY = "com.moonloaf.geospoof.pro.monthly";
const PRODUCT_ANNUAL = "com.moonloaf.geospoof.pro.annual";
const PRODUCT_LIFETIME = "com.moonloaf.geospoof.pro.lifetime";

/** First-installed builds below this are grandfathered founders (`ProStore.founderCutoff`). */
export const FOUNDER_CUTOFF_BUILD = 40;

/**
 * Founder iff the leading run of ASCII digits parses below the cutoff. "1.0"
 * (what sandbox/TestFlight often reports) reads as 1, so founder; absent or
 * unparseable is not founder.
 */
export function isFounderBuild(originalApplicationVersion?: string): boolean {
  if (typeof originalApplicationVersion !== "string") return false;
  const digits = /^[0-9]+/.exec(originalApplicationVersion)?.[0];
  if (digits === undefined) return false;
  return Number(digits) < FOUNDER_CUTOFF_BUILD;
}

export interface DecodedTransaction {
  readonly bundleId?: string;
  readonly productId?: string;
  readonly expiresDate?: number;
  readonly revocationDate?: number;
}

export interface DecodedAppTransaction {
  readonly bundleId?: string;
  readonly originalApplicationVersion?: string;
}

/** Whether a VERIFIED transaction currently grants Pro, judged at `nowMs`. */
export function transactionGrantsPro(tx: DecodedTransaction, nowMs: number): boolean {
  if (tx.revocationDate !== undefined && tx.revocationDate !== null) return false;
  switch (tx.productId) {
    case PRODUCT_LIFETIME:
      return true;
    case PRODUCT_MONTHLY:
    case PRODUCT_ANNUAL:
      return typeof tx.expiresDate === "number" && tx.expiresDate > nowMs;
    default:
      return false;
  }
}

/** One StoreKit environment's verifier. Both methods throw on anything unverifiable. */
export interface EntitlementVerifier {
  verifyAppTransaction(jws: string): Promise<DecodedAppTransaction>;
  verifyTransaction(jws: string): Promise<DecodedTransaction>;
}

/** Test seam over `new SignedDataVerifier(...)`. */
export type VerifierFactory = (
  rootCertificates: Buffer[],
  enableOnlineChecks: boolean,
  environment: Environment,
  bundleId: string,
  appAppleId?: number
) => Pick<SignedDataVerifier, "verifyAndDecodeAppTransaction" | "verifyAndDecodeTransaction">;

const defaultFactory: VerifierFactory = (roots, online, env, bundleId, appAppleId) =>
  new SignedDataVerifier(roots, online, env, bundleId, appAppleId);

/**
 * Offline (design.md: "Verified offline"). The cost: no OCSP, so a replayed,
 * old but unrevoked lifetime JWS keeps working - the same as in the agent.
 */
const ENABLE_ONLINE_CHECKS = false;

const VERIFIED_ENVIRONMENTS = [Environment.PRODUCTION, Environment.SANDBOX] as const;

/**
 * Build one verifier per configured StoreKit environment, Production first.
 * Throws for anything other than Production or Sandbox, as defense in depth on
 * top of env-contract's own check.
 */
export function createAppleVerifiers(
  cfg: RelayRuntimeConfig,
  make: VerifierFactory = defaultFactory
): EntitlementVerifier[] {
  for (const env of cfg.storeKitEnvironments as readonly string[]) {
    if (!(VERIFIED_ENVIRONMENTS as readonly string[]).includes(env)) {
      throw new Error("only Production and Sandbox StoreKit environments are verified");
    }
  }
  const roots = appleRootCertificates();
  return VERIFIED_ENVIRONMENTS.filter((env) => cfg.storeKitEnvironments.includes(env)).map(
    (env) => {
      // The library requires appAppleId for Production (and cross-checks it
      // against AppTransaction.appAppleId); it is documented as omitted for Sandbox.
      const v = make(
        roots,
        ENABLE_ONLINE_CHECKS,
        env,
        cfg.bundleId,
        env === Environment.PRODUCTION ? cfg.appAppleId : undefined
      );
      return {
        verifyAppTransaction: (jws) => v.verifyAndDecodeAppTransaction(jws),
        verifyTransaction: (jws) => v.verifyAndDecodeTransaction(jws),
      };
    }
  );
}

export interface EntitlementProof {
  readonly appTransaction?: string;
  readonly transactions: readonly string[];
}

/**
 * The agent's loop: per environment, the AppTransaction (founder) and then each
 * transaction. True on the first artifact that verifies AND grants. Every
 * exception is swallowed - unverified material simply contributes nothing.
 */
export async function verifyPro(
  proof: EntitlementProof,
  verifiers: readonly EntitlementVerifier[],
  bundleId: string,
  nowMs: number
): Promise<boolean> {
  for (const verifier of verifiers) {
    if (proof.appTransaction !== undefined) {
      try {
        const appTx = await verifier.verifyAppTransaction(proof.appTransaction);
        if (appTx.bundleId === bundleId && isFounderBuild(appTx.originalApplicationVersion)) {
          return true;
        }
      } catch {
        // Unverifiable: contributes nothing. Not logged (verify and discard).
      }
    }
    for (const jws of proof.transactions) {
      try {
        const tx = await verifier.verifyTransaction(jws);
        if (tx.bundleId === bundleId && transactionGrantsPro(tx, nowMs)) return true;
      } catch {
        // Unverifiable: contributes nothing. Not logged (verify and discard).
      }
    }
  }
  return false;
}
