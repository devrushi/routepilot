-- auth.js's createPostgresUserRepo. mfa/biometrics are always read/written
-- as whole objects via save(), so they stay JSONB rather than being
-- normalized into child tables (same rationale as shifts.js's breaks/waits/trip).
-- username_lower is a plain column (kept in sync in application code, not a
-- generated column) used for case-insensitive lookup and uniqueness.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  mfa JSONB NOT NULL DEFAULT '{"enabled":false,"secret":null,"pendingSecret":null,"recoveryCodes":[]}'::jsonb,
  biometrics JSONB NOT NULL DEFAULT '{"credentials":[]}'::jsonb,
  created_at BIGINT NOT NULL
);
