import { AuthError } from '../auth.js';
import { sendJson, readJsonBody, registerErrorStatuses } from '../http-utils.js';

// Codes not listed here (e.g. unexpected AuthError variants) fall back to
// 400 — they're all client-input problems, never server faults.
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

export function registerAuthRoutes(router, { authService }) {
  registerErrorStatuses(AuthError, AUTH_ERROR_STATUS);

  router.post('/register', async (req, res) => {
    const { username, password } = await readJsonBody(req);
    const user = await authService.register(username, password);
    sendJson(res, 201, { user });
  });

  router.post('/login', async (req, res) => {
    const { username, password } = await readJsonBody(req);
    const result = await authService.login(username, password);
    if (result.status === 'mfa_required') {
      sendJson(res, 200, { status: 'mfa_required', mfaToken: result.mfaToken });
    } else {
      sendJson(res, 200, { status: 'authenticated', user: result.user, tokens: result.tokens });
    }
  });

  router.post('/login/verify-totp', async (req, res) => {
    const { mfaToken, code } = await readJsonBody(req);
    const result = await authService.verifyMfa(mfaToken, code);
    sendJson(res, 200, { status: 'authenticated', user: result.user, tokens: result.tokens });
  });
}
