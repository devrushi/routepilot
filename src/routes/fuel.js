import { FuelError } from '../fuel.js';
import { sendJson, readJsonBody, requireSession, registerErrorStatuses } from '../http-utils.js';

const FUEL_ERROR_STATUS = {
  FUEL_DRIVER: 400,
  FUEL_AMOUNT: 400,
  FUEL_VOLUME: 400,
  FUEL_UNIT: 400,
  FUEL_CURRENCY: 400,
  FUEL_KWH: 400,
};

/**
 * Registers /fuel routes. `driverId` always comes from the verified
 * session (`payload.sub`).
 */
export function registerFuelRoutes(router, { sessionManager, fuelLogger }) {
  registerErrorStatuses(FuelError, FUEL_ERROR_STATUS);

  router.post('/fuel/purchases', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const record = await fuelLogger.logFuelPurchase(payload.sub, body);
    sendJson(res, 201, { log: record });
  });

  router.post('/fuel/charging-sessions', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const record = await fuelLogger.logChargingSession(payload.sub, body);
    sendJson(res, 201, { log: record });
  });

  router.get('/fuel', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const { type } = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    const logs = await fuelLogger.list(payload.sub, type ? { type } : {});
    sendJson(res, 200, { logs });
  });

  router.get('/fuel/:id', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const log = await fuelLogger.get(payload.sub, params.id);
    if (!log) {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    sendJson(res, 200, { log });
  });
}
