// Shared scaffolding for integration tests that run against a real Postgres
// database (TEST_DATABASE_URL) rather than an in-memory repo. Not itself a
// *.test.js file — nothing in here registers a test.
//
// `integrationTest` auto-skips (not fails) when TEST_DATABASE_URL isn't set,
// so `npm run test:integration` is always safe to run: with no database
// configured you get a clean "all skipped," not an error, and `npm test`
// (the default suite) never touches this directory at all.

import { test } from 'node:test';
import { neon } from '@neondatabase/serverless';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export const hasTestDb = Boolean(TEST_DATABASE_URL);

let sqlClient = null;
/** The shared test-database client, or `null` if TEST_DATABASE_URL isn't set. */
export function getTestSql() {
  if (!TEST_DATABASE_URL) return null;
  if (!sqlClient) sqlClient = neon(TEST_DATABASE_URL);
  return sqlClient;
}

/**
 * Like node:test's `test()`, but skips instead of running when there's no
 * test database configured.
 * @param {string} name
 * @param {(t: import('node:test').TestContext, sql: ReturnType<typeof getTestSql>) => Promise<void>} fn
 */
export function integrationTest(name, fn) {
  test(name, async (t) => {
    if (!hasTestDb) {
      t.skip('TEST_DATABASE_URL is not set');
      return;
    }
    await fn(t, getTestSql());
  });
}

/** Empty a set of tables before a test — table names are trusted constants from test files, never user input. */
export async function resetTables(sql, tableNames) {
  if (!sql) return;
  for (const name of tableNames) {
    await sql.query(`TRUNCATE TABLE ${name} CASCADE`);
  }
}
