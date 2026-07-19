// Shift start/end recording for RoutePilot drivers.
//
// A "shift" is the unit of work a driver logs mileage, breaks and expenses
// against: it opens when they start driving and closes when they stop, each
// edge stamped with a timestamp and the location the client reported (the
// server never geolocates on its own — lat/long always comes from the
// caller, matching how the mobile app already has GPS access). Only one
// shift can be open per driver at a time.
//
// Storage is a `repo`: `{ insert, findActiveByDriver, findById, update,
// listByDriver }`, async so it can be backed by Postgres in production
// (createPostgresShiftRepo) or an in-memory Map in tests/local dev
// (createInMemoryShiftRepo, the default) — same pattern as session.js.
// Both repos return copies, never live references — a caller must call
// `repo.update()` to persist a mutation to breaks/waits/trip/status.

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

const EARTH_RADIUS_MILES = 3958.8;

// Great-circle distance between two { lat, long } points, in miles.
function haversineMiles(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLong = toRad(b.long - a.long);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLong / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function roundDistance(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function validateOdometerReading(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ShiftError(`${field} must be a non-negative finite number`, 'SHIFT_ODOMETER');
  }
  return value;
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
    Object.freeze(obj);
  }
  return obj;
}

/** In-memory shift repo (default) — nested Map-backed, async interface. */
export function createInMemoryShiftRepo() {
  const byDriver = new Map(); // driverId -> Map(shiftId -> record)

  function driverShifts(driverId) {
    let shifts = byDriver.get(driverId);
    if (!shifts) {
      shifts = new Map();
      byDriver.set(driverId, shifts);
    }
    return shifts;
  }

  return {
    async insert(record) {
      driverShifts(record.driverId).set(record.id, structuredClone(record));
    },
    async findActiveByDriver(driverId) {
      const shifts = byDriver.get(driverId);
      if (!shifts) return null;
      for (const shift of shifts.values()) {
        if (shift.status === 'active') return structuredClone(shift);
      }
      return null;
    },
    async findById(driverId, shiftId) {
      const shifts = byDriver.get(driverId);
      const record = shifts && shifts.get(shiftId);
      return record ? structuredClone(record) : null;
    },
    async update(record) {
      driverShifts(record.driverId).set(record.id, structuredClone(record));
    },
    async listByDriver(driverId) {
      const shifts = byDriver.get(driverId);
      if (!shifts) return [];
      return [...shifts.values()].sort((a, b) => a.startedAt - b.startedAt).map((r) => structuredClone(r));
    },
  };
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * Postgres-backed shift repo. Expects a `shifts` table (see db/migrations)
 * with `breaks`/`waits`/`trip`/location fields as JSONB.
 * @param {import('@neondatabase/serverless').NeonQueryFunction<false,false>} sql
 */
export function createPostgresShiftRepo(sql) {
  function fromRow(row) {
    return {
      id: row.id,
      driverId: row.driver_id,
      status: row.status,
      startedAt: Number(row.started_at),
      startLocation: parseJsonColumn(row.start_location, null),
      endedAt: row.ended_at === null ? null : Number(row.ended_at),
      endLocation: parseJsonColumn(row.end_location, null),
      breaks: parseJsonColumn(row.breaks, []),
      waits: parseJsonColumn(row.waits, []),
      trip: parseJsonColumn(row.trip, { gpsPoints: [], gpsDistanceMiles: 0, odometer: null }),
    };
  }

  return {
    async insert(record) {
      await sql`
        INSERT INTO shifts (id, driver_id, status, started_at, start_location, ended_at, end_location, breaks, waits, trip)
        VALUES (
          ${record.id}, ${record.driverId}, ${record.status}, ${record.startedAt},
          ${JSON.stringify(record.startLocation)}::jsonb, ${record.endedAt},
          ${record.endLocation ? JSON.stringify(record.endLocation) : null}::jsonb,
          ${JSON.stringify(record.breaks)}::jsonb, ${JSON.stringify(record.waits)}::jsonb, ${JSON.stringify(record.trip)}::jsonb
        )
      `;
    },
    async findActiveByDriver(driverId) {
      const rows = await sql`SELECT * FROM shifts WHERE driver_id = ${driverId} AND status = 'active' LIMIT 1`;
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async findById(driverId, shiftId) {
      const rows = await sql`SELECT * FROM shifts WHERE driver_id = ${driverId} AND id = ${shiftId} LIMIT 1`;
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async update(record) {
      await sql`
        UPDATE shifts SET
          status = ${record.status},
          ended_at = ${record.endedAt},
          end_location = ${record.endLocation ? JSON.stringify(record.endLocation) : null}::jsonb,
          breaks = ${JSON.stringify(record.breaks)}::jsonb,
          waits = ${JSON.stringify(record.waits)}::jsonb,
          trip = ${JSON.stringify(record.trip)}::jsonb
        WHERE id = ${record.id}
      `;
    },
    async listByDriver(driverId) {
      const rows = await sql`SELECT * FROM shifts WHERE driver_id = ${driverId} ORDER BY started_at ASC`;
      return rows.map(fromRow);
    },
  };
}

/**
 * Create the shift tracker.
 * @param {object} [config]
 * @param {{insert:Function, findActiveByDriver:Function, findById:Function, update:Function, listByDriver:Function}} [config.repo] Shift repo (defaults to an in-memory one).
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 * @param {() => string} [config.generateId] Shift id generator.
 */
export function createShiftTracker(config = {}) {
  const {
    repo = createInMemoryShiftRepo(),
    now = () => Date.now(),
    generateId = () => `shift_${randomUUID()}`,
  } = config;

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
   * @returns {Promise<object>} The new, frozen shift record.
   */
  async function startShift(driverId, input = {}) {
    if (!driverId) {
      throw new ShiftError('A driverId is required', 'SHIFT_DRIVER');
    }
    if (await repo.findActiveByDriver(driverId)) {
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
      breaks: [],
      waits: [],
      trip: { gpsPoints: [], gpsDistanceMiles: 0, odometer: null },
    };
    await repo.insert(record);
    return snapshot(record);
  }

  /**
   * End a driver's currently active shift.
   * @param {string} driverId
   * @param {object} input
   * @param {number} input.lat
   * @param {number} input.long
   * @param {number} [input.at] Timestamp override (ms since epoch).
   * @returns {Promise<object>} The updated, frozen shift record.
   * @throws {ShiftError} `SHIFT_NOT_ACTIVE` if the driver has no open shift.
   */
  async function endShift(driverId, input = {}) {
    const record = await repo.findActiveByDriver(driverId);
    if (!record) {
      throw new ShiftError(`Driver "${driverId}" has no active shift`, 'SHIFT_NOT_ACTIVE');
    }
    const location = validateLocation(input);
    record.status = 'completed';
    record.endedAt = input.at ?? now();
    record.endLocation = location;
    await repo.update(record);
    return snapshot(record);
  }

  // Breaks and wait periods share the same start/end/duration shape and
  // single-open-at-a-time rule, so both are driven through these two
  // helpers, parameterized by which list ('breaks' or 'waits') they touch.

  async function startPeriod(driverId, listKey, alreadyActiveCode, input) {
    const record = await repo.findActiveByDriver(driverId);
    if (!record) {
      throw new ShiftError(`Driver "${driverId}" has no active shift`, 'SHIFT_NOT_ACTIVE');
    }
    const list = record[listKey];
    if (list.some((p) => p.endedAt === null)) {
      const label = listKey === 'breaks' ? 'break' : 'wait period';
      throw new ShiftError(`A ${label} is already in progress`, alreadyActiveCode);
    }
    list.push({ id: randomUUID(), startedAt: input.at ?? now(), endedAt: null, durationMs: null });
    await repo.update(record);
    return snapshot(record);
  }

  async function endPeriod(driverId, listKey, notActiveCode, input) {
    const record = await repo.findActiveByDriver(driverId);
    if (!record) {
      throw new ShiftError(`Driver "${driverId}" has no active shift`, 'SHIFT_NOT_ACTIVE');
    }
    const open = record[listKey].find((p) => p.endedAt === null);
    if (!open) {
      const label = listKey === 'breaks' ? 'break' : 'wait period';
      throw new ShiftError(`No ${label} is in progress`, notActiveCode);
    }
    open.endedAt = input.at ?? now();
    open.durationMs = open.endedAt - open.startedAt;
    await repo.update(record);
    return snapshot(record);
  }

  /**
   * Start a break during the driver's active shift.
   * @param {string} driverId
   * @param {object} [input] `{ at }` timestamp override.
   * @returns {Promise<object>} The updated, frozen shift record.
   */
  function startBreak(driverId, input = {}) {
    return startPeriod(driverId, 'breaks', 'SHIFT_BREAK_ALREADY_ACTIVE', input);
  }

  /** End the driver's in-progress break. */
  function endBreak(driverId, input = {}) {
    return endPeriod(driverId, 'breaks', 'SHIFT_BREAK_NOT_ACTIVE', input);
  }

  /**
   * Start a wait period (e.g. waiting for a delivery pickup) during the
   * driver's active shift.
   * @param {string} driverId
   * @param {object} [input] `{ at }` timestamp override.
   * @returns {Promise<object>} The updated, frozen shift record.
   */
  function startWait(driverId, input = {}) {
    return startPeriod(driverId, 'waits', 'SHIFT_WAIT_ALREADY_ACTIVE', input);
  }

  /** End the driver's in-progress wait period. */
  function endWait(driverId, input = {}) {
    return endPeriod(driverId, 'waits', 'SHIFT_WAIT_NOT_ACTIVE', input);
  }

  async function requireShift(driverId, shiftId) {
    const record = await repo.findById(driverId, shiftId);
    if (!record) {
      throw new ShiftError(`No shift "${shiftId}" for driver "${driverId}"`, 'SHIFT_NOT_FOUND');
    }
    return record;
  }

  /**
   * Append one GPS point to the active shift's trip and accumulate the
   * distance from the previous point (haversine great-circle distance, in
   * miles). The first point of a trip has nothing to accumulate against.
   * @param {string} driverId
   * @param {object} input `{ lat, long, at? }`
   * @returns {Promise<object>} The updated, frozen shift record.
   */
  async function addGpsPoint(driverId, input = {}) {
    const record = await repo.findActiveByDriver(driverId);
    if (!record) {
      throw new ShiftError(`Driver "${driverId}" has no active shift`, 'SHIFT_NOT_ACTIVE');
    }
    const location = validateLocation(input);
    const point = { lat: location.lat, long: location.long, at: input.at ?? now() };
    const { gpsPoints } = record.trip;
    if (gpsPoints.length > 0) {
      record.trip.gpsDistanceMiles = roundDistance(
        record.trip.gpsDistanceMiles + haversineMiles(gpsPoints[gpsPoints.length - 1], point),
      );
    }
    gpsPoints.push(point);
    await repo.update(record);
    return snapshot(record);
  }

  /**
   * Record a manual odometer start/end reading for the active shift's trip.
   * When present, this takes precedence over GPS-accumulated distance (see
   * {@link getTripDistance}) — the driver's own reading is treated as ground
   * truth over an inferred one.
   * @param {string} driverId
   * @param {object} input `{ startMiles, endMiles }`
   * @returns {Promise<object>} The updated, frozen shift record.
   */
  async function setOdometer(driverId, input = {}) {
    const record = await repo.findActiveByDriver(driverId);
    if (!record) {
      throw new ShiftError(`Driver "${driverId}" has no active shift`, 'SHIFT_NOT_ACTIVE');
    }
    const startMiles = validateOdometerReading(input.startMiles, 'startMiles');
    const endMiles = validateOdometerReading(input.endMiles, 'endMiles');
    if (endMiles < startMiles) {
      throw new ShiftError('endMiles cannot be less than startMiles', 'SHIFT_ODOMETER');
    }
    record.trip.odometer = { startMiles, endMiles };
    await repo.update(record);
    return snapshot(record);
  }

  /**
   * The trip distance for a shift: the manual odometer reading when one has
   * been recorded, otherwise the GPS-accumulated distance.
   * @returns {Promise<{ distanceMiles: number, source: 'odometer'|'gps' }>}
   */
  async function getTripDistance(driverId, shiftId) {
    const record = await requireShift(driverId, shiftId);
    if (record.trip.odometer) {
      const { startMiles, endMiles } = record.trip.odometer;
      return { distanceMiles: roundDistance(endMiles - startMiles), source: 'odometer' };
    }
    return { distanceMiles: record.trip.gpsDistanceMiles, source: 'gps' };
  }

  /**
   * Total break and wait time logged against a shift (active or completed).
   * Any still-open period (not yet ended) contributes nothing — end it first
   * to have it counted.
   * @returns {Promise<{ totalBreakMs: number, totalWaitMs: number }>}
   */
  async function getDurations(driverId, shiftId) {
    const record = await requireShift(driverId, shiftId);
    const sum = (periods) => periods.reduce((total, p) => total + (p.durationMs ?? 0), 0);
    return { totalBreakMs: sum(record.breaks), totalWaitMs: sum(record.waits) };
  }

  /** Get a driver's currently active shift, or `null`. */
  async function getActive(driverId) {
    const record = await repo.findActiveByDriver(driverId);
    return record ? snapshot(record) : null;
  }

  /** Get one shift by id, or `null`. */
  async function get(driverId, shiftId) {
    const record = await repo.findById(driverId, shiftId);
    return record ? snapshot(record) : null;
  }

  /** List a driver's shifts, oldest first. */
  async function list(driverId) {
    const records = await repo.listByDriver(driverId);
    return records.map(snapshot);
  }

  return {
    startShift,
    endShift,
    startBreak,
    endBreak,
    startWait,
    endWait,
    getDurations,
    addGpsPoint,
    setOdometer,
    getTripDistance,
    getActive,
    get,
    list,
    repo,
  };
}
