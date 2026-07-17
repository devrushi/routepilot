// JWT-based session handling for RoutePilot.
//
// A session issues a short-lived access token and a longer-lived refresh
// token, both signed JWTs. Refresh tokens are rotated on every use and tied
// to a single-use `jti` recorded in a session store, so a stolen/replayed
// refresh token is detected and the whole session can be revoked. Access
// tokens are stateless but carry a `sid` that is checked against the store's
// revocation flag, giving immediate logout.

import { randomUUID } from 'node:crypto';
import { JwtError, signJwt, verifyJwt } from './jwt.js';

const ACCESS_TYP = 'access';
const REFRESH_TYP = 'refresh';

export class SessionError extends Error {
  constructor(message, code = 'SESSION_INVALID') {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}

/**
 * Create a session manager.
 * @param {object} config
 * @param {string|Buffer} config.accessSecret Signing key for access tokens.
 * @param {string|Buffer} config.refreshSecret Signing key for refresh tokens.
 * @param {number} [config.accessTtlSeconds=900] Access token lifetime (15 min).
 * @param {number} [config.refreshTtlSeconds=2592000] Refresh lifetime (30 days).
 * @param {string} [config.issuer='routepilot'] `iss` claim.
 * @param {Map} [config.store] Session record store (defaults to in-memory Map).
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 */
export function createSessionManager(config = {}) {
  const {
    accessSecret,
    refreshSecret,
    accessTtlSeconds = 15 * 60,
    refreshTtlSeconds = 30 * 24 * 60 * 60,
    issuer = 'routepilot',
    store = new Map(),
    now = () => Date.now(),
  } = config;

  if (!accessSecret || !refreshSecret) {
    throw new SessionError('accessSecret and refreshSecret are required', 'SESSION_CONFIG');
  }
  if (accessSecret === refreshSecret) {
    throw new SessionError('accessSecret and refreshSecret must differ', 'SESSION_CONFIG');
  }

  function nowSeconds() {
    return Math.floor(now() / 1000);
  }

  function mint(session, extraClaims) {
    const currentSeconds = nowSeconds();
    const accessToken = signJwt(
      { ...extraClaims, sub: session.subject, sid: session.sid, typ: ACCESS_TYP, iss: issuer },
      accessSecret,
      { now: currentSeconds, expiresInSeconds: accessTtlSeconds },
    );
    const refreshToken = signJwt(
      { sub: session.subject, sid: session.sid, jti: session.refreshJti, typ: REFRESH_TYP, iss: issuer },
      refreshSecret,
      { now: currentSeconds, expiresInSeconds: refreshTtlSeconds },
    );
    return {
      accessToken,
      refreshToken,
      sid: session.sid,
      subject: session.subject,
      accessExpiresAt: (currentSeconds + accessTtlSeconds) * 1000,
      refreshExpiresAt: (currentSeconds + refreshTtlSeconds) * 1000,
    };
  }

  /**
   * Start a new session for a subject (user id).
   * @param {string} subject
   * @param {object} [extraClaims] Extra claims embedded in the access token.
   * @returns {object} Token pair + metadata.
   */
  function issue(subject, extraClaims = {}) {
    if (!subject) {
      throw new SessionError('A subject is required to issue a session', 'SESSION_SUBJECT');
    }
    const session = {
      sid: randomUUID(),
      subject,
      refreshJti: randomUUID(),
      revoked: false,
      createdAt: now(),
    };
    store.set(session.sid, session);
    return mint(session, extraClaims);
  }

  /**
   * Verify an access token and ensure its session is still active.
   * @param {string} token
   * @returns {object} Verified access-token payload.
   * @throws {SessionError}
   */
  function verifyAccess(token) {
    let payload;
    try {
      payload = verifyJwt(token, accessSecret, { now: nowSeconds() });
    } catch (err) {
      if (err instanceof JwtError) {
        throw new SessionError(`Access token rejected: ${err.message}`, err.code);
      }
      throw err;
    }
    if (payload.typ !== ACCESS_TYP) {
      throw new SessionError('Not an access token', 'SESSION_WRONG_TYPE');
    }
    const session = store.get(payload.sid);
    if (!session || session.revoked) {
      throw new SessionError('Session has been revoked', 'SESSION_REVOKED');
    }
    return payload;
  }

  /**
   * Exchange a refresh token for a new token pair, rotating the refresh token.
   * Reusing a previously-rotated refresh token is treated as replay: the
   * session is revoked and an error is thrown.
   * @param {string} token
   * @param {object} [extraClaims]
   * @returns {object} New token pair.
   * @throws {SessionError}
   */
  function refresh(token, extraClaims = {}) {
    let payload;
    try {
      payload = verifyJwt(token, refreshSecret, { now: nowSeconds(), issuer });
    } catch (err) {
      if (err instanceof JwtError) {
        throw new SessionError(`Refresh token rejected: ${err.message}`, err.code);
      }
      throw err;
    }
    if (payload.typ !== REFRESH_TYP) {
      throw new SessionError('Not a refresh token', 'SESSION_WRONG_TYPE');
    }
    const session = store.get(payload.sid);
    if (!session || session.revoked) {
      throw new SessionError('Session has been revoked', 'SESSION_REVOKED');
    }
    if (payload.jti !== session.refreshJti) {
      // A valid signature but stale jti means this token was already rotated
      // out — a replay. Kill the session defensively.
      session.revoked = true;
      throw new SessionError('Refresh token reuse detected', 'SESSION_REPLAY');
    }
    session.refreshJti = randomUUID();
    return mint(session, extraClaims);
  }

  /**
   * Revoke a session by its id (logout).
   * @param {string} sid
   * @returns {boolean} Whether a session was found and revoked.
   */
  function revoke(sid) {
    const session = store.get(sid);
    if (!session) return false;
    session.revoked = true;
    return true;
  }

  /**
   * Revoke the session that owns a given (access or refresh) token, without
   * requiring the token to be unexpired.
   * @param {string} token
   * @returns {boolean}
   */
  function revokeByToken(token) {
    try {
      const parts = token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      return payload.sid ? revoke(payload.sid) : false;
    } catch {
      return false;
    }
  }

  function isActive(sid) {
    const session = store.get(sid);
    return Boolean(session && !session.revoked);
  }

  return { issue, verifyAccess, refresh, revoke, revokeByToken, isActive, store };
}
