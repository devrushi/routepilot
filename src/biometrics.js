// Biometric authentication for RoutePilot's native mobile clients.
//
// Native platforms (iOS Secure Enclave / Face ID / Touch ID, Android
// Keystore / BiometricPrompt) can generate a hardware-backed key pair whose
// private key never leaves the device and is released only after a successful
// biometric check. This module implements the server side of that flow using
// public-key challenge–response, the same shape as WebAuthn/FIDO2 assertions:
//
//   1. Enrollment  — the device generates a key pair, unlocks the private key
//                    with the user's biometric, signs a server challenge, and
//                    registers the PUBLIC key. The server never sees biometric
//                    data, only a public key + a proof of possession.
//   2. Assertion   — at login the server issues a fresh random challenge; the
//                    device signs it with the biometric-gated private key and
//                    the server verifies the signature against the stored key.
//
// Only Node's `crypto` is used, keeping the auth stack dependency-free. The
// signature algorithms cover what the mobile Secure Enclave / Keystore APIs
// actually emit: ECDSA P-256/P-384 (the default for both platforms), RSA
// (PKCS#1 v1.5 and PSS) and Ed25519.

import { constants, createPublicKey, createHash, randomBytes, verify as cryptoVerify } from 'node:crypto';
import { base64UrlEncode } from './encoding.js';

export class BiometricError extends Error {
  constructor(message, code = 'BIOMETRIC_INVALID') {
    super(message);
    this.name = 'BiometricError';
    this.code = code;
  }
}

// Supported COSE-style algorithm identifiers → Node crypto parameters. ECDSA
// uses a `digest`; RSA-PSS adds PSS padding; Ed25519 hashes internally so its
// digest is `null` (Node's convention for one-shot EdDSA verification).
const ALGORITHMS = {
  ES256: { type: 'ec', digest: 'sha256', curve: 'P-256' },
  ES384: { type: 'ec', digest: 'sha384', curve: 'P-384' },
  ES512: { type: 'ec', digest: 'sha512', curve: 'P-521' },
  RS256: { type: 'rsa', digest: 'sha256' },
  RS384: { type: 'rsa', digest: 'sha384' },
  RS512: { type: 'rsa', digest: 'sha512' },
  PS256: { type: 'rsa-pss', digest: 'sha256' },
  PS384: { type: 'rsa-pss', digest: 'sha384' },
  PS512: { type: 'rsa-pss', digest: 'sha512' },
  EdDSA: { type: 'ed25519', digest: null },
};

/** Algorithm identifiers this module can verify. */
export const SUPPORTED_ALGORITHMS = Object.freeze(Object.keys(ALGORITHMS));

// Case-insensitive lookup, plus the common "Ed25519" alias for "EdDSA".
const ALGORITHM_ALIASES = new Map(Object.keys(ALGORITHMS).map((name) => [name.toUpperCase(), name]));
ALGORITHM_ALIASES.set('ED25519', 'EdDSA');

function normalizeAlgorithm(algorithm) {
  if (typeof algorithm !== 'string') {
    throw new BiometricError('An algorithm is required', 'BIOMETRIC_ALGORITHM');
  }
  const name = ALGORITHM_ALIASES.get(algorithm.trim().toUpperCase());
  if (!name) {
    throw new BiometricError(`Unsupported biometric algorithm: ${algorithm}`, 'BIOMETRIC_ALGORITHM');
  }
  return { name, spec: ALGORITHMS[name] };
}

// Accept a signature or challenge/message as a Buffer, a base64url string, or
// (for messages) an arbitrary UTF-8 string.
function toBuffer(value, { allowUtf8 = false } = {}) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') {
    if (allowUtf8) return Buffer.from(value, 'utf8');
    // base64url → base64 → Buffer.
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (normalized.length % 4)) % 4;
    return Buffer.from(normalized + '='.repeat(pad), 'base64');
  }
  throw new BiometricError('Expected a Buffer or base64url string', 'BIOMETRIC_ENCODING');
}

/**
 * Import a client-supplied public key into a canonical SPKI PEM string and a
 * Node KeyObject. Accepts PEM (SPKI/PKCS#1), DER bytes (Buffer or base64url),
 * a JWK object, or an existing KeyObject.
 * @param {string|Buffer|object} publicKey
 * @returns {{ keyObject: import('node:crypto').KeyObject, pem: string, type: string }}
 */
