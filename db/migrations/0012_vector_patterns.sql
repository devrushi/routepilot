-- embeddings.js's createPostgresVectorRepo. Requires the pgvector extension.
-- `embedding vector(4)` is fixed-width to match the mock embedding
-- provider's 4-dim output (totalMiles, totalEarnings, shiftHours,
-- deliveries) — widening this to a real model's dimensionality later is a
-- migration (ALTER COLUMN ... TYPE vector(N)), not solved here.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS vector_patterns (
  id TEXT PRIMARY KEY,
  driver_id TEXT,
  embedding vector(4) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS vector_patterns_driver_id_idx ON vector_patterns (driver_id);
