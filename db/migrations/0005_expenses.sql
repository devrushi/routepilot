-- expenses.js's createPostgresExpenseRepo. Plain columns throughout — the
-- record has no nested arrays/objects, unlike shifts.js/fuel.js. Insert-only
-- (no update).
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  category TEXT NOT NULL,
  category_label TEXT NOT NULL,
  authority TEXT NOT NULL,
  bucket TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL,
  at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS expenses_driver_id_idx ON expenses (driver_id);
CREATE INDEX IF NOT EXISTS expenses_driver_category_idx ON expenses (driver_id, category);
