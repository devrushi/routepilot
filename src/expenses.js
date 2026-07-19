// Manual expense categorization for RoutePilot drivers, mapped onto the
// correct tax-code bucket for the driver's declared jurisdiction.
//
// A driver assigns each expense to one of a small set of categories (fuel,
// vehicle maintenance, phone/data, insurance, ...). Which *tax bucket* that
// category lands in depends on jurisdiction — a US driver's fuel costs are
// part of Schedule C "Car and truck expenses"; a UK driver's are "Car, van
// and travel expenses" on the Self Assessment. This module owns that
// category -> bucket mapping and reuses tax-residency.js's jurisdiction/
// authority model (IRS vs HMRC) rather than redefining it.
//
// The bucket labels below are a reasonable, simplified approximation of each
// authority's actual expense categories for a sole-trader/self-employed
// driver — not tax advice, and not a substitute for the real Schedule C /
// SA103 line items a filing would ultimately use.

import { randomUUID } from 'node:crypto';
import { TAX_JURISDICTIONS } from './tax-residency.js';

export class ExpenseError extends Error {
  constructor(message, code = 'EXPENSE_INVALID') {
    super(message);
    this.name = 'ExpenseError';
    this.code = code;
  }
}

/**
 * Expense categories a driver can log, each mapped to its IRS (US) and HMRC
 * (UK) tax bucket.
 */
export const EXPENSE_CATEGORIES = [
  {
    id: 'fuel',
    label: 'Fuel',
    irsBucket: 'Car and truck expenses (Schedule C, Line 9)',
    hmrcBucket: 'Car, van and travel expenses',
  },
  {
    id: 'vehicle_maintenance',
    label: 'Vehicle maintenance & repairs',
    irsBucket: 'Car and truck expenses (Schedule C, Line 9)',
    hmrcBucket: 'Car, van and travel expenses',
  },
  {
    id: 'parking_tolls',
    label: 'Parking & tolls',
    irsBucket: 'Car and truck expenses (Schedule C, Line 9)',
    hmrcBucket: 'Car, van and travel expenses',
  },
  {
    id: 'insurance',
    label: 'Vehicle insurance',
    irsBucket: 'Insurance, other than health (Schedule C, Line 15)',
    hmrcBucket: 'Car, van and travel expenses',
  },
  {
    id: 'phone_data',
    label: 'Phone & data plan',
    irsBucket: 'Other expenses — phone/utilities (Schedule C, Part V)',
    hmrcBucket: 'Phone, internet and office costs',
  },
  {
    id: 'supplies',
    label: 'Supplies & equipment',
    irsBucket: 'Supplies (Schedule C, Line 22)',
    hmrcBucket: 'Office costs (equipment, supplies)',
  },
  {
    id: 'professional_fees',
    label: 'Professional & legal fees',
    irsBucket: 'Legal and professional services (Schedule C, Line 17)',
    hmrcBucket: 'Legal and financial costs',
  },
  {
    id: 'other',
    label: 'Other business expense',
    irsBucket: 'Other expenses (Schedule C, Part V)',
    hmrcBucket: 'Other business expenses',
  },
];

function resolveCategory(value) {
  if (typeof value !== 'string') return null;
  const needle = value.trim().toLowerCase();
  return EXPENSE_CATEGORIES.find((c) => c.id === needle) ?? null;
}

/**
 * Resolve a tax authority ('IRS' or 'HMRC') from anything that already
 * carries or implies one: a full declaration from declareTaxResidency()
 * (`{ jurisdiction: { authority } }`), a raw TAX_JURISDICTIONS entry
 * (`{ authority }`), a jurisdiction id/country ('US', 'GB', 'UK'), or the
 * authority itself. Shared with tax-estimation.js and other modules that
 * need to go from "a driver's declared jurisdiction" to "which tax code
 * applies" without redefining the jurisdiction catalogue.
 * @param {object|string} jurisdiction
 * @returns {'IRS'|'HMRC'}
 */
export function resolveAuthority(jurisdiction) {
  if (jurisdiction && typeof jurisdiction === 'object') {
    const j = jurisdiction.authority ? jurisdiction : jurisdiction.jurisdiction;
    if (j && j.authority) return j.authority;
  }
  if (typeof jurisdiction === 'string') {
    const needle = jurisdiction.trim().toUpperCase();
    if (needle === 'IRS' || needle === 'HMRC') return needle;
    const alias = needle === 'UK' ? 'GB' : needle;
    const match = TAX_JURISDICTIONS.find(
      (j) => j.id === alias || j.country === alias || j.label.toUpperCase() === needle,
    );
    if (match) return match.authority;
  }
  throw new ExpenseError(
    `Unable to resolve a tax authority from jurisdiction: ${JSON.stringify(jurisdiction)}`,
    'EXPENSE_JURISDICTION',
  );
}

