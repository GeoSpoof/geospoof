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
 * - Pro = founder (a signed AppTransaction verified in the PRODUCTION
 *   environment whose originalApplicationVersion's leading digits are below
 *   build 40; see `appTransactionGrantsFounder`) OR a verified, unrevoked lifetime
 *   transaction OR a verified, unrevoked monthly/annual transaction whose
 *   expiresDate is after the RELAY's now, or that is in Apple's Billing Grace
 *   Period per a verified renewal info (`inBillingGracePeriod`). One artifact
 *   that verifies and grants is enough; material that fails verification
 *   contributes nothing.
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
 * The build-number half of the founder rule: the leading run of ASCII digits
 * parses below the cutoff; absent or unparseable is not founder. On its own it
 * would call "1.0" a founder, which is what Sandbox (TestFlight, sandbox
 * accounts) reports for every install, so it is only ever applied to a
 * Production AppTransaction. See `appTransactionGrantsFounder`.
 */
export function isFounderBuild(originalApplicationVersion?: string): boolean {
  if (typeof originalApplicationVersion !== "string") return false;
  const digits = /^[0-9]+/.exec(originalApplicationVersion)?.[0];
  if (digits === undefined) return false;
  return Number(digits) < FOUNDER_CUTOFF_BUILD;
}

/**
 * Founder iff the AppTransaction was verified in the PRODUCTION environment
 * and its build is below the cutoff, per the agent's
 * `app_transaction_grants_founder`. A Sandbox AppTransaction never grants
 * founder: Apple reports originalApplicationVersion "1.0" there, so every
 * TestFlight or sandbox install would otherwise read as a founder. This is the
 * iOS app's rule too (`ProStore` resolves the founder grant only from a
 * production AppTransaction). Sandbox purchases still grant through their
 * transactions.
 */
export function appTransactionGrantsFounder(
  environment: Environment,
  appTx: DecodedAppTransaction
): boolean {
  return environment === Environment.PRODUCTION && isFounderBuild(appTx.originalApplicationVersion);
}

export interface DecodedTransaction {
  readonly bundleId?: string;
  readonly productId?: string;
  readonly originalTransactionId?: string;
  readonly expiresDate?: number;
  readonly revocationDate?: number;
}

export interface DecodedRenewalInfo {
  readonly productId?: string;
  readonly originalTransactionId?: string;
  readonly gracePeriodExpiresDate?: number;
}

export interface DecodedAppTransaction {
  readonly bundleId?: string;
  readonly originalApplicationVersion?: string;
}

const isRevoked = (tx: DecodedTransaction): boolean =>
  tx.revocationDate !== undefined && tx.revocationDate !== null;

/**
 * Whether a VERIFIED transaction currently grants Pro on its own, judged at
 * `nowMs`. An expired subscription can still grant through `inBillingGracePeriod`.
 */
