// Vercel serverless entry point. vercel.json rewrites every request here, so
// this single function serves the whole app — createRequestHandler() is the
// same request handler createServer() wraps in a real http.Server for local/
// traditional hosting, just without the .listen() call serverless forbids.
//
// Built once per cold start (module scope). resolveServices() in src/server.js
// falls back to an in-memory repo for any module when DATABASE_URL is unset —
// on Vercel that means data silently vanishes between cold starts, so
// DATABASE_URL (and the SESSION_*/AUTH_CHALLENGE_SECRET env vars) MUST be set
// as real Vercel project environment variables before this is reachable from
// the internet. See AGENTS.md's deployment note.

import { createRequestHandler } from '../src/server.js';

export default createRequestHandler();
