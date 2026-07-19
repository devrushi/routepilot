// Run against a real database: set TEST_DATABASE_URL, apply migrations
// with `npm run migrate -- --test`, then `npm run test:integration`.

import assert from 'node:assert/strict';
import { createRouteCostTracker, createPostgresRouteCostRepo } from '../../src/cost-anomaly.js';
import { integrationTest, resetTables } from './_helpers.js';

const TABLES = ['route_cost_history'];
const HISTORY = [50, 52, 48, 51, 49, 53, 47]; // mean 50, population stddev 2

function makeTracker(sql) {
  return createRouteCostTracker({ repo: createPostgresRouteCostRepo(sql) });
}

integrationTest('recordCost persists history and checkCost flags an outlier through Postgres', async (t, sql) => {
  await resetTables(sql, TABLES);
  const tracker = makeTracker(sql);

  for (const cost of HISTORY) {
    await tracker.recordCost('drv_1', 'downtown-loop', cost);
  }
  assert.deepEqual(await tracker.history('drv_1', 'downtown-loop'), HISTORY);

  const normal = await tracker.checkCost('drv_1', 'downtown-loop', 51);
  assert.equal(normal.isAnomaly, false);

  const outlier = await tracker.checkCost('drv_1', 'downtown-loop', 200);
  assert.equal(outlier.isAnomaly, true);
});

integrationTest('route history is isolated per driver and per route through Postgres', async (t, sql) => {
  await resetTables(sql, TABLES);
  const tracker = makeTracker(sql);

  await tracker.recordCost('drv_1', 'route-a', 50);
  await tracker.recordCost('drv_2', 'route-a', 999);
  await tracker.recordCost('drv_1', 'route-b', 10);

  assert.deepEqual(await tracker.history('drv_1', 'route-a'), [50]);
  assert.deepEqual(await tracker.history('drv_2', 'route-a'), [999]);
  assert.deepEqual(await tracker.history('drv_1', 'route-b'), [10]);
});
