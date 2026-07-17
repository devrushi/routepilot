// Vehicle registry & schema for RoutePilot onboarding.
//
// After a driver declares how they do business (see onboarding.js) they set up
// the vehicle(s) they earn with. A driver is **not** limited to one car — a
// rideshare/delivery driver may keep several vehicles on the road at once and
// switch between them — so this module is a registry that supports *multiple
// active vehicles* per driver rather than a single primary record.
//
// This is the dependency-free schema + validation core for a stored vehicle:
// it knows the catalogue of **fuel / EV powertrain types** (and which extra
// fields — battery capacity, charge connector — an electric or plug-in vehicle
// carries), validates and normalizes a submitted vehicle *immediately* (VIN
// with its ISO 3779 check digit, model year, plate, powertrain-specific
// fields), and manages the lifecycle of each vehicle (active / inactive /
// retired) plus which active vehicle is the driver's `primary` one for the
// downstream financial-profile module.

import { randomUUID } from 'node:crypto';

export class VehicleError extends Error {
  constructor(message, code = 'VEHICLE_INVALID') {
    super(message);
    this.name = 'VehicleError';
    this.code = code;
  }
}

/**
 * Fuel / EV powertrain types a vehicle can be registered with, keyed by their
 * canonical id. `category` groups them (combustion / hybrid / electric),
 * `combustion` records whether the vehicle burns a liquid/gaseous fuel, and
 * `chargeable` records whether it plugs in to charge — the flag that gates the
 * EV-only fields (battery capacity + charge connector).
 */
export const FUEL_TYPES = [
  { id: 'gasoline', label: 'Gasoline', category: 'combustion', combustion: true, chargeable: false },
  { id: 'diesel', label: 'Diesel', category: 'combustion', combustion: true, chargeable: false },
  { id: 'hybrid', label: 'Hybrid (HEV)', category: 'hybrid', combustion: true, chargeable: false },
  { id: 'plug_in_hybrid', label: 'Plug-in hybrid (PHEV)', category: 'hybrid', combustion: true, chargeable: true },
  { id: 'battery_electric', label: 'Battery electric (BEV)', category: 'electric', combustion: false, chargeable: true },
  { id: 'hydrogen_fuel_cell', label: 'Hydrogen fuel cell (FCEV)', category: 'electric', combustion: false, chargeable: false },
];

/**
 * Charge connector standards accepted for chargeable (BEV / PHEV) vehicles.
 * `current` records whether the connector carries AC, DC or both.
 */
export const EV_CONNECTOR_TYPES = [
  { id: 'j1772', label: 'SAE J1772 (Type 1)', current: 'AC' },
  { id: 'type2', label: 'IEC 62196 Type 2 (Mennekes)', current: 'AC' },
  { id: 'ccs1', label: 'CCS Combo 1', current: 'DC' },
  { id: 'ccs2', label: 'CCS Combo 2', current: 'DC' },
  { id: 'chademo', label: 'CHAdeMO', current: 'DC' },
  { id: 'nacs', label: 'NACS (Tesla)', current: 'AC/DC' },
];

/** Lifecycle states a registered vehicle can be in. */
export const VEHICLE_STATUSES = ['active', 'inactive', 'retired'];

const MAX_BATTERY_KWH = 400; // generously above any road vehicle (semis ~ 900, cars < 250)

// --- VIN validation ------------------------------------------------------
//
// A VIN is 17 characters, using every letter except I, O and Q (excluded so
// they are never confused with 1 and 0). Position 9 is a check digit computed
// from a weighted modulus-11 of the transliterated VIN (ISO 3779 / 49 CFR 565).

const VIN_TRANSLITERATION = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
};

const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * Compute the ISO 3779 check character for a 17-character VIN (the value that
 * belongs in position 9). Returns a single character, `'0'`–`'9'` or `'X'`.
 * @param {string} vin A 17-character VIN (case-insensitive; I/O/Q rejected).
 * @returns {string}
 */
