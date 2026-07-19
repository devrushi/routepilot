import { DspError } from '../dsp.js';
import { sendJson, readJsonBody, requireSession, registerErrorStatuses } from '../http-utils.js';

const DSP_ERROR_STATUS = {
  DSP_DRIVER: 400,
  DSP_FIELD: 400,
  DSP_CURRENCY: 400,
  DSP_RATE: 400,
  DSP_RATE_TYPE: 400,
  DSP_PARTNER: 400,
  DSP_STATUS: 400,
  DSP_WORK: 400,
  DSP_DUPLICATE: 409,
  DSP_NOT_FOUND: 404,
};

/** Registers /dsp/links routes. `driverId` always comes from the verified session. */
export function registerDspRoutes(router, { sessionManager, connections }) {
  registerErrorStatuses(DspError, DSP_ERROR_STATUS);

  router.post('/dsp/links', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const link = await connections.link(payload.sub, body, body.options ?? {});
    sendJson(res, 201, { link });
  });

  router.get('/dsp/links', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    const filter = {};
    if (query.status) filter.status = query.status;
    if (query.category) filter.category = query.category;
    const links = await connections.list(payload.sub, filter);
    sendJson(res, 200, { links });
  });

  router.get('/dsp/links/:id', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const link = await connections.get(payload.sub, params.id);
    sendJson(res, 200, { link });
  });

  router.patch('/dsp/links/:id', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const link = await connections.update(payload.sub, params.id, body);
    sendJson(res, 200, { link });
  });

  router.patch('/dsp/links/:id/rate', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const link = await connections.updateRate(payload.sub, params.id, body);
    sendJson(res, 200, { link });
  });

  router.post('/dsp/links/:id/activate', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const link = await connections.activate(payload.sub, params.id);
    sendJson(res, 200, { link });
  });

  router.post('/dsp/links/:id/suspend', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const link = await connections.suspend(payload.sub, params.id);
    sendJson(res, 200, { link });
  });

  router.post('/dsp/links/:id/unlink', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const link = await connections.unlink(payload.sub, params.id);
    sendJson(res, 200, { link });
  });

  router.post('/dsp/links/:id/estimate-payout', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const estimate = await connections.estimatePayout(payload.sub, params.id, body.work, { peak: body.peak });
    sendJson(res, 200, { estimate });
  });

  router.delete('/dsp/links/:id', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const removed = await connections.remove(payload.sub, params.id);
    sendJson(res, 200, { removed });
  });
}
