# Migrations

Plain `.sql` files, applied in filename order by `scripts/migrate.js` (`npm run migrate`). Numbered `NNNN_description.sql`, roughly one file per module/cluster converted to Postgres.

Not run inside a transaction (Neon's HTTP driver doesn't support multi-statement transactions over one call) — every migration must be safe to re-run/resume: use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, etc. Applied filenames are tracked in a `schema_migrations` table the runner creates automatically.
