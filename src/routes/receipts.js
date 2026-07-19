import { ReceiptError } from '../receipts.js';
import { sendJson, readJsonBody, requireSession, registerErrorStatuses } from '../http-utils.js';

const RECEIPT_ERROR_STATUS = {
  RECEIPT_DRIVER: 400,
  RECEIPT_UPLOAD: 400,
  RECEIPT_NOT_FOUND: 404,
  RECEIPT_NOT_QUEUED: 409,
};

// processNext()/processAll() sweep the FIFO queue across *all* drivers —
// a background-worker operation, not something scoped to one session, so
// they're deliberately not exposed here. A driver can only queue and
// process their own receipts (by id), never trigger a global sweep.
export function registerReceiptRoutes(router, { sessionManager, receiptProcessor }) {
  registerErrorStatuses(ReceiptError, RECEIPT_ERROR_STATUS);

  router.post('/receipts', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const receipt = await receiptProcessor.queue(payload.sub, body);
    sendJson(res, 201, { receipt });
  });

  router.post('/receipts/:id/process', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const receipt = await receiptProcessor.process(payload.sub, params.id);
    sendJson(res, 200, { receipt });
  });

  router.get('/receipts', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const { status } = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    const receipts = await receiptProcessor.list(payload.sub, status ? { status } : {});
    sendJson(res, 200, { receipts });
  });

  router.get('/receipts/:id', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const receipt = await receiptProcessor.get(payload.sub, params.id);
    if (!receipt) {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    sendJson(res, 200, { receipt });
  });
}
