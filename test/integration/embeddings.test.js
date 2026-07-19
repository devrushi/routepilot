// Run against a real database: set TEST_DATABASE_URL, apply migrations
// with `npm run migrate -- --test`, then `npm run test:integration`.
// Requires the pgvector extension (created by db/migrations/0012_vector_patterns.sql).

import assert from 'node:assert/strict';
import { createVectorStore, createPostgresVectorRepo, createDriverPatternIndex } from '../../src/embeddings.js';
import { integrationTest, resetTables } from './_helpers.js';

const TABLES = ['vector_patterns'];

function makeIndex(sql) {
  return createDriverPatternIndex({ vectorStore: createVectorStore({ repo: createPostgresVectorRepo(sql) }) });
}

integrationTest('upsert and get round-trip a vector through pgvector', async (t, sql) => {
  await resetTables(sql, TABLES);
  const store = createVectorStore({ repo: createPostgresVectorRepo(sql) });

  await store.upsert('pat_1', [1, 0, 0, 0], { driverId: 'drv_1', label: 'first' });
  const record = await store.get('pat_1');
  assert.deepEqual(record.vector, [1, 0, 0, 0]);
  assert.equal(record.metadata.driverId, 'drv_1');
  assert.equal(record.metadata.label, 'first');
  assert.equal(await store.size(), 1);
});

integrationTest('search ranks nearest neighbors via pgvector cosine distance', async (t, sql) => {
  await resetTables(sql, TABLES);
  const store = createVectorStore({ repo: createPostgresVectorRepo(sql) });

  await store.upsert('close', [1, 0, 0, 0], { driverId: 'drv_1' });
  await store.upsert('far', [0, 1, 0, 0], { driverId: 'drv_1' });
  await store.upsert('opposite', [-1, 0, 0, 0], { driverId: 'drv_1' });

  const results = await store.search([1, 0, 0, 0], { topK: 2 });
  assert.equal(results.length, 2);
  assert.equal(results[0].id, 'close');
  assert.ok(results[0].score > results[1].score);
});

integrationTest('createDriverPatternIndex scopes findSimilarPatterns to one driver through Postgres', async (t, sql) => {
  await resetTables(sql, TABLES);
  const index = makeIndex(sql);

  await index.indexPattern('drv_1', { period: '2024-W10', totalMiles: 320, totalEarnings: 480, shiftHours: 30, deliveries: 60 });
  await index.indexPattern('drv_1', { period: '2024-W11', totalMiles: 310, totalEarnings: 460, shiftHours: 29, deliveries: 58 });
  await index.indexPattern('drv_2', { period: '2024-W10', totalMiles: 300, totalEarnings: 450, shiftHours: 28, deliveries: 55 });

  const matches = await index.findSimilarPatterns('drv_1', { totalMiles: 315, totalEarnings: 470, shiftHours: 29, deliveries: 59 }, { topK: 5 });
  assert.equal(matches.length, 2);
  assert.ok(matches.every((m) => m.metadata.driverId === 'drv_1'));
});
