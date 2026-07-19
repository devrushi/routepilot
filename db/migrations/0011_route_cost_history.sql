-- cost-anomaly.js's createPostgresRouteCostRepo. Insert-only history of
-- recorded costs per driver/route, read back in insertion order for the
-- mean/stddev calculation in detectCostAnomaly.
CREATE TABLE IF NOT EXISTS route_cost_history (
  id BIGSERIAL PRIMARY KEY,
  driver_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  cost NUMERIC NOT NULL
);

CREATE INDEX IF NOT EXISTS route_cost_history_driver_route_idx ON route_cost_history (driver_id, route_key, id);
