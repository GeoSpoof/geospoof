/**
 * Apple Root CA - G3, the trust anchor for StoreKit 2 signed transactions and
 * AppTransactions. `SignedDataVerifier` checks each JWS's `x5c` chain
 * (leaf -> intermediate -> root) terminates here, so the root is embedded
 * rather than read from the request.
 *
 * Base64 in source rather than a `.cer` file because this is bundled by
 * esbuild into a Lambda: a binary asset only survives if the bundler happens to
 * copy it, while a string constant always does. (Same pattern as
 * geospoof-site:src/lib/purchase-alerts/apple-root-ca.ts.) Never commit a `.cer`.
 *
 * Provenance - downloaded from https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
 * on 2026-10-18 and confirmed byte-identical to the root embedded in the GPS
 * agent (geospoof-gps:agent/assets/AppleRootCA-G3.cer), whose entitlement
 * policy this relay mirrors:
 *   subject/issuer  CN=Apple Root CA - G3, OU=Apple Certification Authority, O=Apple Inc., C=US
 *   validity        2014-04-30 -> 2039-04-30
 *   SHA-256         63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
 *
 * To re-verify (outside the repo; the root .gitignore ignores *.cer anyway):
 *   T=$(mktemp -d)
 *   curl -sSf -o "$T/g3.cer" https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
 *   openssl x509 -inform der -in "$T/g3.cer" -noout -fingerprint -sha256
 *   base64 -i "$T/g3.cer"     # must equal the constant below
 *   rm -rf "$T"
 * The unit test also asserts the decoded DER hashes to the fingerprint above.
 */

export const APPLE_ROOT_CA_G3_SHA256 =
  "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79";

const APPLE_ROOT_CA_G3_BASE64 =
  "MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9v" +
  "dCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UE" +
  "CgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2" +
  "WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmlj" +
  "YXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqG" +
  "SM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxE" +
  "tX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNC" +
  "MEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0P" +
  "AQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3m" +
  "eoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkL" +
  "F1vLUagM6BgD56KyKA==";

/** The DER bytes of Apple Root CA - G3, in the shape `SignedDataVerifier` wants. */
export function appleRootCertificates(): Buffer[] {
  return [Buffer.from(APPLE_ROOT_CA_G3_BASE64, "base64")];
}
