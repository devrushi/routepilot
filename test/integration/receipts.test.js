// Run against a real database: set TEST_DATABASE_URL, apply migrations
// with `npm run migrate -- --test`, then `npm run test:integration`.

import assert from 'node:assert/strict';
import { createReceiptProcessor, createPostgresReceiptRepo, createMockOcrProvider } from '../../src/receipts.js';
import { integrationTest, resetTables } from './_helpers.js';

const TABLES = ['receipts'];

function makeProcessor(nowRef, sql, ocrProvider) {
  return createReceiptProcessor({ now: () => nowRef.value, repo: createPostgresReceiptRepo(sql), ocrProvider });
}

integrationTest('queue and process a receipt through Postgres', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const ocrProvider = createMockOcrProvider({
    responses: new Map([['/r1.jpg', { fields: { vendor: 'Shell', total: 42.17, currency: 'USD', date: '2024-03-01' } }]]),
  });
  const processor = makeProcessor(nowRef, sql, ocrProvider);

  const receipt = await processor.queue('drv_1', { path: '/r1.jpg' });
  assert.equal(receipt.status, 'queued');

  const processed = await processor.process('drv_1', receipt.id);
  assert.equal(processed.status, 'processed');
  assert.deepEqual(processed.fields, { vendor: 'Shell', total: 42.17, currency: 'USD', date: '2024-03-01' });
});

integrationTest('processAll claims receipts atomically via claimNextQueued (FOR UPDATE SKIP LOCKED)', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const ocrProvider = createMockOcrProvider({ defaultResponse: { text: 'Vendor\nTOTAL $1.00' } });
  const processor = makeProcessor(nowRef, sql, ocrProvider);

  const a = await processor.queue('drv_1', { path: '/a.jpg' });
  const b = await processor.queue('drv_2', { path: '/b.jpg' });

  const results = await processor.processAll();
  assert.deepEqual(results.map((r) => r.id).sort(), [a.id, b.id].sort());
  assert.equal((await processor.list('drv_1', { status: 'queued' })).length, 0);
  assert.equal((await processor.get('drv_1', a.id)).status, 'processed');
});
