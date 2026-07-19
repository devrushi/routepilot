// Quarterly estimated tax payment countdowns and payment tracking.
//
// Self-employed drivers pay estimated tax in installments through the year
// rather than one lump sum at filing time. The due-date schedule is a fixed,
// well-known set per authority — not derived from anything else in the app —
// so it's hardcoded here:
//   IRS  — the 4 standard US estimated-tax dates (Apr 15, Jun 15, Sep 15,
//          Jan 15 of the following year) for income earned in a given tax year.
//   HMRC — the 2 Self Assessment "payment on account" dates (31 Jan, 31 Jul).
//          Not literally quarterly, but the same due-date/countdown/payment-
//          tracking machinery applies, so it's modeled the same way.
// Dates assume no weekend/holiday shift (the IRS/HMRC actually roll a date
// landing on a weekend to the next business day) — a reasonable
// simplification for an estimate/reminder feature, not a filing system.

import { randomUUID } from 'node:crypto';
import { resolveAuthority } from './expenses.js';

export class EstimatedPaymentError extends Error {
  constructor(message, code = 'PAYMENT_INVALID') {
    super(message);
    this.name = 'EstimatedPaymentError';
    this.code = code;
  }
}

// { quarter, month (1-12), day, yearOffset } — yearOffset shifts the due
// date into the following calendar year for a given tax year (IRS Q4).
const AUTHORITY_SCHEDULES = {
  IRS: [
    { quarter: 'Q1', month: 4, day: 15, yearOffset: 0 },
    { quarter: 'Q2', month: 6, day: 15, yearOffset: 0 },
    { quarter: 'Q3', month: 9, day: 15, yearOffset: 0 },
    { quarter: 'Q4', month: 1, day: 15, yearOffset: 1 },
  ],
  HMRC: [
    { quarter: 'H1', month: 1, day: 31, yearOffset: 1 },
    { quarter: 'H2', month: 7, day: 31, yearOffset: 1 },
  ],
};

const DAY_MS = 24 * 60 * 60 * 1000;

function scheduleFor(authority) {
  const schedule = AUTHORITY_SCHEDULES[authority];
  if (!schedule) {
    throw new EstimatedPaymentError(`No due-date schedule for authority: ${authority}`, 'PAYMENT_AUTHORITY');
  }
  return schedule;
}

/**
 * The due dates for one tax year under an authority's schedule.
 * @param {string|object} jurisdiction See {@link resolveAuthority}.
 * @param {number} taxYear The tax year the payments are for.
 * @returns {Array<{quarter:string, taxYear:number, dueDate:Date}>}
 */
export function getQuarterlyDueDates(jurisdiction, taxYear) {
  const authority = resolveAuthority(jurisdiction);
  if (!Number.isInteger(taxYear)) {
    throw new EstimatedPaymentError('taxYear must be an integer', 'PAYMENT_TAX_YEAR');
  }
  return scheduleFor(authority).map(({ quarter, month, day, yearOffset }) => ({
    quarter,
    taxYear,
    dueDate: new Date(Date.UTC(taxYear + yearOffset, month - 1, day)),
  }));
}

/**
 * The next upcoming due date (across tax years, so it's correct even right
 * after New Year's when the prior tax year's final installment is still
 * ahead).
 * @param {string|object} jurisdiction See {@link resolveAuthority}.
 * @param {object} [options]
 * @param {() => number} [options.now] Clock in ms (injectable for tests).
 * @returns {{authority:string, quarter:string, taxYear:number, dueDate:string, daysUntil:number}}
 */
export function nextDueDate(jurisdiction, options = {}) {
  const { now = () => Date.now() } = options;
  const authority = resolveAuthority(jurisdiction);
  const nowMs = now();
  const currentYear = new Date(nowMs).getUTCFullYear();

  const upcoming = [currentYear - 1, currentYear, currentYear + 1]
    .flatMap((year) => getQuarterlyDueDates(authority, year))
    .filter((d) => d.dueDate.getTime() >= nowMs)
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  if (upcoming.length === 0) {
    throw new EstimatedPaymentError('No upcoming due date found', 'PAYMENT_NO_DUE_DATE');
  }
  const next = upcoming[0];
  return {
    authority,
    quarter: next.quarter,
    taxYear: next.taxYear,
    dueDate: next.dueDate.toISOString(),
    daysUntil: Math.ceil((next.dueDate.getTime() - nowMs) / DAY_MS),
  };
}