export function importPublicKey(publicKey) {
  if (publicKey == null) {
    throw new BiometricError('A public key is required', 'BIOMETRIC_PUBLIC_KEY');
  }
  // Reject private key material outright — createPublicKey would happily derive
  // the public half, but a client should never transmit a private key.
  if (typeof publicKey === 'object' && publicKey.constructor?.name === 'KeyObject' && publicKey.type === 'private') {
    throw new BiometricError('Expected a public key, not a private key', 'BIOMETRIC_PUBLIC_KEY');
  }
  if (typeof publicKey === 'string' && publicKey.includes('PRIVATE KEY')) {
    throw new BiometricError('Expected a public key, not a private key', 'BIOMETRIC_PUBLIC_KEY');
  }
  if (typeof publicKey === 'object' && !Buffer.isBuffer(publicKey) && publicKey.constructor?.name !== 'KeyObject' && 'd' in publicKey) {
    throw new BiometricError('Expected a public JWK, not a private one', 'BIOMETRIC_PUBLIC_KEY');
  }

  let keyObject;
  try {
    if (typeof publicKey === 'object' && publicKey.constructor?.name === 'KeyObject') {
      keyObject = publicKey;
    } else if (typeof publicKey === 'string' && publicKey.includes('-----BEGIN')) {
      keyObject = createPublicKey(publicKey);
    } else if (typeof publicKey === 'object' && !Buffer.isBuffer(publicKey)) {
      keyObject = createPublicKey({ key: publicKey, format: 'jwk' });
    } else {
      // Bytes: DER-encoded SubjectPublicKeyInfo, given as Buffer or base64url.
      const der = Buffer.isBuffer(publicKey) ? publicKey : toBuffer(publicKey);
      keyObject = createPublicKey({ key: der, format: 'der', type: 'spki' });
    }
  } catch (err) {
    throw new BiometricError(`Invalid public key: ${err.message}`, 'BIOMETRIC_PUBLIC_KEY');
  }
  if (keyObject.type !== 'public') {
    throw new BiometricError('Expected a public key, not a private key', 'BIOMETRIC_PUBLIC_KEY');
  }
  return {
    keyObject,
    pem: keyObject.export({ type: 'spki', format: 'pem' }).toString(),
    type: keyObject.asymmetricKeyType,
  };
}

/**
 * Generate a random login/enrollment challenge (a nonce the device signs).
 * @param {number} [byteLength=32] Entropy in bytes (min 16).
 * @returns {string} base64url-encoded challenge.
 */
export function generateChallenge(byteLength = 32) {
  if (!Number.isInteger(byteLength) || byteLength < 16) {
    throw new BiometricError('A biometric challenge needs at least 16 bytes of entropy', 'BIOMETRIC_CHALLENGE');
  }
  return base64UrlEncode(randomBytes(byteLength));
}

/**
 * Derive a stable, opaque credential id from a public key (base64url SHA-256
 * of the SPKI DER). Used when a client does not supply its own credential id.
 * @param {string} pem SPKI PEM public key.
 * @returns {string}
 */
export function deriveCredentialId(pem) {
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return base64UrlEncode(createHash('sha256').update(der).digest());
}

/**
 * Verify a biometric assertion: that `signature` over `challenge` was produced
 * by the private key matching `publicKey`. Never throws on a bad/forged
 * signature — returns false — but throws BiometricError on misconfiguration
 * (unknown algorithm, unusable public key).
 *
 * @param {object} params
 * @param {string|Buffer|object} params.publicKey Stored public key.
 * @param {string} params.algorithm One of SUPPORTED_ALGORITHMS.
 * @param {string|Buffer} params.challenge The challenge the device signed. A
 *   string is treated as the raw UTF-8 challenge text (challenges are issued as
 *   base64url text and signed as-is by the client).
 * @param {string|Buffer} params.signature base64url string or Buffer. ECDSA
 *   signatures are ASN.1/DER by default (what Secure Enclave, Android Keystore
 *   and WebAuthn emit); pass `signatureFormat: 'ieee-p1363'` for raw r||s.
 * @param {'der'|'ieee-p1363'} [params.signatureFormat='der']
 * @returns {boolean}
 */
export function verifyAssertion({ publicKey, algorithm, challenge, signature, signatureFormat = 'der' }) {
  const { spec } = normalizeAlgorithm(algorithm);
  const { keyObject } = importPublicKey(publicKey);

  if (challenge == null) {
    throw new BiometricError('A challenge is required', 'BIOMETRIC_CHALLENGE');
  }
  if (signature == null) return false;

  let message;
  let sig;
  try {
    message = toBuffer(challenge, { allowUtf8: true });
    sig = toBuffer(signature);
  } catch {
    return false;
  }
  if (sig.length === 0) return false;

  const keyInput = { key: keyObject };
  if (spec.type === 'ec') {
    keyInput.dsaEncoding = signatureFormat === 'ieee-p1363' ? 'ieee-p1363' : 'der';
  } else if (spec.type === 'rsa-pss') {
    // RSASSA-PSS with the salt length equal to the digest length (the default
    // both mobile Keystores and WebAuthn use).
    keyInput.padding = constants.RSA_PKCS1_PSS_PADDING;
    keyInput.saltLength = constants.RSA_PSS_SALTLEN_DIGEST;
  }

  try {
    return cryptoVerify(spec.digest, message, keyInput, sig);
  } catch {
    // Malformed signature/key material from an untrusted client → reject.
    return false;
  }
}
