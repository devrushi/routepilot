// Fuel purchase and EV charging session logging, plus the currency/volume
// converters RoutePilot needs to compare costs across currencies and units.
//
// A driver logs either a fuel purchase (amount + currency, volume + unit) or
// an EV charging session (cost + currency, kWh). Every record is normalized
// at write time — amounts to a base currency, fuel volume to liters — so
// downstream reporting (expense totals, cost-per-mile, anomaly checks) never
// has to re-derive comparable units from mixed currencies/unit systems.
//
// Logs are insert-only (never mutated after creation), so the repo is
// simpler than shifts.js/session.js's: just `insert`/`findById`/
// `listByDriver`, no `update`. Async so it can be backed by Postgres in
// production (createPostgresFuelRepo) or an in-memory Map in tests/local
// dev (createInMemoryFuelRepo, the default).

import { randomUUID } from 'node:crypto';

export class FuelError extends Error {
  constructor(message, code = 'FUEL_INVALID') {
    super(message);
    this.name = 'FuelError';
    this.code = code;
  }
}

export const BASE_CURRENCY = 'USD';

/**
 * Static, illustrative USD-per-unit exchange rates — NOT live market data.
 * Pass `rates` to `createFuelLogger`/`convertCurrency` to override with real
 * rates from a provider.
 */
export const DEFAULT_EXCHANGE_RATES = {
  USD: 1,
  GBP: 1.27,
  EUR: 1.08,
  CAD: 0.73,
  AUD: 0.66,
};

const LITERS_PER_GALLON = 3.785411784; // exact US liquid gallon

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundVolume(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function validateAmount(value, field, code, { min = 0 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new FuelError(`${field} must be a finite number >= ${min}`, code);
  }
  return value;
}

function normalizeCurrencyCode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value.trim())) {
    throw new FuelError('Currency must be a 3-letter ISO 4217 code', 'FUEL_CURRENCY');
  }
  return value.trim().toUpperCase();
}

const VOLUME_UNIT_ALIASES = {
  l: 'liter', liter: 'liter', liters: 'liter', litre: 'liter', litres: 'liter',
  gal: 'gallon', gallon: 'gallon', gallons: 'gallon',
};

function normalizeVolumeUnit(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const unit = VOLUME_UNIT_ALIASES[key];
  if (!unit) {
    throw new FuelError(`Unknown volume unit: ${value}. Expected liters or gallons`, 'FUEL_UNIT');
  }
  return unit;
}

/**
 * Convert a currency amount to another currency via USD-per-unit rates.
 * @param {number} amount
 * @param {string} fromCurrency ISO 4217 code.
 * @param {string} [toCurrency='USD'] ISO 4217 code.
 * @param {Record<string, number>} [rates] USD value of one unit of each currency.
 * @returns {number} Amount in `toCurrency`, rounded to cents.
 */
export function convertCurrency(amount, fromCurrency, toCurrency = BASE_CURRENCY, rates = DEFAULT_EXCHANGE_RATES) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new FuelError('amount must be a finite number', 'FUEL_AMOUNT');
  }
  const value = amount;
  const from = normalizeCurrencyCode(fromCurrency);
  const to = normalizeCurrencyCode(toCurrency);
  if (!(from in rates)) {
    throw new FuelError(`No exchange rate configured for currency: ${from}`, 'FUEL_CURRENCY');
  }
  if (!(to in rates)) {
    throw new FuelError(`No exchange rate configured for currency: ${to}`, 'FUEL_CURRENCY');
  }
  return roundMoney((value * rates[from]) / rates[to]);
}

/**
 * Convert a fuel volume between liters and gallons (US liquid gallon).
 * @param {number} amount
 * @param {string} fromUnit 'liter'/'l' or 'gallon'/'gal' (case-insensitive).
 * @param {string} toUnit Same accepted forms.
 * @returns {number} Converted amount, rounded to 3 decimal places.
 */
export function convertVolume(amount, fromUnit, toUnit) {
  const value = validateAmount(amount, 'volume', 'FUEL_VOLUME');
  const from = normalizeVolumeUnit(fromUnit);
  const to = normalizeVolumeUnit(toUnit);
  const liters = from === 'liter' ? value : value * LITERS_PER_GALLON;
  const result = to === 'liter' ? liters : liters / LITERS_PER_GALLON;
  return roundVolume(result);
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
    Object.freeze(obj);
  }
  return obj;
}

