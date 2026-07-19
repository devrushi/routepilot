// Small HTTP helpers shared by server.js and every src/routes/*.js module:
// JSON responses, JSON body parsing, bearer-token session auth, and a
// generic <Name>Error -> HTTP status mapping so each route module can
// register its own module's error codes without a growing central switch
// statement in server.js.

export class BodyError extends Error {}

export function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new BodyError('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new BodyError('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

/**
 * Verifies the request's bearer token against a session manager, sending a
 * 401 itself on missing/invalid tokens. Returns the access-token payload,
 * or `null` (the caller should just return — the response is already sent).
 */
export async function requireSession(req, res, sessionManager) {
  const token = bearerToken(req);
  if (!token) {
    sendJson(res, 401, { error: 'Missing session token' });
    return null;
  }
  try {
    // Awaited inside the try, not just returned — a rejected promise must
    // be caught right here, not propagate to the caller as a thrown error.
    return await sessionManager.verifyAccess(token);
  } catch {
    sendJson(res, 401, { error: 'Invalid or expired session' });
    return null;
  }
}

// ErrorClass -> (a `{ [code]: status }` map, or a single constant status
// for every code from that class). Populated by registerErrorStatuses,
// consulted by handleError — lets each route module own its module's
// error/status mapping instead of one ever-growing central table.
const errorStatusRegistry = new Map();

/**
 * Register how a module's `<Name>Error` maps onto HTTP status codes.
 * @param {Function} ErrorClass
 * @param {Record<string, number> | number} statusMapOrConstant A code->status map, or one status for every code from this class.
 */
export function registerErrorStatuses(ErrorClass, statusMapOrConstant) {
  errorStatusRegistry.set(ErrorClass, statusMapOrConstant);
}

registerErrorStatuses(BodyError, 400);

/** Send the right error response for anything a route handler threw. */
export function handleError(res, err) {
  for (const [ErrorClass, mapping] of errorStatusRegistry) {
    if (err instanceof ErrorClass) {
      const status = typeof mapping === 'number' ? mapping : (mapping[err.code] ?? 400);
      sendJson(res, status, { error: err.message, code: err.code });
      return;
    }
  }
  console.error(err);
  sendJson(res, 500, { error: 'Internal Server Error' });
}
