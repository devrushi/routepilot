// Biometric authentication for RoutePilot native mobile clients.
//
// Native apps (iOS Face ID / Touch ID, Android BiometricPrompt) unlock a
// hardware-backed private key held in the Secure Enclave / Keystore. Only the
// public half is registered with RoutePilot during enrollment; thereafter the
// device proves possession by signing a short-lived, server-issued challenge.
// The private key never leaves the device, so this is a genuine possession
// factor — usable for passwordless native login or as a step-up MFA factor.
//
// This module is the dependency-free crypto core: importing device public keys
// and verifying signatures over challenges. The orchestration (issuing
// challenges, storing credentials, minting sessions) lives in auth.js.

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { base64UrlDecode } from './encoding.js';

// Supported COSE-style algorithm identifiers mapped onto node:crypto.
//   ES256 — ECDSA P-256 with SHA-256, DER-encoded signature (WebAuthn default).
//   ES384 — ECDSA P-384 with SHA-384.
//   Ed25519 — EdDSA over Curve25519 (no separate digest step).
const ALGORITHMS = {
  ES256: { digest: 'sha256', keyType: 'ec', namedCurve: 'prime256v1' },
  ES384: { digest: 'sha384', keyType: 'ec', namedCurve: 'secp384r1' },
  Ed25519: { digest: null, keyType: 'ed25519', namedCurve: null },
};

/** Algorithm identifiers a device may register a credential under. */
export const SUPPORTED_BIOMETRIC_ALGORITHMS = Object.keys(ALGORITHMS);

export class BiometricError extends Error {
  constructor(message, code = 'BIOMETRIC_INVALID') {
    super(message);
    this.name = 'BiometricError';
    this.code = code;
  }
}

/** @returns {boolean} whether `algorithm` is a supported identifier. */
export function isSupportedBiometricAlgorithm(algorithm) {
  return Object.prototype.hasOwnProperty.call(ALGORITHMS, algorithm);
}

/**
 * Import a device public key into a KeyObject. Accepts either a PEM SPKI string
 * or a base64url-encoded DER SPKI blob (what mobile keystores typically export).
 * @param {string} publicKey
 * @param {string} algorithm One of {@link SUPPORTED_BIOMETRIC_ALGORITHMS}.
 * @returns {import('node:crypto').KeyObject}
 * @throws {BiometricError}
 */
export function importPublicKey(publicKey, algorithm) {
  const spec = ALGORITHMS[algorithm];
  if (!spec) {
    throw new BiometricError(`Unsupported algorithm: ${algorithm}`, 'BIOMETRIC_ALG');
  }
  if (typeof publicKey !== 'string' || publicKey.trim() === '') {
    throw new BiometricError('A public key is required', 'BIOMETRIC_KEY');
  }
  let keyObject;
  try {
    if (publicKey.includes('-----BEGIN')) {
      keyObject = createPublicKey({ key: publicKey, format: 'pem' });
    } else {
      keyObject = createPublicKey({ key: base64UrlDecode(publicKey), format: 'der', type: 'spki' });
    }
  } catch (err) {
    throw new BiometricError(`Could not parse public key: ${err.message}`, 'BIOMETRIC_KEY');
  }
  // Reject a key whose type/curve doesn't match the declared algorithm, so a
  // credential can never be verified under an algorithm it wasn't issued for.
  if (keyObject.asymmetricKeyType !== spec.keyType) {
    throw new BiometricError(
      `Public key type "${keyObject.asymmetricKeyType}" does not match algorithm ${algorithm}`,
      'BIOMETRIC_KEY',
    );
  }
  if (spec.namedCurve) {
    const curve = keyObject.asymmetricKeyDetails?.namedCurve;
    if (curve && curve !== spec.namedCurve) {
      throw new BiometricError(
        `Public key curve "${curve}" does not match algorithm ${algorithm}`,
        'BIOMETRIC_KEY',
      );
    }
  }
  return keyObject;
}

/**
 * Normalize a device public key to a stable PEM SPKI string for storage.
 * @returns {string}
 */
export function normalizePublicKey(publicKey, algorithm) {
  return importPublicKey(publicKey, algorithm).export({ type: 'spki', format: 'pem' });
}

/**
 * Verify a device signature over `data`.
 * @param {object} params
 * @param {string|import('node:crypto').KeyObject} params.publicKey PEM/DER string or KeyObject.
 * @param {string} params.algorithm One of {@link SUPPORTED_BIOMETRIC_ALGORITHMS}.
 * @param {string|Buffer} params.data The exact bytes that were signed.
 * @param {string} params.signature base64url-encoded signature.
 * @returns {boolean} Whether the signature is valid. Never throws on a bad
 *   signature/encoding — only on an unusable algorithm or public key.
 */
export function verifyBiometricSignature({ publicKey, algorithm, data, signature }) {
  const spec = ALGORITHMS[algorithm];
  if (!spec) {
    throw new BiometricError(`Unsupported algorithm: ${algorithm}`, 'BIOMETRIC_ALG');
  }
  if (typeof signature !== 'string' || signature.trim() === '') {
    return false;
  }
  const key =
    typeof publicKey === 'object' && publicKey && publicKey.asymmetricKeyType
      ? publicKey
      : importPublicKey(publicKey, algorithm);

  let signatureBuf;
  try {
    signatureBuf = base64UrlDecode(signature);
  } catch {
    return false;
  }
  if (signatureBuf.length === 0) {
    return false;
  }
  const message = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  try {
    return cryptoVerify(spec.digest, message, key, signatureBuf);
  } catch {
    return false;
  }
}
