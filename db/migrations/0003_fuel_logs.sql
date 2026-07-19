-- fuel.js's createPostgresFuelRepo. Logs are insert-only (never mutated),
-- and fuel/charging records have different field sets, so the whole record
-- is stored as JSONB (`data`) with just the columns needed for
-- filtering/sorting broken out.
CREATE TABLE IF NOT EXISTS fuel_logs (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS fuel_logs_driver_id_idx ON fuel_logs (driver_id);
CREATE INDEX IF NOT EXISTS fuel_logs_driver_type_idx ON fuel_logs (driver_id, type);
