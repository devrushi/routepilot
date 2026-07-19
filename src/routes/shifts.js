import { ShiftError } from '../shifts.js';
import { sendJson, readJsonBody, requireSession, registerErrorStatuses } from '../http-utils.js';

const SHIFT_ERROR_STATUS = {
  SHIFT_DRIVER: 400,
  SHIFT_LOCATION: 400,
  SHIFT_ODOMETER: 400,
  SHIFT_ALREADY_ACTIVE: 409,
  SHIFT_NOT_ACTIVE: 409,
  SHIFT_BREAK_ALREADY_ACTIVE: 409,
  SHIFT_BREAK_NOT_ACTIVE: 409,
  SHIFT_WAIT_ALREADY_ACTIVE: 409,
  SHIFT_WAIT_NOT_ACTIVE: 409,
  SHIFT_NOT_FOUND: 404,
};

/**
 * Registers /shifts routes. `driverId` always comes from the verified
 * session (`payload.sub`), never from the request body/params — a driver
 * can only ever act on their own shifts.
 */
export function registerShiftRoutes(router, { sessionManager, shiftTracker }) {
  registerErrorStatuses(ShiftError, SHIFT_ERROR_STATUS);

  router.post('/shifts/start', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const shift = await shiftTracker.startShift(payload.sub, body);
    sendJson(res, 201, { shift });
  });

  router.post('/shifts/end', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const shift = await shiftTracker.endShift(payload.sub, body);
    sendJson(res, 200, { shift });
  });

  router.post('/shifts/breaks/start', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const shift = await shiftTracker.startBreak(payload.sub, body);
    sendJson(res, 200, { shift });
  });

  router.post('/shifts/breaks/end', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const shift = await shiftTracker.endBreak(payload.sub, body);
    sendJson(res, 200, { shift });
  });

  router.post('/shifts/waits/start', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const shift = await shiftTracker.startWait(payload.sub, body);
    sendJson(res, 200, { shift });
  });

  router.post('/shifts/waits/end', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const shift = await shiftTracker.endWait(payload.sub, body);
    sendJson(res, 200, { shift });
  });

  router.post('/shifts/gps-points', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const shift = await shiftTracker.addGpsPoint(payload.sub, body);
    sendJson(res, 200, { shift });
  });

  router.post('/shifts/odometer', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const shift = await shiftTracker.setOdometer(payload.sub, body);
    sendJson(res, 200, { shift });
  });

  router.get('/shifts/active', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const shift = await shiftTracker.getActive(payload.sub);
    sendJson(res, 200, { shift });
  });

  router.get('/shifts', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const shifts = await shiftTracker.list(payload.sub);
    sendJson(res, 200, { shifts });
  });

  router.get('/shifts/:id', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const shift = await shiftTracker.get(payload.sub, params.id);
    if (!shift) {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    sendJson(res, 200, { shift });
  });

  router.get('/shifts/:id/trip-distance', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const tripDistance = await shiftTracker.getTripDistance(payload.sub, params.id);
    sendJson(res, 200, { tripDistance });
  });

  router.get('/shifts/:id/durations', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const durations = await shiftTracker.getDurations(payload.sub, params.id);
    sendJson(res, 200, { durations });
  });
}
