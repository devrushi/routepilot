// Vector embeddings of historical driver mileage/earning patterns, with a
// cosine-similarity nearest-neighbor search backed by either an in-memory
// store or Postgres/pgvector.
//
// No real embedding model is wired up yet: `createMockEmbeddingProvider`
// implements the same `{ embed(input) }` interface a real provider (OpenAI,
// Cohere, a local model, ...) would, but derives a small deterministic
// feature vector directly from the mileage/earnings fields instead of
// calling out to anything — so indexing and search are fully testable
// without network access. Swap in a real provider later by passing a
// different `embeddingProvider` to `createDriverPatternIndex`; the store
// and search logic don't change.

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

function cloneRecord(record) {
  return { id: record.id, vector: [...record.vector], metadata: { ...record.metadata } };
}

/**
 * In-memory (a `Map`) vector repo — the default. `search`'s `driverId`
 * option scopes candidates to `metadata.driverId === driverId`, mirroring
 * how the Postgres repo pushes the same scoping down to a real column.
 */
export function createInMemoryVectorRepo() {
  const store = new Map();
  return {
    async upsert(id, vector, metadata) {
      const record = { id, vector: [...vector], metadata: { ...metadata } };
      store.set(id, record);
      return cloneRecord(record);
    },
    async remove(id) {
      return store.delete(id);
    },
    async get(id) {
      const record = store.get(id);
      return record ? cloneRecord(record) : null;
    },
    async search(queryVector, options = {}) {
      const { topK = 5, driverId } = options;
      const scored = [];
      for (const record of store.values()) {
        if (record.vector.length !== queryVector.length) continue;
        if (driverId && record.metadata.driverId !== driverId) continue;
        scored.push({ ...cloneRecord(record), score: cosineSimilarity(queryVector, record.vector) });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    },
    async size() {
      return store.size;
    },
  };
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

// Postgres's pgvector output format (e.g. "[1,2,3]") is valid JSON, so the
// same JSON.parse-if-string handling as parseJsonColumn works here too.
function parseVectorColumn(value) {
  return typeof value === 'string' ? JSON.parse(value) : [...value];
}

function toVectorLiteral(vector) {
  return `[${vector.join(',')}]`;
}

/**
 * Postgres/pgvector-backed vector repo. Expects a `vector_patterns` table
 * (see db/migrations, `CREATE EXTENSION vector`) with a fixed-width
 * `embedding vector(4)` column matching the mock provider's 4-dim output —
 * widening it is a migration, documented as a known follow-up for whenever
 * a real embedding model replaces the mock. `driver_id` is stored as its
 * own column (not just inside `metadata` JSONB) so `search`'s `driverId`
 * scoping can be pushed into the `WHERE` clause alongside pgvector's `<=>`
 * (cosine distance) operator for the `ORDER BY`.
 * @param {import('@neondatabase/serverless').NeonQueryFunction<false,false>} sql
 */
export function createPostgresVectorRepo(sql) {
  function fromRow(row) {
    return {
      id: row.id,
      vector: parseVectorColumn(row.embedding),
      metadata: parseJsonColumn(row.metadata, {}),
    };
  }

  return {
    async upsert(id, vector, metadata) {
      const driverId = metadata?.driverId ?? null;
      const vectorLiteral = toVectorLiteral(vector);
      await sql`
        INSERT INTO vector_patterns (id, driver_id, embedding, metadata)
        VALUES (${id}, ${driverId}, ${vectorLiteral}::vector, ${JSON.stringify(metadata)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET driver_id = EXCLUDED.driver_id, embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata
      `;
      return { id, vector: [...vector], metadata: { ...metadata } };
    },
    async remove(id) {
      const rows = await sql`DELETE FROM vector_patterns WHERE id = ${id} RETURNING id`;
      return rows.length > 0;
    },
    async get(id) {
      const [row] = await sql`SELECT id, embedding, metadata FROM vector_patterns WHERE id = ${id}`;
      return row ? fromRow(row) : null;
    },
    async search(queryVector, options = {}) {
      const { topK = 5, driverId } = options;
      const vectorLiteral = toVectorLiteral(queryVector);
      const rows = driverId
        ? await sql`
            SELECT id, embedding, metadata, 1 - (embedding <=> ${vectorLiteral}::vector) AS score
            FROM vector_patterns
            WHERE driver_id = ${driverId}
            ORDER BY embedding <=> ${vectorLiteral}::vector
            LIMIT ${topK}
          `
        : await sql`
            SELECT id, embedding, metadata, 1 - (embedding <=> ${vectorLiteral}::vector) AS score
            FROM vector_patterns
            ORDER BY embedding <=> ${vectorLiteral}::vector
            LIMIT ${topK}
          `;
      return rows.map((row) => ({ ...fromRow(row), score: Number(row.score) }));
    },
    async size() {
      const [row] = await sql`SELECT COUNT(*)::int AS count FROM vector_patterns`;
      return row.count;
    },
  };
}

/**
 * Create a vector store with cosine-similarity search.
 * @param {object} [config]
 * @param {{upsert:Function, remove:Function, get:Function, search:Function, size:Function}} [config.repo] Vector repo (defaults to an in-memory one).
 */
export function createVectorStore(config = {}) {
  const { repo = createInMemoryVectorRepo() } = config;

  /**
   * Insert or replace a vector.
   * @param {string} id
   * @param {number[]} vector
   * @param {object} [metadata] Arbitrary data returned alongside search hits.
   * @returns {Promise<object>} The stored record.
   */
  async function upsert(id, vector, metadata = {}) {
    if (!id) {
      throw new EmbeddingError('An id is required', 'EMBEDDING_ID');
    }
    validateVector(vector);
    return repo.upsert(id, vector, { ...metadata });
  }

  /** Remove a vector. @returns {Promise<boolean>} Whether one was removed. */
  async function remove(id) {
    return repo.remove(id);
  }

  /** Get one vector record, or `null`. */
  async function get(id) {
    return repo.get(id);
  }

  /**
   * Nearest-neighbor search by cosine similarity, highest first.
   * @param {number[]} queryVector
   * @param {object} [options]
   * @param {number} [options.topK=5]
   * @param {string} [options.driverId] Restrict the candidate set to one driver's vectors.
   * @returns {Promise<Array<{id:string, score:number, vector:number[], metadata:object}>>}
   */
  async function search(queryVector, options = {}) {
    validateVector(queryVector);
    return repo.search(queryVector, options);
  }

  /** Number of stored vectors. */
  async function size() {
    return repo.size();
  }

  return { upsert, remove, get, search, size, repo };
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
    return vectorStore.search(vector, { ...options, driverId });
  }

  return { indexPattern, findSimilarPatterns, vectorStore, embeddingProvider };
}
