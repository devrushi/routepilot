import { VehicleError } from '../vehicles.js';
import { sendJson, readJsonBody, requireSession, registerErrorStatuses } from '../http-utils.js';

const VEHICLE_ERROR_STATUS = {
  VEHICLE_DRIVER: 400,
  VEHICLE_FIELD: 400,
  VEHICLE_YEAR: 400,
  VEHICLE_PLATE: 400,
  VEHICLE_FUEL_TYPE: 400,
  VEHICLE_CONNECTOR: 400,
  VEHICLE_BATTERY: 400,
  VEHICLE_VIN_FORMAT: 400,
  VEHICLE_VIN_INVALID: 400,
  VEHICLE_STATUS: 400,
  VEHICLE_DUPLICATE: 409,
  VEHICLE_NOT_FOUND: 404,
};

/** Registers /vehicles routes. `driverId` always comes from the verified session. */
export function registerVehicleRoutes(router, { sessionManager, vehicleRegistry }) {
  registerErrorStatuses(VehicleError, VEHICLE_ERROR_STATUS);

  router.post('/vehicles', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const vehicle = await vehicleRegistry.add(payload.sub, body, body.options ?? {});
    sendJson(res, 201, { vehicle });
  });

  router.get('/vehicles', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    const filter = {};
    if (query.status) filter.status = query.status;
    if (query.fuelCategory) filter.fuelCategory = query.fuelCategory;
    const vehicles = await vehicleRegistry.list(payload.sub, filter);
    sendJson(res, 200, { vehicles });
  });

  router.get('/vehicles/primary', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const vehicle = await vehicleRegistry.getPrimary(payload.sub);
    sendJson(res, 200, { vehicle });
  });

  router.get('/vehicles/:id', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const vehicle = await vehicleRegistry.get(payload.sub, params.id);
    sendJson(res, 200, { vehicle });
  });

  router.patch('/vehicles/:id', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const vehicle = await vehicleRegistry.update(payload.sub, params.id, body);
    sendJson(res, 200, { vehicle });
  });

  router.post('/vehicles/:id/activate', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const vehicle = await vehicleRegistry.activate(payload.sub, params.id);
    sendJson(res, 200, { vehicle });
  });

  router.post('/vehicles/:id/deactivate', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const vehicle = await vehicleRegistry.deactivate(payload.sub, params.id);
    sendJson(res, 200, { vehicle });
  });

  router.post('/vehicles/:id/retire', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const vehicle = await vehicleRegistry.retire(payload.sub, params.id);
    sendJson(res, 200, { vehicle });
  });

  router.post('/vehicles/:id/primary', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const vehicle = await vehicleRegistry.setPrimary(payload.sub, params.id);
    sendJson(res, 200, { vehicle });
  });

  router.delete('/vehicles/:id', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const removed = await vehicleRegistry.remove(payload.sub, params.id);
    sendJson(res, 200, { removed });
  });
}
