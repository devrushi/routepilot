// Shift start/end recording for RoutePilot drivers.
//
// A "shift" is the unit of work a driver logs mileage, breaks and expenses
// against: it opens when they start driving and closes when they stop, each
// edge stamped with a timestamp and the location the client reported (the
// server never geolocates on its own — lat/long always comes from the
// caller, matching how the mobile app already has GPS access). Only one
// shift can be open per driver at a time.

import { randomUUID } from 'node:crypto';

export class ShiftError extends Error {
  constructor(message, code = 'SHIFT_INVALID') {
    super(message);
    this.name = 'ShiftError';
    this.code = code;
  }
}

function validateLocation(location) {
  if (location === null || typeof location !== 'object') {
    throw new ShiftError('A location { lat, long } is required', 'SHIFT_LOCATION');
  }
  const { lat, long } = location;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new ShiftError('lat must be a finite number between -90 and 90', 'SHIFT_LOCATION');
  }
  if (typeof long !== 'number' || !Number.isFinite(long) || long < -180 || long > 180) {
    throw new ShiftError('long must be a finite number between -180 and 180', 'SHIFT_LOCATION');
  }
  return { lat, long };
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
    Object.freeze(obj);
  }
  return obj;
}

/**
 * Create the shift tracker.
 * @param {object} [config]
 * @param {Map} [config.store] Per-driver shift store (defaults in-memory).
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 * @param {() => string} [config.generateId] Shift id generator.
 */
export function createShiftTracker(config = {}) {
  const {
    store = new Map(),
    now = () => Date.now(),
    generateId = () => `shift_${randomUUID()}`,
  } = config;

  function requireDriverShifts(driverId) {
    if (!driverId) {
      throw new ShiftError('A driverId is required', 'SHIFT_DRIVER');
    }
    let shifts = store.get(driverId);
    if (!shifts) {
      shifts = new Map();
      store.set(driverId, shifts);
    }
    return shifts;
  }

  function findActive(driverId) {
    const shifts = store.get(driverId);
    if (!shifts) return null;
    for (const shift of shifts.values()) {
      if (shift.status === 'active') return shift;
    }
    return null;
  }

  function snapshot(record) {
    return deepFreeze(structuredClone(record));
  }

  /**
   * Start a shift for a driver. Fails if that driver already has one open.
   * @param {string} driverId
   * @param {object} input
   * @param {number} input.lat
   * @param {number} input.long
   * @param {number} [input.at] Timestamp override (ms since epoch).
   * @returns {object} The new, frozen shift record.
   */
  function startShift(driverId, input = {}) {
    const shifts = requireDriverShifts(driverId);
    if (findActive(driverId)) {
      throw new ShiftError(`Driver "${driverId}" already has an active shift`, 'SHIFT_ALREADY_ACTIVE');
    }
    const location = validateLocation(input);
    const startedAt = input.at ?? now();
    const record = {
      id: generateId(),
      driverId,
      status: 'active',
      startedAt,
      startLocation: location,
      endedAt: null,
      endLocation: null,
    };
    shifts.set(record.id, record);
    return snapshot(record);
  }

  /**
   * End a driver's currently active shift.
   * @param {string} driverId
   * @param {object} input
   * @param {number} input.lat
   * @param {number} input.long
   * @param {number} [input.at] Timestamp override (ms since epoch).
   * @returns {object} The updated, frozen shift record.
   * @throws {ShiftError} `SHIFT_NOT_ACTIVE` if the driver has no open shift.
   */
  function endShift(driverId, input = {}) {
    const record = findActive(driverId);
    if (!record) {
      throw new ShiftError(`Driver "${driverId}" has no active shift`, 'SHIFT_NOT_ACTIVE');
    }
    const location = validateLocation(input);
    record.status = 'completed';
    record.endedAt = input.at ?? now();
    record.endLocation = location;
    return snapshot(record);
  }

  /** Get a driver's currently active shift, or `null`. */
  function getActive(driverId) {
    const record = findActive(driverId);
    return record ? snapshot(record) : null;
  }

  /** Get one shift by id, or `null`. */
  function get(driverId, shiftId) {
    const shifts = store.get(driverId);
    const record = shifts && shifts.get(shiftId);
    return record ? snapshot(record) : null;
  }

  /** List a driver's shifts, oldest first. */
  function list(driverId) {
    const shifts = store.get(driverId);
    if (!shifts) return [];
    return [...shifts.values()].sort((a, b) => a.startedAt - b.startedAt).map(snapshot);
  }

  return { startShift, endShift, getActive, get, list, store };
}
