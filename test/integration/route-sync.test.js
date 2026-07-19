// Run against a real database: set TEST_DATABASE_URL, apply migrations
// with `npm run migrate -- --test`, then `npm run test:integration`.

import assert from 'node:assert/strict';
import { createDspConnectionManager, createPostgresDspLinkRepo } from '../../src/dsp.js';
import { createRouteHistorySyncWorker, createPostgresRouteSyncRepo } from '../../src/route-sync.js';
import { integrationTest, resetTables } from './_helpers.js';

const TABLES = ['dsp_links', 'route_sync_state', 'synced_routes'];

integrationTest('syncLink fetches, upserts and advances the cursor through Postgres', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: Date.UTC(2024, 6, 1) };
  const connections = createDspConnectionManager({ now: () => nowRef.value, repo: createPostgresDspLinkRepo(sql) });
  const link = await connections.link('drv_1', {
    partner: 'doordash',
    externalAccountId: 'dd-1',
    payoutRate: { components: [{ type: 'per_mile', rate: 1 }] },
  });

  const worker = createRouteHistorySyncWorker({
    connections,
    repo: createPostgresRouteSyncRepo(sql),
    now: () => nowRef.value,
    portal: async () => [{ routeId: 'r1', endTime: '2024-06-30T10:30:00Z', stops: 3, distanceMiles: 10 }],
  });

  const summary = await worker.syncLink('drv_1', link);
  assert.equal(summary.added, 1);
  assert.equal(summary.total, 1);

  const routes = await worker.listRoutes('drv_1', link.id);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].id, 'r1');

  const state = await worker.getSyncState('drv_1', link.id);
  assert.equal(state.routeCount, 1);
  assert.equal(state.cursor, Date.UTC(2024, 5, 30, 10, 30, 0));
});
