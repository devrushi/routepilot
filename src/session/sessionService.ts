/**
 * SessionService — JWT-based session handling with optional TOTP MFA.
 *
 * This is the heart of the ticket. It orchestrates:
 *   - registration and password login,
 *   - issuing short-lived access tokens + long-lived refresh tokens,
 *   - refreshing a session from a refresh token,
 *   - optional TOTP MFA enrollment, activation, and the two-step login
 *     challenge (password → interim MFA token → TOTP code → real tokens).
 *
 * Every token is a signed JWT (see ../auth/jwt); MFA codes are validated with
 * the RFC 6238 implementation in ../auth/totp. The store is injected so the
 * persistence layer can change independently.
 */

import { AuthConfig } from '../config';
import { JwtClaims, signJwt, TokenError, verifyJwt } from '../auth/jwt';
import { hashPassword, verifyPassword } from '../auth/password';
import {
  buildOtpAuthUri,
  generateTotpSecret,
  verifyTotp,
} from '../auth/totp';
import { UserStore } from './userStore';
import {
  AuthenticatedResult,
  DriverUser,
  LoginResult,
  PublicUser,
  SessionTokenType,
  TokenPair,
  toPublicUser,
} from './types';

/** Raised for any recoverable authentication problem, with a stable code. */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_credentials'
      | 'email_taken'
      | 'weak_password'
      | 'invalid_email'
      | 'user_not_found'
      | 'invalid_token'
      | 'mfa_not_initialized'
      | 'mfa_already_enabled'
      | 'invalid_mfa_code',
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface MfaEnrollment {
  secret: string;
  /** `otpauth://` URI for the authenticator app (render as a QR code). */
  otpauthUri: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

export class SessionService {
  constructor(
    private readonly store: UserStore,
    private readonly config: AuthConfig,
  ) {}

  /** Register a new driver and return an authenticated session. */
  async register(email: string, password: string): Promise<AuthenticatedResult> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      throw new AuthError('A valid email address is required', 'invalid_email');
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new AuthError(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        'weak_password',
      );
    }
    if (await this.store.findByEmail(normalizedEmail)) {
      throw new AuthError('That email is already registered', 'email_taken', 409);
    }

    const user = await this.store.create({
      email: normalizedEmail,
      passwordHash: await hashPassword(password),
      mfaEnabled: false,
    });

    return {
      status: 'authenticated',
      tokens: this.issueTokens(user),
      user: toPublicUser(user),
    };
  }

  /**
   * Verify an email/password pair. If MFA is enabled for the driver, returns a
   * short-lived challenge token instead of full session tokens.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.store.findByEmail(email);
    // Always run a password verification to keep timing roughly uniform whether
    // or not the account exists, then fail with the same generic error.
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const passwordOk = await verifyPassword(password, hash);

    if (!user || !passwordOk) {
      throw new AuthError(
        'Incorrect email or password',
        'invalid_credentials',
        401,
      );
    }

    if (user.mfaEnabled) {
      return { status: 'mfa_required', mfaToken: this.issueMfaChallenge(user) };
    }

    return {
      status: 'authenticated',
      tokens: this.issueTokens(user),
      user: toPublicUser(user),
    };
  }

  /** Complete a pending MFA login with the challenge token and a TOTP code. */
  async completeMfa(mfaToken: string, code: string): Promise<AuthenticatedResult> {
    const claims = this.verifyTyped(mfaToken, 'mfa_challenge');
    const user = await this.requireUser(claims.sub);

    if (!user.mfaEnabled || !user.totpSecret) {
      throw new AuthError('MFA is not active for this account', 'mfa_not_initialized');
    }
    if (!verifyTotp(code, user.totpSecret)) {
      throw new AuthError('Invalid authentication code', 'invalid_mfa_code', 401);
    }

    return {
      status: 'authenticated',
      tokens: this.issueTokens(user),
      user: toPublicUser(user),
    };
  }

  /** Exchange a valid refresh token for a fresh token pair (rotation). */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const claims = this.verifyTyped(refreshToken, 'refresh');
    const user = await this.requireUser(claims.sub);
    return this.issueTokens(user);
  }

  /**
   * Validate an access token and return its subject. Used by HTTP middleware to
   * protect routes.
   */
  async authenticate(accessToken: string): Promise<PublicUser> {
    const claims = this.verifyTyped(accessToken, 'access');
    const user = await this.requireUser(claims.sub);
    return toPublicUser(user);
  }

  /**
   * Begin TOTP enrollment: generate and persist a secret (not yet enforced) and
   * return the provisioning URI. Call `activateMfa` with a valid code to enable.
   */
  async beginMfaEnrollment(userId: string): Promise<MfaEnrollment> {
    const user = await this.requireUser(userId);
    if (user.mfaEnabled) {
      throw new AuthError('MFA is already enabled', 'mfa_already_enabled', 409);
    }

    const secret = generateTotpSecret();
    await this.store.update({ ...user, totpSecret: secret });

    return {
      secret,
      otpauthUri: buildOtpAuthUri({
        secret,
        accountName: user.email,
        issuer: this.config.totpIssuer,
      }),
    };
  }

  /** Activate MFA after enrollment by confirming a valid TOTP code. */
  async activateMfa(userId: string, code: string): Promise<PublicUser> {
    const user = await this.requireUser(userId);
    if (user.mfaEnabled) {
      throw new AuthError('MFA is already enabled', 'mfa_already_enabled', 409);
    }
    if (!user.totpSecret) {
      throw new AuthError(
        'Start MFA enrollment before activating',
        'mfa_not_initialized',
      );
    }
    if (!verifyTotp(code, user.totpSecret)) {
      throw new AuthError('Invalid authentication code', 'invalid_mfa_code', 401);
    }

    const updated = await this.store.update({ ...user, mfaEnabled: true });
    return toPublicUser(updated);
  }

  /** Disable MFA after confirming a valid TOTP code, clearing the secret. */
  async disableMfa(userId: string, code: string): Promise<PublicUser> {
    const user = await this.requireUser(userId);
    if (!user.mfaEnabled || !user.totpSecret) {
      throw new AuthError('MFA is not active for this account', 'mfa_not_initialized');
    }
    if (!verifyTotp(code, user.totpSecret)) {
      throw new AuthError('Invalid authentication code', 'invalid_mfa_code', 401);
    }

    const updated = await this.store.update({
      ...user,
      mfaEnabled: false,
      totpSecret: undefined,
    });
    return toPublicUser(updated);
  }

  // --- internals -----------------------------------------------------------

  private issueTokens(user: DriverUser): TokenPair {
    const accessToken = this.sign(user.id, 'access', this.config.accessTokenTtlSeconds);
    const refreshToken = this.sign(
      user.id,
      'refresh',
      this.config.refreshTokenTtlSeconds,
    );
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.config.accessTokenTtlSeconds,
    };
  }

  private issueMfaChallenge(user: DriverUser): string {
    return this.sign(user.id, 'mfa_challenge', this.config.mfaChallengeTtlSeconds);
  }

  private sign(sub: string, typ: SessionTokenType, ttl: number): string {
    return signJwt(
      { sub, typ },
      {
        secret: this.config.jwtSecret,
        issuer: this.config.issuer,
        expiresInSeconds: ttl,
      },
    );
  }

  private verifyTyped(token: string, expected: SessionTokenType): JwtClaims {
    let claims: JwtClaims;
    try {
      claims = verifyJwt(token, {
        secret: this.config.jwtSecret,
        issuer: this.config.issuer,
      });
    } catch (err) {
      const reason = err instanceof TokenError ? err.message : 'Invalid token';
      throw new AuthError(reason, 'invalid_token', 401);
    }
    if (claims.typ !== expected) {
      throw new AuthError(
        `Expected a ${expected} token`,
        'invalid_token',
        401,
      );
    }
    return claims;
  }

  private async requireUser(id: string): Promise<DriverUser> {
    const user = await this.store.findById(id);
    if (!user) {
      throw new AuthError('Account no longer exists', 'user_not_found', 401);
    }
    return user;
  }
}

/**
 * A precomputed scrypt hash of a random value, used to equalize timing for the
 * "user does not exist" branch of login. It never matches a real password.
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'x'.repeat(88);