export function computeVinCheckDigit(vin) {
  const s = String(vin).trim().toUpperCase();
  if (s.length !== 17) {
    throw new VehicleError('A VIN must be 17 characters', 'VEHICLE_VIN_FORMAT');
  }
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const value = VIN_TRANSLITERATION[s[i]];
    if (value === undefined) {
      throw new VehicleError(`VIN contains an invalid character "${s[i]}"`, 'VEHICLE_VIN_FORMAT');
    }
    sum += value * VIN_WEIGHTS[i];
  }
  const remainder = sum % 11;
  return remainder === 10 ? 'X' : String(remainder);
}

/**
 * Validate a VIN and return its normalized (upper-cased, separator-stripped)
 * form. Throws a {@link VehicleError} on a malformed VIN or a check-digit
 * mismatch.
 * @param {string} raw The VIN as entered.
 * @returns {string} The normalized 17-character VIN.
 */
export function validateVin(raw) {
  if (typeof raw !== 'string') {
    throw new VehicleError('A VIN must be a string', 'VEHICLE_VIN_FORMAT');
  }
  const s = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(s)) {
    throw new VehicleError(
      'A VIN must be 17 characters using letters (except I, O, Q) and digits',
      'VEHICLE_VIN_FORMAT',
    );
  }
  const expected = computeVinCheckDigit(s);
  if (s[8] !== expected) {
    throw new VehicleError(
      `VIN check digit "${s[8]}" does not match the computed value "${expected}"`,
      'VEHICLE_VIN_INVALID',
    );
  }
  return s;
}

// --- Field helpers -------------------------------------------------------

function normalizeText(value, field, { max = 64 } = {}) {
  if (typeof value !== 'string') {
    throw new VehicleError(`${field} is required`, 'VEHICLE_FIELD');
  }
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    throw new VehicleError(`${field} is required`, 'VEHICLE_FIELD');
  }
  if (trimmed.length > max) {
    throw new VehicleError(`${field} must be at most ${max} characters`, 'VEHICLE_FIELD');
  }
  return trimmed;
}

function normalizeYear(value, { minYear, maxYear }) {
  const year = typeof value === 'string' && /^\d{4}$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof year !== 'number' || !Number.isInteger(year)) {
    throw new VehicleError('Model year must be a four-digit integer', 'VEHICLE_YEAR');
  }
  if (year < minYear || year > maxYear) {
    throw new VehicleError(`Model year must be between ${minYear} and ${maxYear}`, 'VEHICLE_YEAR');
  }
  return year;
}

function normalizePlate(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = typeof value === 'object' ? value.value : value;
  const region = typeof value === 'object' ? value.region : undefined;
  if (typeof raw !== 'string') {
    throw new VehicleError('License plate must be a string', 'VEHICLE_PLATE');
  }
  const plate = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!plate) return null;
  if (!/^[A-Z0-9][A-Z0-9 -]{0,10}$/.test(plate)) {
    throw new VehicleError('License plate must be 1-11 letters, digits, spaces or hyphens', 'VEHICLE_PLATE');
  }
  let normalizedRegion = null;
  if (region !== undefined && region !== null && region !== '') {
    if (typeof region !== 'string') {
      throw new VehicleError('License plate region must be a string', 'VEHICLE_PLATE');
    }
    normalizedRegion = region.trim().toUpperCase();
  }
  return { value: plate, region: normalizedRegion };
}

function resolveFuelType(catalogue, value) {
  if (typeof value !== 'string') return null;
  const needle = value.trim().toLowerCase();
  if (!needle) return null;
  return catalogue.find((f) => f.id.toLowerCase() === needle) ?? null;
}

function resolveConnector(catalogue, value) {
  if (typeof value !== 'string') return null;
  const needle = value.trim().toLowerCase();
  if (!needle) return null;
  return catalogue.find((c) => c.id.toLowerCase() === needle) ?? null;
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
    Object.freeze(obj);
  }
  return obj;
}

