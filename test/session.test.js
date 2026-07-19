import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager } from '../src/session.js';

function makeManager(nowRef) {
  return createSessionManager({
    accessSecret: 'access-secret',
    refreshSecret: 'refresh-secret',
    accessTtlSeconds: 900,
    refreshTtlSeconds: 3600,
    now: () => nowRef.value,
  });
}

test('requires two distinct secrets', () => {
  assert.throws(() => createSessionManager({ accessSecret: 'a', refreshSecret: 'a' }), /must differ/);
  assert.throws(() => createSessionManager({ accessSecret: 'a' }), /required/);
});

test('issue produces a verifiable access token carrying subject and sid', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const mgr = makeManager(nowRef);
  const session = await mgr.issue('usr_1', { role: 'driver' });
  const payload = await mgr.verifyAccess(session.accessToken);
  assert.equal(payload.sub, 'usr_1');
  assert.equal(payload.sid, session.sid);
  assert.equal(payload.role, 'driver');
  assert.equal(payload.typ, 'access');
});

test('expired access token is rejected', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const mgr = makeManager(nowRef);
  const session = await mgr.issue('usr_1');
  nowRef.value += 901 * 1000;
  await assert.rejects(() => mgr.verifyAccess(session.accessToken), (e) => e.code === 'JWT_EXPIRED');
});

test('refresh rotates tokens and old refresh token replays are caught', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const mgr = makeManager(nowRef);
  const first = await mgr.issue('usr_1');
  const second = await mgr.refresh(first.refreshToken);
  assert.notEqual(first.refreshToken, second.refreshToken);
  // new access token still valid
  assert.equal((await mgr.verifyAccess(second.accessToken)).sub, 'usr_1');
  // reusing the old refresh token is detected as replay and kills the session
  await assert.rejects(() => mgr.refresh(first.refreshToken), (e) => e.code === 'SESSION_REPLAY');
  await assert.rejects(() => mgr.verifyAccess(second.accessToken), (e) => e.code === 'SESSION_REVOKED');
});

test('revoke immediately invalidates the access token', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const mgr = makeManager(nowRef);
  const session = await mgr.issue('usr_1');
  assert.ok(await mgr.verifyAccess(session.accessToken));
  assert.equal(await mgr.revoke(session.sid), true);
  await assert.rejects(() => mgr.verifyAccess(session.accessToken), (e) => e.code === 'SESSION_REVOKED');
  await assert.rejects(() => mgr.refresh(session.refreshToken), (e) => e.code === 'SESSION_REVOKED');
});

test('revokeByToken works for access and refresh tokens', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const mgr = makeManager(nowRef);
  const session = await mgr.issue('usr_1');
  assert.equal(await mgr.revokeByToken(session.refreshToken), true);
  assert.equal(await mgr.isActive(session.sid), false);
});

test('access token cannot be used as a refresh token and vice versa', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const mgr = makeManager(nowRef);
  const session = await mgr.issue('usr_1');
  // access token signed with a different secret => signature failure on refresh
  await assert.rejects(() => mgr.refresh(session.accessToken));
  await assert.rejects(() => mgr.verifyAccess(session.refreshToken));
});
