import { describe, it, expect, vi } from "vitest";
import { createHash, X509Certificate } from "node:crypto";
import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import {
  APPLE_ROOT_CA_G3_SHA256,
  appleRootCertificates,
} from "../../lib/lambda/apns-relay/apple-root-ca";
import {
  createAppleVerifiers,
  isFounderBuild,
  transactionGrantsPro,
  verifyPro,
  type EntitlementVerifier,
  type VerifierFactory,
} from "../../lib/lambda/apns-relay/entitlement";
import type {
  RelayRuntimeConfig,
  StoreKitEnvironmentName,
} from "../../lib/lambda/apns-relay/env-contract";
import { createTestChain } from "./test-chain";

const BUNDLE = "com.moonloaf.geospoof";
const APP_APPLE_ID = 6765719745;
const NOW = Date.UTC(2026, 9, 18, 12);
const DAY = 86_400_000;

const cfg = (envs: readonly string[] = ["Production", "Sandbox"]): RelayRuntimeConfig => ({
  bundleId: BUNDLE,
  teamId: "9445Q654K8",
  appAppleId: APP_APPLE_ID,
  storeKitEnvironments: envs as StoreKitEnvironmentName[],
  apnsKeys: { sandbox: { keyId: "A3TWAYM427", secretId: "geospoof/apns/signing-key" } },
  sessionSecretId: "session",
});

const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unsignedJws = (header: object, payload: object) => `${b64u(header)}.${b64u(payload)}.`;

/** Build the real library verifiers, but rooted at `roots` instead of Apple's. */
const rootedAt =
  (roots: Buffer[]): VerifierFactory =>
  (_roots, online, env, bundleId, appAppleId) =>
    new SignedDataVerifier(roots, online, env, bundleId, appAppleId);

const lifetimeTx = (overrides: object = {}) => ({
  bundleId: BUNDLE,
  productId: "com.moonloaf.geospoof.pro.lifetime",
  environment: "Sandbox",
  signedDate: NOW - 1000,
  ...overrides,
});

const founderAppTx = (overrides: object = {}) => ({
  bundleId: BUNDLE,
  receiptType: "Sandbox",
  originalApplicationVersion: "12",
  receiptCreationDate: NOW - 1000,
  ...overrides,
});

describe("Apple Root CA - G3", () => {
  const [der] = appleRootCertificates();

  it("hashes to the pinned fingerprint", () => {
    const hex = createHash("sha256").update(der).digest("hex").toUpperCase();
    expect(hex.match(/../g)?.join(":")).toBe(APPLE_ROOT_CA_G3_SHA256);
  });

  it("is Apple Root CA - G3, valid to 2039", () => {
    const cert = new X509Certificate(der);
    expect(cert.subject).toContain("Apple Root CA - G3");
    expect(cert.issuer).toBe(cert.subject);
    expect(new Date(cert.validTo).getUTCFullYear()).toBe(2039);
  });
});

describe("createAppleVerifiers", () => {
  it("constructs the real library verifiers for Production and Sandbox", () => {
    expect(createAppleVerifiers(cfg())).toHaveLength(2);
  });

  it("refuses Xcode and LocalTesting, whose JWS the library does not verify", () => {
    expect(() => createAppleVerifiers(cfg(["Xcode"]))).toThrow();
    expect(() => createAppleVerifiers(cfg(["LocalTesting"]))).toThrow();
    expect(() => createAppleVerifiers(cfg(["Production", "Xcode"]))).toThrow();
  });

  it("passes appAppleId to Production only, offline, with the Apple root, Production first", () => {
    const make = vi.fn<VerifierFactory>(() => ({
      verifyAndDecodeAppTransaction: vi.fn(),
      verifyAndDecodeTransaction: vi.fn(),
    }));
    createAppleVerifiers(cfg(["Sandbox", "Production"]), make);
    expect(make).toHaveBeenCalledTimes(2);
    const [prod, sandbox] = make.mock.calls;
    expect(prod.slice(1)).toEqual([false, Environment.PRODUCTION, BUNDLE, APP_APPLE_ID]);
    expect(sandbox.slice(1)).toEqual([false, Environment.SANDBOX, BUNDLE, undefined]);
    expect(prod[0]).toEqual(appleRootCertificates());
  });
});

