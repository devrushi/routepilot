// Run against a real database: set TEST_DATABASE_URL, apply migrations
// with `npm run migrate -- --test`, then `npm run test:integration`.

import assert from 'node:assert/strict';
import { createExpenseTracker, createPostgresExpenseRepo } from '../../src/expenses.js';
import { integrationTest, resetTables } from './_helpers.js';

const TABLES = ['expenses'];

function makeTracker(nowRef, sql) {
  return createExpenseTracker({ now: () => nowRef.value, repo: createPostgresExpenseRepo(sql) });
}

integrationTest('categorize persists an expense and resolves its tax bucket through Postgres', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef, sql);

  const record = await tracker.categorize('drv_1', { category: 'fuel', amount: 45.5, currency: 'USD', jurisdiction: 'US' });
  assert.equal(record.authority, 'IRS');
  assert.equal(record.bucket, 'Car and truck expenses (Schedule C, Line 9)');

  const fetched = await tracker.get('drv_1', record.id);
  assert.equal(fetched.amount, 45.5);
});

integrationTest('list filters by category and is isolated per driver', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef, sql);

  await tracker.categorize('drv_1', { category: 'fuel', amount: 10, currency: 'USD', jurisdiction: 'US' });
  await tracker.categorize('drv_1', { category: 'insurance', amount: 20, currency: 'USD', jurisdiction: 'US' });
  await tracker.categorize('drv_2', { category: 'fuel', amount: 30, currency: 'GBP', jurisdiction: 'GB' });

  assert.equal((await tracker.list('drv_1')).length, 2);
  assert.equal((await tracker.list('drv_1', { category: 'fuel' })).length, 1);
  assert.equal((await tracker.list('drv_2')).length, 1);
});
