/**
 * A minimal, dependency-free HS256 JSON Web Token implementation.
 *
 * We sign tokens with HMAC-SHA256 over `base64url(header).base64url(payload)`
 * and verify using a constant-time comparison. This is intentionally small and
 * self-contained: RoutePilot only needs symmetric, short-lived session tokens,
 * and avoiding a third-party dependency keeps the trusted surface tiny.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { base64UrlDecode, base64UrlEncode } from '../crypto/encoding';

export interface JwtClaims {
  /** Subject — the user id the token is issued for. */
  sub: string;
  /** Issuer. */
  iss?: string;
  /** Issued-at, seconds since the epoch. */
  iat?: number;
  /** Expiry, seconds since the epoch. */
  exp?: number;
  /** Not-before, seconds since the epoch. */
  nbf?: number;
  /** Arbitrary application claims (token type, roles, mfa state, …). */
  [claim: string]: unknown;
}

export interface SignOptions {
  secret: string;
  /** Seconds until the token expires. Omit for a token without `exp`. */
  expiresInSeconds?: number;
  issuer?: string;
  /** Override "now" (seconds); primarily for deterministic tests. */
  now?: number;
}

export interface VerifyOptions {
  secret: string;
  issuer?: string;
  /** Allowed clock skew, in seconds, when checking exp/nbf. */
  clockToleranceSeconds?: number;
  /** Override "now" (seconds); primarily for deterministic tests. */
  now?: number;
}

/** Raised for any token that fails structural checks, signature, or claims. */
export class TokenError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'malformed'
      | 'unsupported_alg'
      | 'invalid_signature'
      | 'expired'
      | 'not_active'
      | 'invalid_issuer',
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

function nowSeconds(override?: number): number {
  return override ?? Math.floor(Date.now() / 1000);
}

function signingInput(headerSegment: string, payloadSegment: string): string {
  return `${headerSegment}.${payloadSegment}`;
}

function computeSignature(input: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(input).digest());
}

/** Sign a set of claims into a compact JWS string. */
export function signJwt(claims: JwtClaims, options: SignOptions): string {
  const issuedAt = nowSeconds(options.now);
  const payload: JwtClaims = { iat: issuedAt, ...claims };

  if (options.issuer && payload.iss === undefined) {
    payload.iss = options.issuer;
  }
  if (options.expiresInSeconds !== undefined && payload.exp === undefined) {
    payload.exp = issuedAt + options.expiresInSeconds;
  }

  const headerSegment = base64UrlEncode(JSON.stringify(HEADER));
  const payloadSegment = base64UrlEncode(JSON.stringify(payload));
  const signature = computeSignature(
    signingInput(headerSegment, payloadSegment),
    options.secret,
  );

  return `${headerSegment}.${payloadSegment}.${signature}`;
}

/** Verify a compact JWS string and return its claims, or throw a TokenError. */
export function verifyJwt(token: string, options: VerifyOptions): JwtClaims {
  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new TokenError('Token must have three segments', 'malformed');
  }

  const [headerSegment, payloadSegment, signatureSegment] = segments;

  let header: { alg?: string; typ?: string };
  let payload: JwtClaims;
  try {
    header = JSON.parse(base64UrlDecode(headerSegment).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(payloadSegment).toString('utf8'));
  } catch {
    throw new TokenError('Token header/payload is not valid JSON', 'malformed');
  }

  if (header.alg !== 'HS256') {
    throw new TokenError(
      `Unsupported algorithm: ${header.alg ?? 'none'}`,
      'unsupported_alg',
    );
  }

  const expectedSignature = computeSignature(
    signingInput(headerSegment, payloadSegment),
    options.secret,
  );
  if (!constantTimeEquals(signatureSegment, expectedSignature)) {
    throw new TokenError('Signature verification failed', 'invalid_signature');
  }

  const tolerance = options.clockToleranceSeconds ?? 0;
  const current = nowSeconds(options.now);

  if (typeof payload.exp === 'number' && current > payload.exp + tolerance) {
    throw new TokenError('Token has expired', 'expired');
  }
  if (typeof payload.nbf === 'number' && current + tolerance < payload.nbf) {
    throw new TokenError('Token is not yet active', 'not_active');
  }
  if (options.issuer !== undefined && payload.iss !== options.issuer) {
    throw new TokenError('Unexpected token issuer', 'invalid_issuer');
  }

  return payload;
}

/** Length-safe, constant-time string comparison over their byte encodings. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