export function transactionGrantsPro(tx: DecodedTransaction, nowMs: number): boolean {
  if (isRevoked(tx)) return false;
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

/** An unrevoked monthly or annual transaction: the only kind grace can extend. */
function isUnrevokedSubscription(tx: DecodedTransaction): boolean {
  return !isRevoked(tx) && (tx.productId === PRODUCT_MONTHLY || tx.productId === PRODUCT_ANNUAL);
}

/**
 * Whether a VERIFIED, expired subscription transaction is inside Apple's
 * Billing Grace Period, per the agent's `in_billing_grace_period`.
 *
 * During grace StoreKit still lists the subscription as a current entitlement,
 * but its expiresDate has passed; the extended date is gracePeriodExpiresDate
 * on the separately signed renewal info. So this holds only when a VERIFIED
 * renewal info for the same subscription (same originalTransactionId AND same
 * productId) has a grace end after `nowMs`.
 *
 * The originalTransactionId match is also what ties a renewal info to this
 * app: JWSRenewalInfo carries no bundle id (the library checks signature,
 * chain and environment only), while the transaction it must match was
 * bundle-checked. A missing id on either side never matches.
 */
export function inBillingGracePeriod(
  tx: DecodedTransaction,
  renewals: readonly DecodedRenewalInfo[],
  nowMs: number
): boolean {
  if (!isUnrevokedSubscription(tx)) return false;
  const { originalTransactionId, productId } = tx;
  if (typeof originalTransactionId !== "string" || typeof productId !== "string") return false;
  return renewals.some(
    (info) =>
      info.originalTransactionId === originalTransactionId &&
      info.productId === productId &&
      typeof info.gracePeriodExpiresDate === "number" &&
      info.gracePeriodExpiresDate > nowMs
  );
}

/** One StoreKit environment's verifier. Every method throws on anything unverifiable. */
export interface EntitlementVerifier {
  /** The environment this verifier checks artifacts against. Only Production can grant founder. */
  readonly environment: Environment;
  verifyAppTransaction(jws: string): Promise<DecodedAppTransaction>;
  verifyTransaction(jws: string): Promise<DecodedTransaction>;
  verifyRenewalInfo(jws: string): Promise<DecodedRenewalInfo>;
}

/** Test seam over `new SignedDataVerifier(...)`. */
export type VerifierFactory = (
  rootCertificates: Buffer[],
  enableOnlineChecks: boolean,
  environment: Environment,
  bundleId: string,
  appAppleId?: number
) => Pick<
  SignedDataVerifier,
  "verifyAndDecodeAppTransaction" | "verifyAndDecodeTransaction" | "verifyAndDecodeRenewalInfo"
>;

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
        environment: env,
        verifyAppTransaction: (jws) => v.verifyAndDecodeAppTransaction(jws),
        verifyTransaction: (jws) => v.verifyAndDecodeTransaction(jws),
        verifyRenewalInfo: (jws) => v.verifyAndDecodeRenewalInfo(jws),
      };
    }
  );
}

export interface EntitlementProof {
  readonly appTransaction?: string;
  readonly transactions: readonly string[];
  /** Signed RenewalInfo JWS. They grant nothing alone; see `inBillingGracePeriod`. */
  readonly renewalInfos?: readonly string[];
}

/** Verify each renewal info with this environment's verifier, keeping only those that verify. */
async function verifiedRenewalInfos(
  verifier: EntitlementVerifier,
  renewalInfos: readonly string[]
): Promise<DecodedRenewalInfo[]> {
  const verified: DecodedRenewalInfo[] = [];
  for (const jws of renewalInfos) {
    try {
      verified.push(await verifier.verifyRenewalInfo(jws));
    } catch {
      // Unverifiable: contributes nothing. Not logged (verify and discard).
    }
  }
  return verified;
}

/**
 * The agent's loop: per environment, the AppTransaction (founder, Production
 * only) and then each
 * transaction. True on the first artifact that verifies AND grants. Renewal
 * infos are verified lazily, with the same environment's verifier, only once
 * an expired subscription needs them. Every exception is swallowed -
 * unverified material simply contributes nothing.
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
        if (
          appTx.bundleId === bundleId &&
          appTransactionGrantsFounder(verifier.environment, appTx)
        ) {
          return true;
        }
      } catch {
        // Unverifiable: contributes nothing. Not logged (verify and discard).
      }
    }
    const renewalInfos = proof.renewalInfos ?? [];
    let renewals: DecodedRenewalInfo[] | undefined;
    for (const jws of proof.transactions) {
      let tx: DecodedTransaction;
      try {
        tx = await verifier.verifyTransaction(jws);
      } catch {
        continue; // Unverifiable: contributes nothing. Not logged (verify and discard).
      }
      if (tx.bundleId !== bundleId) continue;
      if (transactionGrantsPro(tx, nowMs)) return true;
      if (isUnrevokedSubscription(tx) && renewalInfos.length > 0) {
        renewals ??= await verifiedRenewalInfos(verifier, renewalInfos);
        if (inBillingGracePeriod(tx, renewals, nowMs)) return true;
      }
    }
  }
  return false;
}
