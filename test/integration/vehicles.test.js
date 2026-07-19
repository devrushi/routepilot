// Run against a real database: set TEST_DATABASE_URL, apply migrations
// with `npm run migrate -- --test`, then `npm run test:integration`.

import assert from 'node:assert/strict';
import { createVehicleRegistry, createPostgresVehicleRepo } from '../../src/vehicles.js';
import { integrationTest, resetTables } from './_helpers.js';

const TABLES = ['vehicles'];
const HONDA = '1HGBH41JXMN109186';
const TESLA = '5YJ3E1EA6KF000000';

function makeRegistry(nowRef, sql) {
  return createVehicleRegistry({ now: () => nowRef.value, repo: createPostgresVehicleRepo(sql) });
}

integrationTest('add persists a vehicle and primary reassignment works through Postgres', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const reg = makeRegistry(nowRef, sql);

  const a = await reg.add('drv_1', { vin: HONDA, make: 'Honda', model: 'Accord', year: 2021, fuelType: 'gasoline' }, { id: 'v1' });
  const b = await reg.add('drv_1', { vin: TESLA, make: 'Tesla', model: 'Model 3', year: 2019, fuelType: 'battery_electric', batteryKwh: 75, connectorType: 'nacs' }, { id: 'v2' });

  assert.equal(a.primary, true);
  assert.equal(b.primary, false);
  assert.equal((await reg.getPrimary('drv_1')).id, 'v1');

  await reg.deactivate('drv_1', 'v1');
  assert.equal((await reg.getPrimary('drv_1')).id, 'v2');

  const active = await reg.listActive('drv_1');
  assert.deepEqual(active.map((v) => v.id), ['v2']);
});
