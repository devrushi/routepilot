import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEstimatedPaymentTracker,
  getQuarterlyDueDates,
  nextDueDate,
} from '../src/estimated-payments.js';

test('getQuarterlyDueDates returns the 4 standard US dates for a tax year', () => {
  const dates = getQuarterlyDueDates('US', 2024);
  assert.equal(dates.length, 4);
  assert.deepEqual(dates.map((d) => d.quarter), ['Q1', 'Q2', 'Q3', 'Q4']);
  assert.equal(dates[0].dueDate.toISOString(), '2024-04-15T00:00:00.000Z');
  // Q4 rolls into the following calendar year.
  assert.equal(dates[3].dueDate.toISOString(), '2025-01-15T00:00:00.000Z');
});

test('nextDueDate computes days until the next upcoming due date', () => {
  const now = () => Date.parse('2024-05-01T00:00:00.000Z');
  const result = nextDueDate('US', { now });
  assert.equal(result.authority, 'IRS');
  assert.equal(result.quarter, 'Q2');
  assert.equal(result.taxYear, 2024);
  assert.equal(result.dueDate, '2024-06-15T00:00:00.000Z');
  assert.equal(result.daysUntil, 45);
});

test('nextDueDate rolls over to the next tax year\'s Q1 right after the final installment', () => {
  const now = () => Date.parse('2025-01-20T00:00:00.000Z'); // just past the 2024 tax year's Q4 (Jan 15, 2025)
  const result = nextDueDate('US', { now });
  assert.equal(result.quarter, 'Q1');
  assert.equal(result.taxYear, 2025);
  assert.equal(result.dueDate, '2025-04-15T00:00:00.000Z');
});

test('nextDueDate supports the HMRC payment-on-account schedule', () => {
  const now = () => Date.parse('2024-03-01T00:00:00.000Z');
  const result = nextDueDate('GB', { now });
  assert.equal(result.authority, 'HMRC');
  assert.equal(result.quarter, 'H2');
  assert.equal(result.dueDate, '2024-07-31T00:00:00.000Z');
});

test('recordPayment stores a payment and it can be retrieved for its quarter', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = createEstimatedPaymentTracker({ now: () => nowRef.value });
  const payment = tracker.recordPayment('drv_1', { taxYear: 2024, quarter: 'Q2', amount: 1500, currency: 'usd' });
  assert.equal(payment.taxYear, 2024);
  assert.equal(payment.quarter, 'Q2');
  assert.equal(payment.currency, 'USD');
  assert.equal(payment.paidAt, nowRef.value);

  const forQuarter = tracker.listPayments('drv_1', { taxYear: 2024, quarter: 'Q2' });
  assert.equal(forQuarter.length, 1);
  assert.equal(forQuarter[0].id, payment.id);
});

test('totalPaid sums multiple (partial) payments against the same quarter', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = createEstimatedPaymentTracker({ now: () => nowRef.value });
  tracker.recordPayment('drv_1', { taxYear: 2024, quarter: 'Q3', amount: 600, currency: 'USD' });
  nowRef.value += 1000;
  tracker.recordPayment('drv_1', { taxYear: 2024, quarter: 'Q3', amount: 400, currency: 'USD' });
  tracker.recordPayment('drv_1', { taxYear: 2024, quarter: 'Q4', amount: 900, currency: 'USD' });

  assert.equal(tracker.totalPaid('drv_1', 2024, 'Q3'), 1000);
  assert.equal(tracker.totalPaid('drv_1', 2024, 'Q4'), 900);
});

test('recordPayment rejects invalid input', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = createEstimatedPaymentTracker({ now: () => nowRef.value });
  assert.throws(
    () => tracker.recordPayment('drv_1', { taxYear: 2024, quarter: '', amount: 100, currency: 'USD' }),
    (e) => e.code === 'PAYMENT_QUARTER',
  );
  assert.throws(
    () => tracker.recordPayment('drv_1', { taxYear: 2024, quarter: 'Q1', amount: -5, currency: 'USD' }),
    (e) => e.code === 'PAYMENT_AMOUNT',
  );
});
