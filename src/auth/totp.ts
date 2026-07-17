/**
 * RFC 4226 (HOTP) / RFC 6238 (TOTP) implementation used for optional MFA.
 *
 * Drivers who opt in to multi-factor auth register a shared secret with an
 * authenticator app (Google Authenticator, 1Password, …) via an `otpauth://`
 * provisioning URI. At sign-in they present the current 6-digit code, which we
 * validate here against the stored secret with a small verification window to
 * tolerate clock drift.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { base32Decode, base32Encode } from '../crypto/encoding';

export interface TotpOptions {
  /** Number of digits in the code. Defaults to 6. */
  digits?: number;
  /** Time step in seconds. Defaults to 30. */
  periodSeconds?: number;
  /** HMAC hash algorithm. Defaults to SHA-1 (authenticator-app default). */
  algorithm?: 'sha1' | 'sha256' | 'sha512';
  /** Override "now" in ms; primarily for deterministic tests. */
  now?: number;
}

export interface VerifyTotpOptions extends TotpOptions {
  /**
   * How many steps before/after the current one to accept, to tolerate clock
   * drift. A window of 1 accepts the previous, current and next codes.
   */
  window?: number;
}

const DEFAULTS = {
  digits: 6,
  periodSeconds: 30,
  algorithm: 'sha1' as const,
};

/** Generate a fresh, random base32 TOTP secret. */
export function generateTotpSecret(byteLength = 20): string {
  return base32Encode(randomBytes(byteLength));
}

/** Compute an HOTP value (RFC 4226) for a specific counter. */
export function hotp(
  secret: string,
  counter: number,
  options: Pick<TotpOptions, 'digits' | 'algorithm'> = {},
): string {
  const digits = options.digits ?? DEFAULTS.digits;
  const algorithm = options.algorithm ?? DEFAULTS.algorithm;

  const key = base32Decode(secret);
  const counterBuffer = Buffer.alloc(8);
  // Write the counter as a big-endian 64-bit integer.
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(algorithm, key).update(counterBuffer).digest();

  // Dynamic truncation (RFC 4226 §5.3).
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  const code = binary % 10 ** digits;
  return code.toString().padStart(digits, '0');
}

function counterForTime(options: TotpOptions): number {
  const period = options.periodSeconds ?? DEFAULTS.periodSeconds;
  const nowMs = options.now ?? Date.now();
  return Math.floor(nowMs / 1000 / period);
}

/** Generate the TOTP code valid for the current (or overridden) time. */
export function generateTotp(secret: string, options: TotpOptions = {}): string {
  return hotp(secret, counterForTime(options), options);
}

/**
 * Verify a submitted TOTP code against the secret.
 *
 * Comparison is done digit-by-digit against each candidate counter in the
 * window; codes are short, fixed-width and low-entropy per attempt, so the
 * meaningful defense is rate limiting at the call site rather than constant
 * time here.
 */
export function verifyTotp(
  token: string,
  secret: string,
  options: VerifyTotpOptions = {},
): boolean {
  const window = options.window ?? 1;
  const normalized = token.replace(/\s/g, '');
  const digits = options.digits ?? DEFAULTS.digits;

  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) {
    return false;
  }

  const baseCounter = counterForTime(options);
  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    const candidate = hotp(secret, baseCounter + errorWindow, options);
    if (candidate === normalized) {
      return true;
    }
  }
  return false;
}

export interface KeyUriParams {
  secret: string;
  /** Account label, typically the user's email. */
  accountName: string;
  /** Issuer shown in the authenticator app. */
  issuer: string;
  digits?: number;
  periodSeconds?: number;
  algorithm?: 'sha1' | 'sha256' | 'sha512';
}

/**
 * Build an `otpauth://totp/...` provisioning URI that authenticator apps can
 * import (usually rendered as a QR code by the client).
 */
export function buildOtpAuthUri(params: KeyUriParams): string {
  const digits = params.digits ?? DEFAULTS.digits;
  const period = params.periodSeconds ?? DEFAULTS.periodSeconds;
  const algorithm = (params.algorithm ?? DEFAULTS.algorithm).toUpperCase();

  const label = `${params.issuer}:${params.accountName}`;
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm,
    digits: String(digits),
    period: String(period),
  });

  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`;
}
