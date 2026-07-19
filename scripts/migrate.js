#!/usr/bin/env node
// Minimal migration runner: applies db/migrations/*.sql in filename order,
// tracking what's already run in a `schema_migrations` table. No migration
// framework — this repo hand-writes SQL, so this just needs to be "run
// files I haven't run yet, in order, exactly once."
//
// Usage:
//   npm run migrate                 # applies against DATABASE_URL
//   npm run migrate -- --test       # applies against TEST_DATABASE_URL
//
// Not run inside a transaction — Neon's HTTP driver doesn't support
// multi-statement transactions over a single query call — so every
// migration must be written to be safe to re-run/resume (CREATE TABLE IF
// NOT EXISTS, CREATE INDEX IF NOT EXISTS, etc.) rather than relying on
// all-or-nothing rollback.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');

function splitStatements(sqlText) {
  return sqlText
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const useTest = process.argv.includes('--test');
  const url = useTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  const envName = useTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
  if (!url) {
    console.error(`${envName} is not set.`);
    process.exit(1);
  }

  const sql = neon(url);
  await sql.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  );

  const appliedRows = await sql.query('SELECT filename FROM schema_migrations');
  const applied = new Set(appliedRows.map((r) => r.filename));

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;

  for (const file of files) {
    if (applied.has(file)) continue;
    const content = await readFile(path.join(migrationsDir, file), 'utf8');
    console.log(`Applying ${file}...`);
    for (const statement of splitStatements(content)) {
      await sql.query(statement);
    }
    await sql.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    console.log(`Applied ${file}`);
    count += 1;
  }

  console.log(count === 0 ? 'Already up to date.' : `Applied ${count} migration(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
