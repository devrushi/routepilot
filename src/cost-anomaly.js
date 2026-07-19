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

/**
 * Create a per-driver, per-route cost history tracker built on
 * {@link detectCostAnomaly}.
 * @param {object} [config]
 * @param {Map} [config.store] Backing store, keyed by `driverId::routeKey` (defaults in-memory).
 * @param {number} [config.threshold=DEFAULT_ANOMALY_THRESHOLD]
 */
export function createRouteCostTracker(config = {}) {
  const { store = new Map(), threshold = DEFAULT_ANOMALY_THRESHOLD } = config;

  function key(driverId, routeKey) {
    if (!driverId || !routeKey) {
      throw new CostAnomalyError('A driverId and routeKey are required', 'ANOMALY_ROUTE');
    }
    return `${driverId}::${routeKey}`;
  }

  /** A driver's recorded cost history for a route, oldest first. */
  function history(driverId, routeKey) {
    return [...(store.get(key(driverId, routeKey)) ?? [])];
  }

  /** Record a cost against a driver's route history. */
  function recordCost(driverId, routeKey, cost) {
    validateCost(cost);
    const k = key(driverId, routeKey);
    const list = store.get(k) ?? [];
    list.push(cost);
    store.set(k, list);
    return [...list];
  }

  /** Check a cost against the driver's existing route history (not including this cost). */
  function checkCost(driverId, routeKey, cost, options = {}) {
    return detectCostAnomaly(cost, history(driverId, routeKey), { threshold, ...options });
  }

  /** Check a cost against history, then record it so future checks include it. */
  function recordAndCheck(driverId, routeKey, cost, options = {}) {
    const result = checkCost(driverId, routeKey, cost, options);
    recordCost(driverId, routeKey, cost);
    return result;
  }

  return { recordCost, checkCost, recordAndCheck, history, store };
}
