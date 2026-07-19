// Run against a real database: set TEST_DATABASE_URL, apply migrations
// with `npm run migrate -- --test`, then `npm run test:integration`.

import assert from 'node:assert/strict';
import { createShiftTracker, createPostgresShiftRepo } from '../../src/shifts.js';
import { integrationTest, resetTables } from './_helpers.js';

const TABLES = ['shifts'];

function makeTracker(nowRef, sql) {
  return createShiftTracker({ now: () => nowRef.value, repo: createPostgresShiftRepo(sql) });
}

integrationTest('start/end a shift, log a break and GPS points, persisted through Postgres', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef, sql);

  const started = await tracker.startShift('drv_1', { lat: 40.7128, long: -74.006 });
  assert.equal(started.status, 'active');

  await tracker.startBreak('drv_1');
  nowRef.value += 10 * 60 * 1000;
  await tracker.endBreak('drv_1');

  await tracker.addGpsPoint('drv_1', { lat: 40.7128, long: -74.006 });
  await tracker.addGpsPoint('drv_1', { lat: 39.9526, long: -75.1652 });

  const ended = await tracker.endShift('drv_1', { lat: 39.9526, long: -75.1652 });
  assert.equal(ended.status, 'completed');
  assert.equal(ended.breaks.length, 1);
  assert.equal(ended.breaks[0].durationMs, 10 * 60 * 1000);

  const distance = await tracker.getTripDistance('drv_1', started.id);
  assert.equal(distance.source, 'gps');
  assert.ok(distance.distanceMiles > 75 && distance.distanceMiles < 85);
});

integrationTest('only one active shift per driver is enforced across repo reads', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef, sql);

  await tracker.startShift('drv_1', { lat: 1, long: 1 });
  await assert.rejects(() => tracker.startShift('drv_1', { lat: 2, long: 2 }), (e) => e.code === 'SHIFT_ALREADY_ACTIVE');
});

integrationTest('list returns a driver\'s shifts oldest first', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef, sql);

  const first = await tracker.startShift('drv_1', { lat: 1, long: 1 });
  await tracker.endShift('drv_1', { lat: 1, long: 1 });
  nowRef.value += 1000;
  const second = await tracker.startShift('drv_1', { lat: 1, long: 1 });

  const list = await tracker.list('drv_1');
  assert.deepEqual(list.map((s) => s.id), [first.id, second.id]);
});
