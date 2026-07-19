// Run against a real database: set TEST_DATABASE_URL, apply migrations
// with `npm run migrate -- --test`, then `npm run test:integration`.
// Skips (doesn't fail) when TEST_DATABASE_URL isn't set — see _helpers.js.

import assert from 'node:assert/strict';
import { createSessionManager, createPostgresSessionRepo } from '../../src/session.js';
import { integrationTest, resetTables } from './_helpers.js';

const TABLES = ['sessions'];

function makeManager(nowRef, sql) {
  return createSessionManager({
    accessSecret: 'access-secret',
    refreshSecret: 'refresh-secret',
    accessTtlSeconds: 900,
    refreshTtlSeconds: 3600,
    now: () => nowRef.value,
    repo: createPostgresSessionRepo(sql),
  });
}

integrationTest('issue/verifyAccess/refresh/revoke round-trip through Postgres', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const mgr = makeManager(nowRef, sql);

  const first = await mgr.issue('usr_1');
  const payload = await mgr.verifyAccess(first.accessToken);
  assert.equal(payload.sub, 'usr_1');

  const second = await mgr.refresh(first.refreshToken);
  assert.notEqual(second.refreshToken, first.refreshToken);
  await assert.rejects(() => mgr.refresh(first.refreshToken), (e) => e.code === 'SESSION_REPLAY');

  assert.equal(await mgr.revoke(second.sid), true);
  await assert.rejects(() => mgr.verifyAccess(second.accessToken), (e) => e.code === 'SESSION_REVOKED');
});

integrationTest('sessions persist independently per row', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const mgr = makeManager(nowRef, sql);

  const a = await mgr.issue('usr_a');
  const b = await mgr.issue('usr_b');
  assert.equal(await mgr.isActive(a.sid), true);
  assert.equal(await mgr.isActive(b.sid), true);

  await mgr.revoke(a.sid);
  assert.equal(await mgr.isActive(a.sid), false);
  assert.equal(await mgr.isActive(b.sid), true);
});
