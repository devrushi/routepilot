// Partner Delivery Service Provider (DSP) linking with variable payout rates.
//
// After a driver has a business profile and at least one vehicle (see
// onboarding.js / vehicles.js) they connect the delivery platforms they earn on
// — Amazon Flex, DoorDash, Uber Eats, Instacart, and so on (_Driver Onboarding
// & Financial Profile › Business & Vehicle Setup › DSP Connection_). A driver
// typically works several at once, so this module is a per-driver registry of
// **DSP links** rather than a single connection.
//
// The distinguishing feature of a link is its **variable payout rate**: a DSP
// does not pay a single flat number. Earnings are built from several rate
// components at once — a base amount per delivery, a per-mile rate, a per-hour
// guarantee, a percentage of order value — and those are scaled by a peak/surge
// multiplier and floored by a minimum guarantee. This module is the
// dependency-free schema + validation core for such a rate card, plus the logic
// to *compute* an estimated payout for a batch of work from it, and the registry
// that manages the lifecycle of each link.

import { randomUUID } from 'node:crypto';

export class DspError extends Error {
  constructor(message, code = 'DSP_INVALID') {
    super(message);
    this.name = 'DspError';
    this.code = code;
  }
}

/**
 * Known partner Delivery Service Providers a driver can link, keyed by their
 * canonical id. `category` groups them by what they carry. The catalogue is
 * overridable (see the `partners` option) so a deployment can add its own.
 */
export const DSP_PARTNERS = [
  { id: 'amazon_flex', label: 'Amazon Flex', category: 'parcel' },
  { id: 'doordash', label: 'DoorDash', category: 'food' },
  { id: 'uber_eats', label: 'Uber Eats', category: 'food' },
  { id: 'grubhub', label: 'Grubhub', category: 'food' },
  { id: 'instacart', label: 'Instacart', category: 'grocery' },
  { id: 'spark', label: 'Walmart Spark', category: 'grocery' },
  { id: 'roadie', label: 'Roadie', category: 'parcel' },
];

/**
 * Payout rate component types. A rate card mixes any of these — each is a
 * separate variable dimension of the driver's earnings. `basis` names the field
 * of a work batch it is multiplied by; `unit` is for display.
 */
export const PAYOUT_RATE_TYPES = [
  { id: 'per_delivery', label: 'Per delivery', basis: 'deliveries', unit: 'delivery' },
  { id: 'per_mile', label: 'Per mile', basis: 'miles', unit: 'mile' },
  { id: 'per_hour', label: 'Per hour', basis: 'hours', unit: 'hour' },
  { id: 'percentage', label: 'Percentage of order value', basis: 'orderValue', unit: 'percent' },
];

/** Lifecycle states a DSP link can be in. */
export const LINK_STATUSES = ['pending', 'active', 'suspended', 'unlinked'];

// Generous sanity bounds so a typo is caught but no realistic rate is rejected.
const MAX_RATE_AMOUNT = 10000; // a currency amount per unit (per delivery / mile / hour)
const MAX_PEAK_MULTIPLIER = 10; // surge multipliers rarely exceed ~3x
const MAX_MINIMUM_PAYOUT = 1000000;

// --- number / money helpers ----------------------------------------------

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    return Number.isNaN(n) ? NaN : n;
  }
  return NaN;
}

/** Round a currency amount to whole cents, avoiding binary-float drift. */
function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function validateAmount(value, field, code, { min = 0, max } = {}) {
  const n = toNumber(value);
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new DspError(`${field} must be a finite number`, code);
  }
  if (n < min || (max !== undefined && n > max)) {
    const upper = max === undefined ? '' : ` and at most ${max}`;
    throw new DspError(`${field} must be at least ${min}${upper}`, code);
  }
  return n;
}

function normalizeText(value, field, { max = 80 } = {}) {
  if (typeof value !== 'string') {
    throw new DspError(`${field} is required`, 'DSP_FIELD');
  }
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    throw new DspError(`${field} is required`, 'DSP_FIELD');
  }
  if (trimmed.length > max) {
    throw new DspError(`${field} must be at most ${max} characters`, 'DSP_FIELD');
  }
  return trimmed;
}

