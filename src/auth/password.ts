/**
 * Password hashing using scrypt (a memory-hard KDF built into Node).
 *
 * Hashes are stored in a self-describing string so parameters can evolve
 * without a migration: `scrypt$N$r$p$saltB64$hashB64`.
 */

import { randomBytes, scrypt, ScryptOptions, timingSafeEqual } from 'node:crypto';

/**
 * Promise wrapper around `scrypt`. We wrap manually rather than using
 * `promisify` so the `options` overload (cost parameters) is preserved.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) {
        reject(err);
      } else {
        resolve(derivedKey);
      }
    });
  });
}

const PARAMS = { N: 16384, r: 8, p: 1, keyLength: 64, saltBytes: 16 };

/** Hash a plaintext password into a self-describing, storable string. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PARAMS.saltBytes);
  const derived = (await scryptAsync(password, salt, PARAMS.keyLength, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
  })) as Buffer;

  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/** Verify a plaintext password against a stored hash, in constant time. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }

  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = Number.parseInt(nStr, 10);
  const r = Number.parseInt(rStr, 10);
  const p = Number.parseInt(pStr, 10);
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');

  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  const derived = (await scryptAsync(password, salt, expected.length, {
    N,
    r,
    p,
  })) as Buffer;

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
