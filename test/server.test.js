import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { createSessionManager } from '../src/session.js';
import { createAuthService } from '../src/auth.js';
import { generateTOTP } from '../src/totp.js';

async function withServer(fn, overrides = {}) {
  const server = createServer({ now: () => 1_700_000_000_000, ...overrides });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function postJson(baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET /health returns 200 with a status payload', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.timestamp, new Date(1_700_000_000_000).toISOString());
  });
});

test('unknown routes return 404', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'Not Found');
  });
});

test('POST /register creates a new driver account', async () => {
  await withServer(async (baseUrl) => {
    const res = await postJson(baseUrl, '/register', { username: 'driver.jane', password: 'hunter2hunter2' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.user.username, 'driver.jane');
    assert.equal(body.user.mfaEnabled, false);
    assert.ok(body.user.id);
  });
});

test('POST /register rejects a duplicate username', async () => {
  await withServer(async (baseUrl) => {
    await postJson(baseUrl, '/register', { username: 'driver.jane', password: 'hunter2hunter2' });
    const res = await postJson(baseUrl, '/register', { username: 'driver.jane', password: 'anotherpass' });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'AUTH_USER_EXISTS');
  });
});

test('POST /login returns a session for correct credentials', async () => {
  await withServer(async (baseUrl) => {
    await postJson(baseUrl, '/register', { username: 'driver.jane', password: 'hunter2hunter2' });
    const res = await postJson(baseUrl, '/login', { username: 'driver.jane', password: 'hunter2hunter2' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'authenticated');
    assert.ok(body.tokens.accessToken);
    assert.equal(body.user.username, 'driver.jane');
  });
});

test('POST /login rejects a wrong password', async () => {
  await withServer(async (baseUrl) => {
    await postJson(baseUrl, '/register', { username: 'driver.jane', password: 'hunter2hunter2' });
    const res = await postJson(baseUrl, '/login', { username: 'driver.jane', password: 'wrong-password' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'AUTH_INVALID_CREDENTIALS');
  });
});

test('POST /login rejects an unknown user', async () => {
  await withServer(async (baseUrl) => {
    const res = await postJson(baseUrl, '/login', { username: 'ghost', password: 'whatever' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'AUTH_INVALID_CREDENTIALS');
  });
});

test('POST /login/verify-totp completes an MFA-protected login', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const sessionManager = createSessionManager({
    accessSecret: 'access-secret',
    refreshSecret: 'refresh-secret',
    now: () => nowRef.value,
  });
  const authService = createAuthService({
    sessionManager,
    challengeSecret: 'challenge-secret',
    now: () => nowRef.value,
  });
  const user = await authService.register('driver.jane', 'hunter2hunter2');
  const { secret } = await authService.beginMfaEnrollment(user.id);
  await authService.confirmMfaEnrollment(user.id, generateTOTP(secret, { now: nowRef.value }));

  await withServer(
    async (baseUrl) => {
      const loginRes = await postJson(baseUrl, '/login', { username: 'driver.jane', password: 'hunter2hunter2' });
      assert.equal(loginRes.status, 200);
      const loginBody = await loginRes.json();
      assert.equal(loginBody.status, 'mfa_required');
      assert.ok(loginBody.mfaToken);
      assert.equal(loginBody.tokens, undefined);

      const badRes = await postJson(baseUrl, '/login/verify-totp', { mfaToken: loginBody.mfaToken, code: '000000' });
      assert.equal(badRes.status, 401);
      assert.equal((await badRes.json()).code, 'AUTH_INVALID_MFA_CODE');

      const code = generateTOTP(secret, { now: nowRef.value });
      const verifyRes = await postJson(baseUrl, '/login/verify-totp', { mfaToken: loginBody.mfaToken, code });
      assert.equal(verifyRes.status, 200);
      const verifyBody = await verifyRes.json();
      assert.equal(verifyBody.status, 'authenticated');
      assert.ok(verifyBody.tokens.accessToken);
      assert.equal(verifyBody.user.username, 'driver.jane');
    },
    { now: () => nowRef.value, sessionManager, authService },
  );
});
