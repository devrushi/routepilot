import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDspConnectionManager, validatePayoutRate } from '../src/dsp.js';
import { createRouteHistorySyncWorker } from '../src/route-sync.js';
import { reconcileRoute, createPayoutReconciliationWidget } from '../src/payout-reconciliation.js';

const RAW_PER_MILE_RATE = { currency: 'USD', components: [{ type: 'per_mile', rate: 1 }] };
// reconcileRoute forwards this straight to dsp.js's computePayout, which
// requires a *validated* rate card (basis/label/unit filled in) — same
// contract as everywhere else in dsp.js.
const PER_MILE_RATE = validatePayoutRate(RAW_PER_MILE_RATE);

test('reconcileRoute matches when the DSP-reported earnings equal the computed payout', () => {
  const route = { id: 'r1', work: { miles: 10, deliveries: 0, hours: 0, orderValue: 0 }, earnings: 10 };
  const result = reconcileRoute(route, PER_MILE_RATE);
  assert.equal(result.status, 'matched');
  assert.equal(result.mismatched, false);
  assert.equal(result.recordedAmount, 10);
  assert.equal(result.reportedAmount, 10);
  assert.equal(result.diff, 0);
});

test('reconcileRoute flags a clear mismatch between recorded and reported earnings', () => {
  const route = { id: 'r2', work: { miles: 10, deliveries: 0, hours: 0, orderValue: 0 }, earnings: 5 };
  const result = reconcileRoute(route, PER_MILE_RATE);
  assert.equal(result.status, 'mismatch');
  assert.equal(result.mismatched, true);
  assert.equal(result.recordedAmount, 10);
  assert.equal(result.diff, 5);
});

test('reconcileRoute tolerates rounding noise within the default tolerance', () => {
  const route = { id: 'r3', work: { miles: 10, deliveries: 0, hours: 0, orderValue: 0 }, earnings: 9.995 };
  const result = reconcileRoute(route, PER_MILE_RATE);
  assert.equal(result.status, 'matched');
});

test('reconcileRoute returns pending when the DSP hasn\'t reported earnings yet', () => {
  const route = { id: 'r4', work: { miles: 10, deliveries: 0, hours: 0, orderValue: 0 }, earnings: null };
  const result = reconcileRoute(route, PER_MILE_RATE);
  assert.equal(result.status, 'pending');
  assert.equal(result.mismatched, false);
});

async function setupDriverWithRoutes(portalRoutes) {
  const connections = createDspConnectionManager();
  const link = await connections.link('drv_1', {
    partner: 'doordash',
    externalAccountId: 'acct_1',
    payoutRate: RAW_PER_MILE_RATE,
  });
  const routeSync = createRouteHistorySyncWorker({
    portal: async () => portalRoutes,
    connections,
  });
  await routeSync.syncDriver('drv_1');
  return { connections, routeSync, linkId: link.id };
}

test('createPayoutReconciliationWidget reports a matched status for a driver whose DSP payouts line up', async () => {
  const { connections, routeSync, linkId } = await setupDriverWithRoutes([
    { id: 'route1', miles: 10, earnings: 10, status: 'completed' },
    { id: 'route2', miles: 4, earnings: 4, status: 'completed' },
  ]);
  const widget = createPayoutReconciliationWidget({ connections, routeSync });

  const linkResult = await widget.reconcileLink('drv_1', linkId);
  assert.equal(linkResult.status, 'matched');
  assert.equal(linkResult.mismatchCount, 0);
  assert.equal(linkResult.evaluatedRoutes, 2);

  const driverResults = await widget.reconcileDriver('drv_1');
  assert.equal(driverResults.length, 1);
  assert.equal(driverResults[0].status, 'matched');
});

test('createPayoutReconciliationWidget flags a driver with a mismatched DSP payout', async () => {
  const { connections, routeSync, linkId } = await setupDriverWithRoutes([
    { id: 'route1', miles: 10, earnings: 10, status: 'completed' },
    { id: 'route2', miles: 20, earnings: 5, status: 'completed' }, // should be $20, DSP reported $5
  ]);
  const widget = createPayoutReconciliationWidget({ connections, routeSync });

  const linkResult = await widget.reconcileLink('drv_1', linkId);
  assert.equal(linkResult.status, 'mismatch');
  assert.equal(linkResult.mismatchCount, 1);
  const mismatch = linkResult.reconciliations.find((r) => r.routeId === 'route2');
  assert.equal(mismatch.mismatched, true);
  assert.equal(mismatch.diff, 15);
});
