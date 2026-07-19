import { sendJson } from '../http-utils.js';

export function registerHealthRoutes(router, { now }) {
  router.get('/health', async (req, res) => {
    sendJson(res, 200, { status: 'ok', timestamp: new Date(now()).toISOString() });
  });
}
