import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager } from '../src/session.js';
import { createAuthService } from '../src/auth.js';
import { generateTOTP } from '../src/totp.js';

function makeService(nowRef) {
  const sessionManager = createSessionManager({
    accessSecret: 'access-secret',
    refreshSecret: 'refresh-secret',
    now: () => nowRef.value,
  });
  const auth = createAuthService({
    sessionManager,
    challengeSecret: 'challenge-secret',
    now: () => nowRef.value,
  });
  return { auth, sessionManager };
}

test('register + login without MFA yields a session', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth, sessionManager } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  assert.equal(user.mfaEnabled, false);

  const result = await auth.login('driver.jane', 'hunter2hunter2');
  assert.equal(result.status, 'authenticated');
  assert.ok(result.tokens.accessToken);
  assert.equal((await sessionManager.verifyAccess(result.tokens.accessToken)).sub, user.id);
});

test('login rejects a wrong password with a uniform error', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  await auth.register('driver.jane', 'hunter2hunter2');
  await assert.rejects(() => auth.login('driver.jane', 'wrong'), (e) => e.code === 'AUTH_INVALID_CREDENTIALS');
  await assert.rejects(() => auth.login('ghost', 'whatever'), (e) => e.code === 'AUTH_INVALID_CREDENTIALS');
});

test('duplicate usernames and weak passwords are rejected', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  await auth.register('driver.jane', 'hunter2hunter2');
  await assert.rejects(() => auth.register('driver.jane', 'anotherpass'), (e) => e.code === 'AUTH_USER_EXISTS');
  await assert.rejects(() => auth.register('bob', 'short'), (e) => e.code === 'AUTH_WEAK_PASSWORD');
});

test('MFA enrollment: begin returns a secret + otpauth URI, confirm enables it', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');

  const { secret, otpauthUri } = await auth.beginMfaEnrollment(user.id);
  assert.match(secret, /^[A-Z2-7]+$/);
  assert.ok(otpauthUri.startsWith('otpauth://totp/RoutePilot:driver.jane?'));

  // wrong code fails to confirm
  await assert.rejects(() => auth.confirmMfaEnrollment(user.id, '000000'), (e) => e.code === 'AUTH_INVALID_MFA_CODE');

  const code = generateTOTP(secret, { now: nowRef.value });
  const { recoveryCodes } = await auth.confirmMfaEnrollment(user.id, code);
  assert.equal(recoveryCodes.length, 10);

  const stored = await auth.userStore.findById(user.id);
  assert.equal(stored.mfa.enabled, true);
});

test('with MFA enabled, login becomes a two-step challenge flow', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth, sessionManager } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const { secret } = await auth.beginMfaEnrollment(user.id);
  await auth.confirmMfaEnrollment(user.id, generateTOTP(secret, { now: nowRef.value }));

  const step1 = await auth.login('driver.jane', 'hunter2hunter2');
  assert.equal(step1.status, 'mfa_required');
  assert.ok(step1.mfaToken);
  assert.equal(step1.tokens, undefined);

  await assert.rejects(() => auth.verifyMfa(step1.mfaToken, '000000'), (e) => e.code === 'AUTH_INVALID_MFA_CODE');

  const code = generateTOTP(secret, { now: nowRef.value });
  const step2 = await auth.verifyMfa(step1.mfaToken, code);
  assert.equal(step2.status, 'authenticated');
  assert.equal((await sessionManager.verifyAccess(step2.tokens.accessToken)).sub, user.id);
});

test('an expired MFA challenge token is rejected', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const { secret } = await auth.beginMfaEnrollment(user.id);
  await auth.confirmMfaEnrollment(user.id, generateTOTP(secret, { now: nowRef.value }));

  const step1 = await auth.login('driver.jane', 'hunter2hunter2');
  nowRef.value += 6 * 60 * 1000; // past the 5-minute challenge TTL
  const code = generateTOTP(secret, { now: nowRef.value });
  await assert.rejects(() => auth.verifyMfa(step1.mfaToken, code), (e) => e.code === 'AUTH_CHALLENGE_INVALID');
});

test('recovery codes work once as a fallback', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const { secret } = await auth.beginMfaEnrollment(user.id);
  const { recoveryCodes } = await auth.confirmMfaEnrollment(user.id, generateTOTP(secret, { now: nowRef.value }));

  const step1 = await auth.login('driver.jane', 'hunter2hunter2');
  const recovery = recoveryCodes[0];
  const result = await auth.verifyMfa(step1.mfaToken, recovery);
  assert.equal(result.status, 'authenticated');
  assert.equal(result.usedRecoveryCode, true);

  // the same recovery code cannot be reused
  const step1b = await auth.login('driver.jane', 'hunter2hunter2');
  await assert.rejects(() => auth.verifyMfa(step1b.mfaToken, recovery), (e) => e.code === 'AUTH_INVALID_MFA_CODE');
});

test('disableMfa reverts login to a single step', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const { secret } = await auth.beginMfaEnrollment(user.id);
  await auth.confirmMfaEnrollment(user.id, generateTOTP(secret, { now: nowRef.value }));

  await assert.rejects(() => auth.disableMfa(user.id, '000000'), (e) => e.code === 'AUTH_INVALID_MFA_CODE');
  const disabled = await auth.disableMfa(user.id, generateTOTP(secret, { now: nowRef.value }));
  assert.equal(disabled.mfaEnabled, false);

  const login = await auth.login('driver.jane', 'hunter2hunter2');
  assert.equal(login.status, 'authenticated');
});

test('end-to-end: register -> enroll -> login(mfa) -> refresh -> logout', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth, sessionManager } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const { secret } = await auth.beginMfaEnrollment(user.id);
  await auth.confirmMfaEnrollment(user.id, generateTOTP(secret, { now: nowRef.value }));

  const step1 = await auth.login('driver.jane', 'hunter2hunter2');
  const { tokens } = await auth.verifyMfa(step1.mfaToken, generateTOTP(secret, { now: nowRef.value }));

  const rotated = await auth.refresh(tokens.refreshToken);
  assert.equal((await sessionManager.verifyAccess(rotated.accessToken)).sub, user.id);

  assert.equal(await auth.logout(rotated.accessToken), true);
  await assert.rejects(() => sessionManager.verifyAccess(rotated.accessToken), (e) => e.code === 'SESSION_REVOKED');
});