/** In-memory fuel log repo (default) — nested Map-backed, async interface. */
export function createInMemoryFuelRepo() {
  const byDriver = new Map(); // driverId -> Map(id -> record)

  function driverLogs(driverId) {
    let logs = byDriver.get(driverId);
    if (!logs) {
      logs = new Map();
      byDriver.set(driverId, logs);
    }
    return logs;
  }

  return {
    async insert(record) {
      driverLogs(record.driverId).set(record.id, structuredClone(record));
    },
    async findById(driverId, id) {
      const logs = byDriver.get(driverId);
      const record = logs && logs.get(id);
      return record ? structuredClone(record) : null;
    },
    async listByDriver(driverId, filter = {}) {
      const logs = byDriver.get(driverId);
      if (!logs) return [];
      let records = [...logs.values()].sort((a, b) => a.at - b.at);
      if (filter.type !== undefined) {
        records = records.filter((r) => r.type === filter.type);
      }
      return records.map((r) => structuredClone(r));
    },
  };
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * Postgres-backed fuel log repo. Expects a `fuel_logs` table (see
 * db/migrations) with the full record stored as JSONB (`data`) alongside
 * indexed `driver_id`/`type`/`at` columns for filtering/sorting.
 * @param {import('@neondatabase/serverless').NeonQueryFunction<false,false>} sql
 */
export function createPostgresFuelRepo(sql) {
  function fromRow(row) {
    return { ...parseJsonColumn(row.data, {}), id: row.id, driverId: row.driver_id, type: row.type, at: Number(row.at) };
  }

  return {
    async insert(record) {
      await sql`
        INSERT INTO fuel_logs (id, driver_id, type, at, data)
        VALUES (${record.id}, ${record.driverId}, ${record.type}, ${record.at}, ${JSON.stringify(record)}::jsonb)
      `;
    },
    async findById(driverId, id) {
      const rows = await sql`SELECT * FROM fuel_logs WHERE driver_id = ${driverId} AND id = ${id} LIMIT 1`;
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async listByDriver(driverId, filter = {}) {
      const rows = filter.type !== undefined
        ? await sql`SELECT * FROM fuel_logs WHERE driver_id = ${driverId} AND type = ${filter.type} ORDER BY at ASC`
        : await sql`SELECT * FROM fuel_logs WHERE driver_id = ${driverId} ORDER BY at ASC`;
      return rows.map(fromRow);
    },
  };
}

/**
 * Create the fuel/charging session logger.
 * @param {object} [config]
 * @param {{insert:Function, findById:Function, listByDriver:Function}} [config.repo] Fuel log repo (defaults to an in-memory one).
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 * @param {() => string} [config.generateId] Record id generator.
 * @param {Record<string, number>} [config.rates] Exchange rates for currency normalization.
 */
export function createFuelLogger(config = {}) {
  const {
    repo = createInMemoryFuelRepo(),
    now = () => Date.now(),
    generateId = () => `fuel_${randomUUID()}`,
    rates = DEFAULT_EXCHANGE_RATES,
  } = config;

  function snapshot(record) {
    return deepFreeze(structuredClone(record));
  }

  /**
   * Log a fuel purchase.
   * @param {string} driverId
   * @param {object} input
   * @param {number} input.amount Amount paid.
   * @param {string} input.currency ISO 4217 code.
   * @param {number} input.volume Fuel volume.
   * @param {string} input.unit 'liter' or 'gallon'.
   * @param {number} [input.at] Timestamp override (ms since epoch).
   * @returns {Promise<object>} The stored, frozen log record.
   */
  async function logFuelPurchase(driverId, input = {}) {
    if (!driverId) {
      throw new FuelError('A driverId is required', 'FUEL_DRIVER');
    }
    const amount = validateAmount(input.amount, 'amount', 'FUEL_AMOUNT');
    const currency = normalizeCurrencyCode(input.currency);
    const volume = validateAmount(input.volume, 'volume', 'FUEL_VOLUME');
    const unit = normalizeVolumeUnit(input.unit);
    const record = {
      id: generateId(),
      driverId,
      type: 'fuel',
      amount,
      currency,
      amountBase: convertCurrency(amount, currency, BASE_CURRENCY, rates),
      baseCurrency: BASE_CURRENCY,
      volume,
      unit,
      volumeLiters: convertVolume(volume, unit, 'liter'),
      at: input.at ?? now(),
    };
    await repo.insert(record);
    return snapshot(record);
  }

  /**
   * Log an EV charging session.
   * @param {string} driverId
   * @param {object} input
   * @param {number} input.cost Amount paid.
   * @param {string} input.currency ISO 4217 code.
   * @param {number} input.kWh Energy delivered.
   * @param {number} [input.at] Timestamp override (ms since epoch).
   * @returns {Promise<object>} The stored, frozen log record.
   */
  async function logChargingSession(driverId, input = {}) {
    if (!driverId) {
      throw new FuelError('A driverId is required', 'FUEL_DRIVER');
    }
    const cost = validateAmount(input.cost, 'cost', 'FUEL_AMOUNT');
    const currency = normalizeCurrencyCode(input.currency);
    const kWh = validateAmount(input.kWh, 'kWh', 'FUEL_KWH');
    const record = {
      id: generateId(),
      driverId,
      type: 'charging',
      cost,
      currency,
      costBase: convertCurrency(cost, currency, BASE_CURRENCY, rates),
      baseCurrency: BASE_CURRENCY,
      kWh,
      at: input.at ?? now(),
    };
    await repo.insert(record);
    return snapshot(record);
  }

  /** Get one log record, or `null`. */
  async function get(driverId, id) {
    const record = await repo.findById(driverId, id);
    return record ? snapshot(record) : null;
  }

  /**
   * List a driver's logs, oldest first.
   * @param {string} driverId
   * @param {object} [filter]
   * @param {'fuel'|'charging'} [filter.type]
   */
  async function list(driverId, filter = {}) {
    const records = await repo.listByDriver(driverId, filter);
    return records.map(snapshot);
  }

  return { logFuelPurchase, logChargingSession, get, list, repo };
}
