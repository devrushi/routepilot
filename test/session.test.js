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

test('issue produces a verifiable access token carrying subject and sid', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const mgr = makeManager(nowRef);
  const session = mgr.issue('usr_1', { role: 'driver' });
  const payload = mgr.verifyAccess(session.accessToken);
  assert.equal(payload.sub, 'usr_1');
  assert.equal(payload.sid, session.sid);
  assert.equal(payload.role, 'driver');
  assert.equal(payload.typ, 'access');
});

test('expired access token is rejected', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const mgr = makeManager(nowRef);
  const session = mgr.issue('usr_1');
  nowRef.value += 901 * 1000;
  assert.throws(() => mgr.verifyAccess(session.accessToken), (e) => e.code === 'JWT_EXPIRED');
});

test('refresh rotates tokens and old refresh token replays are caught', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const mgr = makeManager(nowRef);
  const first = mgr.issue('usr_1');
  const second = mgr.refresh(first.refreshToken);
  assert.notEqual(first.refreshToken, second.refreshToken);
  // new access token still valid
  assert.equal(mgr.verifyAccess(second.accessToken).sub, 'usr_1');
  // reusing the old refresh token is detected as replay and kills the session
  assert.throws(() => mgr.refresh(first.refreshToken), (e) => e.code === 'SESSION_REPLAY');
  assert.throws(() => mgr.verifyAccess(second.accessToken), (e) => e.code === 'SESSION_REVOKED');
});

test('revoke immediately invalidates the access token', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const mgr = makeManager(nowRef);
  const session = mgr.issue('usr_1');
  assert.ok(mgr.verifyAccess(session.accessToken));
  assert.equal(mgr.revoke(session.sid), true);
  assert.throws(() => mgr.verifyAccess(session.accessToken), (e) => e.code === 'SESSION_REVOKED');
  assert.throws(() => mgr.refresh(session.refreshToken), (e) => e.code === 'SESSION_REVOKED');
});

test('revokeByToken works for access and refresh tokens', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const mgr = makeManager(nowRef);
  const session = mgr.issue('usr_1');
  assert.equal(mgr.revokeByToken(session.refreshToken), true);
  assert.equal(mgr.isActive(session.sid), false);
});

test('access token cannot be used as a refresh token and vice versa', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const mgr = makeManager(nowRef);
  const session = mgr.issue('usr_1');
  // access token signed with a different secret => signature failure on refresh
  assert.throws(() => mgr.refresh(session.accessToken));
  assert.throws(() => mgr.verifyAccess(session.refreshToken));
});
