import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRouteHistorySyncWorker,
  normalizeRoute,
  normalizeStatus,
  ROUTE_STATUSES,
  RouteSyncError,
} from '../src/route-sync.js';
import { createDspConnectionManager } from '../src/dsp.js';

// A fixed clock so `syncedAt`/cursor comparisons are deterministic.
const FIXED_NOW = Date.UTC(2024, 6, 1);
const now = () => FIXED_NOW;

function rateCard(overrides = {}) {
  return {
    currency: 'USD',
    components: [{ type: 'per_delivery', rate: 3 }, { type: 'per_mile', rate: 0.5 }],
    ...overrides,
  };
}

// Build a DSP connection manager with a couple of active links for one driver.
let idCounter = 0;
function dspManager() {
  idCounter = 0;
  const dsp = createDspConnectionManager({
    now,
    generateId: () => `dsp_${(idCounter += 1)}`,
  });
  dsp.link('drv_1', { partner: 'doordash', externalAccountId: 'dd-1', payoutRate: rateCard() });
  dsp.link('drv_1', { partner: 'amazon_flex', externalAccountId: 'af-1', payoutRate: rateCard() });
  return dsp;
}

// A DoorDash-style route payload keyed loosely; portals differ in field names.
function ddRoute(id, overrides = {}) {
  return {
    routeId: id,
    startTime: '2024-06-30T08:00:00Z',
    endTime: '2024-06-30T10:30:00Z',
    status: 'DELIVERED',
    stops: 7,
    distanceMiles: 22.4,
    durationHours: 2.5,
    payout: '48.75',
    currency: 'usd',
    ...overrides,
  };
}

// --- normalizeStatus -----------------------------------------------------

test('normalizeStatus collapses portal spellings onto the catalogue', () => {
  assert.equal(normalizeStatus('DELIVERED'), 'completed');
  assert.equal(normalizeStatus('Complete'), 'completed');
  assert.equal(normalizeStatus('in-progress'), 'in_progress');
  assert.equal(normalizeStatus('EnRoute'), 'in_progress');
  assert.equal(normalizeStatus('canceled'), 'cancelled');
  assert.equal(normalizeStatus('upcoming'), 'scheduled');
  assert.equal(normalizeStatus('teleported'), null);
  assert.equal(normalizeStatus(''), null);
  assert.equal(normalizeStatus(42), null);
});

// --- normalizeRoute ------------------------------------------------------

test('normalizeRoute normalizes a full route and shapes a work batch', () => {
  const route = normalizeRoute('doordash', ddRoute('r1'));
  assert.equal(route.id, 'r1');
  assert.equal(route.partner, 'doordash');
  assert.equal(route.status, 'completed');
  assert.equal(route.statusDescription, 'DELIVERED');
  assert.equal(route.startedAt, Date.UTC(2024, 5, 30, 8, 0, 0));
  assert.equal(route.completedAt, Date.UTC(2024, 5, 30, 10, 30, 0));
  assert.deepEqual(route.work, { deliveries: 7, miles: 22.4, hours: 2.5, orderValue: 0 });
  assert.equal(route.earnings, 48.75);
  assert.equal(route.currency, 'USD');
  assert.equal(route.raw.routeId, 'r1');
});

test('normalizeRoute accepts field aliases and unix-seconds timestamps', () => {
  const route = normalizeRoute('amazon_flex', {
    blockId: 'b9',
    start: 1719734400, // unix seconds → ms
    state: 'active',
    packages: '12',
    mileage: 30,
    amount: 60,
  });
  assert.equal(route.id, 'b9');
  assert.equal(route.startedAt, 1719734400 * 1000);
  assert.equal(route.status, 'in_progress');
  assert.equal(route.work.deliveries, 12);
  assert.equal(route.work.miles, 30);
  assert.equal(route.earnings, 60);
});

test('normalizeRoute tolerates partial data with null/zero defaults', () => {
  const route = normalizeRoute('roadie', { id: 'x', foo: 'bar' });
  assert.equal(route.id, 'x');
  assert.equal(route.status, null);
  assert.equal(route.startedAt, null);
  assert.equal(route.completedAt, null);
  assert.equal(route.earnings, null);
  assert.equal(route.currency, null);
  assert.deepEqual(route.work, { deliveries: 0, miles: 0, hours: 0, orderValue: 0 });
});

