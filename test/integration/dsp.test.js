// Run against a real database: set TEST_DATABASE_URL, apply migrations
// with `npm run migrate -- --test`, then `npm run test:integration`.

import assert from 'node:assert/strict';
import { createDspConnectionManager, createPostgresDspLinkRepo } from '../../src/dsp.js';
import { integrationTest, resetTables } from './_helpers.js';

const TABLES = ['dsp_links'];

function makeManager(nowRef, sql) {
  return createDspConnectionManager({ now: () => nowRef.value, repo: createPostgresDspLinkRepo(sql) });
}

integrationTest('link/list/updateRate/unlink round-trip through Postgres', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const dsp = makeManager(nowRef, sql);

  const link = await dsp.link('drv_1', {
    partner: 'doordash',
    externalAccountId: 'dd-1',
    payoutRate: { currency: 'USD', components: [{ type: 'per_mile', rate: 1 }] },
  });
  assert.equal(link.status, 'active');

  await assert.rejects(
    () => dsp.link('drv_1', { partner: 'doordash', externalAccountId: 'dd-2', payoutRate: { components: [{ type: 'per_mile', rate: 1 }] } }),
    (e) => e.code === 'DSP_DUPLICATE',
  );

  const updated = await dsp.updateRate('drv_1', link.id, { components: [{ type: 'per_mile', rate: 2 }] });
  assert.equal(updated.payoutRate.components[0].rate, 2);

  assert.deepEqual((await dsp.listActive('drv_1')).map((l) => l.id), [link.id]);

  await dsp.unlink('drv_1', link.id);
  assert.deepEqual(await dsp.listActive('drv_1'), []);
});

integrationTest('listDriverIds discovers every driver with a link', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const dsp = makeManager(nowRef, sql);
  await dsp.link('drv_1', { partner: 'doordash', externalAccountId: 'a', payoutRate: { components: [{ type: 'per_mile', rate: 1 }] } });
  await dsp.link('drv_2', { partner: 'instacart', externalAccountId: 'b', payoutRate: { components: [{ type: 'per_mile', rate: 1 }] } });

  const ids = await dsp.listDriverIds();
  assert.deepEqual(ids.sort(), ['drv_1', 'drv_2']);
});