describe("entitlement rejection through the real SignedDataVerifier", () => {
  const verifiers = createAppleVerifiers(cfg());
  const reject = async (proof: { appTransaction?: string; transactions: string[] }) =>
    expect(await verifyPro(proof, verifiers, BUNDLE, NOW)).toBe(false);

  it("rejects garbage", async () => {
    await reject({ appTransaction: "not.a.jws", transactions: ["not.a.jws"] });
    await reject({ appTransaction: "eyJhbGciOiJFUzI1NiJ9.e30.sig", transactions: [] });
  });

  it("rejects an unsigned Xcode-environment AppTransaction (one an Xcode verifier would pass)", async () => {
    const payload = { bundleId: BUNDLE, receiptType: "Xcode", originalApplicationVersion: "1" };
    const jws = unsignedJws({ alg: "ES256" }, payload);
    // The premise: the library really would accept this in the Xcode environment.
    const xcode = new SignedDataVerifier(appleRootCertificates(), false, Environment.XCODE, BUNDLE);
    await expect(xcode.verifyAndDecodeAppTransaction(jws)).resolves.toMatchObject(payload);
    await reject({ appTransaction: jws, transactions: [] });
  });

  it("rejects the same unsigned payload claiming Sandbox", async () => {
    const payload = { bundleId: BUNDLE, receiptType: "Sandbox", originalApplicationVersion: "1" };
    await reject({ appTransaction: unsignedJws({ alg: "ES256" }, payload), transactions: [] });
  });

  it("rejects a JWS whose x5c is the real G3 root three times", async () => {
    const g3 = appleRootCertificates()[0].toString("base64");
    const jws = unsignedJws({ alg: "ES256", x5c: [g3, g3, g3] }, founderAppTx());
    await reject({ appTransaction: jws, transactions: [jws] });
  });

  it("rejects an empty proof", async () => {
    await reject({ transactions: [] });
  });

  it("rejects a well-formed chain that is not rooted in Apple", async () => {
    const chain = createTestChain();
    await reject({
      appTransaction: chain.signJws(founderAppTx()),
      transactions: [chain.signJws(lifetimeTx())],
    });
  });
});

describe("entitlement through the real SignedDataVerifier with a local test root", () => {
  const chain = createTestChain();
  const verifiers = createAppleVerifiers(cfg(), rootedAt([chain.rootDer]));
  const pro = (proof: { appTransaction?: string; transactions: string[] }) =>
    verifyPro(proof, verifiers, BUNDLE, NOW);

  it("grants a verified founder AppTransaction (positive path)", async () => {
    expect(await pro({ appTransaction: chain.signJws(founderAppTx()), transactions: [] })).toBe(
      true
    );
  });

  it("grants a verified lifetime transaction (positive path)", async () => {
    expect(await pro({ transactions: [chain.signJws(lifetimeTx())] })).toBe(true);
  });

  it("grants a verified Production AppTransaction carrying our appAppleId", async () => {
    const appTx = founderAppTx({ receiptType: "Production", appAppleId: APP_APPLE_ID });
    expect(await pro({ appTransaction: chain.signJws(appTx), transactions: [] })).toBe(true);
  });

  it("rejects a Production AppTransaction for another app id", async () => {
    const appTx = founderAppTx({ receiptType: "Production", appAppleId: 1 });
    expect(await pro({ appTransaction: chain.signJws(appTx), transactions: [] })).toBe(false);
  });

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const [h, , s] = chain.signJws(founderAppTx({ originalApplicationVersion: "99" })).split(".");
    const forged = `${h}.${b64u(founderAppTx({ originalApplicationVersion: "1" }))}.${s}`;
    expect(await pro({ appTransaction: forged, transactions: [] })).toBe(false);
  });

  it("rejects another bundle id", async () => {
    expect(
      await pro({
        appTransaction: chain.signJws(founderAppTx({ bundleId: "com.example.other" })),
        transactions: [chain.signJws(lifetimeTx({ bundleId: "com.example.other" }))],
      })
    ).toBe(false);
  });

  it("rejects validly signed Xcode and LocalTesting material", async () => {
    for (const env of ["Xcode", "LocalTesting"]) {
      expect(
        await pro({
          appTransaction: chain.signJws(founderAppTx({ receiptType: env })),
          transactions: [chain.signJws(lifetimeTx({ environment: env }))],
        })
      ).toBe(false);
    }
  });

  it("rejects a leaf without Apple's receipt-signing marker", async () => {
    expect(await pro({ transactions: [chain.unmarkedLeafJws(lifetimeTx())] })).toBe(false);
  });

  it("rejects verified material that does not grant Pro", async () => {
    expect(
      await pro({
        appTransaction: chain.signJws(founderAppTx({ originalApplicationVersion: "40" })),
        transactions: [
          chain.signJws(lifetimeTx({ revocationDate: NOW - DAY })),
          chain.signJws(
            lifetimeTx({ productId: "com.moonloaf.geospoof.pro.monthly", expiresDate: NOW - 1 })
          ),
          chain.signJws(lifetimeTx({ productId: "com.example.unknown" })),
        ],
      })
    ).toBe(false);
  });

  it("grants when one artifact verifies and grants even if another fails", async () => {
    expect(
      await pro({
        appTransaction: "not.a.jws",
        transactions: ["also.not.valid", chain.signJws(lifetimeTx())],
      })
    ).toBe(true);
  });
});

