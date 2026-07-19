import { WizardError } from '../onboarding.js';
import { sendJson, readJsonBody, requireSession, registerErrorStatuses } from '../http-utils.js';

const WIZARD_ERROR_STATUS = {
  WIZARD_USER: 400,
  WIZARD_INVALID_CHOICE: 400,
  WIZARD_WRONG_STEP: 400,
  WIZARD_UNKNOWN_STEP: 400,
  WIZARD_NO_STEP: 400,
  WIZARD_AT_START: 400,
  WIZARD_INCOMPLETE: 400,
  WIZARD_ALREADY_STARTED: 409,
  WIZARD_COMPLETED: 409,
  WIZARD_ALREADY_COMPLETED: 409,
  WIZARD_NOT_STARTED: 404,
};

/** Registers /onboarding routes. `userId` always comes from the verified session. */
export function registerOnboardingRoutes(router, { sessionManager, profileWizard }) {
  registerErrorStatuses(WizardError, WIZARD_ERROR_STATUS);

  router.get('/onboarding/steps', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    sendJson(res, 200, { steps: profileWizard.getSteps() });
  });

  router.post('/onboarding/start', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const state = await profileWizard.start(payload.sub, { restart: body.restart === true });
    sendJson(res, 201, { state });
  });

  router.get('/onboarding', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const state = await profileWizard.getState(payload.sub);
    sendJson(res, 200, { state });
  });

  router.post('/onboarding/steps/:stepId', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const state = await profileWizard.submitStep(payload.sub, params.stepId, body.value);
    sendJson(res, 200, { state });
  });

  router.post('/onboarding/back', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const state = await profileWizard.back(payload.sub);
    sendJson(res, 200, { state });
  });

  router.post('/onboarding/goto/:stepId', async (req, res, params) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const state = await profileWizard.goToStep(payload.sub, params.stepId);
    sendJson(res, 200, { state });
  });

  router.post('/onboarding/complete', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const profile = await profileWizard.complete(payload.sub);
    sendJson(res, 200, { profile });
  });
}
