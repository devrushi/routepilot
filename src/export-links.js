// Scheduled email export worker: periodically emails a driver a link to
// their latest export (see exports.js) rather than attaching the file
// directly, via a signed, expiring download link.
//
// The link is a JWT (reusing jwt.js's HS256 sign/verify — no new crypto):
// its signature makes tampering detectable and its `exp` claim makes it
// self-expiring, so a leaked link stops working on its own rather than
// needing server-side revocation bookkeeping. The actual email send is
// stubbed behind a `{ send(email) }` provider interface (same pattern as the
// push/LLM/embedding tickets) — link issuance/verification and the
// sweep/scheduling logic that decides when to send are real.

import { JwtError, signJwt, verifyJwt } from './jwt.js';

export class ExportLinkError extends Error {
  constructor(message, code = 'EXPORT_LINK_INVALID') {
    super(message);
    this.name = 'ExportLinkError';
    this.code = code;
  }
}

const EXPORT_LINK_TYP = 'export_link';

/**
 * Create the signed export-link issuer/verifier.
 * @param {object} config
 * @param {string|Buffer} config.secret Signing key.
 * @param {number} [config.ttlSeconds=3600] Default link lifetime.
 * @param {string} [config.issuer='routepilot-exports']
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 */
export function createSignedExportLinkService(config = {}) {
  const { secret, ttlSeconds = 3600, issuer = 'routepilot-exports', now = () => Date.now() } = config;
  if (!secret) {
    throw new ExportLinkError('A signing secret is required', 'EXPORT_LINK_CONFIG');
  }
  const nowSeconds = () => Math.floor(now() / 1000);

  /**
   * Issue a signed, expiring link token for one driver's export.
   * @param {string} driverId
   * @param {string} exportId
   * @param {object} [options]
   * @param {number} [options.ttlSeconds] Overrides the default lifetime.
   * @returns {{token:string, expiresAt:number}} `expiresAt` in ms since epoch.
   */
  function createLink(driverId, exportId, options = {}) {
    if (!driverId || !exportId) {
      throw new ExportLinkError('driverId and exportId are required', 'EXPORT_LINK_FIELD');
    }
    const expiresInSeconds = options.ttlSeconds ?? ttlSeconds;
    const issuedAt = nowSeconds();
    const token = signJwt(
      { sub: driverId, exportId, typ: EXPORT_LINK_TYP, iss: issuer },
      secret,
      { now: issuedAt, expiresInSeconds },
    );
    return { token, expiresAt: (issuedAt + expiresInSeconds) * 1000 };
  }

  /**
   * Verify a link token: signature, expiry and type. Throws on anything
   * tampered, expired, or not an export-link token.
   * @param {string} token
   * @returns {{driverId:string, exportId:string}}
   */
  function verifyLink(token) {
    let payload;
    try {
      payload = verifyJwt(token, secret, { now: nowSeconds(), issuer });
    } catch (err) {
      if (err instanceof JwtError) {
        const code = err.code === 'JWT_EXPIRED' ? 'EXPORT_LINK_EXPIRED' : 'EXPORT_LINK_INVALID';
        throw new ExportLinkError(`Export link rejected: ${err.message}`, code);
      }
      throw err;
    }
    if (payload.typ !== EXPORT_LINK_TYP) {
      throw new ExportLinkError('Not an export link token', 'EXPORT_LINK_INVALID');
    }
    return { driverId: payload.sub, exportId: payload.exportId };
  }

  return { createLink, verifyLink };
}

/**
 * A mock email provider: `{ send(email): Promise<{id, status}> }`. A real
 * provider (SES, Postmark, SendGrid, ...) plugs in later as a different
 * object satisfying the same interface. This one just records what was sent.
 */
export function createMockEmailProvider() {
  const sent = [];
  return {
    async send(email) {
      const record = { id: `email_${sent.length + 1}`, status: 'sent', email };
      sent.push(record);
      return record;
    },
    sent,
  };
}

