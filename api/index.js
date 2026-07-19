// Vercel serverless entry point. vercel.json rewrites every request here, so
// this single function serves the whole app — createRequestHandler() is the
// same request handler createServer() wraps in a real http.Server for local/
// traditional hosting, just without the .listen() call serverless forbids.
//
// Built once per cold start (module scope), so the in-memory session/user/
// etc. stores in src/server.js's default services live only as long as this
// function instance does — see AGENTS.md's deployment note.

import { createRequestHandler } from '../src/server.js';

export default createRequestHandler();
