// Background worker that syncs route histories from primary delivery partner
// portals.
//
// Once a driver has connected their delivery partners (see dsp.js — Amazon
// Flex, DoorDash, Uber Eats, …) RoutePilot needs their **route history**: the
// blocks/offers they actually worked, with the deliveries, miles, hours and
// earnings each carried (_Driver Onboarding & Financial Profile › Business &
// Vehicle Setup › DSP Connection_). That history is what later drives income
// verification and payout reconciliation, so it must be pulled from each
// partner portal continuously in the background rather than on demand.
//
// This module is the dependency-free core of that worker. The partner portals
// are reached through a single injectable `portal` function, so all of the real
// logic — incremental (cursor-based) fetching, per-route normalization,
// dedupe/upsert into a route store, per-link sync state, resilient multi-link
// sweeps and interval scheduling — is fully testable without a network or real
// timers. It reads active links straight from a DSP connection manager (dsp.js)
// so the two compose directly.

import { randomUUID } from 'node:crypto';

export class RouteSyncError extends Error {
  constructor(message, code = 'ROUTE_SYNC_INVALID') {
    super(message);
    this.name = 'RouteSyncError';
    this.code = code;
  }
}

/**
 * Lifecycle a synced route can be in. Portal payloads use many spellings for
 * these (see {@link normalizeStatus}); they are collapsed onto this catalogue.
 */
export const ROUTE_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'];

const STATUS_SYNONYMS = {
  scheduled: 'scheduled',
  pending: 'scheduled',
  upcoming: 'scheduled',
  offered: 'scheduled',
  accepted: 'scheduled',
  in_progress: 'in_progress',
  inprogress: 'in_progress',
  active: 'in_progress',
  ongoing: 'in_progress',
  started: 'in_progress',
  enroute: 'in_progress',
  completed: 'completed',
  complete: 'completed',
  delivered: 'completed',
  finished: 'completed',
  done: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  aborted: 'cancelled',
  abandoned: 'cancelled',
  missed: 'cancelled',
  forfeited: 'cancelled',
};

// --- raw-field coercion (mirrors the tolerant style of vehicle-lookup.js) --

function firstDefined(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function coerceText(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed || null;
}

function coerceNumber(value) {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return n;
}

function coerceCount(value) {
  const n = coerceNumber(value);
  return n === null ? null : Math.round(n);
}

/** Round a currency amount to whole cents, avoiding binary-float drift. */
function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function coerceMoney(value) {
  const n = coerceNumber(value);
  return n === null ? null : roundMoney(n);
}

/**
 * Coerce a portal timestamp to epoch milliseconds. Accepts a number (ms, or
 * seconds when clearly a 10-digit unix time), a numeric string, or an ISO-8601
 * date string. Returns `null` when it cannot be parsed.
 */
function coerceTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: unix seconds are ~1e9-1e10; ms are ~1e12+. Promote seconds.
    return value > 0 && value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) return coerceTimestamp(Number(trimmed));
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function coerceCurrency(value) {
  if (typeof value !== 'string') return null;
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

/**
 * Collapse a raw portal status onto a {@link ROUTE_STATUSES} id, or `null` when
 * it is absent/unrecognized (the raw text is kept on the route as
 * `statusDescription`).
 * @param {*} value Raw status/state field.
 * @returns {string|null}
 */
export function normalizeStatus(value) {
  const text = coerceText(value);
  if (!text) return null;
  const key = text.toLowerCase().replace(/[\s-]+/g, '_');
  if (STATUS_SYNONYMS[key]) return STATUS_SYNONYMS[key];
  return STATUS_SYNONYMS[key.replace(/_/g, '')] ?? null;
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
    Object.freeze(obj);
  }
  return obj;
}

/**
 * Normalize one raw route record from a partner portal into the canonical shape
 * the rest of RoutePilot consumes. Field aliases common across portals are
 * accepted (routeId/blockId/id, startTime/startedAt, distanceMiles/miles, …).
 * The `work` sub-object is deliberately shaped like a `computePayout` work batch
 * (see dsp.js) so a synced route can be re-priced against a link's rate card.
 *
 * A route MUST carry an id — that is its dedupe key across syncs — otherwise a
 * `ROUTE_SYNC_ROUTE` error is thrown. Every other field degrades to `null` when
 * missing or unparseable; the untouched payload is preserved under `raw`.
 *
 * @param {string} partnerId The DSP partner id the route came from.
 * @param {object} raw The portal's route payload.
 * @returns {object} Normalized route.
 */