function normalizeCurrency(value) {
  if (value === undefined || value === null || value === '') return 'USD';
  if (typeof value !== 'string') {
    throw new DspError('Currency must be a 3-letter ISO 4217 code', 'DSP_CURRENCY');
  }
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new DspError('Currency must be a 3-letter ISO 4217 code', 'DSP_CURRENCY');
  }
  return currency;
}

function resolvePartner(catalogue, value) {
  if (value && typeof value === 'object') {
    // A custom partner supplied inline: { id, label, category }.
    const id = normalizeText(value.id, 'partner id', { max: 40 })
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    const label = normalizeText(value.label, 'partner label');
    const category = value.category === undefined || value.category === null || value.category === ''
      ? 'other'
      : normalizeText(value.category, 'partner category', { max: 40 }).toLowerCase();
    return { id, label, category };
  }
  if (typeof value !== 'string') return null;
  const needle = value.trim().toLowerCase();
  if (!needle) return null;
  const match = catalogue.find(
    (p) => p.id.toLowerCase() === needle || p.label.toLowerCase() === needle,
  );
  return match ? { id: match.id, label: match.label, category: match.category } : null;
}

function resolveRateType(catalogue, value) {
  if (typeof value !== 'string') return null;
  const needle = value.trim().toLowerCase();
  if (!needle) return null;
  return catalogue.find((t) => t.id.toLowerCase() === needle) ?? null;
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
    Object.freeze(obj);
  }
  return obj;
}

/**
 * Validate and normalize a **variable payout rate** card. A rate card is a
 * currency plus one or more rate components (each a distinct earning dimension),
 * optionally scaled by a `peakMultiplier` during surge and floored by a
 * `minimumPayout` guarantee.
 *
 * @param {object} input
 * @param {string} [input.currency='USD'] ISO 4217 currency code.
 * @param {Array<{type:string, rate:number}>} input.components One or more rate
 *   components; `type` is a {@link PAYOUT_RATE_TYPES} id, `rate` its amount
 *   (currency per unit, or a percent for `percentage`). No duplicate types.
 * @param {number} [input.peakMultiplier=1] Multiplier applied to the subtotal
 *   during peak/surge periods (>= 1).
 * @param {number} [input.minimumPayout=0] A floor applied to the computed total.
 * @param {object} [opts]
 * @param {Array} [opts.rateTypes] Rate-type catalogue (defaults to {@link PAYOUT_RATE_TYPES}).
 * @returns {object} Normalized rate card.
 */
export function validatePayoutRate(input = {}, opts = {}) {
  const { rateTypes = PAYOUT_RATE_TYPES } = opts;
  if (input === null || typeof input !== 'object') {
    throw new DspError('A payout rate must be an object', 'DSP_RATE');
  }

  const currency = normalizeCurrency(input.currency);

  if (!Array.isArray(input.components) || input.components.length === 0) {
    throw new DspError('A payout rate needs at least one rate component', 'DSP_RATE');
  }

  const seen = new Set();
  const components = input.components.map((raw) => {
    if (raw === null || typeof raw !== 'object') {
      throw new DspError('Each rate component must be an object', 'DSP_RATE');
    }
    const type = resolveRateType(rateTypes, raw.type);
    if (!type) {
      const accepted = rateTypes.map((t) => t.id).join(', ');
      throw new DspError(`Unknown payout rate type: ${raw.type}. Accepted: ${accepted}`, 'DSP_RATE_TYPE');
    }
    if (seen.has(type.id)) {
      throw new DspError(`Duplicate payout rate component: ${type.id}`, 'DSP_RATE');
    }
    seen.add(type.id);
    // A percentage is 0-100; the currency-denominated rates share one bound.
    const rate = type.id === 'percentage'
      ? validateAmount(raw.rate, 'A percentage rate', 'DSP_RATE', { min: 0, max: 100 })
      : validateAmount(raw.rate, `The ${type.label} rate`, 'DSP_RATE', { min: 0, max: MAX_RATE_AMOUNT });
    return { type: type.id, label: type.label, basis: type.basis, unit: type.unit, rate };
  });

  const peakMultiplier = input.peakMultiplier === undefined || input.peakMultiplier === null || input.peakMultiplier === ''
    ? 1
    : validateAmount(input.peakMultiplier, 'Peak multiplier', 'DSP_RATE', { min: 1, max: MAX_PEAK_MULTIPLIER });

  const minimumPayout = input.minimumPayout === undefined || input.minimumPayout === null || input.minimumPayout === ''
    ? 0
    : roundMoney(validateAmount(input.minimumPayout, 'Minimum payout', 'DSP_RATE', { min: 0, max: MAX_MINIMUM_PAYOUT }));

  return { currency, components, peakMultiplier, minimumPayout };
}

