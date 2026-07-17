// Minimal, dependency-free JWT (JWS) implementation supporting the HS256
// algorithm. Purpose-built for RoutePilot session tokens; it deliberately
// supports only the features the session layer needs and rejects everything
// else (notably the "none" algorithm and algorithm confusion attacks).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { base64UrlDecode, base64UrlEncode } from './encoding.js';

const SUPPORTED_ALG = 'HS256';

export class JwtError extends Error {
  constructor(message, code = 'JWT_INVALID') {
    super(message);
    this.name = 'JwtError';
    this.code = code;
  }
}

function sign(signingInput, secret) {
  return base64UrlEncode(createHmac('sha256', secret).update(signingInput).digest());
}

/**
 * Create a signed HS256 JWT.
 * @param {object} payload Claims to embed. `iat` is added if absent.
 * @param {string|Buffer} secret HMAC signing key.
 * @param {object} [options]
 * @param {number} [options.expiresInSeconds] Sets `exp` relative to now.
 * @param {number} [options.now] Override current time (seconds) — for testing.
 * @param {object} [options.header] Extra header fields merged in.
 * @returns {string} Compact-serialized JWT.
 */
export function signJwt(payload, secret, options = {}) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new JwtError('JWT payload must be a plain object', 'JWT_PAYLOAD');
  }
  if (!secret) {
    throw new JwtError('A signing secret is required', 'JWT_SECRET');
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const header = { alg: SUPPORTED_ALG, typ: 'JWT', ...options.header };
  const claims = { iat: now, ...payload };
  if (options.expiresInSeconds != null) {
    claims.exp = now + options.expiresInSeconds;
  }
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

/**
 * Verify a JWT's signature and standard time claims.
 * @param {string} token
 * @param {string|Buffer} secret
 * @param {object} [options]
 * @param {number} [options.now] Override current time (seconds).
 * @param {number} [options.clockToleranceSeconds] Leeway for exp/nbf checks.
 * @param {string} [options.issuer] Required `iss` value, if set.
 * @param {string} [options.audience] Required `aud` value, if set.
 * @returns {object} The decoded, verified payload.
 * @throws {JwtError}
 */
export function verifyJwt(token, secret, options = {}) {
  if (typeof token !== 'string') {
    throw new JwtError('Token must be a string', 'JWT_MALFORMED');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('Token must have three segments', 'JWT_MALFORMED');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
  } catch {
    throw new JwtError('Token header or payload is not valid JSON', 'JWT_MALFORMED');
  }

  // Pin the algorithm to prevent "alg: none" and HS/RS confusion attacks.
  if (header.alg !== SUPPORTED_ALG) {
    throw new JwtError(`Unsupported JWT algorithm: ${header.alg}`, 'JWT_ALG');
  }

  const expected = sign(`${encodedHeader}.${encodedPayload}`, secret);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(encodedSignature);
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new JwtError('Signature verification failed', 'JWT_SIGNATURE');
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.clockToleranceSeconds ?? 0;

  if (payload.nbf != null && now + tolerance < payload.nbf) {
    throw new JwtError('Token is not yet valid', 'JWT_NOT_ACTIVE');
  }
  if (payload.exp != null && now - tolerance >= payload.exp) {
    throw new JwtError('Token has expired', 'JWT_EXPIRED');
  }
  if (options.issuer != null && payload.iss !== options.issuer) {
    throw new JwtError('Unexpected token issuer', 'JWT_ISSUER');
  }
  if (options.audience != null) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(options.audience)) {
      throw new JwtError('Unexpected token audience', 'JWT_AUDIENCE');
    }
  }

  return payload;
}

/**
 * Decode a JWT without verifying its signature. Never trust the result for
 * authorization — this is for inspection/logging only.
 * @param {string} token
 * @returns {{ header: object, payload: object }}
 */
export function decodeJwt(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw new JwtError('Token must be a compact JWS string', 'JWT_MALFORMED');
  }
  const [encodedHeader, encodedPayload] = token.split('.');
  return {
    header: JSON.parse(base64UrlDecode(encodedHeader).toString('utf8')),
    payload: JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')),
  };
}
