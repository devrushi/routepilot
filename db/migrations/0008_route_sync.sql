-- route-sync.js's createPostgresRouteSyncRepo. Two tables: per-link sync
-- state (cursor/lastRunAt/lastError) and the synced routes themselves,
-- upserted (deduped) by (driver_id, link_id, route_id).
CREATE TABLE IF NOT EXISTS route_sync_state (
  driver_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  cursor BIGINT,
  last_run_at BIGINT,
  last_error TEXT,
  PRIMARY KEY (driver_id, link_id)
);

CREATE TABLE IF NOT EXISTS synced_routes (
  driver_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  partner TEXT,
  status TEXT,
  status_description TEXT,
  started_at BIGINT,
  completed_at BIGINT,
  work JSONB,
  earnings NUMERIC,
  currency TEXT,
  raw JSONB,
  synced_at BIGINT NOT NULL,
  PRIMARY KEY (driver_id, link_id, route_id)
);

CREATE INDEX IF NOT EXISTS synced_routes_driver_link_idx ON synced_routes (driver_id, link_id);
