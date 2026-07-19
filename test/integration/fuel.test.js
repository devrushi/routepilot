// Run against a real database: set TEST_DATABASE_URL, apply migrations
// with `npm run migrate -- --test`, then `npm run test:integration`.

import assert from 'node:assert/strict';
import { createFuelLogger, createPostgresFuelRepo } from '../../src/fuel.js';
import { integrationTest, resetTables } from './_helpers.js';

const TABLES = ['fuel_logs'];

function makeLogger(nowRef, sql) {
  return createFuelLogger({ now: () => nowRef.value, repo: createPostgresFuelRepo(sql) });
}

integrationTest('logFuelPurchase and logChargingSession persist through Postgres', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const logger = makeLogger(nowRef, sql);

  const fuel = await logger.logFuelPurchase('drv_1', { amount: 50, currency: 'gbp', volume: 40, unit: 'liters' });
  assert.equal(fuel.amountBase, 63.5);

  const charging = await logger.logChargingSession('drv_1', { cost: 20, currency: 'EUR', kWh: 45 });
  assert.equal(charging.costBase, 21.6);

  const all = await logger.list('drv_1');
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((r) => r.id).sort(), [fuel.id, charging.id].sort());

  const fuelOnly = await logger.list('drv_1', { type: 'fuel' });
  assert.equal(fuelOnly.length, 1);
  assert.equal(fuelOnly[0].id, fuel.id);
});

integrationTest('get retrieves a single logged record by id', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const logger = makeLogger(nowRef, sql);

  const record = await logger.logFuelPurchase('drv_1', { amount: 10, currency: 'USD', volume: 5, unit: 'gallon' });
  const fetched = await logger.get('drv_1', record.id);
  assert.equal(fetched.volumeLiters, record.volumeLiters);
  assert.equal(await logger.get('drv_1', 'nope'), null);
});