/**
 * Create the scheduled export-email worker.
 * @param {object} config
 * @param {ReturnType<typeof createSignedExportLinkService>} config.linkService
 * @param {(driverId:string) => (object|null|Promise<object|null>)} config.getLatestExport
 *   Resolves a driver's latest export as `{ exportId, ... }`, or `null` if they have none yet.
 * @param {() => string[]} config.listDriverIds Discovers which drivers to sweep.
 * @param {{send:(email:object)=>Promise<object>}} [config.emailProvider]
 * @param {(driverId:string) => string} [config.getRecipient] Resolves a driver's email address (defaults to echoing the driverId — this repo has no email-on-file yet).
 * @param {(token:string) => string} [config.buildDownloadUrl] Builds the download URL embedding the signed token.
 * @param {number} [config.intervalMs] Default sweep interval for {@link start}.
 * @param {(fn:Function, ms:number) => *} [config.setInterval]
 * @param {(handle:*) => void} [config.clearInterval]
 * @param {(report:object[]) => void} [config.onRun]
 * @param {(error:Error) => void} [config.onError]
 */
export function createScheduledExportEmailWorker(config = {}) {
  const {
    linkService,
    getLatestExport,
    listDriverIds,
    emailProvider = createMockEmailProvider(),
    getRecipient = (driverId) => driverId,
    buildDownloadUrl = (token) => `/exports/download?token=${token}`,
    intervalMs: defaultIntervalMs,
    onRun,
    onError,
  } = config;

  if (!linkService || typeof getLatestExport !== 'function' || typeof listDriverIds !== 'function') {
    throw new ExportLinkError(
      'linkService, getLatestExport and listDriverIds are required',
      'EXPORT_LINK_CONFIG',
    );
  }

  const setIntervalFn = config.setInterval ?? setInterval;
  const clearIntervalFn = config.clearInterval ?? clearInterval;
  let timer = null;

  /**
   * Sweep drivers, emailing anyone with a ready export a fresh signed link.
   * @param {object} [options]
   * @param {string} [options.driverId] Limit the sweep to a single driver.
   * @returns {Promise<object[]>} One entry per email sent.
   */
  async function runOnce(options = {}) {
    const driverIds = options.driverId ? [options.driverId] : listDriverIds();
    const results = [];

    for (const driverId of driverIds) {
      const latest = await getLatestExport(driverId);
      if (!latest || !latest.exportId) continue;

      const { token, expiresAt } = linkService.createLink(driverId, latest.exportId);
      const url = buildDownloadUrl(token);
      const sendResult = await emailProvider.send({
        to: getRecipient(driverId),
        subject: 'Your RoutePilot export is ready',
        body: `Your export is ready. Download it here (link expires ${new Date(expiresAt).toISOString()}): ${url}`,
        driverId,
        exportId: latest.exportId,
        url,
        expiresAt,
      });
      results.push({ driverId, exportId: latest.exportId, url, expiresAt, sendResult });
    }
    return results;
  }

  /**
   * Start the background worker: sweep now (unless `immediate:false`), then
   * on every interval. Throws `EXPORT_LINK_STATE` if already running.
   * @param {object} [options]
   * @param {number} [options.intervalMs]
   * @param {boolean} [options.immediate=true]
   * @returns {{stop:Function}}
   */
  function start(options = {}) {
    if (timer !== null) {
      throw new ExportLinkError('The export email worker is already running', 'EXPORT_LINK_STATE');
    }
    const interval = options.intervalMs ?? defaultIntervalMs;
    if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) {
      throw new ExportLinkError('A positive intervalMs is required to start', 'EXPORT_LINK_CONFIG');
    }
    const tick = () => {
      Promise.resolve()
        .then(() => runOnce(options))
        .then((report) => { onRun?.(report); }, (err) => { onError?.(err); });
    };
    if (options.immediate !== false) tick();
    timer = setIntervalFn(tick, interval);
    return { stop };
  }

  /** Stop the background worker. Safe to call when not running. */
  function stop() {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  /** Whether the background worker is currently scheduled. */
  function isRunning() {
    return timer !== null;
  }

  return { runOnce, start, stop, isRunning };
}
