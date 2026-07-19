-- estimated-payments.js's createPostgresEstimatedPaymentRepo. Plain columns
-- throughout, insert-only (no update) — multiple partial payments per
-- tax-year/quarter are just multiple rows.
CREATE TABLE IF NOT EXISTS estimated_payments (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  quarter TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL,
  paid_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS estimated_payments_driver_id_idx ON estimated_payments (driver_id);
CREATE INDEX IF NOT EXISTS estimated_payments_driver_year_quarter_idx ON estimated_payments (driver_id, tax_year, quarter);
