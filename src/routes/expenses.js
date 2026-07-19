import { ExpenseError } from '../expenses.js';
import { sendJson, readJsonBody, requireSession, registerErrorStatuses } from '../http-utils.js';

const EXPENSE_ERROR_STATUS = {
  EXPENSE_DRIVER: 400,
  EXPENSE_CATEGORY: 400,
  EXPENSE_JURISDICTION: 400,
  EXPENSE_AMOUNT: 400,
  EXPENSE_CURRENCY: 400,
  EXPENSE_AUTHORITY: 400,
};

export function registerExpenseRoutes(router, { sessionManager, expenseTracker }) {
  registerErrorStatuses(ExpenseError, EXPENSE_ERROR_STATUS);

  router.post('/expenses', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const expense = await expenseTracker.categorize(payload.sub, body);
    sendJson(res, 201, { expense });
  });

  router.get('/expenses', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const { category } = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    const expenses = await expenseTracker.list(payload.sub, category ? { category } : {});
    sendJson(res, 200, { expenses });
  });

  router.get('/expenses/:id', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const expense = await expenseTracker.get(payload.sub, params.id);
    if (!expense) {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    sendJson(res, 200, { expense });
  });
}
