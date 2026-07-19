-- shifts.js's createPostgresShiftRepo. breaks/waits/trip/location fields
-- are JSONB (always read/written as a whole object from the app) rather
-- than normalized child tables — see AGENTS.md's schema-conventions note.
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  start_location JSONB NOT NULL,
  ended_at BIGINT,
  end_location JSONB,
  breaks JSONB NOT NULL DEFAULT '[]',
  waits JSONB NOT NULL DEFAULT '[]',
  trip JSONB NOT NULL DEFAULT '{"gpsPoints":[],"gpsDistanceMiles":0,"odometer":null}'
);

CREATE INDEX IF NOT EXISTS shifts_driver_id_idx ON shifts (driver_id);
