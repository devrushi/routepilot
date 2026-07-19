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
 * In-memory route-sync repo (default) — same nested shape this module
 * always used internally (`driverId -> linkId -> { cursor, lastRunAt,
 * lastError, routes }`), just behind an async interface.
 */
export function createInMemoryRouteSyncRepo() {
  const byDriver = new Map(); // driverId -> Map(linkId -> { cursor, lastRunAt, lastError, routes: Map(routeId -> route) })

  function linkBucket(driverId, linkId) {
    let links = byDriver.get(driverId);
    if (!links) {
      links = new Map();
      byDriver.set(driverId, links);
    }
    let bucket = links.get(linkId);
    if (!bucket) {
      bucket = { cursor: null, lastRunAt: null, lastError: null, routes: new Map() };
      links.set(linkId, bucket);
    }
    return bucket;
  }

  return {
    async getLinkState(driverId, linkId) {
      const links = byDriver.get(driverId);
      const bucket = links && links.get(linkId);
      if (!bucket) return null;
      return { cursor: bucket.cursor, lastRunAt: bucket.lastRunAt, lastError: bucket.lastError };
    },
    async saveLinkState(driverId, linkId, state) {
      const bucket = linkBucket(driverId, linkId);
      bucket.cursor = state.cursor;
      bucket.lastRunAt = state.lastRunAt;
      bucket.lastError = state.lastError;
    },
    async listRouteIds(driverId, linkId) {
      const links = byDriver.get(driverId);
      const bucket = links && links.get(linkId);
      return bucket ? new Set(bucket.routes.keys()) : new Set();
    },
    async upsertRoute(driverId, linkId, route) {
      linkBucket(driverId, linkId).routes.set(route.id, structuredClone(route));
    },
    async countRoutes(driverId, linkId) {
      const links = byDriver.get(driverId);
      const bucket = links && links.get(linkId);
      return bucket ? bucket.routes.size : 0;
    },
    async listRoutes(driverId, linkId) {
      const links = byDriver.get(driverId);
      const bucket = links && links.get(linkId);
      return bucket ? [...bucket.routes.values()].map((r) => structuredClone(r)) : [];
    },
  };
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * Postgres-backed route-sync repo. Expects `route_sync_state` (one row per
 * driver+link) and `synced_routes` (one row per driver+link+route) tables
 * (see db/migrations).
 * @param {import('@neondatabase/serverless').NeonQueryFunction<false,false>} sql
 */
export function createPostgresRouteSyncRepo(sql) {
  function stateFromRow(row) {
    return {
      cursor: row.cursor === null ? null : Number(row.cursor),
      lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
      lastError: row.last_error,
    };
  }
  function routeFromRow(row) {
    return {
      id: row.route_id,
      driverId: row.driver_id,
      linkId: row.link_id,
      partner: row.partner,
      status: row.status,
      statusDescription: row.status_description,
      startedAt: row.started_at === null ? null : Number(row.started_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      work: parseJsonColumn(row.work, {}),
      earnings: row.earnings === null ? null : Number(row.earnings),
      currency: row.currency,
      raw: parseJsonColumn(row.raw, null),
      syncedAt: Number(row.synced_at),
    };
  }

  return {
    async getLinkState(driverId, linkId) {
      const rows = await sql`SELECT * FROM route_sync_state WHERE driver_id = ${driverId} AND link_id = ${linkId} LIMIT 1`;
      return rows[0] ? stateFromRow(rows[0]) : null;
    },
    async saveLinkState(driverId, linkId, state) {
      await sql`
        INSERT INTO route_sync_state (driver_id, link_id, cursor, last_run_at, last_error)
        VALUES (${driverId}, ${linkId}, ${state.cursor}, ${state.lastRunAt}, ${state.lastError})
        ON CONFLICT (driver_id, link_id) DO UPDATE SET
          cursor = EXCLUDED.cursor, last_run_at = EXCLUDED.last_run_at, last_error = EXCLUDED.last_error
      `;
    },
    async listRouteIds(driverId, linkId) {
      const rows = await sql`SELECT route_id FROM synced_routes WHERE driver_id = ${driverId} AND link_id = ${linkId}`;
      return new Set(rows.map((r) => r.route_id));
    },
    async upsertRoute(driverId, linkId, route) {
      await sql`
        INSERT INTO synced_routes (
          driver_id, link_id, route_id, partner, status, status_description,
          started_at, completed_at, work, earnings, currency, raw, synced_at
        )
        VALUES (
          ${driverId}, ${linkId}, ${route.id}, ${route.partner}, ${route.status}, ${route.statusDescription},
          ${route.startedAt}, ${route.completedAt}, ${JSON.stringify(route.work)}::jsonb,
          ${route.earnings}, ${route.currency}, ${JSON.stringify(route.raw)}::jsonb, ${route.syncedAt}
        )
        ON CONFLICT (driver_id, link_id, route_id) DO UPDATE SET
          partner = EXCLUDED.partner, status = EXCLUDED.status, status_description = EXCLUDED.status_description,
          started_at = EXCLUDED.started_at, completed_at = EXCLUDED.completed_at, work = EXCLUDED.work,
          earnings = EXCLUDED.earnings, currency = EXCLUDED.currency, raw = EXCLUDED.raw, synced_at = EXCLUDED.synced_at
      `;
    },
    async countRoutes(driverId, linkId) {
      const rows = await sql`SELECT COUNT(*)::int AS count FROM synced_routes WHERE driver_id = ${driverId} AND link_id = ${linkId}`;
      return rows[0]?.count ?? 0;
    },
    async listRoutes(driverId, linkId) {
      const rows = await sql`SELECT * FROM synced_routes WHERE driver_id = ${driverId} AND link_id = ${linkId}`;
      return rows.map(routeFromRow);
    },
  };
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
 * @param {(driverId: string) => (Array|Promise<Array>)} [config.listActiveLinks] Override for how
 *   a driver's syncable links are listed (defaults to `connections.listActive`).
 * @param {() => (Array<string>|Promise<Array<string>>)} [config.listDriverIds] Override for how driver
 *   ids are discovered (defaults to `connections.listDriverIds`).
 * @param {{getLinkState:Function, saveLinkState:Function, listRouteIds:Function, upsertRoute:Function, countRoutes:Function, listRoutes:Function}} [config.repo]
 *   Route-sync repo (defaults to an in-memory one).
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
    repo = createInMemoryRouteSyncRepo(),
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
    ?? (connections ? () => connections.listDriverIds() : null);
  const listActiveLinks = config.listActiveLinks
    ?? (connections ? (driverId) => connections.listActive(driverId) : null);

  if (typeof listActiveLinks !== 'function' || typeof listDriverIds !== 'function') {
    throw new RouteSyncError(
      'A DSP connection manager (or listActiveLinks + listDriverIds) is required',
      'ROUTE_SYNC_CONFIG',
    );
  }

  let timer = null;

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

    const priorState = (await repo.getLinkState(driverId, link.id)) ?? { cursor: null, lastRunAt: null, lastError: null };
    const since = options.since !== undefined
      ? options.since
      : (options.full ? null : priorState.cursor);

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
      const message = err && err.message ? err.message : String(err);
      await repo.saveLinkState(driverId, link.id, { ...priorState, lastError: message });
      throw new RouteSyncError(`Route sync failed for ${partner}: ${message}`, 'ROUTE_SYNC_PORTAL');
    }

    if (rawList === null || rawList === undefined) rawList = [];
    if (!Array.isArray(rawList)) {
      await repo.saveLinkState(driverId, link.id, { ...priorState, lastError: 'portal did not return an array of routes' });
      throw new RouteSyncError(
        `Route portal for ${partner} must return an array of routes`,
        'ROUTE_SYNC_PORTAL',
      );
    }

    const existingIds = await repo.listRouteIds(driverId, link.id);
    let added = 0;
    let updated = 0;
    let skipped = 0;
    let cursor = priorState.cursor;
    const syncedAt = now();

    for (const raw of rawList) {
      let route;
      try {
        route = normalizeRoute(partner, raw);
      } catch {
        skipped += 1; // a single malformed record must not abort the sweep
        continue;
      }
      const existed = existingIds.has(route.id);
      await repo.upsertRoute(driverId, link.id, { ...route, driverId, linkId: link.id, syncedAt });
      existingIds.add(route.id);
      if (existed) updated += 1; else added += 1;

      const ts = routeCursor(route);
      if (ts !== null && (cursor === null || ts > cursor)) cursor = ts;
    }

    await repo.saveLinkState(driverId, link.id, { cursor, lastRunAt: syncedAt, lastError: null });
    const total = await repo.countRoutes(driverId, link.id);

    return deepFreeze({
      driverId,
      linkId: link.id,
      partner,
      since,
      fetched: rawList.length,
      added,
      updated,
      skipped,
      total,
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
    const links = (await listActiveLinks(driverId)) ?? [];
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
    const driverIds = options.driverId ? [options.driverId] : await listDriverIds();
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
   * @returns {Promise<object[]>} Frozen route records.
   */
  async function listRoutes(driverId, linkId, filter = {}) {
    let routes = await repo.listRoutes(driverId, linkId);
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
   * @returns {Promise<object>} A frozen snapshot.
   */
  async function getSyncState(driverId, linkId) {
    const state = await repo.getLinkState(driverId, linkId);
    if (!state) {
      throw new RouteSyncError(
        `No sync state for link "${linkId}" of driver "${driverId}"`,
        'ROUTE_SYNC_NOT_FOUND',
      );
    }
    const routeCount = await repo.countRoutes(driverId, linkId);
    return deepFreeze({
      driverId,
      linkId,
      cursor: state.cursor,
      lastRunAt: state.lastRunAt,
      lastError: state.lastError,
      routeCount,
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
    repo,
  };
}
