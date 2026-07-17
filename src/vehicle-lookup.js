// Vehicle specification lookup by license plate registration number.
//
// During Business & Vehicle Setup a driver enters their vehicle's license
// plate (registration number). Rather than make them hand-type every field,
// this endpoint fetches the vehicle's **specifications** from a registration
// authority (e.g. a DVLA Vehicle Enquiry-style service) and returns them in a
// normalized shape the Vehicle Registry (see vehicles.js) can consume — the
// resolved fuel/EV powertrain type, model year, colour, engine capacity, etc.
//
// Like the rest of the module this is dependency-free: the network call is an
// injectable `provider` function, so the lookup logic — registration
// normalization, fuel-type resolution, spec normalization, caching and the
// HTTP-shaped response mapping — is fully testable without a real service.

import { FUEL_TYPES } from './vehicles.js';

export class VehicleLookupError extends Error {
  constructor(message, code = 'VEHICLE_LOOKUP_INVALID') {
    super(message);
    this.name = 'VehicleLookupError';
    this.code = code;
  }
}

// Free-text fuel descriptions a registration authority may return, mapped to
// the canonical catalogue ids in FUEL_TYPES. Keys are compared case- and
// separator-insensitively (see canonicalizeFuelKey).
const FUEL_SYNONYMS = {
  petrol: 'gasoline',
  gasoline: 'gasoline',
  gas: 'gasoline',
  diesel: 'diesel',
  'heavy oil': 'diesel',
  hybrid: 'hybrid',
  'hybrid electric': 'hybrid',
  hev: 'hybrid',
  'plug in hybrid': 'plug_in_hybrid',
  'plug in hybrid electric': 'plug_in_hybrid',
  'plug in electric hybrid': 'plug_in_hybrid',
  phev: 'plug_in_hybrid',
  'petrol plug in hybrid': 'plug_in_hybrid',
  'diesel plug in hybrid': 'plug_in_hybrid',
  'petrol plug in electric hybrid': 'plug_in_hybrid',
  'diesel plug in electric hybrid': 'plug_in_hybrid',
  electric: 'battery_electric',
  electricity: 'battery_electric',
  'battery electric': 'battery_electric',
  bev: 'battery_electric',
  ev: 'battery_electric',
  hydrogen: 'hydrogen_fuel_cell',
  'fuel cell': 'hydrogen_fuel_cell',
  'hydrogen fuel cell': 'hydrogen_fuel_cell',
  fcev: 'hydrogen_fuel_cell',
};