describe("Pro policy", () => {
  it("founder: leading digits below 40", () => {
    expect(isFounderBuild("39")).toBe(true);
    expect(isFounderBuild("1.0")).toBe(true);
    expect(isFounderBuild("1")).toBe(true);
    expect(isFounderBuild("40")).toBe(false);
    expect(isFounderBuild("41")).toBe(false);
    expect(isFounderBuild("400")).toBe(false);
    expect(isFounderBuild(undefined)).toBe(false);
    expect(isFounderBuild("beta")).toBe(false);
    expect(isFounderBuild("")).toBe(false);
    expect(isFounderBuild(" 1")).toBe(false);
  });

  const tx = (productId: string, extra: object = {}) => ({ productId, ...extra });
  const monthly = "com.moonloaf.geospoof.pro.monthly";
  const annual = "com.moonloaf.geospoof.pro.annual";
  const lifetime = "com.moonloaf.geospoof.pro.lifetime";

  it("lifetime grants unless revoked", () => {
    expect(transactionGrantsPro(tx(lifetime), NOW)).toBe(true);
    expect(transactionGrantsPro(tx(lifetime, { revocationDate: NOW - DAY }), NOW)).toBe(false);
  });

  it("subscriptions grant only while unexpired and unrevoked", () => {
    for (const p of [monthly, annual]) {
      expect(transactionGrantsPro(tx(p, { expiresDate: NOW + DAY }), NOW)).toBe(true);
      expect(transactionGrantsPro(tx(p, { expiresDate: NOW - 1 }), NOW)).toBe(false);
      expect(transactionGrantsPro(tx(p, { expiresDate: NOW }), NOW)).toBe(false);
      expect(transactionGrantsPro(tx(p), NOW)).toBe(false);
      expect(
        transactionGrantsPro(tx(p, { expiresDate: NOW + DAY, revocationDate: NOW - 1 }), NOW)
      ).toBe(false);
    }
  });

  it("an unknown product never grants", () => {
    expect(transactionGrantsPro(tx("com.example.unknown", { expiresDate: NOW + DAY }), NOW)).toBe(
      false
    );
    expect(transactionGrantsPro({}, NOW)).toBe(false);
  });

  it("judges expiry against the injected now, not Date.now", () => {
    const farFuture = Date.UTC(2100, 0, 1);
    const sub = tx(monthly, { expiresDate: farFuture - DAY });
    expect(transactionGrantsPro(sub, farFuture)).toBe(false);
    expect(transactionGrantsPro(sub, farFuture - 2 * DAY)).toBe(true);
  });
});

describe("verifyPro with fake verifiers", () => {
  const fake = (over: Partial<EntitlementVerifier> = {}): EntitlementVerifier => ({
    verifyAppTransaction: () => Promise.reject(new Error("unverifiable")),
    verifyTransaction: () => Promise.reject(new Error("unverifiable")),
    ...over,
  });

  it("grants a verified founder AppTransaction", async () => {
    const v = fake({
      verifyAppTransaction: async () => ({ bundleId: BUNDLE, originalApplicationVersion: "39" }),
    });
    expect(await verifyPro({ appTransaction: "a.b.c", transactions: [] }, [v], BUNDLE, NOW)).toBe(
      true
    );
  });

  it("does not grant a verified, granting transaction for another bundle id", async () => {
    const v = fake({
      verifyTransaction: async () => ({
        bundleId: "com.example.other",
        productId: "com.moonloaf.geospoof.pro.lifetime",
      }),
    });
    expect(await verifyPro({ transactions: ["a.b.c"] }, [v], BUNDLE, NOW)).toBe(false);
  });

  it("grants when the first verifier throws and the second verifies and grants", async () => {
    const second = fake({
      verifyTransaction: async () => ({
        bundleId: BUNDLE,
        productId: "com.moonloaf.geospoof.pro.lifetime",
      }),
    });
    expect(await verifyPro({ transactions: ["a.b.c"] }, [fake(), second], BUNDLE, NOW)).toBe(true);
  });

  it("denies when every verifier throws", async () => {
    expect(
      await verifyPro(
        { appTransaction: "a.b.c", transactions: ["d.e.f"] },
        [fake(), fake()],
        BUNDLE,
        NOW
      )
    ).toBe(false);
  });

  it("writes nothing to stdout, stderr or the console", async () => {
    const out = vi.spyOn(process.stdout, "write");
    const err = vi.spyOn(process.stderr, "write");
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const consoles = methods.map((m) => vi.spyOn(console, m));
    try {
      const chain = createTestChain();
      const real = createAppleVerifiers(cfg(), rootedAt([chain.rootDer]));
      await verifyPro(
        { appTransaction: "not.a.jws", transactions: [chain.signJws(lifetimeTx())] },
        [fake(), ...real, ...createAppleVerifiers(cfg())],
        BUNDLE,
        NOW
      );
      await verifyPro({ appTransaction: "x.y.z", transactions: ["q.r.s"] }, real, BUNDLE, NOW);
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
      for (const c of consoles) expect(c).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
      for (const c of consoles) c.mockRestore();
    }
  });
});
