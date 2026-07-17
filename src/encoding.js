// Low-level encoding helpers shared by the JWT and TOTP implementations.
// Kept dependency-free so the whole auth stack relies only on Node's crypto.

/**
 * Encode a Buffer or string as base64url (RFC 4648 §5) with no padding.
 * @param {Buffer|string} input
 * @returns {string}
 */
export function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a base64url string back into a Buffer.
 * @param {string} input
 * @returns {Buffer}
 */
export function base64UrlDecode(input) {
  if (typeof input !== 'string') {
    throw new TypeError('base64UrlDecode expects a string');
  }
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLength), 'base64');
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode a Buffer as RFC 4648 base32 (used for TOTP shared secrets).
 * @param {Buffer} buffer
 * @returns {string}
 */
export function base32Encode(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('base32Encode expects a Buffer');
  }
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Decode an RFC 4648 base32 string into a Buffer. Padding, whitespace and
 * case are tolerated so user-entered secrets round-trip cleanly.
 * @param {string} input
 * @returns {Buffer}
 */
export function base32Decode(input) {
  if (typeof input !== 'string') {
    throw new TypeError('base32Decode expects a string');
  }
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error(`Invalid base32 character: ${char}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
