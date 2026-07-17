// Authentication service for RoutePilot driver onboarding.
//
// Ties password authentication together with JWT session issuance and an
// OPTIONAL TOTP MFA layer. MFA is per-user and off by default; drivers can
// enroll an authenticator app, and once enabled login becomes a two-step
// flow: password -> short-lived MFA challenge token -> TOTP (or recovery
// code) -> session. Recovery codes are single-use fallbacks stored hashed.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { base32Encode } from './encoding.js';
import { hashPassword, verifyPassword } from './password.js';
import { JwtError, signJwt, verifyJwt } from './jwt.js';
import { generateSecret, keyUri, verifyTOTP } from './totp.js';

const MFA_CHALLENGE_TYP = 'mfa_challenge';

export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/** Default in-memory user store. Swap for a real DB adapter in production. */
export function createInMemoryUserStore() {
  const byId = new Map();
  const byUsername = new Map();
  return {
    async findById(id) {
      return byId.get(id) ?? null;
    },
    async findByUsername(username) {
      const id = byUsername.get(username.toLowerCase());
      return id ? byId.get(id) ?? null : null;
    },
    async save(user) {
      byId.set(user.id, user);
      byUsername.set(user.username.toLowerCase(), user.id);
      return user;
    },
  };
}

function hashRecoveryCode(code) {
  return createHash('sha256').update(code).digest('hex');
}

function sanitize(user) {
  return {
    id: user.id,
    username: user.username,
    mfaEnabled: user.mfa.enabled,
  };
}

