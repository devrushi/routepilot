import { RouteSyncError } from '../route-sync.js';
import { sendJson, requireSession, registerErrorStatuses } from '../http-utils.js';

const ROUTE_SYNC_ERROR_STATUS = {
  ROUTE_SYNC_STATUS: 400,
  ROUTE_SYNC_NOT_FOUND: 404,
};

// Read-only: syncing itself is a background-worker operation (like
// receipts.js's processNext/processAll), not something a driver's session
// triggers directly — see AGENTS.md.
export function registerRouteSyncRoutes(router, { sessionManager, routeSync }) {
  registerErrorStatuses(RouteSyncError, ROUTE_SYNC_ERROR_STATUS);

  router.get('/dsp/links/:id/routes', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const { status } = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    const routes = await routeSync.listRoutes(payload.sub, params.id, status ? { status } : {});
    sendJson(res, 200, { routes });
  });

  router.get('/dsp/links/:id/sync-state', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const state = await routeSync.getSyncState(payload.sub, params.id);
    sendJson(res, 200, { syncState: state });
  });
}