/**
 * Validate a vehicle and return its normalized schema core — the stored fields
 * that describe the vehicle itself, independent of any registry bookkeeping
 * (id, driver, status, timestamps). The `battery` sub-record is present only
 * for chargeable (BEV / PHEV) powertrains, carrying the EV-only fields.
 *
 * @param {object} input
 * @param {string} input.vin Vehicle identification number.
 * @param {string} input.make Manufacturer, e.g. "Toyota".
 * @param {string} input.model Model, e.g. "Prius".
 * @param {number|string} input.year Four-digit model year.
 * @param {string} input.fuelType Powertrain id from {@link FUEL_TYPES}.
 * @param {string} [input.nickname] Driver-chosen display name.
 * @param {string|object} [input.plate] License plate (string or `{ value, region }`).
 * @param {number} [input.batteryKwh] Usable battery capacity (required if chargeable).
 * @param {string} [input.connectorType] Charge connector id (required if chargeable).
 * @param {object} [opts]
 * @param {Array} [opts.fuelTypes] Fuel/EV catalogue (defaults to {@link FUEL_TYPES}).
 * @param {Array} [opts.connectorTypes] Connector catalogue (defaults to {@link EV_CONNECTOR_TYPES}).
 * @param {number} [opts.minYear=1900] Oldest accepted model year.
 * @param {number} [opts.maxYear] Newest accepted model year (defaults to next year).
 * @param {() => number} [opts.now] Clock in ms (used to derive the default maxYear).
 * @returns {object} Normalized vehicle core.
 */
export function validateVehicle(input = {}, opts = {}) {
  const {
    fuelTypes = FUEL_TYPES,
    connectorTypes = EV_CONNECTOR_TYPES,
    now = () => Date.now(),
    minYear = 1900,
    maxYear = new Date(now()).getUTCFullYear() + 1,
  } = opts;

  if (input === null || typeof input !== 'object') {
    throw new VehicleError('A vehicle must be an object', 'VEHICLE_FIELD');
  }

  const vin = validateVin(input.vin);
  const make = normalizeText(input.make, 'make');
  const model = normalizeText(input.model, 'model');
  const year = normalizeYear(input.year, { minYear, maxYear });
  const plate = normalizePlate(input.plate);

  const fuel = resolveFuelType(fuelTypes, input.fuelType);
  if (!fuel) {
    const accepted = fuelTypes.map((f) => f.id).join(', ');
    throw new VehicleError(
      `Unknown fuel/EV type: ${input.fuelType}. Accepted: ${accepted}`,
      'VEHICLE_FUEL_TYPE',
    );
  }

  const nickname =
    input.nickname === undefined || input.nickname === null || input.nickname === ''
      ? null
      : normalizeText(input.nickname, 'nickname');

  // EV-only fields (battery capacity + charge connector) apply *only* to
  // chargeable powertrains. For those they are required; for anything else they
  // must be omitted, so a gasoline car can never carry a connector by mistake.
  const hasBattery = input.batteryKwh !== undefined && input.batteryKwh !== null && input.batteryKwh !== '';
  const hasConnector = input.connectorType !== undefined && input.connectorType !== null && input.connectorType !== '';

  let battery = null;
  if (fuel.chargeable) {
    if (!hasConnector) {
      throw new VehicleError(`A ${fuel.label} vehicle requires a charge connector type`, 'VEHICLE_CONNECTOR');
    }
    const connector = resolveConnector(connectorTypes, input.connectorType);
    if (!connector) {
      const accepted = connectorTypes.map((c) => c.id).join(', ');
      throw new VehicleError(
        `Unknown charge connector: ${input.connectorType}. Accepted: ${accepted}`,
        'VEHICLE_CONNECTOR',
      );
    }
    if (!hasBattery) {
      throw new VehicleError(`A ${fuel.label} vehicle requires a battery capacity in kWh`, 'VEHICLE_BATTERY');
    }
    const capacityKwh = typeof input.batteryKwh === 'string' ? Number(input.batteryKwh) : input.batteryKwh;
    if (typeof capacityKwh !== 'number' || !Number.isFinite(capacityKwh) || capacityKwh <= 0 || capacityKwh > MAX_BATTERY_KWH) {
      throw new VehicleError(`Battery capacity must be a number between 0 and ${MAX_BATTERY_KWH} kWh`, 'VEHICLE_BATTERY');
    }
    battery = {
      capacityKwh,
      connector: { id: connector.id, label: connector.label, current: connector.current },
    };
  } else if (hasBattery || hasConnector) {
    throw new VehicleError(
      `Battery and connector fields only apply to chargeable vehicles, not a ${fuel.label}`,
      'VEHICLE_FIELD',
    );
  }

  return {
    vin,
    make,
    model,
    year,
    nickname,
    displayName: nickname ?? `${year} ${make} ${model}`,
    plate,
    fuel: {
      id: fuel.id,
      label: fuel.label,
      category: fuel.category,
      combustion: fuel.combustion,
      chargeable: fuel.chargeable,
    },
    battery,
  };
}