export function normalizeRoute(partnerId, raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RouteSyncError('A route record must be an object', 'ROUTE_SYNC_ROUTE');
  }

  const id = coerceText(firstDefined(raw, ['id', 'routeId', 'route_id', 'blockId', 'block_id', 'offerId']));
  if (!id) {
    throw new RouteSyncError('A route record is missing an id', 'ROUTE_SYNC_ROUTE');
  }

  const startedAt = coerceTimestamp(firstDefined(raw, [
    'startedAt', 'startTime', 'startAt', 'start', 'scheduledStart', 'startedAtMs',
  ]));
  const completedAt = coerceTimestamp(firstDefined(raw, [
    'completedAt', 'endTime', 'endAt', 'end', 'finishedAt', 'completedAtMs',
  ]));

  const statusRaw = coerceText(firstDefined(raw, ['status', 'state']));
  const status = normalizeStatus(statusRaw);

  const work = {
    deliveries: coerceCount(firstDefined(raw, ['deliveries', 'stops', 'stopCount', 'packages', 'packageCount'])) ?? 0,
    miles: coerceNumber(firstDefined(raw, ['miles', 'distanceMiles', 'distance', 'mileage'])) ?? 0,
    hours: coerceNumber(firstDefined(raw, ['hours', 'durationHours'])) ?? 0,
    orderValue: coerceMoney(firstDefined(raw, ['orderValue', 'basketValue', 'subtotal'])) ?? 0,
  };

  return {
    id,
    partner: partnerId,
    status,
    statusDescription: statusRaw,
    startedAt,
    completedAt,
    work,
    earnings: coerceMoney(firstDefined(raw, ['earnings', 'pay', 'payout', 'totalPay', 'amount', 'total'])),
    currency: coerceCurrency(firstDefined(raw, ['currency', 'currencyCode'])),
    raw,
  };
}

// The moment used to advance a link's incremental cursor: prefer when the route
// finished, fall back to when it started.
function routeCursor(route) {
  return route.completedAt ?? route.startedAt ?? null;
}

