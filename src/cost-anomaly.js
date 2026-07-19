// Statistical anomaly check for a driver's fuel/vehicle costs on a route,
// compared against their own historical average for similar routes.
//
// Threshold: a cost is flagged when it exceeds the historical mean by more
// than 2 standard deviations (population stddev over the driver's own
// history for that route). 2 stddev is a standard, conservative outlier cut
// (roughly the top ~2.3% under a normal distribution) — high enough that
// ordinary day-to-day price variance on a small per-driver sample doesn't
// constantly trip it, low enough to catch a real one-off spike (e.g. a
// detour, a fuel-price gouge, an unusually large repair).

export class CostAnomalyError extends Error {
  constructor(message, code = 'ANOMALY_INVALID') {
    super(message);
    this.name = 'CostAnomalyError';
    this.code = code;
  }
}

export const DEFAULT_ANOMALY_THRESHOLD = 2;

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundScore(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function populationStddev(values, avg) {
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function validateCost(value, field = 'cost') {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CostAnomalyError(`${field} must be a finite number`, 'ANOMALY_COST');
  }
  return value;
}

function validateHistory(values) {
  if (!Array.isArray(values) || values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new CostAnomalyError('historicalCosts must be an array of finite numbers', 'ANOMALY_HISTORY');
  }
  return values;
}

/**
 * Flag `cost` as an outlier against a driver's own historical costs for
 * similar routes.
 * @param {number} cost The new cost to check.
 * @param {number[]} historicalCosts Prior costs for the same/similar route (not including `cost`).
 * @param {object} [options]
 * @param {number} [options.threshold=DEFAULT_ANOMALY_THRESHOLD] Standard deviations above the mean to flag.
 * @returns {{isAnomaly:boolean, mean:number|null, stddev:number|null, threshold:number, zScore:number|null, sampleSize:number}}
 */
export function detectCostAnomaly(cost, historicalCosts, options = {}) {
  const { threshold = DEFAULT_ANOMALY_THRESHOLD } = options;
  validateCost(cost);
  validateHistory(historicalCosts);

  // Fewer than 2 data points can't establish a spread — never flag.
  if (historicalCosts.length < 2) {
    return {
      isAnomaly: false,
      mean: historicalCosts[0] ?? null,
      stddev: null,
      threshold,
      zScore: null,
      sampleSize: historicalCosts.length,
    };
  }

  const avg = mean(historicalCosts);
  const sd = populationStddev(historicalCosts, avg);
  const zScore = sd === 0 ? (cost > avg ? Infinity : 0) : (cost - avg) / sd;

  return {
    isAnomaly: zScore > threshold,
    mean: roundMoney(avg),
    stddev: roundMoney(sd),
    threshold,
    zScore: Number.isFinite(zScore) ? roundScore(zScore) : zScore,
    sampleSize: historicalCosts.length,
  };
}

/** In-memory route-cost repo (default) — keyed by `driverId::routeKey`, async interface. */
export function createInMemoryRouteCostRepo() {
  const store = new Map();
  return {
    async listHistory(driverId, routeKey) {
      return [...(store.get(`${driverId}::${routeKey}`) ?? [])];
    },
    async recordCost(driverId, routeKey, cost) {
      const k = `${driverId}::${routeKey}`;
      const list = store.get(k) ?? [];
      list.push(cost);
      store.set(k, list);
    },
  };
}

/**
 * Postgres-backed route-cost repo. Expects a `route_cost_history` table
 * (see db/migrations) — insert-only, one row per recorded cost.
 * @param {import('@neondatabase/serverless').NeonQueryFunction<false,false>} sql
 */
export function createPostgresRouteCostRepo(sql) {
  return {
    async listHistory(driverId, routeKey) {
      const rows = await sql`
        SELECT cost FROM route_cost_history WHERE driver_id = ${driverId} AND route_key = ${routeKey} ORDER BY id ASC
      `;
      return rows.map((r) => Number(r.cost));
    },
    async recordCost(driverId, routeKey, cost) {
      await sql`INSERT INTO route_cost_history (driver_id, route_key, cost) VALUES (${driverId}, ${routeKey}, ${cost})`;
    },
  };
}

/**
 * Create a per-driver, per-route cost history tracker built on
 * {@link detectCostAnomaly}.
 * @param {object} [config]
 * @param {{listHistory:Function, recordCost:Function}} [config.repo] Cost history repo (defaults to an in-memory one).
 * @param {number} [config.threshold=DEFAULT_ANOMALY_THRESHOLD]
 */
export function createRouteCostTracker(config = {}) {
  const { repo = createInMemoryRouteCostRepo(), threshold = DEFAULT_ANOMALY_THRESHOLD } = config;

  function requireKey(driverId, routeKey) {
    if (!driverId || !routeKey) {
      throw new CostAnomalyError('A driverId and routeKey are required', 'ANOMALY_ROUTE');
    }
  }

  /** A driver's recorded cost history for a route, oldest first. */
  async function history(driverId, routeKey) {
    requireKey(driverId, routeKey);
    return repo.listHistory(driverId, routeKey);
  }

  /** Record a cost against a driver's route history. */
  async function recordCost(driverId, routeKey, cost) {
    requireKey(driverId, routeKey);
    validateCost(cost);
    await repo.recordCost(driverId, routeKey, cost);
    return repo.listHistory(driverId, routeKey);
  }

  /** Check a cost against the driver's existing route history (not including this cost). */
  async function checkCost(driverId, routeKey, cost, options = {}) {
    const hist = await history(driverId, routeKey);
    return detectCostAnomaly(cost, hist, { threshold, ...options });
  }

  /** Check a cost against history, then record it so future checks include it. */
  async function recordAndCheck(driverId, routeKey, cost, options = {}) {
    const result = await checkCost(driverId, routeKey, cost, options);
    await recordCost(driverId, routeKey, cost);
    return result;
  }

  return { recordCost, checkCost, recordAndCheck, history, repo };
}