test('normalizeRoute requires an id and rejects non-objects', () => {
  assert.throws(() => normalizeRoute('doordash', { stops: 3 }), (e) => e instanceof RouteSyncError && e.code === 'ROUTE_SYNC_ROUTE');
  assert.throws(() => normalizeRoute('doordash', 'nope'), (e) => e.code === 'ROUTE_SYNC_ROUTE');
  assert.throws(() => normalizeRoute('doordash', [1, 2]), (e) => e.code === 'ROUTE_SYNC_ROUTE');
});

// --- config --------------------------------------------------------------

test('createRouteHistorySyncWorker validates its config', () => {
  assert.throws(() => createRouteHistorySyncWorker({}), (e) => e.code === 'ROUTE_SYNC_CONFIG');
  assert.throws(
    () => createRouteHistorySyncWorker({ portal: async () => [] }),
    (e) => e.code === 'ROUTE_SYNC_CONFIG', // no connections / listers
  );
});

// --- syncLink ------------------------------------------------------------

test('syncLink fetches, normalizes, upserts and advances the cursor', async () => {
  const dsp = dspManager();
  let seenSince;
  const worker = createRouteHistorySyncWorker({
    connections: dsp,
    now,
    portal: async ({ partner, since }) => {
      seenSince = since;
      return partner === 'doordash' ? [ddRoute('r1'), ddRoute('r2')] : [];
    },
  });
  const [ddLink] = dsp.listActive('drv_1');

  const summary = await worker.syncLink('drv_1', ddLink);
  assert.equal(seenSince, null); // first run has no cursor
  assert.equal(summary.added, 2);
  assert.equal(summary.updated, 0);
  assert.equal(summary.total, 2);
  assert.equal(summary.cursor, Date.UTC(2024, 5, 30, 10, 30, 0));
  assert.ok(Object.isFrozen(summary));

  const routes = worker.listRoutes('drv_1', ddLink.id);
  assert.equal(routes.length, 2);
  assert.ok(Object.isFrozen(routes[0]));
});

test('syncLink is incremental and deduplicates by route id', async () => {
  const dsp = dspManager();
  const [ddLink] = dsp.listActive('drv_1');
  let call = 0;
  const sinceByCall = [];
  const worker = createRouteHistorySyncWorker({
    connections: dsp,
    now,
    portal: async ({ since }) => {
      sinceByCall.push(since);
      call += 1;
      if (call === 1) return [ddRoute('r1'), ddRoute('r2')];
      // Second run: r2 re-appears (update) plus a newer r3.
      return [
        ddRoute('r2', { payout: '50.00' }),
        ddRoute('r3', { endTime: '2024-06-30T12:00:00Z' }),
      ];
    },
  });

  const first = await worker.syncLink('drv_1', ddLink);
  assert.equal(first.added, 2);

  const second = await worker.syncLink('drv_1', ddLink);
  assert.equal(sinceByCall[1], Date.UTC(2024, 5, 30, 10, 30, 0)); // cursor carried over
  assert.equal(second.added, 1); // r3
  assert.equal(second.updated, 1); // r2
  assert.equal(second.total, 3); // no duplicate
  assert.equal(second.cursor, Date.UTC(2024, 5, 30, 12, 0, 0));

  const r2 = worker.listRoutes('drv_1', ddLink.id).find((r) => r.id === 'r2');
  assert.equal(r2.earnings, 50); // upserted with the newer payload
});

test('syncLink skips malformed records without aborting the sweep', async () => {
  const dsp = dspManager();
  const [ddLink] = dsp.listActive('drv_1');
  const worker = createRouteHistorySyncWorker({
    connections: dsp,
    now,
    portal: async () => [ddRoute('r1'), { stops: 3 /* no id */ }, ddRoute('r2')],
  });
  const summary = await worker.syncLink('drv_1', ddLink);
  assert.equal(summary.fetched, 3);
  assert.equal(summary.added, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.total, 2);
});

test('syncLink full-refetch ignores the stored cursor', async () => {
  const dsp = dspManager();
  const [ddLink] = dsp.listActive('drv_1');
  const sinceByCall = [];
  const worker = createRouteHistorySyncWorker({
    connections: dsp,
    now,
    portal: async ({ since }) => { sinceByCall.push(since); return [ddRoute('r1')]; },
  });
  await worker.syncLink('drv_1', ddLink);
  await worker.syncLink('drv_1', ddLink, { full: true });
  assert.equal(sinceByCall[0], null);
  assert.equal(sinceByCall[1], null); // cursor ignored on full refetch
});

