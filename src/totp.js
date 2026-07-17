// RFC 4226 (HOTP) and RFC 6238 (TOTP) implemented on Node's crypto, plus the
// otpauth:// key-URI format that authenticator apps (Google Authenticator,
// Authy, 1Password, …) scan. Used for the optional MFA layer.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { base32Decode, base32Encode } from './encoding.js';

const DEFAULT_STEP = 30; // seconds per TOTP window
const DEFAULT_DIGITS = 6;
const DEFAULT_ALGORITHM = 'SHA1'; // the near-universal authenticator default

/**
 * Generate a cryptographically random base32 TOTP secret.
 * @param {number} [byteLength=20] Raw entropy length (20 bytes = 160 bits).
 * @returns {string} base32-encoded secret.
 */
export function generateSecret(byteLength = 20) {
  if (!Number.isInteger(byteLength) || byteLength < 10) {
    throw new Error('TOTP secret must be at least 10 bytes of entropy');
  }
  return base32Encode(randomBytes(byteLength));
}

function hotpAlgorithm(algorithm) {
  const normalized = String(algorithm).toUpperCase();
  if (!['SHA1', 'SHA256', 'SHA512'].includes(normalized)) {
    throw new Error(`Unsupported TOTP algorithm: ${algorithm}`);
  }
  return normalized;
}

/**
 * Compute an HOTP value (RFC 4226) for a given counter.
 * @param {string} secret base32-encoded secret.
 * @param {number} counter Moving factor.
 * @param {object} [options]
 * @param {number} [options.digits=6]
 * @param {string} [options.algorithm='SHA1']
 * @returns {string} Zero-padded OTP of `digits` length.
 */
export function generateHOTP(secret, counter, options = {}) {
  const digits = options.digits ?? DEFAULT_DIGITS;
  const algorithm = hotpAlgorithm(options.algorithm ?? DEFAULT_ALGORITHM);
  const key = base32Decode(secret);
  if (key.length === 0) {
    throw new Error('TOTP secret decodes to an empty key');
  }

  // Counter as a big-endian 8-byte buffer.
  const counterBuf = Buffer.alloc(8);
  let value = BigInt(Math.trunc(counter));
  for (let i = 7; i >= 0; i -= 1) {
    counterBuf[i] = Number(value & 0xffn);
    value >>= 8n;
  }

  const digest = createHmac(algorithm, key).update(counterBuf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

function counterForTime(now, step) {
  return Math.floor(now / 1000 / step);
}

/**
 * Compute the TOTP value (RFC 6238) for the current (or given) time.
 * @param {string} secret base32-encoded secret.
 * @param {object} [options]
 * @param {number} [options.now=Date.now()] Milliseconds since epoch.
 * @param {number} [options.step=30]
 * @param {number} [options.digits=6]
 * @param {string} [options.algorithm='SHA1']
 * @returns {string}
 */
export function generateTOTP(secret, options = {}) {
  const now = options.now ?? Date.now();
  const step = options.step ?? DEFAULT_STEP;
  return generateHOTP(secret, counterForTime(now, step), options);
}

/**
 * Verify a user-supplied TOTP token, tolerating small clock drift by checking
 * a window of adjacent time steps.
 * @param {string} secret base32-encoded secret.
 * @param {string} token The code entered by the user.
 * @param {object} [options]
 * @param {number} [options.now=Date.now()]
 * @param {number} [options.step=30]
 * @param {number} [options.digits=6]
 * @param {string} [options.algorithm='SHA1']
 * @param {number} [options.window=1] Steps of drift allowed on each side.
 * @returns {{ valid: boolean, delta: number|null }} `delta` is the matching
 *   step offset (0 = current window), or null when no match.
 */
export function verifyTOTP(secret, token, options = {}) {
  if (typeof token !== 'string' || token.trim() === '') {
    return { valid: false, delta: null };
  }
  const digits = options.digits ?? DEFAULT_DIGITS;
  const normalized = token.trim();
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) {
    return { valid: false, delta: null };
  }

  const now = options.now ?? Date.now();
  const step = options.step ?? DEFAULT_STEP;
  const window = options.window ?? 1;
  const baseCounter = counterForTime(now, step);
  const candidateBuf = Buffer.from(normalized);

  for (let delta = -window; delta <= window; delta += 1) {
    const expected = generateHOTP(secret, baseCounter + delta, options);
    const expectedBuf = Buffer.from(expected);
    if (
      expectedBuf.length === candidateBuf.length &&
      timingSafeEqual(expectedBuf, candidateBuf)
    ) {
      return { valid: true, delta };
    }
  }
  return { valid: false, delta: null };
}

/**
 * Build an otpauth:// key URI for provisioning an authenticator app.
 * @param {object} params
 * @param {string} params.secret base32-encoded secret.
 * @param {string} params.accountName Usually the driver's email/username.
 * @param {string} params.issuer Product/organization name (e.g. "RoutePilot").
 * @param {number} [params.digits=6]
 * @param {number} [params.step=30]
 * @param {string} [params.algorithm='SHA1']
 * @returns {string}
 */
export function keyUri({
  secret,
  accountName,
  issuer,
  digits = DEFAULT_DIGITS,
  step = DEFAULT_STEP,
  algorithm = DEFAULT_ALGORITHM,
}) {
  if (!secret) throw new Error('keyUri requires a secret');
  if (!accountName) throw new Error('keyUri requires an accountName');
  if (!issuer) throw new Error('keyUri requires an issuer');
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: hotpAlgorithm(algorithm),
    digits: String(digits),
    period: String(step),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