/**
 * Compute the payout for a batch of work from a (validated) payout rate card.
 * Each rate component is multiplied by the matching field of `work`; the subtotal
 * is scaled by the `peakMultiplier` when `options.peak` is set, then raised to
 * the `minimumPayout` floor if it falls short.
 *
 * @param {object} rate A rate card (as returned by {@link validatePayoutRate}).
 * @param {object} [work]
 * @param {number} [work.deliveries=0] Completed deliveries.
 * @param {number} [work.miles=0] Miles driven.
 * @param {number} [work.hours=0] Hours worked.
 * @param {number} [work.orderValue=0] Total order value (for percentage rates).
 * @param {object} [options]
 * @param {boolean} [options.peak=false] Apply the peak/surge multiplier.
 * @returns {object} A frozen breakdown: `{ currency, breakdown, subtotal, peak,
 *   multiplier, total, floorApplied }`.
 */
export function computePayout(rate, work = {}, options = {}) {
  if (rate === null || typeof rate !== 'object' || !Array.isArray(rate.components)) {
    throw new DspError('A payout rate is required', 'DSP_RATE');
  }
  if (work === null || typeof work !== 'object') {
    throw new DspError('Work must be an object', 'DSP_WORK');
  }

  const quantityFor = (basis) => {
    const value = work[basis];
    if (value === undefined || value === null || value === '') return 0;
    return validateAmount(value, `Work "${basis}"`, 'DSP_WORK', { min: 0 });
  };

  const breakdown = rate.components.map((c) => {
    const quantity = quantityFor(c.basis);
    const amount = c.type === 'percentage'
      ? roundMoney((c.rate / 100) * quantity)
      : roundMoney(c.rate * quantity);
    return { type: c.type, rate: c.rate, unit: c.unit, quantity, amount };
  });

  const subtotal = roundMoney(breakdown.reduce((sum, b) => sum + b.amount, 0));
  const peak = options.peak === true;
  const multiplier = peak ? rate.peakMultiplier : 1;
  let total = roundMoney(subtotal * multiplier);

  const minimum = rate.minimumPayout ?? 0;
  const floorApplied = total < minimum;
  if (floorApplied) total = roundMoney(minimum);

  return deepFreeze({
    currency: rate.currency,
    breakdown,
    subtotal,
    peak,
    multiplier,
    total,
    floorApplied,
  });
}

/**
 * Validate a DSP link and return its normalized schema core — the fields that
 * describe the connection itself, independent of registry bookkeeping (id,
 * driver, status, timestamps).
 *
 * @param {object} input
 * @param {string|object} input.partner A {@link DSP_PARTNERS} id/label, or a
 *   custom `{ id, label, category }`.
 * @param {string} input.externalAccountId The driver's account id at the DSP.
 * @param {object} input.payoutRate A variable payout rate card (see {@link validatePayoutRate}).
 * @param {string} [input.label] Driver-chosen display name for the link.
 * @param {object} [opts]
 * @param {Array} [opts.partners] Partner catalogue (defaults to {@link DSP_PARTNERS}).
 * @param {Array} [opts.rateTypes] Rate-type catalogue (defaults to {@link PAYOUT_RATE_TYPES}).
 * @returns {object} Normalized DSP link core.
 */
export function validateDspLink(input = {}, opts = {}) {
  const { partners = DSP_PARTNERS, rateTypes = PAYOUT_RATE_TYPES } = opts;

  if (input === null || typeof input !== 'object') {
    throw new DspError('A DSP link must be an object', 'DSP_FIELD');
  }

  const partner = resolvePartner(partners, input.partner);
  if (!partner) {
    const accepted = partners.map((p) => p.id).join(', ');
    throw new DspError(`Unknown DSP partner: ${input.partner}. Accepted: ${accepted}`, 'DSP_PARTNER');
  }

  const externalAccountId = normalizeText(input.externalAccountId, 'externalAccountId', { max: 128 });

  const label = input.label === undefined || input.label === null || input.label === ''
    ? null
    : normalizeText(input.label, 'label');

  const payoutRate = validatePayoutRate(input.payoutRate, { rateTypes });

  return {
    partner,
    externalAccountId,
    label,
    displayName: label ?? partner.label,
    payoutRate,
  };
}