function validateAmount(value, field, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ExpenseError(`${field} must be a non-negative finite number`, code);
  }
  return value;
}

function normalizeCurrencyCode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value.trim())) {
    throw new ExpenseError('Currency must be a 3-letter ISO 4217 code', 'EXPENSE_CURRENCY');
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
 * Look up the tax bucket a category maps to for a given authority.
 * @param {string} categoryId {@link EXPENSE_CATEGORIES} id.
 * @param {string} authority 'IRS' or 'HMRC'.
 * @returns {string}
 */
export function bucketFor(categoryId, authority) {
  const category = resolveCategory(categoryId);
  if (!category) {
    const accepted = EXPENSE_CATEGORIES.map((c) => c.id).join(', ');
    throw new ExpenseError(`Unknown expense category: ${categoryId}. Accepted: ${accepted}`, 'EXPENSE_CATEGORY');
  }
  if (authority === 'IRS') return category.irsBucket;
  if (authority === 'HMRC') return category.hmrcBucket;
  throw new ExpenseError(`Unknown tax authority: ${authority}`, 'EXPENSE_AUTHORITY');
}

/**
 * Create the expense categorization tracker.
 * @param {object} [config]
 * @param {Map} [config.store] Per-driver expense store (defaults in-memory).
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 * @param {() => string} [config.generateId] Record id generator.
 */
export function createExpenseTracker(config = {}) {
  const {
    store = new Map(),
    now = () => Date.now(),
    generateId = () => `exp_${randomUUID()}`,
  } = config;

  function requireDriverExpenses(driverId) {
    if (!driverId) {
      throw new ExpenseError('A driverId is required', 'EXPENSE_DRIVER');
    }
    let expenses = store.get(driverId);
    if (!expenses) {
      expenses = new Map();
      store.set(driverId, expenses);
    }
    return expenses;
  }

  function snapshot(record) {
    return deepFreeze(structuredClone(record));
  }

  /**
   * Categorize an expense and resolve its tax bucket for the driver's
   * declared jurisdiction.
   * @param {string} driverId
   * @param {object} input
   * @param {string} input.category {@link EXPENSE_CATEGORIES} id.
   * @param {number} input.amount
   * @param {string} input.currency ISO 4217 code.
   * @param {object|string} input.jurisdiction Driver's tax residency (see {@link resolveAuthority}).
   * @param {number} [input.at] Timestamp override (ms since epoch).
   * @returns {object} The stored, frozen expense record.
   */
  function categorize(driverId, input = {}) {
    const expenses = requireDriverExpenses(driverId);
    const category = resolveCategory(input.category);
    if (!category) {
      const accepted = EXPENSE_CATEGORIES.map((c) => c.id).join(', ');
      throw new ExpenseError(`Unknown expense category: ${input.category}. Accepted: ${accepted}`, 'EXPENSE_CATEGORY');
    }
    const authority = resolveAuthority(input.jurisdiction);
    const amount = validateAmount(input.amount, 'amount', 'EXPENSE_AMOUNT');
    const currency = normalizeCurrencyCode(input.currency);

    const record = {
      id: generateId(),
      driverId,
      category: category.id,
      categoryLabel: category.label,
      authority,
      bucket: bucketFor(category.id, authority),
      amount,
      currency,
      at: input.at ?? now(),
    };
    expenses.set(record.id, record);
    return snapshot(record);
  }

  /** Get one expense, or `null`. */
  function get(driverId, id) {
    const expenses = store.get(driverId);
    const record = expenses && expenses.get(id);
    return record ? snapshot(record) : null;
  }

  /**
   * List a driver's expenses, oldest first.
   * @param {string} driverId
   * @param {object} [filter]
   * @param {string} [filter.category]
   */
  function list(driverId, filter = {}) {
    const expenses = store.get(driverId);
    if (!expenses) return [];
    let records = [...expenses.values()].sort((a, b) => a.at - b.at);
    if (filter.category !== undefined) {
      records = records.filter((r) => r.category === filter.category);
    }
    return records.map(snapshot);
  }

  return { categorize, get, list, store };
}
