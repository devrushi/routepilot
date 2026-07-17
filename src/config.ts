/**
 * Central configuration for the authentication subsystem.
 *
 * Values are read from the environment so deployments can inject real secrets,
 * but every field has a sensible default so the service (and its test suite)
 * runs out of the box. The one thing you must override in production is
 * AUTH_JWT_SECRET.
 */

export interface AuthConfig {
  /** Secret used to sign/verify JWTs (HMAC-SHA256). */
  jwtSecret: string;
  /** Issuer (`iss`) claim stamped onto every token. */
  issuer: string;
  /** Lifetime of a short-lived access token, in seconds. */
  accessTokenTtlSeconds: number;
  /** Lifetime of a refresh token, in seconds. */
  refreshTokenTtlSeconds: number;
  /** Lifetime of the interim token issued when MFA is pending, in seconds. */
  mfaChallengeTtlSeconds: number;
  /** Human-readable label shown in authenticator apps (issuer of the TOTP). */
  totpIssuer: string;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return parsed;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  return {
    jwtSecret: env.AUTH_JWT_SECRET || 'dev-insecure-secret-change-me',
    issuer: env.AUTH_ISSUER || 'routepilot',
    accessTokenTtlSeconds: intFromEnv('AUTH_ACCESS_TTL', 15 * 60),
    refreshTokenTtlSeconds: intFromEnv('AUTH_REFRESH_TTL', 30 * 24 * 60 * 60),
    mfaChallengeTtlSeconds: intFromEnv('AUTH_MFA_CHALLENGE_TTL', 5 * 60),
    totpIssuer: env.AUTH_TOTP_ISSUER || 'RoutePilot',
  };
}

export const authConfig = loadAuthConfig();
