/**
 * A locally generated, Apple-shaped certificate chain for exercising the REAL
 * `SignedDataVerifier` end to end: a self-signed root, an intermediate carrying
 * Apple's WWDR intermediate marker OID, and a leaf carrying Apple's App Store
 * receipt-signing marker OID. Passed to the verifier as its roots, it lets a
 * test produce JWS the library accepts - and then break them one way at a time.
 *
 * Everything is generated in-process per test run and never written anywhere.
 * jsrsasign is not a direct dependency: it is the library's own dependency for
 * exactly these OID checks, so it is present whenever the library is.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { KJUR } from "jsrsasign";

/** Marker extensions `SignedDataVerifier` requires (jws_verification.js). */
const OID_APPLE_INTERMEDIATE = "1.2.840.113635.100.6.2.1";
const OID_APPLE_RECEIPT_LEAF = "1.2.840.113635.100.6.11.1";

interface Pair {
  readonly privatePem: string;
  readonly publicPem: string;
  readonly privateKey: KeyObject;
}

function pair(): Pair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    privateKey,
  };
}

let serial = 1;

function certificate(opts: {
  subject: string;
  issuer: string;
  subjectKey: Pair;
  signerKey: Pair;
  ca: boolean;
  markerOid?: string;
  notBefore?: string;
  notAfter?: string;
}): Buffer {
  const ext: unknown[] = [{ extname: "basicConstraints", critical: true, cA: opts.ca }];
  if (opts.markerOid) ext.push({ extname: opts.markerOid, extn: "0500" });
  const cert = new KJUR.asn1.x509.Certificate({
    version: 3,
    serial: { int: serial++ },
    issuer: { str: opts.issuer },
    subject: { str: opts.subject },
    notbefore: opts.notBefore ?? "20200101000000Z",
    notafter: opts.notAfter ?? "20491231000000Z",
    sbjpubkey: opts.subjectKey.publicPem,
    ext,
    sigalg: "SHA256withECDSA",
    cakey: opts.signerKey.privatePem,
  } as unknown as ConstructorParameters<typeof KJUR.asn1.x509.Certificate>[0]);
  return Buffer.from(cert.getEncodedHex(), "hex");
}

export interface TestChain {
  readonly rootDer: Buffer;
  /** Sign `payload` as a compact ES256 JWS with `x5c` = [leaf, intermediate, root]. */
  signJws(payload: object, opts?: { x5c?: Buffer[] }): string;
  /** A second chain from the same root whose leaf lacks Apple's marker OID. */
  unmarkedLeafJws(payload: object): string;
}

export function createTestChain(): TestChain {
  const rootKey = pair();
  const intermediateKey = pair();
  const leafKey = pair();
  const rootDer = certificate({
    subject: "/CN=GeoSpoof Test Root",
    issuer: "/CN=GeoSpoof Test Root",
    subjectKey: rootKey,
    signerKey: rootKey,
    ca: true,
  });
  const intermediateDer = certificate({
    subject: "/CN=GeoSpoof Test Intermediate",
    issuer: "/CN=GeoSpoof Test Root",
    subjectKey: intermediateKey,
    signerKey: rootKey,
    ca: true,
    markerOid: OID_APPLE_INTERMEDIATE,
  });
  const leafDer = certificate({
    subject: "/CN=GeoSpoof Test Leaf",
    issuer: "/CN=GeoSpoof Test Intermediate",
    subjectKey: leafKey,
    signerKey: intermediateKey,
    ca: false,
    markerOid: OID_APPLE_RECEIPT_LEAF,
  });
  const unmarkedLeafDer = certificate({
    subject: "/CN=GeoSpoof Test Leaf",
    issuer: "/CN=GeoSpoof Test Intermediate",
    subjectKey: leafKey,
    signerKey: intermediateKey,
    ca: false,
  });

  const jws = (payload: object, x5c: Buffer[]): string => {
    const header = { alg: "ES256", x5c: x5c.map((d) => d.toString("base64")) };
    const input =
      Buffer.from(JSON.stringify(header)).toString("base64url") +
      "." +
      Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = sign("sha256", Buffer.from(input), {
      key: leafKey.privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `${input}.${sig.toString("base64url")}`;
  };

  return {
    rootDer,
    signJws: (payload, opts) => jws(payload, opts?.x5c ?? [leafDer, intermediateDer, rootDer]),
    unmarkedLeafJws: (payload) => jws(payload, [unmarkedLeafDer, intermediateDer, rootDer]),
  };
}
