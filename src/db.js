// Shared Postgres client factory (Neon's HTTP-based driver — no persistent
// TCP connection pool to exhaust on serverless, which is what makes it a
// good fit for Vercel functions).
//
// Returns `null` when no connection string is configured, rather than
// throwing: every `create<X>Tracker`/`createAuthService`-style factory in
// this app defaults to an in-memory repo when its `repo` option is omitted,
// so "no DATABASE_URL" is a supported, first-class mode (local dev, the
// existing fast test suite) — not an error.

import { neon } from '@neondatabase/serverless';

/**
 * @param {object} [config]
 * @param {string} [config.url] Connection string (defaults to `process.env.DATABASE_URL`).
 * @returns {import('@neondatabase/serverless').NeonQueryFunction<false, false> | null}
 */
export function createDbClient(config = {}) {
  const url = config.url ?? process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}