test('syncLink surfaces a portal failure as ROUTE_SYNC_PORTAL and records it', async () => {
  const dsp = dspManager();
  const [ddLink] = dsp.listActive('drv_1');
  const worker = createRouteHistorySyncWorker({
    connections: dsp,
    now,
    portal: async () => { throw new Error('portal 503'); },
  });
  await assert.rejects(
    () => worker.syncLink('drv_1', ddLink),
    (e) => e.code === 'ROUTE_SYNC_PORTAL' && /portal 503/.test(e.message),
  );
  assert.equal(worker.getSyncState('drv_1', ddLink.id).lastError, 'portal 503');
});

test('syncLink rejects a non-array portal response', async () => {
  const dsp = dspManager();
  const [ddLink] = dsp.listActive('drv_1');
  const worker = createRouteHistorySyncWorker({
    connections: dsp, now, portal: async () => ({ not: 'an array' }),
  });
  await assert.rejects(() => worker.syncLink('drv_1', ddLink), (e) => e.code === 'ROUTE_SYNC_PORTAL');
});

test('syncLink treats a null/empty portal response as no routes', async () => {
  const dsp = dspManager();
  const [ddLink] = dsp.listActive('drv_1');
  const worker = createRouteHistorySyncWorker({ connections: dsp, now, portal: async () => null });
  const summary = await worker.syncLink('drv_1', ddLink);
  assert.equal(summary.fetched, 0);
  assert.equal(summary.total, 0);
});

// --- runOnce (background sweep) ------------------------------------------

test('runOnce sweeps every active link of every driver', async () => {
  const dsp = dspManager();
  dsp.link('drv_2', { partner: 'uber_eats', externalAccountId: 'ue-1', payoutRate: rateCard() });
  const worker = createRouteHistorySyncWorker({
    connections: dsp,
    now,
    generateId: () => 'run_1',
    portal: async ({ partner }) => (partner === 'doordash' ? [ddRoute('r1')] : [ddRoute(`${partner}-a`)]),
  });

  const report = await worker.runOnce();
  assert.equal(report.runId, 'run_1');
  assert.equal(report.drivers, 2);
  assert.equal(report.links, 3); // 2 for drv_1, 1 for drv_2
  assert.equal(report.added, 3);
  assert.equal(report.errors.length, 0);
  assert.ok(Object.isFrozen(report));
});

test('runOnce isolates a failing link and keeps sweeping the rest', async () => {
  const dsp = dspManager();
  const worker = createRouteHistorySyncWorker({
    connections: dsp,
    now,
    portal: async ({ partner }) => {
      if (partner === 'amazon_flex') throw new Error('flex down');
      return [ddRoute('r1')];
    },
  });
  const report = await worker.runOnce({ driverId: 'drv_1' });
  assert.equal(report.drivers, 1);
  assert.equal(report.links, 2);
  assert.equal(report.added, 1); // doordash succeeded
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].partner, 'amazon_flex');
  assert.equal(report.errors[0].code, 'ROUTE_SYNC_PORTAL');
});

test('runOnce can target a single driver', async () => {
  const dsp = dspManager();
  dsp.link('drv_2', { partner: 'uber_eats', externalAccountId: 'ue-1', payoutRate: rateCard() });
  const worker = createRouteHistorySyncWorker({
    connections: dsp, now, portal: async () => [ddRoute('r1')],
  });
  const report = await worker.runOnce({ driverId: 'drv_2' });
  assert.equal(report.drivers, 1);
  assert.equal(report.links, 1);
});

// --- start / stop (interval scheduling with an injected timer) -----------