function validateAmount(value, field, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new EstimatedPaymentError(`${field} must be a positive finite number`, code);
  }
  return value;
}

function normalizeCurrencyCode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value.trim())) {
    throw new EstimatedPaymentError('Currency must be a 3-letter ISO 4217 code', 'PAYMENT_CURRENCY');
  }
  return value.trim().toUpperCase();
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
    Object.freeze(obj);
  }
  return obj;
}

/**
 * Create the estimated payment tracker.
 * @param {object} [config]
 * @param {Map} [config.store] Per-driver payment store (defaults in-memory).
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 * @param {() => string} [config.generateId] Payment id generator.
 */
export function createEstimatedPaymentTracker(config = {}) {
  const {
    store = new Map(),
    now = () => Date.now(),
    generateId = () => `pmt_${randomUUID()}`,
  } = config;

  function requireDriverPayments(driverId) {
    if (!driverId) {
      throw new EstimatedPaymentError('A driverId is required', 'PAYMENT_DRIVER');
    }
    let payments = store.get(driverId);
    if (!payments) {
      payments = new Map();
      store.set(driverId, payments);
    }
    return payments;
  }

  function snapshot(record) {
    return deepFreeze(structuredClone(record));
  }

  /**
   * Record a payment made against a given tax year/quarter. Multiple
   * (partial) payments against the same quarter are allowed.
   * @param {string} driverId
   * @param {object} input
   * @param {number} input.taxYear
   * @param {string} input.quarter e.g. 'Q1' (IRS) or 'H1' (HMRC).
   * @param {number} input.amount
   * @param {string} input.currency ISO 4217 code.
   * @param {number} [input.paidAt] Timestamp override (ms since epoch).
   * @returns {object} The stored, frozen payment record.
   */
  function recordPayment(driverId, input = {}) {
    const payments = requireDriverPayments(driverId);
    if (!Number.isInteger(input.taxYear)) {
      throw new EstimatedPaymentError('taxYear must be an integer', 'PAYMENT_TAX_YEAR');
    }
    if (typeof input.quarter !== 'string' || !input.quarter.trim()) {
      throw new EstimatedPaymentError('A quarter label is required', 'PAYMENT_QUARTER');
    }
    const amount = validateAmount(input.amount, 'amount', 'PAYMENT_AMOUNT');
    const currency = normalizeCurrencyCode(input.currency);
    const record = {
      id: generateId(),
      driverId,
      taxYear: input.taxYear,
      quarter: input.quarter.trim(),
      amount,
      currency,
      paidAt: input.paidAt ?? now(),
    };
    payments.set(record.id, record);
    return snapshot(record);
  }

  /**
   * List payments for a driver, optionally filtered to one tax year/quarter,
   * oldest first.
   * @param {string} driverId
   * @param {object} [filter]
   * @param {number} [filter.taxYear]
   * @param {string} [filter.quarter]
   */
  function listPayments(driverId, filter = {}) {
    const payments = store.get(driverId);
    if (!payments) return [];
    let records = [...payments.values()].sort((a, b) => a.paidAt - b.paidAt);
    if (filter.taxYear !== undefined) records = records.filter((r) => r.taxYear === filter.taxYear);
    if (filter.quarter !== undefined) records = records.filter((r) => r.quarter === filter.quarter);
    return records.map(snapshot);
  }

  /** Total amount paid for a tax year/quarter (assumes a single currency; no conversion is performed). */
  function totalPaid(driverId, taxYear, quarter) {
    return listPayments(driverId, { taxYear, quarter }).reduce((sum, r) => sum + r.amount, 0);
  }

  return { recordPayment, listPayments, totalPaid, store };
}
