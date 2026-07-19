// Tax estimation engine: progressive-bracket income tax with automatic
// deductions from a driver's categorized expenses.
//
// Scope and assumptions (deliberately simplified — this is an estimate, not
// a filing):
//   - Income tax only. US self-employment tax (Social Security + Medicare,
//     ~15.3% on net self-employment earnings) and UK National Insurance are
//     NOT included — a real gig-driver estimate would need both on top of
//     this.
//   - US: 2024 single-filer federal brackets, plus the 2024 single-filer
//     standard deduction ($14,600) subtracted from gross income before
//     brackets are applied. No state income tax.
//   - UK: 2024/25 England & Northern Ireland bands (Scotland/Wales differ).
//     The £12,570 personal allowance is modeled as a 0% bracket rather than
//     a separate deduction, and is NOT tapered for high earners (real HMRC
//     rules taper it away above £100,000).
//   - Deductions are the sum of `.amount` on the categorized expense records
//     passed in (see expenses.js) — the caller is responsible for passing
//     expenses in the same currency as `grossIncome`; no currency
//     conversion happens here.

import { resolveAuthority } from './expenses.js';

export class TaxEstimationError extends Error {
  constructor(message, code = 'TAX_ESTIMATION_INVALID') {
    super(message);
    this.name = 'TaxEstimationError';
    this.code = code;
  }
}

/** 2024 US federal single-filer brackets (marginal rate per band). */
export const US_FEDERAL_BRACKETS_2024 = [
  { upTo: 11_600, rate: 0.10 },
  { upTo: 47_150, rate: 0.12 },
  { upTo: 100_525, rate: 0.22 },
  { upTo: 191_950, rate: 0.24 },
  { upTo: 243_725, rate: 0.32 },
  { upTo: 609_350, rate: 0.35 },
  { upTo: null, rate: 0.37 },
];

/** 2024 US single-filer standard deduction. */
export const US_STANDARD_DEDUCTION_2024 = 14_600;

/** 2024/25 UK (England & NI) income tax bands; personal allowance modeled as a 0% band. */
export const GB_INCOME_TAX_BANDS_2024 = [
  { upTo: 12_570, rate: 0 },
  { upTo: 50_270, rate: 0.20 },
  { upTo: 125_140, rate: 0.40 },
  { upTo: null, rate: 0.45 },
];

/** Default per-authority bracket table + flat deduction, keyed by tax authority. */
export const DEFAULT_JURISDICTION_TAX_CONFIG = {
  IRS: { brackets: US_FEDERAL_BRACKETS_2024, standardDeduction: US_STANDARD_DEDUCTION_2024 },
  HMRC: { brackets: GB_INCOME_TAX_BANDS_2024, standardDeduction: 0 },
};

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundRate(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

/**
 * Compute tax owed on `taxableIncome` under a progressive bracket table.
 * Each bracket's `rate` applies only to the slice of income between the
 * previous bracket's `upTo` and its own (the standard "marginal rate" model
 * — not a flat rate on the whole income).
 * @param {number} taxableIncome
 * @param {Array<{upTo:number|null, rate:number}>} brackets Ascending by `upTo`, last entry's `upTo` should be `null`.
 * @returns {number} Tax owed, rounded to cents.
 */
export function computeProgressiveTax(taxableIncome, brackets) {
  if (typeof taxableIncome !== 'number' || !Number.isFinite(taxableIncome)) {
    throw new TaxEstimationError('taxableIncome must be a finite number', 'TAX_ESTIMATION_INCOME');
  }
  if (!Array.isArray(brackets) || brackets.length === 0) {
    throw new TaxEstimationError('At least one tax bracket is required', 'TAX_ESTIMATION_BRACKETS');
  }
  if (taxableIncome <= 0) return 0;

  let tax = 0;
  let lower = 0;
  for (const { upTo, rate } of brackets) {
    const upper = upTo === null || upTo === undefined ? Infinity : upTo;
    const taxableInBand = Math.min(taxableIncome, upper) - lower;
    if (taxableInBand > 0) tax += taxableInBand * rate;
    if (taxableIncome <= upper) break;
    lower = upper;
  }
  return roundMoney(tax);
}

function sumDeductions(expenses) {
  if (!Array.isArray(expenses)) {
    throw new TaxEstimationError('expenses must be an array of categorized expense records', 'TAX_ESTIMATION_EXPENSES');
  }
  return expenses.reduce((total, expense) => {
    const amount = expense && expense.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new TaxEstimationError('Each expense must have a non-negative numeric amount', 'TAX_ESTIMATION_EXPENSES');
    }
    return total + amount;
  }, 0);
}

/**
 * Create a tax estimator.
 * @param {object} [config]
 * @param {Record<string, {brackets:Array, standardDeduction:number}>} [config.jurisdictionConfig]
 *   Per-authority bracket table + flat deduction (defaults to {@link DEFAULT_JURISDICTION_TAX_CONFIG}).
 */
export function createTaxEstimator(config = {}) {
  const { jurisdictionConfig = DEFAULT_JURISDICTION_TAX_CONFIG } = config;

  /**
   * Estimate income tax owed for a period.
   * @param {object} input
   * @param {number} input.grossIncome Total income before deductions.
   * @param {object|string} input.jurisdiction Driver's tax residency (see {@link resolveAuthority}).
   * @param {object[]} [input.expenses] Categorized expense records (see expenses.js); their `.amount` is summed and deducted automatically.
   * @returns {object} Frozen breakdown: `{ authority, grossIncome, deductions, standardDeduction, taxableIncome, estimatedTax, effectiveRate }`.
   */
  function estimateTax(input = {}) {
    const { grossIncome, jurisdiction, expenses = [] } = input;
    if (typeof grossIncome !== 'number' || !Number.isFinite(grossIncome) || grossIncome < 0) {
      throw new TaxEstimationError('grossIncome must be a non-negative finite number', 'TAX_ESTIMATION_INCOME');
    }
    const authority = resolveAuthority(jurisdiction);
    const jConfig = jurisdictionConfig[authority];
    if (!jConfig) {
      throw new TaxEstimationError(`No tax bracket configuration for authority: ${authority}`, 'TAX_ESTIMATION_CONFIG');
    }
    const deductions = roundMoney(sumDeductions(expenses));
    const taxableIncome = Math.max(0, roundMoney(grossIncome - jConfig.standardDeduction - deductions));
    const estimatedTax = computeProgressiveTax(taxableIncome, jConfig.brackets);

    return Object.freeze({
      authority,
      grossIncome,
      deductions,
      standardDeduction: jConfig.standardDeduction,
      taxableIncome,
      estimatedTax,
      effectiveRate: grossIncome > 0 ? roundRate(estimatedTax / grossIncome) : 0,
    });
  }

  return { estimateTax };
}
