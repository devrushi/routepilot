import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVectorStore,
  createDriverPatternIndex,
  createMockEmbeddingProvider,
  cosineSimilarity,
} from '../src/embeddings.js';

test('upsert stores a vector and get retrieves it', () => {
  const store = createVectorStore();
  store.upsert('a', [1, 0, 0], { label: 'first' });
  const record = store.get('a');
  assert.deepEqual(record.vector, [1, 0, 0]);
  assert.equal(record.metadata.label, 'first');
  assert.equal(store.size(), 1);
});

test('upsert rejects a missing id or an invalid vector', () => {
  const store = createVectorStore();
  assert.throws(() => store.upsert('', [1, 2]), (e) => e.code === 'EMBEDDING_ID');
  assert.throws(() => store.upsert('a', []), (e) => e.code === 'EMBEDDING_VECTOR');
  assert.throws(() => store.upsert('a', [1, 'x']), (e) => e.code === 'EMBEDDING_VECTOR');
});

test('search returns the nearest matches for a query vector, closest first', () => {
  const store = createVectorStore();
  store.upsert('close', [1, 0]);
  store.upsert('far', [0, 1]);
  store.upsert('opposite', [-1, 0]);

  const results = store.search([1, 0], { topK: 2 });
  assert.equal(results.length, 2);
  assert.equal(results[0].id, 'close');
  assert.ok(results[0].score > results[1].score);
});

test('search respects a metadata filter', () => {
  const store = createVectorStore();
  store.upsert('a', [1, 0], { driverId: 'drv_1' });
  store.upsert('b', [1, 0], { driverId: 'drv_2' });

  const results = store.search([1, 0], { filter: (m) => m.driverId === 'drv_1' });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'a');
});

test('cosineSimilarity is 1 for identical vectors and 0 for orthogonal ones', () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('createDriverPatternIndex embeds and stores a mileage/earnings pattern', async () => {
  const index = createDriverPatternIndex();
  await index.indexPattern('drv_1', { period: '2024-W10', totalMiles: 320, totalEarnings: 480, shiftHours: 30, deliveries: 60 });
  await index.indexPattern('drv_1', { period: '2024-W11', totalMiles: 310, totalEarnings: 460, shiftHours: 29, deliveries: 58 });
  await index.indexPattern('drv_2', { period: '2024-W10', totalMiles: 300, totalEarnings: 450, shiftHours: 28, deliveries: 55 });

  const matches = await index.findSimilarPatterns('drv_1', { totalMiles: 315, totalEarnings: 470, shiftHours: 29, deliveries: 59 }, { topK: 5 });
  assert.equal(matches.length, 2);
  assert.ok(matches.every((m) => m.metadata.driverId === 'drv_1'));
  assert.ok(matches[0].score >= matches[1].score);
});

test('createMockEmbeddingProvider derives a vector from numeric fields', async () => {
  const provider = createMockEmbeddingProvider();
  const vector = await provider.embed({ totalMiles: 100, totalEarnings: 200, shiftHours: 8, deliveries: 20 });
  assert.deepEqual(vector, [100, 200, 8, 20]);
});