/**
 * Create a vehicle registry that manages a driver's fleet. A driver may keep
 * **multiple active vehicles**; exactly one of the active vehicles is flagged
 * as `primary` (auto-assigned to the first, and re-assigned when a primary is
 * deactivated, retired or removed).
 *
 * @param {object} [config]
 * @param {Map} [config.store] Per-driver vehicle store (defaults in-memory).
 * @param {Array} [config.fuelTypes] Fuel/EV catalogue.
 * @param {Array} [config.connectorTypes] Connector catalogue.
 * @param {number} [config.minYear] Oldest accepted model year.
 * @param {number} [config.maxYear] Newest accepted model year.
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 * @param {() => string} [config.generateId] Vehicle id generator.
 */
export function createVehicleRegistry(config = {}) {
  const {
    store = new Map(),
    fuelTypes = FUEL_TYPES,
    connectorTypes = EV_CONNECTOR_TYPES,
    minYear = 1900,
    maxYear,
    now = () => Date.now(),
    generateId = () => `veh_${randomUUID()}`,
  } = config;

  if (!Array.isArray(fuelTypes) || fuelTypes.length === 0) {
    throw new VehicleError('At least one fuel/EV type is required', 'VEHICLE_CONFIG');
  }
  if (!Array.isArray(connectorTypes) || connectorTypes.length === 0) {
    throw new VehicleError('At least one connector type is required', 'VEHICLE_CONFIG');
  }

  const validateOpts = { fuelTypes, connectorTypes, minYear, now };
  if (maxYear !== undefined) validateOpts.maxYear = maxYear;

  function requireDriver(driverId) {
    if (!driverId) {
      throw new VehicleError('A driverId is required', 'VEHICLE_DRIVER');
    }
    let fleet = store.get(driverId);
    if (!fleet) {
      fleet = new Map();
      store.set(driverId, fleet);
    }
    return fleet;
  }

  function requireVehicle(driverId, vehicleId) {
    const fleet = store.get(driverId);
    const record = fleet && fleet.get(vehicleId);
    if (!record) {
      throw new VehicleError(`No vehicle "${vehicleId}" for driver "${driverId}"`, 'VEHICLE_NOT_FOUND');
    }
    return record;
  }

  // Ordered snapshot of a fleet (oldest-added first), for stable listings and
  // deterministic primary re-assignment.
  function ordered(fleet) {
    return [...fleet.values()].sort((a, b) => a.addedAt - b.addedAt || (a.seq - b.seq));
  }

  // Ensure exactly one active vehicle is primary. If the current primary is no
  // longer active (or gone), promote the earliest-added active vehicle.
  function reconcilePrimary(fleet) {
    const active = ordered(fleet).filter((v) => v.status === 'active');
    const current = active.find((v) => v.primary);
    for (const v of fleet.values()) {
      if (v.status !== 'active' && v.primary) v.primary = false;
    }
    if (active.length === 0) return;
    if (current) {
      for (const v of active) v.primary = v === current;
    } else {
      active.forEach((v, i) => { v.primary = i === 0; });
    }
  }

  function snapshot(record) {
    const { seq, ...rest } = record;
    return deepFreeze(structuredClone(rest));
  }

  /**
   * Register a new vehicle for a driver. Newly added vehicles start `active`.
   * @param {string} driverId
   * @param {object} input Vehicle fields (see {@link validateVehicle}).
   * @param {object} [options]
   * @param {boolean} [options.primary] Make this the driver's primary vehicle.
   * @param {string} [options.status='active'] Initial lifecycle status.
   * @param {string} [options.id] Explicit vehicle id (defaults to a generated one).
   * @returns {object} The stored, frozen vehicle record.
   */
  function add(driverId, input, options = {}) {
    const fleet = requireDriver(driverId);
    const core = validateVehicle(input, validateOpts);

    for (const existing of fleet.values()) {
      if (existing.vin === core.vin && existing.status !== 'retired') {
        throw new VehicleError(
          `Vehicle with VIN ${core.vin} is already registered for this driver`,
          'VEHICLE_DUPLICATE',
        );
      }
    }

    const status = options.status ?? 'active';
    if (!VEHICLE_STATUSES.includes(status)) {
      throw new VehicleError(`Unknown vehicle status: ${status}`, 'VEHICLE_STATUS');
    }
    const id = options.id ?? generateId();
    if (fleet.has(id)) {
      throw new VehicleError(`Vehicle id "${id}" already exists for this driver`, 'VEHICLE_DUPLICATE');
    }

    const timestamp = now();
    const record = {
      id,
      driverId,
      ...core,
      status,
      primary: false,
      addedAt: timestamp,
      updatedAt: timestamp,
      seq: fleet.size,
    };
    fleet.set(id, record);

    if (options.primary === true && status === 'active') {
      for (const v of fleet.values()) v.primary = false;
      record.primary = true;
    }
    reconcilePrimary(fleet);
    return snapshot(record);
  }

  /** Get one vehicle (frozen) or throw `VEHICLE_NOT_FOUND`. */
  function get(driverId, vehicleId) {
    return snapshot(requireVehicle(driverId, vehicleId));
  }

  /**
   * List a driver's vehicles (oldest-added first).
   * @param {string} driverId
   * @param {object} [filter]
   * @param {string} [filter.status] Only vehicles in this lifecycle status.
   * @param {string} [filter.fuelCategory] Only vehicles in this fuel category.
   * @returns {object[]} Frozen vehicle records.
   */
  function list(driverId, filter = {}) {
    const fleet = store.get(driverId);
    if (!fleet) return [];
    let records = ordered(fleet);
    if (filter.status !== undefined) {
      if (!VEHICLE_STATUSES.includes(filter.status)) {
        throw new VehicleError(`Unknown vehicle status: ${filter.status}`, 'VEHICLE_STATUS');
      }
      records = records.filter((v) => v.status === filter.status);
    }
    if (filter.fuelCategory !== undefined) {
      records = records.filter((v) => v.fuel.category === filter.fuelCategory);
    }
    return records.map(snapshot);
  }

  /** List a driver's active vehicles (there may be more than one). */
  function listActive(driverId) {
    return list(driverId, { status: 'active' });
  }

  /** Get the driver's primary active vehicle, or `null` if none is active. */
  function getPrimary(driverId) {
    const fleet = store.get(driverId);
    if (!fleet) return null;
    const primary = ordered(fleet).find((v) => v.status === 'active' && v.primary);
    return primary ? snapshot(primary) : null;
  }

  // Rebuild the raw (pre-normalization) input from a stored record so a patch
  // can be merged and the whole vehicle re-validated as a unit.
  function rawFromRecord(record) {
    return {
      vin: record.vin,
      make: record.make,
      model: record.model,
      year: record.year,
      nickname: record.nickname ?? undefined,
      plate: record.plate ? { value: record.plate.value, region: record.plate.region } : undefined,
      fuelType: record.fuel.id,
      batteryKwh: record.battery ? record.battery.capacityKwh : undefined,
      connectorType: record.battery ? record.battery.connector.id : undefined,
    };
  }

  /**
   * Update a vehicle's descriptive fields. The patch is merged over the current
   * values and the whole vehicle is re-validated, so e.g. switching to a
   * chargeable fuel type requires supplying battery/connector fields too.
   * Lifecycle (`status`) and `primary` are managed via their own methods.
   * @returns {object} The updated, frozen vehicle record.
   */
  function update(driverId, vehicleId, patch = {}) {
    const record = requireVehicle(driverId, vehicleId);
    if (patch === null || typeof patch !== 'object') {
      throw new VehicleError('A vehicle patch must be an object', 'VEHICLE_FIELD');
    }
    const merged = { ...rawFromRecord(record), ...patch };
    const core = validateVehicle(merged, validateOpts);

    if (core.vin !== record.vin) {
      const fleet = store.get(driverId);
      for (const existing of fleet.values()) {
        if (existing !== record && existing.vin === core.vin && existing.status !== 'retired') {
          throw new VehicleError(
            `Vehicle with VIN ${core.vin} is already registered for this driver`,
            'VEHICLE_DUPLICATE',
          );
        }
      }
    }

    Object.assign(record, core);
    record.updatedAt = now();
    return snapshot(record);
  }

  /**
   * Change a vehicle's lifecycle status. Deactivating or retiring the current
   * primary re-assigns primary to another active vehicle.
   * @returns {object} The updated, frozen vehicle record.
   */
  function setStatus(driverId, vehicleId, status) {
    if (!VEHICLE_STATUSES.includes(status)) {
      throw new VehicleError(`Unknown vehicle status: ${status}`, 'VEHICLE_STATUS');
    }
    const record = requireVehicle(driverId, vehicleId);
    const fleet = store.get(driverId);
    if (record.status !== status) {
      record.status = status;
      if (status !== 'active') record.primary = false;
      record.updatedAt = now();
      reconcilePrimary(fleet);
    }
    return snapshot(record);
  }

  /** Mark a vehicle active. */
  function activate(driverId, vehicleId) {
    return setStatus(driverId, vehicleId, 'active');
  }

  /** Mark a vehicle inactive (temporarily off the road). */
  function deactivate(driverId, vehicleId) {
    return setStatus(driverId, vehicleId, 'inactive');
  }

  /** Retire a vehicle permanently (its VIN may be re-registered later). */
  function retire(driverId, vehicleId) {
    return setStatus(driverId, vehicleId, 'retired');
  }

  /**
   * Make an active vehicle the driver's primary one, clearing the flag on the
   * others. The target must be active.
   * @returns {object} The updated, frozen vehicle record.
   */
  function setPrimary(driverId, vehicleId) {
    const record = requireVehicle(driverId, vehicleId);
    if (record.status !== 'active') {
      throw new VehicleError('Only an active vehicle can be the primary vehicle', 'VEHICLE_STATUS');
    }
    const fleet = store.get(driverId);
    for (const v of fleet.values()) v.primary = v === record;
    record.updatedAt = now();
    return snapshot(record);
  }

  /**
   * Remove a vehicle from the registry entirely. Removing the primary re-assigns
   * primary to another active vehicle.
   * @returns {boolean} Whether a vehicle was removed.
   */
  function remove(driverId, vehicleId) {
    const fleet = store.get(driverId);
    if (!fleet || !fleet.has(vehicleId)) return false;
    fleet.delete(vehicleId);
    reconcilePrimary(fleet);
    return true;
  }

  return {
    add,
    get,
    list,
    listActive,
    getPrimary,
    update,
    setStatus,
    activate,
    deactivate,
    retire,
    setPrimary,
    remove,
    store,
  };
}
