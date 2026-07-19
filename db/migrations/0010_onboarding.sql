-- onboarding.js's createPostgresOnboardingRepo. One row per user; answers/
-- profile are JSONB — heterogeneous, step-shaped data not worth normalizing.
CREATE TABLE IF NOT EXISTS onboarding_wizard_state (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  answers JSONB NOT NULL,
  started_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT,
  profile JSONB
);