/**
 * Create the DSP linking interface: a per-driver registry of DSP links, each
 * carrying its own variable payout rate card. A driver may link **multiple**
 * partners; the same partner cannot be linked twice unless the prior link was
 * unlinked.
 *
 * @param {object} [config]
 * @param {Map} [config.store] Per-driver link store (defaults in-memory).
 * @param {Array} [config.partners] Partner catalogue.
 * @param {Array} [config.rateTypes] Rate-type catalogue.
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 * @param {() => string} [config.generateId] Link id generator.
 */
export function createDspConnectionManager(config = {}) {
  const {
    store = new Map(),
    partners = DSP_PARTNERS,
    rateTypes = PAYOUT_RATE_TYPES,
    now = () => Date.now(),
    generateId = () => `dsp_${randomUUID()}`,
  } = config;

  if (!Array.isArray(partners) || partners.length === 0) {
    throw new DspError('At least one DSP partner is required', 'DSP_CONFIG');
  }
  if (!Array.isArray(rateTypes) || rateTypes.length === 0) {
    throw new DspError('At least one payout rate type is required', 'DSP_CONFIG');
  }

  const validateOpts = { partners, rateTypes };

  function requireDriver(driverId) {
    if (!driverId) {
      throw new DspError('A driverId is required', 'DSP_DRIVER');
    }
    let links = store.get(driverId);
    if (!links) {
      links = new Map();
      store.set(driverId, links);
    }
    return links;
  }

  function requireLink(driverId, linkId) {
    const links = store.get(driverId);
    const record = links && links.get(linkId);
    if (!record) {
      throw new DspError(`No DSP link "${linkId}" for driver "${driverId}"`, 'DSP_NOT_FOUND');
    }
    return record;
  }

  function ordered(links) {
    return [...links.values()].sort((a, b) => a.linkedAt - b.linkedAt || (a.seq - b.seq));
  }

  function snapshot(record) {
    const { seq, ...rest } = record;
    return deepFreeze(structuredClone(rest));
  }

  /**
   * Link a driver to a DSP partner. New links start `active` unless `status` is
   * given (e.g. `pending` while a connection is being verified).
   * @param {string} driverId
   * @param {object} input Link fields (see {@link validateDspLink}).
   * @param {object} [options]
   * @param {string} [options.status='active'] Initial lifecycle status.
   * @param {string} [options.id] Explicit link id (defaults to a generated one).
   * @returns {object} The stored, frozen link record.
   */
  function link(driverId, input, options = {}) {
    const links = requireDriver(driverId);
    const core = validateDspLink(input, validateOpts);

    for (const existing of links.values()) {
      if (existing.partner.id === core.partner.id && existing.status !== 'unlinked') {
        throw new DspError(
          `${core.partner.label} is already linked for this driver`,
          'DSP_DUPLICATE',
        );
      }
    }

    const status = options.status ?? 'active';
    if (!LINK_STATUSES.includes(status)) {
      throw new DspError(`Unknown link status: ${status}`, 'DSP_STATUS');
    }
    const id = options.id ?? generateId();
    if (links.has(id)) {
      throw new DspError(`Link id "${id}" already exists for this driver`, 'DSP_DUPLICATE');
    }

    const timestamp = now();
    const record = {
      id,
      driverId,
      ...core,
      status,
      linkedAt: timestamp,
      updatedAt: timestamp,
      seq: links.size,
    };
    links.set(id, record);
    return snapshot(record);
  }

  /** Get one link (frozen) or throw `DSP_NOT_FOUND`. */
  function get(driverId, linkId) {
    return snapshot(requireLink(driverId, linkId));
  }

  /**
   * List a driver's DSP links (oldest-linked first).
   * @param {string} driverId
   * @param {object} [filter]
   * @param {string} [filter.status] Only links in this lifecycle status.
   * @param {string} [filter.category] Only links whose partner is in this category.
   * @returns {object[]} Frozen link records.
   */
  function list(driverId, filter = {}) {
    const links = store.get(driverId);
    if (!links) return [];
    let records = ordered(links);
    if (filter.status !== undefined) {
      if (!LINK_STATUSES.includes(filter.status)) {
        throw new DspError(`Unknown link status: ${filter.status}`, 'DSP_STATUS');
      }
      records = records.filter((l) => l.status === filter.status);
    }
    if (filter.category !== undefined) {
      records = records.filter((l) => l.partner.category === filter.category);
    }
    return records.map(snapshot);
  }

  /** List a driver's active links. */
  function listActive(driverId) {
    return list(driverId, { status: 'active' });
  }

  /**
   * Replace a link's variable payout rate card.
   * @returns {object} The updated, frozen link record.
   */
  function updateRate(driverId, linkId, payoutRate) {
    const record = requireLink(driverId, linkId);
    record.payoutRate = validatePayoutRate(payoutRate, { rateTypes });
    record.updatedAt = now();
    return snapshot(record);
  }

  /**
   * Update a link's descriptive fields (`label`, `externalAccountId`, and — via a
   * whole new card — `payoutRate`). The partner of an existing link cannot be
   * changed; unlink and link a different partner instead.
   * @returns {object} The updated, frozen link record.
   */
  function update(driverId, linkId, patch = {}) {
    const record = requireLink(driverId, linkId);
    if (patch === null || typeof patch !== 'object') {
      throw new DspError('A link patch must be an object', 'DSP_FIELD');
    }
    if (patch.partner !== undefined) {
      throw new DspError('A link\'s partner cannot be changed', 'DSP_FIELD');
    }
    const merged = {
      partner: record.partner,
      externalAccountId: patch.externalAccountId ?? record.externalAccountId,
      label: patch.label !== undefined ? patch.label : record.label,
      payoutRate: patch.payoutRate ?? record.payoutRate,
    };
    const core = validateDspLink(merged, validateOpts);
    record.externalAccountId = core.externalAccountId;
    record.label = core.label;
    record.displayName = core.displayName;
    record.payoutRate = core.payoutRate;
    record.updatedAt = now();
    return snapshot(record);
  }

  /**
   * Change a link's lifecycle status.
   * @returns {object} The updated, frozen link record.
   */
  function setStatus(driverId, linkId, status) {
    if (!LINK_STATUSES.includes(status)) {
      throw new DspError(`Unknown link status: ${status}`, 'DSP_STATUS');
    }
    const record = requireLink(driverId, linkId);
    if (record.status !== status) {
      record.status = status;
      record.updatedAt = now();
    }
    return snapshot(record);
  }

  /** Mark a link active. */
  function activate(driverId, linkId) {
    return setStatus(driverId, linkId, 'active');
  }

  /** Suspend a link (temporarily paused). */
  function suspend(driverId, linkId) {
    return setStatus(driverId, linkId, 'suspended');
  }

  /** Unlink a partner (its slot frees up so it can be linked again later). */
  function unlink(driverId, linkId) {
    return setStatus(driverId, linkId, 'unlinked');
  }

  /**
   * Estimate the payout for a batch of work under a link's variable rate card.
   * @param {string} driverId
   * @param {string} linkId
   * @param {object} [work] Work batch (see {@link computePayout}).
   * @param {object} [options] `{ peak }` (see {@link computePayout}).
   * @returns {object} Frozen payout breakdown.
   */
  function estimatePayout(driverId, linkId, work = {}, options = {}) {
    const record = requireLink(driverId, linkId);
    return computePayout(record.payoutRate, work, options);
  }

  /**
   * Remove a link from the registry entirely.
   * @returns {boolean} Whether a link was removed.
   */
  function remove(driverId, linkId) {
    const links = store.get(driverId);
    if (!links || !links.has(linkId)) return false;
    links.delete(linkId);
    return true;
  }

  return {
    link,
    get,
    list,
    listActive,
    updateRate,
    update,
    setStatus,
    activate,
    suspend,
    unlink,
    estimatePayout,
    remove,
    store,
  };
}
