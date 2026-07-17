// Password hashing built on Node's scrypt KDF. Stored as a self-describing
// string so parameters can evolve without a migration:
//   scrypt$N$r$p$<base64url salt>$<base64url hash>

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { base64UrlDecode, base64UrlEncode } from './encoding.js';

const DEFAULTS = { N: 16384, r: 8, p: 1, keyLen: 32, saltBytes: 16 };

function scryptAsync(password, salt, keyLen, params) {
  return new Promise((resolve, reject) => {
    // maxmem must be raised above the default for the chosen cost params.
    scrypt(password, salt, keyLen, { ...params, maxmem: 128 * params.N * params.r * 2 }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * Hash a plaintext password. Each call uses a fresh random salt.
 * @param {string} password
 * @param {object} [options] Override cost parameters (N, r, p, keyLen, saltBytes).
 * @returns {Promise<string>} Encoded hash string.
 */
export async function hashPassword(password, options = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  const { N, r, p, keyLen, saltBytes } = { ...DEFAULTS, ...options };
  const salt = randomBytes(saltBytes);
  const derived = await scryptAsync(password, salt, keyLen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${base64UrlEncode(salt)}$${base64UrlEncode(derived)}`;
}

/**
 * Verify a plaintext password against an encoded hash. Comparison is
 * constant-time and never throws on malformed input (returns false instead).
 * @param {string} password
 * @param {string} stored Encoded hash produced by hashPassword.
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') {
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (![N, r, p].every(Number.isInteger)) {
    return false;
  }
  let salt;
  let expected;
  try {
    salt = base64UrlDecode(saltB64);
    expected = base64UrlDecode(hashB64);
  } catch {
    return false;
  }
  if (expected.length === 0) {
    return false;
  }
  let derived;
  try {
    derived = await scryptAsync(password, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