test('start runs immediately and on each interval; stop deschedules', async () => {
  const dsp = dspManager();
  let runs = 0;
  const reports = [];
  let scheduled = null;
  const worker = createRouteHistorySyncWorker({
    connections: dsp,
    now,
    portal: async () => { runs += 1; return [ddRoute(`r${runs}`)]; },
    onRun: (r) => reports.push(r),
    setInterval: (fn) => { scheduled = fn; return 'handle'; },
    clearInterval: (h) => { if (h === 'handle') scheduled = null; },
  });

  const handle = worker.start({ intervalMs: 1000 });
  assert.ok(worker.isRunning());
  // Immediate tick + two interval ticks, each sweeping drv_1's two links.
  scheduled();
  scheduled();
  await new Promise((r) => setTimeout(r, 0)); // let the async ticks settle
  assert.equal(runs, 6); // 3 ticks × 2 links
  assert.equal(reports.length, 3); // one report per tick

  handle.stop();
  assert.equal(worker.isRunning(), false);
  assert.equal(scheduled, null);
});

test('start rejects a double-start and a non-positive interval', async () => {
  const dsp = dspManager();
  const worker = createRouteHistorySyncWorker({
    connections: dsp, now, portal: async () => [], setInterval: () => 'h', clearInterval: () => {},
  });
  assert.throws(() => worker.start({}), (e) => e.code === 'ROUTE_SYNC_CONFIG');
  worker.start({ intervalMs: 1000, immediate: false });
  assert.throws(() => worker.start({ intervalMs: 1000 }), (e) => e.code === 'ROUTE_SYNC_STATE');
  worker.stop();
});

test('start forwards a scheduled-sweep failure to onError', async () => {
  const dsp = dspManager();
  const errors = [];
  let scheduled = null;
  const worker = createRouteHistorySyncWorker({
    connections: dsp,
    now,
    // runOnce itself never throws per-link; force a lister-level failure instead.
    listDriverIds: () => { throw new Error('store exploded'); },
    listActiveLinks: (d) => dsp.listActive(d),
    portal: async () => [],
    onError: (e) => errors.push(e),
    setInterval: (fn) => { scheduled = fn; return 'h'; },
    clearInterval: () => {},
  });
  worker.start({ intervalMs: 1000, immediate: true });
  scheduled?.();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(errors.length >= 1);
  assert.match(errors[0].message, /store exploded/);
  worker.stop();
});

// --- listRoutes / getSyncState -------------------------------------------

test('listRoutes returns newest-first and filters by status', async () => {
  const dsp = dspManager();
  const [ddLink] = dsp.listActive('drv_1');
  const worker = createRouteHistorySyncWorker({
    connections: dsp,
    now,
    portal: async () => [
      ddRoute('old', { endTime: '2024-06-01T10:00:00Z' }),
      ddRoute('new', { endTime: '2024-06-30T10:00:00Z' }),
      ddRoute('cx', { status: 'CANCELED', endTime: '2024-06-15T10:00:00Z' }),
    ],
  });
  await worker.syncLink('drv_1', ddLink);

  const routes = worker.listRoutes('drv_1', ddLink.id);
  assert.deepEqual(routes.map((r) => r.id), ['new', 'cx', 'old']);

  const cancelled = worker.listRoutes('drv_1', ddLink.id, { status: 'cancelled' });
  assert.deepEqual(cancelled.map((r) => r.id), ['cx']);

  assert.throws(() => worker.listRoutes('drv_1', ddLink.id, { status: 'bogus' }), (e) => e.code === 'ROUTE_SYNC_STATUS');
  assert.deepEqual(worker.listRoutes('drv_1', 'missing'), []);
});

test('getSyncState reports the cursor, last run and route count', async () => {
  const dsp = dspManager();
  const [ddLink] = dsp.listActive('drv_1');
  const worker = createRouteHistorySyncWorker({
    connections: dsp, now, portal: async () => [ddRoute('r1')],
  });
  await worker.syncLink('drv_1', ddLink);
  const state = worker.getSyncState('drv_1', ddLink.id);
  assert.equal(state.routeCount, 1);
  assert.equal(state.lastRunAt, FIXED_NOW);
  assert.equal(state.cursor, Date.UTC(2024, 5, 30, 10, 30, 0));
  assert.equal(state.lastError, null);
  assert.ok(Object.isFrozen(state));

  assert.throws(() => worker.getSyncState('drv_1', 'missing'), (e) => e.code === 'ROUTE_SYNC_NOT_FOUND');
});

// --- catalogue -----------------------------------------------------------

test('ROUTE_STATUSES is the expected catalogue', () => {
  assert.deepEqual(ROUTE_STATUSES, ['scheduled', 'in_progress', 'completed', 'cancelled']);
  assert.ok(RouteSyncError.prototype instanceof Error);
});
