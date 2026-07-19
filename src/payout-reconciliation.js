// DSP payout reconciliation: for each of a driver's connected DSP partners,
// whether RoutePilot's own computed earnings for a synced route match what
// the DSP actually reported paying out, flagging any mismatch.
//
// Reuses rather than re-derives: "recorded" earnings come from dsp.js's
// `computePayout` against a link's rate card and a synced route's `work`
// batch; "reported" earnings are route-sync.js's `route.earnings` (parsed
// straight from the DSP portal's own payload). This module just compares
// the two — no new DSP/route data model.

import { computePayout } from './dsp.js';

export class PayoutReconciliationError extends Error {
  constructor(message, code = 'RECONCILE_INVALID') {
    super(message);
    this.name = 'PayoutReconciliationError';
    this.code = code;
  }
}

/** Default absolute-amount tolerance (in the payout's currency) before a difference counts as a mismatch — covers rounding, not real discrepancies. */
export const DEFAULT_RECONCILIATION_TOLERANCE = 0.01;

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Reconcile one synced route against a DSP link's payout rate card.
 * @param {object} route A synced route record (see route-sync.js `normalizeRoute`) — needs `work` and `earnings`.
 * @param {object} payoutRate A validated payout rate card (see dsp.js `validatePayoutRate`).
 * @param {object} [options]
 * @param {number} [options.tolerance=DEFAULT_RECONCILIATION_TOLERANCE]
 * @param {boolean} [options.peak=false] Forwarded to `computePayout`.
 * @returns {{routeId:string, status:'matched'|'mismatch'|'pending', recordedAmount:number|null, reportedAmount:number|null, currency:string, diff:number|null, mismatched:boolean}}
 */
export function reconcileRoute(route, payoutRate, options = {}) {
  if (route === null || typeof route !== 'object' || !route.work) {
    throw new PayoutReconciliationError('A route with a work batch is required', 'RECONCILE_ROUTE');
  }
  if (payoutRate === null || typeof payoutRate !== 'object') {
    throw new PayoutReconciliationError('A payout rate is required', 'RECONCILE_RATE');
  }

  // The DSP portal hasn't reported a final payout for this route yet (still
  // in progress, or the field was simply absent) — nothing to compare.
  if (route.earnings === null || route.earnings === undefined) {
    return {
      routeId: route.id,
      status: 'pending',
      recordedAmount: null,
      reportedAmount: null,
      currency: payoutRate.currency,
      diff: null,
      mismatched: false,
    };
  }

  const { tolerance = DEFAULT_RECONCILIATION_TOLERANCE, peak = false } = options;
  const recorded = computePayout(payoutRate, route.work, { peak });
  const reportedAmount = route.earnings;
  const diff = roundMoney(recorded.total - reportedAmount);
  const mismatched = Math.abs(diff) > tolerance;

  return {
    routeId: route.id,
    status: mismatched ? 'mismatch' : 'matched',
    recordedAmount: recorded.total,
    reportedAmount,
    currency: recorded.currency,
    diff,
    mismatched,
  };
}

/**
 * Create the DSP payout reconciliation widget.
 * @param {object} config
 * @param {ReturnType<import('./dsp.js').createDspConnectionManager>} config.connections
 * @param {ReturnType<import('./route-sync.js').createRouteHistorySyncWorker>} config.routeSync
 */
export function createPayoutReconciliationWidget(config = {}) {
  const { connections, routeSync } = config;
  if (!connections || !routeSync) {
    throw new PayoutReconciliationError('connections (dsp.js) and routeSync (route-sync.js) are required', 'RECONCILE_CONFIG');
  }

  /**
   * Reconcile every synced route of one DSP link.
   * @param {string} driverId
   * @param {string} linkId
   * @param {object} [options] Forwarded to {@link reconcileRoute}; `status` filters which synced routes are considered (see route-sync.js `listRoutes`).
   * @returns {Promise<object>} `{ driverId, linkId, partner, totalRoutes, evaluatedRoutes, mismatchCount, status, reconciliations }`.
   */
  async function reconcileLink(driverId, linkId, options = {}) {
    const link = await connections.get(driverId, linkId);
    const routes = await routeSync.listRoutes(driverId, linkId, options.status ? { status: options.status } : {});
    const reconciliations = routes.map((route) => reconcileRoute(route, link.payoutRate, options));
    const evaluated = reconciliations.filter((r) => r.status !== 'pending');
    const mismatches = evaluated.filter((r) => r.mismatched);

    return {
      driverId,
      linkId,
      partner: link.partner,
      totalRoutes: reconciliations.length,
      evaluatedRoutes: evaluated.length,
      mismatchCount: mismatches.length,
      status: mismatches.length > 0 ? 'mismatch' : 'matched',
      reconciliations,
    };
  }

  /**
   * Reconcile every active DSP link for a driver.
   * @param {string} driverId
   * @param {object} [options] Forwarded to {@link reconcileLink}.
   * @returns {Promise<object[]>} One reconciliation summary per active link.
   */
  async function reconcileDriver(driverId, options = {}) {
    const links = await connections.listActive(driverId);
    return Promise.all(links.map((link) => reconcileLink(driverId, link.id, options)));
  }

  return { reconcileLink, reconcileDriver };
}
