-- receipts.js's createPostgresReceiptRepo. No separate queue table —
-- "queued" is just a status; claimNextQueued() does a single
-- CTE + UPDATE ... FOR UPDATE SKIP LOCKED to atomically claim the oldest
-- queued row without a race between concurrent workers. Uploaded file
-- bytes are never persisted here — only path/mimeType (see module header).
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  status TEXT NOT NULL,
  upload JSONB NOT NULL,
  queued_at BIGINT NOT NULL,
  processed_at BIGINT,
  fields JSONB,
  raw_text TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS receipts_driver_id_idx ON receipts (driver_id);
CREATE INDEX IF NOT EXISTS receipts_status_queued_at_idx ON receipts (status, queued_at);
