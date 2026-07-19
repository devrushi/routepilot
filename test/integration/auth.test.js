// Run against a real database: set TEST_DATABASE_URL, apply migrations
// with `npm run migrate -- --test`, then `npm run test:integration`.
// Skips (doesn't fail) when TEST_DATABASE_URL isn't set — see _helpers.js.

import assert from 'node:assert/strict';
import { createAuthService, createPostgresUserRepo } from '../../src/auth.js';
import { createSessionManager } from '../../src/session.js';
import { integrationTest, resetTables } from './_helpers.js';

const TABLES = ['users'];

function makeAuthService(nowRef, sql) {
  return createAuthService({
    sessionManager: createSessionManager({
      accessSecret: 'access-secret',
      refreshSecret: 'refresh-secret',
      now: () => nowRef.value,
    }),
    challengeSecret: 'challenge-secret',
    now: () => nowRef.value,
    userStore: createPostgresUserRepo(sql),
  });
}

integrationTest('register persists a user and login authenticates against it through Postgres', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const auth = makeAuthService(nowRef, sql);

  const registered = await auth.register('DriverOne', 'correcthorsebattery');
  assert.equal(registered.username, 'DriverOne');
  assert.equal(registered.mfaEnabled, false);

  await assert.rejects(() => auth.register('driverone', 'anotherStrongPass1'), (e) => e.code === 'AUTH_USER_EXISTS');

  const result = await auth.login('driverone', 'correcthorsebattery');
  assert.equal(result.status, 'authenticated');
  assert.equal(result.user.id, registered.id);
  assert.ok(result.tokens.accessToken);
});

integrationTest('a second service instance sees users saved by the first, and MFA state round-trips', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const first = makeAuthService(nowRef, sql);

  const user = await first.register('mfauser', 'correcthorsebattery');
  const { secret } = await first.beginMfaEnrollment(user.id);

  const second = makeAuthService(nowRef, sql);
  const stored = await second.userStore.findByUsername('mfauser');
  assert.equal(stored.id, user.id);
  assert.equal(stored.mfa.pendingSecret, secret);
});
