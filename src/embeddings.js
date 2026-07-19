// Vector embeddings of historical driver mileage/earning patterns, with an
// in-memory vector store and cosine-similarity nearest-neighbor search.
//
// No real embedding model or hosted vector DB is wired up yet:
// `createMockEmbeddingProvider` implements the same `{ embed(input) }`
// interface a real provider (OpenAI, Cohere, a local model, ...) would, but
// derives a small deterministic feature vector directly from the
// mileage/earnings fields instead of calling out to anything — so indexing
// and search are fully testable without network access. Swap in a real
// provider later by passing a different `embeddingProvider` to
// `createDriverPatternIndex`; the store and search logic don't change.
//
// In-memory (a `Map`) rather than file-backed, matching every other
// module's store convention in this repo — swap for a persistent backend
// the same way the other trackers would (inject a different `store`).

import { randomUUID } from 'node:crypto';

export class EmbeddingError extends Error {
  constructor(message, code = 'EMBEDDING_INVALID') {
    super(message);
    this.name = 'EmbeddingError';
    this.code = code;
  }
}

/**
 * A deterministic stand-in embedding provider: `{ embed(input) }`. Rather
 * than encoding free text, it packs a handful of numeric mileage/earning
 * features into a fixed-length vector — enough to make similarity search
 * meaningful (similar shifts end up with similar vectors) without depending
 * on a real model.
 */
export function createMockEmbeddingProvider() {
  return {
    async embed(input) {
      if (input === null || typeof input !== 'object') {
        throw new EmbeddingError('embed() input must be an object', 'EMBEDDING_INPUT');
      }
      const { totalMiles = 0, totalEarnings = 0, shiftHours = 0, deliveries = 0 } = input;
      return [totalMiles, totalEarnings, shiftHours, deliveries].map((n) => Number(n) || 0);
    },
  };
}

function validateVector(vector) {
  if (!Array.isArray(vector) || vector.length === 0 || !vector.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new EmbeddingError('A vector must be a non-empty array of finite numbers', 'EMBEDDING_VECTOR');
  }
  return vector;
}

/** Cosine similarity between two equal-length vectors, in [-1, 1] (0 if either is the zero vector). */
export function cosineSimilarity(a, b) {
  validateVector(a);
  validateVector(b);
  if (a.length !== b.length) {
    throw new EmbeddingError('Vectors must be the same length', 'EMBEDDING_DIMENSION');
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Create an in-memory vector store with cosine-similarity search.
 * @param {object} [config]
 * @param {Map} [config.store] Backing store, keyed by vector id (defaults in-memory).
 */
export function createVectorStore(config = {}) {
  const { store = new Map() } = config;

  function cloneRecord(record) {
    return { id: record.id, vector: [...record.vector], metadata: { ...record.metadata } };
  }

  /**
   * Insert or replace a vector.
   * @param {string} id
   * @param {number[]} vector
   * @param {object} [metadata] Arbitrary data returned alongside search hits.
   * @returns {object} The stored record.
   */
  function upsert(id, vector, metadata = {}) {
    if (!id) {
      throw new EmbeddingError('An id is required', 'EMBEDDING_ID');
    }
    validateVector(vector);
    const record = { id, vector: [...vector], metadata: { ...metadata } };
    store.set(id, record);
    return cloneRecord(record);
  }

  /** Remove a vector. @returns {boolean} Whether one was removed. */
  function remove(id) {
    return store.delete(id);
  }

  /** Get one vector record, or `null`. */
  function get(id) {
    const record = store.get(id);
    return record ? cloneRecord(record) : null;
  }

  /**
   * Nearest-neighbor search by cosine similarity, highest first.
   * @param {number[]} queryVector
   * @param {object} [options]
   * @param {number} [options.topK=5]
   * @param {(metadata:object) => boolean} [options.filter] Restrict the candidate set before ranking.
   * @returns {Array<{id:string, score:number, vector:number[], metadata:object}>}
   */
  function search(queryVector, options = {}) {
    validateVector(queryVector);
    const { topK = 5, filter } = options;
    const scored = [];
    for (const record of store.values()) {
      if (record.vector.length !== queryVector.length) continue;
      if (filter && !filter(record.metadata)) continue;
      scored.push({ ...cloneRecord(record), score: cosineSimilarity(queryVector, record.vector) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  return { upsert, remove, get, search, size: () => store.size, store };
}

/**
 * Create a driver mileage/earnings pattern index: embeds a pattern record via
 * `embeddingProvider` and stores the resulting vector in `vectorStore`,
 * tagged with the driver id so similarity search can be scoped per driver.
 * @param {object} [config]
 * @param {{embed:(input:object)=>Promise<number[]>}} [config.embeddingProvider]
 * @param {ReturnType<typeof createVectorStore>} [config.vectorStore]
 * @param {() => string} [config.generateId]
 */
export function createDriverPatternIndex(config = {}) {
  const {
    embeddingProvider = createMockEmbeddingProvider(),
    vectorStore = createVectorStore(),
    generateId = () => `pat_${randomUUID()}`,
  } = config;

  /**
   * Embed and store a historical mileage/earnings pattern for a driver.
   * @param {string} driverId
   * @param {object} pattern e.g. `{ period, totalMiles, totalEarnings, shiftHours, deliveries }`.
   * @returns {Promise<object>} The stored vector record.
   */
  async function indexPattern(driverId, pattern = {}) {
    if (!driverId) {
      throw new EmbeddingError('A driverId is required', 'EMBEDDING_DRIVER');
    }
    const vector = await embeddingProvider.embed(pattern);
    return vectorStore.upsert(generateId(), vector, { driverId, ...pattern });
  }

  /**
   * Find a driver's own historical patterns most similar to a query pattern.
   * @param {string} driverId
   * @param {object} queryPattern
   * @param {object} [options] `{ topK }` (see {@link createVectorStore}.search).
   */
  async function findSimilarPatterns(driverId, queryPattern = {}, options = {}) {
    const vector = await embeddingProvider.embed(queryPattern);
    return vectorStore.search(vector, { ...options, filter: (metadata) => metadata.driverId === driverId });
  }

  return { indexPattern, findSimilarPatterns, vectorStore, embeddingProvider };
}
