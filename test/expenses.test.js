import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExpenseTracker, bucketFor } from '../src/expenses.js';
import { TAX_JURISDICTIONS } from '../src/tax-residency.js';

function makeTracker(nowRef) {
  return createExpenseTracker({ now: () => nowRef.value });
}

test('categorize maps a fuel expense to the IRS bucket for a US driver', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  const record = tracker.categorize('drv_1', {
    category: 'fuel',
    amount: 45.5,
    currency: 'usd',
    jurisdiction: 'US',
  });
  assert.equal(record.authority, 'IRS');
  assert.equal(record.bucket, 'Car and truck expenses (Schedule C, Line 9)');
  assert.equal(record.currency, 'USD');
  assert.equal(record.at, nowRef.value);
});

test('categorize maps a fuel expense to the HMRC bucket for a UK driver', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  const record = tracker.categorize('drv_2', {
    category: 'fuel',
    amount: 38,
    currency: 'GBP',
    jurisdiction: 'GB',
  });
  assert.equal(record.authority, 'HMRC');
  assert.equal(record.bucket, 'Car, van and travel expenses');
});

test('categorize accepts a full tax-residency declaration as the jurisdiction', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  const declaration = { jurisdiction: TAX_JURISDICTIONS.find((j) => j.id === 'GB') };
  const record = tracker.categorize('drv_2', {
    category: 'phone_data',
    amount: 25,
    currency: 'GBP',
    jurisdiction: declaration,
  });
  assert.equal(record.authority, 'HMRC');
  assert.equal(record.bucket, 'Phone, internet and office costs');
});

test('categorize accepts "UK" as an alias for GB', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  const record = tracker.categorize('drv_2', {
    category: 'insurance',
    amount: 60,
    currency: 'GBP',
    jurisdiction: 'UK',
  });
  assert.equal(record.authority, 'HMRC');
});

test('categorize rejects an unknown category or jurisdiction', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  assert.throws(
    () => tracker.categorize('drv_1', { category: 'yacht', amount: 1, currency: 'USD', jurisdiction: 'US' }),
    (e) => e.code === 'EXPENSE_CATEGORY',
  );
  assert.throws(
    () => tracker.categorize('drv_1', { category: 'fuel', amount: 1, currency: 'USD', jurisdiction: 'FR' }),
    (e) => e.code === 'EXPENSE_JURISDICTION',
  );
});

test('list filters by category and is isolated per driver', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  tracker.categorize('drv_1', { category: 'fuel', amount: 10, currency: 'USD', jurisdiction: 'US' });
  tracker.categorize('drv_1', { category: 'insurance', amount: 20, currency: 'USD', jurisdiction: 'US' });
  tracker.categorize('drv_2', { category: 'fuel', amount: 30, currency: 'GBP', jurisdiction: 'GB' });

  assert.equal(tracker.list('drv_1').length, 2);
  assert.equal(tracker.list('drv_1', { category: 'fuel' }).length, 1);
  assert.equal(tracker.list('drv_2').length, 1);
});

test('bucketFor resolves a category/authority pair directly', () => {
  assert.equal(bucketFor('supplies', 'IRS'), 'Supplies (Schedule C, Line 22)');
  assert.equal(bucketFor('supplies', 'HMRC'), 'Office costs (equipment, supplies)');
});
