// HTTP server entry point for RoutePilot.
//
// Built on Node's built-in `http` module rather than a framework — the repo
// had zero dependencies before this ticket, so a small hand-rolled router
// keeps that true. If routes grow enough to need real path params,
// middleware chains, etc., swap this for Express then.

import { createServer as createHttpServer } from 'node:http';
import { createSessionManager } from './session.js';
import { createAuthService, AuthError } from './auth.js';
import { bucketWeeklyProfit, renderWeeklyProfitChartSvg, AnalyticsError } from './analytics.js';

export const DEFAULT_PORT = 3000;

// Maps AuthError codes onto HTTP status codes. Codes not listed here (e.g.
// unexpected AuthError variants) fall back to 400 — they're all client-input
// problems, never server faults.
const AUTH_ERROR_STATUS = {
  AUTH_USERNAME: 400,
  AUTH_WEAK_PASSWORD: 400,
  AUTH_USER_EXISTS: 409,
  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_CHALLENGE_INVALID: 401,
  AUTH_CHALLENGE_REPLAY: 401,
  AUTH_MFA_NOT_ENABLED: 400,
  AUTH_INVALID_MFA_CODE: 401,
  AUTH_USER_NOT_FOUND: 404,
};

/**
 * Create (but do not start) the RoutePilot HTTP server.
 * @param {object} [config]
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 * @param {ReturnType<import('./session.js').createSessionManager>} [config.sessionManager]
 * @param {ReturnType<import('./auth.js').createAuthService>} [config.authService]
 * @returns {import('node:http').Server}
 */
export function createServer(config = {}) {
  const {
    now = () => Date.now(),
    // Dev-only fallback secrets so the server is runnable out of the box.
    // Set SESSION_ACCESS_SECRET / SESSION_REFRESH_SECRET / AUTH_CHALLENGE_SECRET
    // in any real deployment.
    sessionManager = createSessionManager({
      accessSecret: process.env.SESSION_ACCESS_SECRET || 'dev-only-access-secret-change-me',
      refreshSecret: process.env.SESSION_REFRESH_SECRET || 'dev-only-refresh-secret-change-me',
      now,
    }),
    authService = createAuthService({
      sessionManager,
      challengeSecret: process.env.AUTH_CHALLENGE_SECRET || 'dev-only-challenge-secret-change-me',
      now,
    }),
  } = config;

  return createHttpServer(requestListener({ now, sessionManager, authService }));
}

function requestListener({ now, sessionManager, authService }) {
  return async function handleRequest(req, res) {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const { method } = req;

      if (method === 'GET' && pathname === '/health') {
        sendJson(res, 200, { status: 'ok', timestamp: new Date(now()).toISOString() });
        return;
      }

      if (method === 'POST' && pathname === '/register') {
        const { username, password } = await readJsonBody(req);
        const user = await authService.register(username, password);
        sendJson(res, 201, { user });
        return;
      }

      if (method === 'POST' && pathname === '/login') {
        const { username, password } = await readJsonBody(req);
        const result = await authService.login(username, password);
        if (result.status === 'mfa_required') {
          sendJson(res, 200, { status: 'mfa_required', mfaToken: result.mfaToken });
        } else {
          sendJson(res, 200, { status: 'authenticated', user: result.user, tokens: result.tokens });
        }
        return;
      }

      if (method === 'POST' && pathname === '/login/verify-totp') {
        const { mfaToken, code } = await readJsonBody(req);
        const result = await authService.verifyMfa(mfaToken, code);
        sendJson(res, 200, { status: 'authenticated', user: result.user, tokens: result.tokens });
        return;
      }

      if (method === 'GET' && pathname === '/dashboard') {
        await handleDashboard(req, res, { sessionManager, authService });
        return;
      }

      if (method === 'POST' && pathname === '/dashboard/weekly-profit') {
        await handleWeeklyProfit(req, res, { sessionManager });
        return;
      }

      sendJson(res, 404, { error: 'Not Found' });
    } catch (err) {
      handleError(res, err);
    }
  };
}

// Verifies the request's bearer token, sending a 401 itself on
// missing/invalid tokens. Returns the access-token payload, or `null` (the
// caller should just return — the response is already sent).
function requireSession(req, res, sessionManager) {
  const token = bearerToken(req);
  if (!token) {
    sendJson(res, 401, { error: 'Missing session token' });
    return null;
  }
  try {
    return sessionManager.verifyAccess(token);
  } catch {
    sendJson(res, 401, { error: 'Invalid or expired session' });
    return null;
  }
}

async function handleDashboard(req, res, { sessionManager, authService }) {
  const payload = requireSession(req, res, sessionManager);
  if (!payload) return;

  const user = await authService.userStore.findById(payload.sub);
  if (!user) {
    sendJson(res, 401, { error: 'Invalid or expired session' });
    return;
  }

  sendJson(res, 200, { profile: buildProfile(user) });
}

// Accepts { earnings, expenses } (each `[{ at, amount }]`) and returns the
// weekly gross/net buckets plus a rendered SVG chart. Earnings/expenses
// aren't persisted anywhere yet in this repo, so the caller supplies them
// directly rather than this route looking them up itself.
async function handleWeeklyProfit(req, res, { sessionManager }) {
  const payload = requireSession(req, res, sessionManager);
  if (!payload) return;

  const { earnings = [], expenses = [] } = await readJsonBody(req);
  const buckets = bucketWeeklyProfit({ earnings, expenses });
  const svg = renderWeeklyProfitChartSvg(buckets);
  sendJson(res, 200, { buckets, svg });
}

function buildProfile(user) {
  return {
    id: user.id,
    username: user.username,
    mfaEnabled: user.mfa.enabled,
    biometricEnrolled: Boolean(user.biometrics && user.biometrics.credentials.length > 0),
    createdAt: new Date(user.createdAt).toISOString(),
  };
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new BodyError('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new BodyError('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

class BodyError extends Error {}

function handleError(res, err) {
  if (err instanceof AuthError) {
    sendJson(res, AUTH_ERROR_STATUS[err.code] ?? 400, { error: err.message, code: err.code });
    return;
  }
  if (err instanceof BodyError || err instanceof AnalyticsError) {
    sendJson(res, 400, { error: err.message });
    return;
  }
  console.error(err);
  sendJson(res, 500, { error: 'Internal Server Error' });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const server = createServer();
  server.listen(port, () => {
    console.log(`RoutePilot server listening on port ${port}`);
  });
}