/**
 * Create the auth service.
 * @param {object} config
 * @param {ReturnType<import('./session.js').createSessionManager>} config.sessionManager
 * @param {object} [config.userStore] User store adapter.
 * @param {string|Buffer} config.challengeSecret Signing key for MFA challenge tokens.
 * @param {string} [config.issuer='RoutePilot'] Label shown in authenticator apps.
 * @param {number} [config.challengeTtlSeconds=300] MFA challenge lifetime.
 * @param {number} [config.totpWindow=1] Allowed TOTP step drift.
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 */
export function createAuthService(config = {}) {
  const {
    sessionManager,
    userStore = createInMemoryUserStore(),
    challengeSecret,
    issuer = 'RoutePilot',
    challengeTtlSeconds = 5 * 60,
    totpWindow = 1,
    now = () => Date.now(),
  } = config;

  if (!sessionManager) {
    throw new AuthError('A sessionManager is required', 'AUTH_CONFIG');
  }
  if (!challengeSecret) {
    throw new AuthError('A challengeSecret is required', 'AUTH_CONFIG');
  }

  function nowSeconds() {
    return Math.floor(now() / 1000);
  }

  function newUserId() {
    return `usr_${base32Encode(randomBytes(10)).toLowerCase()}`;
  }

  /**
   * Register a new driver account.
   * @returns {Promise<object>} Sanitized user (no secrets).
   */
  async function register(username, password) {
    if (!username || typeof username !== 'string') {
      throw new AuthError('A username is required', 'AUTH_USERNAME');
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw new AuthError('Password must be at least 8 characters', 'AUTH_WEAK_PASSWORD');
    }
    if (await userStore.findByUsername(username)) {
      throw new AuthError('Username is already taken', 'AUTH_USER_EXISTS');
    }
    const user = {
      id: newUserId(),
      username,
      passwordHash: await hashPassword(password),
      mfa: { enabled: false, secret: null, pendingSecret: null, recoveryCodes: [] },
      createdAt: now(),
    };
    await userStore.save(user);
    return sanitize(user);
  }

  function issueChallenge(user) {
    return signJwt(
      { sub: user.id, typ: MFA_CHALLENGE_TYP },
      challengeSecret,
      { now: nowSeconds(), expiresInSeconds: challengeTtlSeconds },
    );
  }

  /**
   * Step 1 of login: verify the password.
   * @returns {Promise<{status:string, tokens?:object, mfaToken?:string, user?:object}>}
   *   status is 'authenticated' (no MFA) or 'mfa_required'.
   */
  async function login(username, password, extraClaims = {}) {
    const user = await userStore.findByUsername(username ?? '');
    // Verify against a dummy hash on the miss path is overkill here; we still
    // avoid leaking which half failed via a uniform error.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new AuthError('Invalid username or password', 'AUTH_INVALID_CREDENTIALS');
    }
    if (user.mfa.enabled) {
      return { status: 'mfa_required', mfaToken: issueChallenge(user) };
    }
    return {
      status: 'authenticated',
      user: sanitize(user),
      tokens: sessionManager.issue(user.id, extraClaims),
    };
  }

  /**
   * Step 2 of login (only when MFA is enabled): verify a TOTP code or a
   * single-use recovery code against the challenge token.
   * @returns {Promise<{status:string, tokens:object, user:object, usedRecoveryCode?:boolean}>}
   */
  async function verifyMfa(mfaToken, code, extraClaims = {}) {
    let payload;
    try {
      payload = verifyJwt(mfaToken, challengeSecret, { now: nowSeconds() });
    } catch (err) {
      if (err instanceof JwtError) {
        throw new AuthError('MFA challenge is invalid or expired', 'AUTH_CHALLENGE_INVALID');
      }
      throw err;
    }
    if (payload.typ !== MFA_CHALLENGE_TYP) {
      throw new AuthError('Not an MFA challenge token', 'AUTH_CHALLENGE_INVALID');
    }
    const user = await userStore.findById(payload.sub);
    if (!user || !user.mfa.enabled || !user.mfa.secret) {
      throw new AuthError('MFA is not enabled for this account', 'AUTH_MFA_NOT_ENABLED');
    }

    if (verifyTOTP(user.mfa.secret, code ?? '', { now: now(), window: totpWindow }).valid) {
      return {
        status: 'authenticated',
        user: sanitize(user),
        tokens: sessionManager.issue(user.id, extraClaims),
      };
    }

    // Fall back to recovery codes (constant-time compare, single use).
    if (typeof code === 'string' && code.length > 0) {
      const provided = hashRecoveryCode(code.trim());
      const providedBuf = Buffer.from(provided);
      const idx = user.mfa.recoveryCodes.findIndex((stored) => {
        const storedBuf = Buffer.from(stored);
        return storedBuf.length === providedBuf.length && timingSafeEqual(storedBuf, providedBuf);
      });
      if (idx !== -1) {
        user.mfa.recoveryCodes.splice(idx, 1);
        await userStore.save(user);
        return {
          status: 'authenticated',
          user: sanitize(user),
          usedRecoveryCode: true,
          tokens: sessionManager.issue(user.id, extraClaims),
        };
      }
    }

    throw new AuthError('Invalid MFA code', 'AUTH_INVALID_MFA_CODE');
  }

  /**
   * Begin TOTP enrollment: generate a pending secret and provisioning URI.
   * Enrollment is not active until confirmMfaEnrollment succeeds.
   * @returns {Promise<{secret:string, otpauthUri:string}>}
   */
  async function beginMfaEnrollment(userId) {
    const user = await userStore.findById(userId);
    if (!user) throw new AuthError('User not found', 'AUTH_USER_NOT_FOUND');
    if (user.mfa.enabled) {
      throw new AuthError('MFA is already enabled', 'AUTH_MFA_ALREADY_ENABLED');
    }
    const secret = generateSecret();
    user.mfa.pendingSecret = secret;
    await userStore.save(user);
    return {
      secret,
      otpauthUri: keyUri({ secret, accountName: user.username, issuer }),
    };
  }

  /**
   * Confirm TOTP enrollment with a code from the authenticator app. On success
   * MFA is enabled and one-time recovery codes are returned (shown once).
   * @returns {Promise<{recoveryCodes:string[]}>}
   */
  async function confirmMfaEnrollment(userId, code, { recoveryCodeCount = 10 } = {}) {
    const user = await userStore.findById(userId);
    if (!user) throw new AuthError('User not found', 'AUTH_USER_NOT_FOUND');
    if (!user.mfa.pendingSecret) {
      throw new AuthError('No pending MFA enrollment', 'AUTH_NO_PENDING_MFA');
    }
    if (!verifyTOTP(user.mfa.pendingSecret, code ?? '', { now: now(), window: totpWindow }).valid) {
      throw new AuthError('Invalid MFA code', 'AUTH_INVALID_MFA_CODE');
    }
    const recoveryCodes = Array.from({ length: recoveryCodeCount }, () =>
      base32Encode(randomBytes(10)).toLowerCase().replace(/(.{5})(.{5})(.{5})(.*)/, '$1-$2-$3-$4'),
    );
    user.mfa.secret = user.mfa.pendingSecret;
    user.mfa.pendingSecret = null;
    user.mfa.enabled = true;
    user.mfa.recoveryCodes = recoveryCodes.map(hashRecoveryCode);
    await userStore.save(user);
    return { recoveryCodes };
  }

  /**
   * Disable MFA for a user after verifying a current TOTP or recovery code.
   * @returns {Promise<object>} Sanitized user.
   */
  async function disableMfa(userId, code) {
    const user = await userStore.findById(userId);
    if (!user) throw new AuthError('User not found', 'AUTH_USER_NOT_FOUND');
    if (!user.mfa.enabled) {
      throw new AuthError('MFA is not enabled', 'AUTH_MFA_NOT_ENABLED');
    }
    const totpOk = verifyTOTP(user.mfa.secret, code ?? '', { now: now(), window: totpWindow }).valid;
    let recoveryOk = false;
    if (!totpOk && typeof code === 'string' && code.length > 0) {
      const provided = hashRecoveryCode(code.trim());
      recoveryOk = user.mfa.recoveryCodes.includes(provided);
    }
    if (!totpOk && !recoveryOk) {
      throw new AuthError('Invalid MFA code', 'AUTH_INVALID_MFA_CODE');
    }
    user.mfa = { enabled: false, secret: null, pendingSecret: null, recoveryCodes: [] };
    await userStore.save(user);
    return sanitize(user);
  }

  /** Rotate a session's tokens. Delegates to the session manager. */
  function refresh(refreshToken, extraClaims = {}) {
    return sessionManager.refresh(refreshToken, extraClaims);
  }

  /** Log out by revoking the session behind a token. */
  function logout(token) {
    return sessionManager.revokeByToken(token);
  }

  return {
    register,
    login,
    verifyMfa,
    beginMfaEnrollment,
    confirmMfaEnrollment,
    disableMfa,
    refresh,
    logout,
    userStore,
  };
}