function canonicalizeFuelKey(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[_/-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Resolve a raw fuel description to a catalogue entry from {@link FUEL_TYPES}.
 * Matches by canonical id, by label, and via a synonym table so authority
 * descriptions like "PETROL" or "ELECTRICITY" resolve. Returns `null` when the
 * description cannot be mapped (the raw text is preserved on the spec instead).
 * @param {Array} catalogue Fuel/EV catalogue.
 * @param {string} value Raw fuel description.
 * @returns {object|null}
 */
export function resolveFuelDescription(catalogue, value) {
  if (typeof value !== 'string') return null;
  const key = canonicalizeFuelKey(value);
  if (!key) return null;
  const byId = catalogue.find((f) => f.id.toLowerCase() === key.replace(/ /g, '_'));
  if (byId) return byId;
  const byLabel = catalogue.find((f) => canonicalizeFuelKey(f.label) === key);
  if (byLabel) return byLabel;
  const mapped = FUEL_SYNONYMS[key];
  return mapped ? catalogue.find((f) => f.id === mapped) ?? null : null;
}

/**
 * Normalize a license plate registration number into its canonical lookup key:
 * upper-cased, with spaces and hyphens stripped. This is the form used both to
 * query the provider and to key the cache, so "ab12 cde" and "AB12-CDE" hit the
 * same entry.
 * @param {string} raw The registration number as entered.
 * @returns {string} The canonical registration.
 */
export function normalizeRegistration(raw) {
  if (typeof raw !== 'string') {
    throw new VehicleLookupError('A registration number is required', 'VEHICLE_LOOKUP_PLATE');
  }
  const registration = raw.trim().toUpperCase().replace(/[\s-]+/g, '');
  if (!registration) {
    throw new VehicleLookupError('A registration number is required', 'VEHICLE_LOOKUP_PLATE');
  }
  if (!/^[A-Z0-9]{1,11}$/.test(registration)) {
    throw new VehicleLookupError(
      'A registration number must be 1-11 letters or digits',
      'VEHICLE_LOOKUP_PLATE',
    );
  }
  return registration;
}

// --- raw-field coercion --------------------------------------------------

function firstDefined(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function coerceText(value) {
  if (typeof value !== 'string') {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
  }
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed || null;
}

function coerceYear(value, { minYear, maxYear }) {
  const year = typeof value === 'string' && /^\d{4}$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof year !== 'number' || !Number.isInteger(year)) return null;
  if (year < minYear || year > maxYear) return null;
  return year;
}

function coerceCount(value) {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
    Object.freeze(obj);
  }
  return obj;
}

/**
 * Normalize a raw provider response into a canonical vehicle specification.
 * Accepts common field aliases (make/manufacturer, year/yearOfManufacture,
 * fuelType/fuel, colour/color, engineCapacity/engineCapacityCc, …). Missing or
 * unparseable fields become `null` rather than throwing — provider data is
 * frequently partial — while the original payload is preserved under `raw`.
 *
 * @param {string} registration Canonical registration (see {@link normalizeRegistration}).
 * @param {object} raw The provider's response payload.
 * @param {object} [opts]
 * @param {Array} [opts.fuelTypes] Fuel/EV catalogue (defaults to {@link FUEL_TYPES}).
 * @param {number} [opts.minYear=1900] Oldest plausible model year.
 * @param {number} [opts.maxYear] Newest plausible model year (defaults to next year).
 * @param {() => number} [opts.now] Clock in ms (used for the default maxYear).
 * @returns {object} Normalized specification.
 */
export function normalizeSpecification(registration, raw, opts = {}) {
  const {
    fuelTypes = FUEL_TYPES,
    now = () => Date.now(),
    minYear = 1900,
    maxYear = new Date(now()).getUTCFullYear() + 1,
  } = opts;

  if (raw === null || typeof raw !== 'object') {
    throw new VehicleLookupError('Provider returned a malformed specification', 'VEHICLE_LOOKUP_PROVIDER');
  }

  const fuelRaw = coerceText(firstDefined(raw, ['fuelType', 'fuel', 'fuelDescription', 'powertrain']));
  const fuel = fuelRaw ? resolveFuelDescription(fuelTypes, fuelRaw) : null;

  return {
    registration,
    make: coerceText(firstDefined(raw, ['make', 'manufacturer'])),
    model: coerceText(firstDefined(raw, ['model'])),
    year: coerceYear(firstDefined(raw, ['year', 'yearOfManufacture', 'manufactureYear']), { minYear, maxYear }),
    fuel: fuel
      ? {
          id: fuel.id,
          label: fuel.label,
          category: fuel.category,
          combustion: fuel.combustion,
          chargeable: fuel.chargeable,
        }
      : null,
    fuelDescription: fuelRaw,
    colour: coerceText(firstDefined(raw, ['colour', 'color'])),
    engineCapacityCc: coerceCount(firstDefined(raw, ['engineCapacityCc', 'engineCapacity', 'engineCc'])),
    co2Emissions: coerceCount(firstDefined(raw, ['co2Emissions', 'co2'])),
  };
}

/**
 * Create the vehicle-specification lookup endpoint. Given a driver-supplied
 * license plate registration number it queries an injectable `provider` and
 * returns normalized specifications; results are optionally cached.
 *
 * @param {object} config
 * @param {(registration: string) => (object|null|Promise<object|null>)} config.provider
 *   Fetches the raw specification for a canonical registration. Should return
 *   `null`/`undefined` for an unknown plate; any thrown error is surfaced as a
 *   `VEHICLE_LOOKUP_PROVIDER` failure.
 * @param {Array} [config.fuelTypes] Fuel/EV catalogue (defaults to {@link FUEL_TYPES}).
 * @param {Map} [config.cache] Cache store (Map-like get/set); omit to disable caching.
 * @param {number} [config.ttlMs] Cache entry lifetime in ms (defaults to no expiry).
 * @param {number} [config.minYear] Oldest plausible model year.
 * @param {number} [config.maxYear] Newest plausible model year.
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 * @returns {{ lookup: Function, handle: Function }}
 */
export function createVehicleLookup(config = {}) {
  const {
    provider,
    fuelTypes = FUEL_TYPES,
    cache,
    ttlMs,
    minYear = 1900,
    maxYear,
    now = () => Date.now(),
  } = config;

  if (typeof provider !== 'function') {
    throw new VehicleLookupError('A provider function is required', 'VEHICLE_LOOKUP_CONFIG');
  }
  if (!Array.isArray(fuelTypes) || fuelTypes.length === 0) {
    throw new VehicleLookupError('At least one fuel/EV type is required', 'VEHICLE_LOOKUP_CONFIG');
  }
  if (cache !== undefined && (cache === null || typeof cache.get !== 'function' || typeof cache.set !== 'function')) {
    throw new VehicleLookupError('cache must be a Map-like store', 'VEHICLE_LOOKUP_CONFIG');
  }

  const normalizeOpts = { fuelTypes, minYear, now };
  if (maxYear !== undefined) normalizeOpts.maxYear = maxYear;

  function finalize(spec, source) {
    return deepFreeze({ ...spec, source, fetchedAt: now() });
  }

  function cached(registration) {
    if (!cache) return null;
    const entry = cache.get(registration);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      cache.delete?.(registration);
      return null;
    }
    return entry.spec;
  }

  /**
   * Fetch a vehicle's specifications by its license plate registration number.
   * @param {string} registrationInput The registration as entered.
   * @param {object} [options]
   * @param {boolean} [options.force] Bypass the cache and re-query the provider.
   * @returns {Promise<object>} Frozen normalized specification.
   */
  async function lookup(registrationInput, options = {}) {
    const registration = normalizeRegistration(registrationInput);

    if (!options.force) {
      const hit = cached(registration);
      if (hit) return finalize(hit, 'cache');
    }

    let raw;
    try {
      raw = await provider(registration);
    } catch (err) {
      throw new VehicleLookupError(
        `Registration lookup failed: ${err && err.message ? err.message : err}`,
        'VEHICLE_LOOKUP_PROVIDER',
      );
    }

    if (raw === null || raw === undefined) {
      throw new VehicleLookupError(
        `No vehicle found for registration "${registration}"`,
        'VEHICLE_LOOKUP_NOT_FOUND',
      );
    }

    const spec = normalizeSpecification(registration, raw, normalizeOpts);
    if (cache) {
      const expiresAt = typeof ttlMs === 'number' && ttlMs > 0 ? now() + ttlMs : null;
      cache.set(registration, { spec, expiresAt });
    }
    return finalize(spec, 'provider');
  }

  /**
   * HTTP-shaped adapter over {@link lookup}: maps a request to a status/body
   * response instead of throwing on expected failures, so it can back a route
   * like `GET /vehicles/specifications?registration=AB12CDE`.
   * @param {object|string} request Either the registration string or an object
   *   carrying it under `registration`/`plate` (e.g. parsed query/path params).
   * @returns {Promise<{ status: number, body: object }>}
   */
  async function handle(request) {
    const registration = typeof request === 'string'
      ? request
      : request && (request.registration ?? request.plate);
    try {
      const vehicle = await lookup(registration);
      return { status: 200, body: { vehicle } };
    } catch (err) {
      if (!(err instanceof VehicleLookupError)) throw err;
      const status = {
        VEHICLE_LOOKUP_PLATE: 400,
        VEHICLE_LOOKUP_NOT_FOUND: 404,
        VEHICLE_LOOKUP_PROVIDER: 502,
      }[err.code] ?? 500;
      return { status, body: { error: { code: err.code, message: err.message } } };
    }
  }

  return { lookup, handle };
}
