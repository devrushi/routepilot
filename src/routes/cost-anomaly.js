import { CostAnomalyError } from '../cost-anomaly.js';
import { sendJson, readJsonBody, requireSession, registerErrorStatuses } from '../http-utils.js';

const ANOMALY_ERROR_STATUS = {
  ANOMALY_COST: 400,
  ANOMALY_HISTORY: 400,
  ANOMALY_ROUTE: 400,
};

export function registerCostAnomalyRoutes(router, { sessionManager, routeCostTracker }) {
  registerErrorStatuses(CostAnomalyError, ANOMALY_ERROR_STATUS);

  router.get('/route-costs/:routeKey', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const history = await routeCostTracker.history(payload.sub, params.routeKey);
    sendJson(res, 200, { history });
  });

  router.post('/route-costs/:routeKey/check', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const result = await routeCostTracker.checkCost(payload.sub, params.routeKey, body.cost);
    sendJson(res, 200, { result });
  });

  router.post('/route-costs/:routeKey', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const result = await routeCostTracker.recordAndCheck(payload.sub, params.routeKey, body.cost);
    sendJson(res, 201, { result });
  });
}
