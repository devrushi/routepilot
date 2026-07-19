import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaxEstimator, computeProgressiveTax, US_FEDERAL_BRACKETS_2024 } from '../src/tax-estimation.js';

test('computeProgressiveTax applies marginal rates band by band', () => {
  // 10% on the first $11,600, 12% on the next $33,800 => $1,160 + $4,056
  assert.equal(computeProgressiveTax(45_400, US_FEDERAL_BRACKETS_2024), 5216);
  assert.equal(computeProgressiveTax(0, US_FEDERAL_BRACKETS_2024), 0);
  assert.equal(computeProgressiveTax(-100, US_FEDERAL_BRACKETS_2024), 0);
});

test('estimateTax computes a plain bracket calculation with no deductions (US)', () => {
  const estimator = createTaxEstimator();
  const result = estimator.estimateTax({ grossIncome: 60_000, jurisdiction: 'US', expenses: [] });
  assert.equal(result.authority, 'IRS');
  assert.equal(result.standardDeduction, 14_600);
  assert.equal(result.deductions, 0);
  assert.equal(result.taxableIncome, 45_400);
  assert.equal(result.estimatedTax, 5216);
  assert.ok(result.effectiveRate > 0 && result.effectiveRate < 0.15);
});

test('estimateTax applies expense deductions and lowers the estimate (US)', () => {
  const estimator = createTaxEstimator();
  const withoutDeductions = estimator.estimateTax({ grossIncome: 60_000, jurisdiction: 'US', expenses: [] });
  const withDeductions = estimator.estimateTax({
    grossIncome: 60_000,
    jurisdiction: 'US',
    expenses: [{ amount: 5000 }, { amount: 2000 }],
  });
  assert.equal(withDeductions.deductions, 7000);
  assert.equal(withDeductions.taxableIncome, 38_400);
  assert.equal(withDeductions.estimatedTax, 4376);
  assert.ok(withDeductions.estimatedTax < withoutDeductions.estimatedTax);
});

test('estimateTax computes UK bands with the personal allowance as a 0% bracket', () => {
  const estimator = createTaxEstimator();
  const result = estimator.estimateTax({ grossIncome: 40_000, jurisdiction: 'GB', expenses: [] });
  assert.equal(result.authority, 'HMRC');
  assert.equal(result.standardDeduction, 0);
  assert.equal(result.taxableIncome, 40_000);
  assert.equal(result.estimatedTax, 5486); // 20% of (40,000 - 12,570)
});

test('estimateTax rejects invalid income and malformed expenses', () => {
  const estimator = createTaxEstimator();
  assert.throws(() => estimator.estimateTax({ grossIncome: -1, jurisdiction: 'US' }), (e) => e.code === 'TAX_ESTIMATION_INCOME');
  assert.throws(
    () => estimator.estimateTax({ grossIncome: 1000, jurisdiction: 'US', expenses: [{ amount: -5 }] }),
    (e) => e.code === 'TAX_ESTIMATION_EXPENSES',
  );
});
