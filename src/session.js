// JWT-based session handling for RoutePilot.
//
// A session issues a short-lived access token and a longer-lived refresh
// token, both signed JWTs. Refresh tokens are rotated on every use and tied
// to a single-use `jti` recorded in a session store, so a stolen/replayed
// refresh token is detected and the whole session can be revoked. Access
// tokens are stateless but carry a `sid` that is checked against the store's
// revocation flag, giving immediate logout.
//
// Storage is a `repo`: `{ insert, findBySid, update }`, async so it can be
// backed by Postgres in production (createPostgresSessionRepo) or an
// in-memory Map in tests/local dev (createInMemorySessionRepo, the
// default) — same pattern as auth.js's createInMemoryUserStore. Both repos
// return copies, never live references, so a caller MUST call `update()` to
// persist a mutation — this keeps the two implementations behaviorally
// identical rather than letting the in-memory one accidentally auto-persist
// via reference mutation.

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

/** In-memory session repo (default) — Map-backed, async interface. */
export function createInMemorySessionRepo() {
  const sessions = new Map();
  return {
    async insert(session) {
      sessions.set(session.sid, { ...session });
    },
    async findBySid(sid) {
      const session = sessions.get(sid);
      return session ? { ...session } : null;
    },
    async update(session) {
      sessions.set(session.sid, { ...session });
    },
  };
}

/**
 * Postgres-backed session repo. Expects a `sessions` table
 * (see db/migrations) with columns `sid, subject, refresh_jti, revoked,
 * created_at`.
 * @param {import('@neondatabase/serverless').NeonQueryFunction<false,false>} sql
 */
export function createPostgresSessionRepo(sql) {
  function fromRow(row) {
    return {
      sid: row.sid,
      subject: row.subject,
      refreshJti: row.refresh_jti,
      revoked: row.revoked,
      createdAt: Number(row.created_at),
    };
  }
  return {
    async insert(session) {
      await sql`
        INSERT INTO sessions (sid, subject, refresh_jti, revoked, created_at)
        VALUES (${session.sid}, ${session.subject}, ${session.refreshJti}, ${session.revoked}, ${session.createdAt})
      `;
    },
    async findBySid(sid) {
      const rows = await sql`
        SELECT sid, subject, refresh_jti, revoked, created_at FROM sessions WHERE sid = ${sid} LIMIT 1
      `;
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async update(session) {
      await sql`
        UPDATE sessions SET refresh_jti = ${session.refreshJti}, revoked = ${session.revoked}
        WHERE sid = ${session.sid}
      `;
    },
  };
}

/**
 * Create a session manager.
 * @param {object} config
 * @param {string|Buffer} config.accessSecret Signing key for access tokens.
 * @param {string|Buffer} config.refreshSecret Signing key for refresh tokens.
 * @param {number} [config.accessTtlSeconds=900] Access token lifetime (15 min).
 * @param {number} [config.refreshTtlSeconds=2592000] Refresh lifetime (30 days).
 * @param {string} [config.issuer='routepilot'] `iss` claim.
 * @param {{insert:Function, findBySid:Function, update:Function}} [config.repo] Session repo (defaults to an in-memory one).
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 */
export function createSessionManager(config = {}) {
  const {
    accessSecret,
    refreshSecret,
    accessTtlSeconds = 15 * 60,
    refreshTtlSeconds = 30 * 24 * 60 * 60,
    issuer = 'routepilot',
    repo = createInMemorySessionRepo(),
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
   * @returns {Promise<object>} Token pair + metadata.
   */
  async function issue(subject, extraClaims = {}) {
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
    await repo.insert(session);
    return mint(session, extraClaims);
  }

  /**
   * Verify an access token and ensure its session is still active.
   * @param {string} token
   * @returns {Promise<object>} Verified access-token payload.
   * @throws {SessionError}
   */
  async function verifyAccess(token) {
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
    const session = await repo.findBySid(payload.sid);
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
   * @returns {Promise<object>} New token pair.
   * @throws {SessionError}
   */
  async function refresh(token, extraClaims = {}) {
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
    const session = await repo.findBySid(payload.sid);
    if (!session || session.revoked) {
      throw new SessionError('Session has been revoked', 'SESSION_REVOKED');
    }
    if (payload.jti !== session.refreshJti) {
      // A valid signature but stale jti means this token was already rotated
      // out — a replay. Kill the session defensively.
      session.revoked = true;
      await repo.update(session);
      throw new SessionError('Refresh token reuse detected', 'SESSION_REPLAY');
    }
    session.refreshJti = randomUUID();
    await repo.update(session);
    return mint(session, extraClaims);
  }

  /**
   * Revoke a session by its id (logout).
   * @param {string} sid
   * @returns {Promise<boolean>} Whether a session was found and revoked.
   */
  async function revoke(sid) {
    const session = await repo.findBySid(sid);
    if (!session) return false;
    session.revoked = true;
    await repo.update(session);
    return true;
  }

  /**
   * Revoke the session that owns a given (access or refresh) token, without
   * requiring the token to be unexpired.
   * @param {string} token
   * @returns {Promise<boolean>}
   */
  async function revokeByToken(token) {
    try {
      const parts = token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      return payload.sid ? await revoke(payload.sid) : false;
    } catch {
      return false;
    }
  }

  async function isActive(sid) {
    const session = await repo.findBySid(sid);
    return Boolean(session && !session.revoked);
  }

  return { issue, verifyAccess, refresh, revoke, revokeByToken, isActive, repo };
}
