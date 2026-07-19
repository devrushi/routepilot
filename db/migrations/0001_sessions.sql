-- session.js's createPostgresSessionRepo. `sid` stays the app-generated
-- UUID primary key (matches JWT `sid` claims exactly, no translation
-- layer). Timestamps are BIGINT ms-since-epoch, not TIMESTAMPTZ — the app
-- already treats these as raw ms integers everywhere.
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  refresh_jti TEXT NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_subject_idx ON sessions (subject);
