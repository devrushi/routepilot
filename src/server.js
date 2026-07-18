// HTTP server entry point for RoutePilot.
//
// Built on Node's built-in `http` module rather than a framework — the repo
// had zero dependencies before this ticket, so a small hand-rolled router
// keeps that true. If routes grow enough to need real path params,
// middleware chains, etc., swap this for Express then.

import { createServer as createHttpServer } from 'node:http';

export const DEFAULT_PORT = 3000;

/**
 * Create (but do not start) the RoutePilot HTTP server.
 * @param {object} [config]
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 * @returns {import('node:http').Server}
 */
export function createServer(config = {}) {
  const { now = () => Date.now() } = config;

  return createHttpServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { status: 'ok', timestamp: new Date(now()).toISOString() });
      return;
    }
    sendJson(res, 404, { error: 'Not Found' });
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const server = createServer();
  server.listen(port, () => {
    console.log(`RoutePilot server listening on port ${port}`);
  });
}
