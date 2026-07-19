import { EstimatedPaymentError, nextDueDate } from '../estimated-payments.js';
import { sendJson, readJsonBody, requireSession, registerErrorStatuses } from '../http-utils.js';

const PAYMENT_ERROR_STATUS = {
  PAYMENT_DRIVER: 400,
  PAYMENT_TAX_YEAR: 400,
  PAYMENT_QUARTER: 400,
  PAYMENT_AMOUNT: 400,
  PAYMENT_CURRENCY: 400,
  PAYMENT_AUTHORITY: 400,
  PAYMENT_NO_DUE_DATE: 404,
};

export function registerEstimatedPaymentRoutes(router, { sessionManager, paymentTracker }) {
  registerErrorStatuses(EstimatedPaymentError, PAYMENT_ERROR_STATUS);

  router.post('/estimated-payments', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const payment = await paymentTracker.recordPayment(payload.sub, body);
    sendJson(res, 201, { payment });
  });

  router.get('/estimated-payments', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    const filter = {};
    if (query.taxYear) filter.taxYear = Number(query.taxYear);
    if (query.quarter) filter.quarter = query.quarter;
    const payments = await paymentTracker.listPayments(payload.sub, filter);
    sendJson(res, 200, { payments });
  });

  router.get('/estimated-payments/next-due-date', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const { jurisdiction } = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    if (!jurisdiction) {
      sendJson(res, 400, { error: 'A jurisdiction query parameter is required' });
      return;
    }
    const next = nextDueDate(jurisdiction);
    sendJson(res, 200, { nextDueDate: next });
  });
}
