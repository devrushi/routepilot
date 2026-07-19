-- vehicles.js's createPostgresVehicleRepo. plate/fuel/battery are JSONB
-- (nested objects, always read/written whole). Column is `primary_flag`,
-- not `primary` (awkward to quote everywhere) — mapped to `primary` in JS.
CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  vin TEXT NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER NOT NULL,
  nickname TEXT,
  display_name TEXT NOT NULL,
  plate JSONB,
  fuel JSONB NOT NULL,
  battery JSONB,
  status TEXT NOT NULL,
  primary_flag BOOLEAN NOT NULL DEFAULT false,
  added_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  seq BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS vehicles_driver_id_idx ON vehicles (driver_id);
