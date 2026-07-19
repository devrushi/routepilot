// Run against a real database: set TEST_DATABASE_URL, apply migrations
// with `npm run migrate -- --test`, then `npm run test:integration`.

import assert from 'node:assert/strict';
import { createEstimatedPaymentTracker, createPostgresEstimatedPaymentRepo } from '../../src/estimated-payments.js';
import { integrationTest, resetTables } from './_helpers.js';

const TABLES = ['estimated_payments'];

function makeTracker(nowRef, sql) {
  return createEstimatedPaymentTracker({ now: () => nowRef.value, repo: createPostgresEstimatedPaymentRepo(sql) });
}

integrationTest('recordPayment persists and totalPaid sums partial payments through Postgres', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef, sql);

  await tracker.recordPayment('drv_1', { taxYear: 2024, quarter: 'Q3', amount: 600, currency: 'USD' });
  nowRef.value += 1000;
  await tracker.recordPayment('drv_1', { taxYear: 2024, quarter: 'Q3', amount: 400, currency: 'USD' });
  await tracker.recordPayment('drv_1', { taxYear: 2024, quarter: 'Q4', amount: 900, currency: 'USD' });

  assert.equal(await tracker.totalPaid('drv_1', 2024, 'Q3'), 1000);
  assert.equal(await tracker.totalPaid('drv_1', 2024, 'Q4'), 900);

  const q3Payments = await tracker.listPayments('drv_1', { taxYear: 2024, quarter: 'Q3' });
  assert.equal(q3Payments.length, 2);
});