/**
 * Create the route-history sync worker.
 *
 * The worker pulls each active DSP link's route history from its partner portal
 * incrementally: it remembers a per-link cursor (the newest route moment seen)
 * and only asks the portal for routes `since` that point. Fetched routes are
 * normalized and upserted (deduped by route id) into a per-driver/per-link
 * route store.
 *
 * @param {object} config
 * @param {(query: {driverId: string, partner: string, externalAccountId: string, since: number|null, linkId: string}) => (Array|Promise<Array>)} config.portal
 *   Fetches raw route records for one link. Should return an array (possibly
 *   empty); any thrown error surfaces as `ROUTE_SYNC_PORTAL`.
 * @param {object} [config.connections] A DSP connection manager (dsp.js). When
 *   given, the worker discovers drivers and their active links from it.
 * @param {(driverId: string) => Array} [config.listActiveLinks] Override for how
 *   a driver's syncable links are listed (defaults to `connections.listActive`).
 * @param {() => Array<string>} [config.listDriverIds] Override for how driver
 *   ids are discovered (defaults to the keys of `connections.store`).
 * @param {Map} [config.store] Route store (per-driver → per-link state); in-memory by default.
 * @param {number} [config.intervalMs] Default sweep interval for {@link start}.
 * @param {(fn: Function, ms: number) => *} [config.setInterval] Scheduler (defaults to global setInterval).
 * @param {(handle: *) => void} [config.clearInterval] Descheduler (defaults to global clearInterval).
 * @param {(report: object) => void} [config.onRun] Called with each sweep's report.
 * @param {(error: Error) => void} [config.onError] Called if a scheduled sweep throws.
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 */
export function createRouteHistorySyncWorker(config = {}) {
  const {
    portal,
    connections,
    store = new Map(),
    intervalMs: defaultIntervalMs,
    onRun,
    onError,
    now = () => Date.now(),
    generateId = () => `sync_${randomUUID()}`,
  } = config;

  const setIntervalFn = config.setInterval ?? setInterval;
  const clearIntervalFn = config.clearInterval ?? clearInterval;

  if (typeof portal !== 'function') {
    throw new RouteSyncError('A portal function is required', 'ROUTE_SYNC_CONFIG');
  }

  const listDriverIds = config.listDriverIds
    ?? (connections ? () => [...connections.store.keys()] : null);
  const listActiveLinks = config.listActiveLinks
    ?? (connections ? (driverId) => connections.listActive(driverId) : null);

  if (typeof listActiveLinks !== 'function' || typeof listDriverIds !== 'function') {
    throw new RouteSyncError(
      'A DSP connection manager (or listActiveLinks + listDriverIds) is required',
      'ROUTE_SYNC_CONFIG',
    );
  }

  let timer = null;

  function driverBucket(driverId) {
    let bucket = store.get(driverId);
    if (!bucket) {
      bucket = new Map();
      store.set(driverId, bucket);
    }
    return bucket;
  }

  function linkState(driverId, linkId) {
    const bucket = driverBucket(driverId);
    let state = bucket.get(linkId);
    if (!state) {
      state = { cursor: null, lastRunAt: null, lastError: null, routes: new Map() };
      bucket.set(linkId, state);
    }
    return state;
  }

  function requireLinkState(driverId, linkId) {
    const bucket = store.get(driverId);
    const state = bucket && bucket.get(linkId);
    if (!state) {
      throw new RouteSyncError(
        `No sync state for link "${linkId}" of driver "${driverId}"`,
        'ROUTE_SYNC_NOT_FOUND',
      );
    }
    return state;
  }

  /**
   * Sync a single link's route history from its partner portal.
   * @param {string} driverId
   * @param {object} link A DSP link record (needs `id`, `partner.id`, `externalAccountId`).
   * @param {object} [options]
   * @param {number|null} [options.since] Override the incremental cursor for this run.
   * @param {boolean} [options.full] Ignore the stored cursor and refetch from the start.
   * @returns {Promise<object>} A frozen summary of the sync.
   */
  async function syncLink(driverId, link, options = {}) {
    if (!driverId) throw new RouteSyncError('A driverId is required', 'ROUTE_SYNC_DRIVER');
    if (link === null || typeof link !== 'object' || !link.id) {
      throw new RouteSyncError('A link with an id is required', 'ROUTE_SYNC_LINK');
    }
    const partner = link.partner && typeof link.partner === 'object' ? link.partner.id : link.partner;
    if (!partner) {
      throw new RouteSyncError('A link partner is required', 'ROUTE_SYNC_LINK');
    }

    const state = linkState(driverId, link.id);
    const since = options.since !== undefined
      ? options.since
      : (options.full ? null : state.cursor);

    let rawList;
    try {
      rawList = await portal({
        driverId,
        linkId: link.id,
        partner,
        externalAccountId: link.externalAccountId ?? null,
        since,
      });
    } catch (err) {
      state.lastError = err && err.message ? err.message : String(err);
      throw new RouteSyncError(
        `Route sync failed for ${partner}: ${state.lastError}`,
        'ROUTE_SYNC_PORTAL',
      );
    }

    if (rawList === null || rawList === undefined) rawList = [];
    if (!Array.isArray(rawList)) {
      state.lastError = 'portal did not return an array of routes';
      throw new RouteSyncError(
        `Route portal for ${partner} must return an array of routes`,
        'ROUTE_SYNC_PORTAL',
      );
    }

    let added = 0;
    let updated = 0;
    let skipped = 0;
    let cursor = state.cursor;
    const syncedAt = now();

    for (const raw of rawList) {
      let route;
      try {
        route = normalizeRoute(partner, raw);
      } catch {
        skipped += 1; // a single malformed record must not abort the sweep
        continue;
      }
      const existed = state.routes.has(route.id);
      state.routes.set(route.id, { ...route, driverId, linkId: link.id, syncedAt });
      if (existed) updated += 1; else added += 1;

      const ts = routeCursor(route);
      if (ts !== null && (cursor === null || ts > cursor)) cursor = ts;
    }

    state.cursor = cursor;
    state.lastRunAt = syncedAt;
    state.lastError = null;

    return deepFreeze({
      driverId,
      linkId: link.id,
      partner,
      since,
      fetched: rawList.length,
      added,
      updated,
      skipped,
      total: state.routes.size,
      cursor,
      syncedAt,
    });
  }

  /**
   * Sync every active link of one driver, isolating per-link failures.
   * @param {string} driverId
   * @param {object} [options] Forwarded to {@link syncLink}.
   * @returns {Promise<object>} `{ driverId, links, results, errors }`.
   */
  async function syncDriver(driverId, options = {}) {
    if (!driverId) throw new RouteSyncError('A driverId is required', 'ROUTE_SYNC_DRIVER');
    const links = listActiveLinks(driverId) ?? [];
    const results = [];
    const errors = [];
    for (const link of links) {
      try {
        results.push(await syncLink(driverId, link, options));
      } catch (err) {
        errors.push({
          driverId,
          linkId: link && link.id,
          partner: link && (link.partner?.id ?? link.partner),
          code: err instanceof RouteSyncError ? err.code : 'ROUTE_SYNC_INVALID',
          message: err && err.message ? err.message : String(err),
        });
      }
    }
    return { driverId, links: links.length, results, errors };
  }

  /**
   * Run one full sweep across drivers/links. Never throws for an individual
   * link — failures are collected into the report so the background loop keeps
   * running.
   * @param {object} [options]
   * @param {string} [options.driverId] Limit the sweep to a single driver.
   * @param {boolean} [options.full] Force a from-scratch refetch of every link.
   * @param {number|null} [options.since] Override the cursor for every link.
   * @returns {Promise<object>} An aggregate report.
   */
  async function runOnce(options = {}) {
    const driverIds = options.driverId ? [options.driverId] : listDriverIds();
    const runId = generateId();
    const startedAt = now();

    const report = {
      runId,
      startedAt,
      drivers: 0,
      links: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      results: [],
      errors: [],
    };

    for (const driverId of driverIds) {
      const driverReport = await syncDriver(driverId, options);
      report.drivers += 1;
      report.links += driverReport.links;
      for (const result of driverReport.results) {
        report.results.push(result);
        report.added += result.added;
        report.updated += result.updated;
        report.skipped += result.skipped;
      }
      report.errors.push(...driverReport.errors);
    }

    report.finishedAt = now();
    return deepFreeze(report);
  }

  /**
   * Start the background worker: run a sweep now (unless `immediate:false`) and
   * then on every interval. Idempotent-guarded — starting an already-running
   * worker throws `ROUTE_SYNC_STATE`.
   * @param {object} [options]
   * @param {number} [options.intervalMs] Sweep interval (defaults to config.intervalMs).
   * @param {boolean} [options.immediate=true] Run one sweep synchronously on start.
   * @returns {{ stop: Function }}
   */
  function start(options = {}) {
    if (timer !== null) {
      throw new RouteSyncError('The route sync worker is already running', 'ROUTE_SYNC_STATE');
    }
    const interval = options.intervalMs ?? defaultIntervalMs;
    if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) {
      throw new RouteSyncError('A positive intervalMs is required to start', 'ROUTE_SYNC_CONFIG');
    }

    const tick = () => {
      Promise.resolve()
        .then(() => runOnce(options))
        .then((report) => { onRun?.(report); }, (err) => { onError?.(err); });
    };

    if (options.immediate !== false) tick();
    timer = setIntervalFn(tick, interval);
    return { stop };
  }

  /** Stop the background worker. Safe to call when not running. */
  function stop() {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  /** Whether the background worker is currently scheduled. */
  function isRunning() {
    return timer !== null;
  }

  /**
   * List a link's synced routes (newest first), optionally filtered by status.
   * @param {string} driverId
   * @param {string} linkId
   * @param {object} [filter]
   * @param {string} [filter.status] Only routes in this {@link ROUTE_STATUSES} status.
   * @returns {object[]} Frozen route records.
   */
  function listRoutes(driverId, linkId, filter = {}) {
    const bucket = store.get(driverId);
    const state = bucket && bucket.get(linkId);
    if (!state) return [];
    let routes = [...state.routes.values()];
    if (filter.status !== undefined) {
      if (!ROUTE_STATUSES.includes(filter.status)) {
        throw new RouteSyncError(`Unknown route status: ${filter.status}`, 'ROUTE_SYNC_STATUS');
      }
      routes = routes.filter((r) => r.status === filter.status);
    }
    routes.sort((a, b) => {
      const at = routeCursor(a) ?? 0;
      const bt = routeCursor(b) ?? 0;
      if (bt !== at) return bt - at;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return routes.map((r) => deepFreeze(structuredClone(r)));
  }

  /**
   * The sync state (cursor / last run / last error / route count) for one link.
   * @returns {object} A frozen snapshot.
   */
  function getSyncState(driverId, linkId) {
    const state = requireLinkState(driverId, linkId);
    return deepFreeze({
      driverId,
      linkId,
      cursor: state.cursor,
      lastRunAt: state.lastRunAt,
      lastError: state.lastError,
      routeCount: state.routes.size,
    });
  }

  return {
    syncLink,
    syncDriver,
    runOnce,
    start,
    stop,
    isRunning,
    listRoutes,
    getSyncState,
    store,
  };
}
