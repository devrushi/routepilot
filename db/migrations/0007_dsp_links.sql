-- dsp.js's createPostgresDspLinkRepo. partner/payout_rate are JSONB
-- (nested objects, always read/written whole). `seq` is app-assigned
-- (a within-process tie-breaker for links created in the same
-- millisecond), not a DB sequence.
CREATE TABLE IF NOT EXISTS dsp_links (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  partner JSONB NOT NULL,
  external_account_id TEXT NOT NULL,
  label TEXT,
  display_name TEXT NOT NULL,
  payout_rate JSONB NOT NULL,
  status TEXT NOT NULL,
  linked_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  seq BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS dsp_links_driver_id_idx ON dsp_links (driver_id);
