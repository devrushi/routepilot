import { bucketWeeklyProfit, renderWeeklyProfitChartSvg, AnalyticsError } from '../analytics.js';
import { sendJson, readJsonBody, requireSession, registerErrorStatuses } from '../http-utils.js';

export function registerDashboardRoutes(router, { sessionManager, authService }) {
  registerErrorStatuses(AnalyticsError, 400);

  router.get('/dashboard', async (req, res) => {
    const payload = requireSession(req, res, sessionManager);
    if (!payload) return;

    const user = await authService.userStore.findById(payload.sub);
    if (!user) {
      sendJson(res, 401, { error: 'Invalid or expired session' });
      return;
    }

    sendJson(res, 200, { profile: buildProfile(user) });
  });

  // Accepts { earnings, expenses } (each `[{ at, amount }]`) and returns the
  // weekly gross/net buckets plus a rendered SVG chart. Earnings/expenses
  // aren't persisted anywhere yet in this repo, so the caller supplies them
  // directly rather than this route looking them up itself.
  router.post('/dashboard/weekly-profit', async (req, res) => {
    const payload = requireSession(req, res, sessionManager);
    if (!payload) return;

    const { earnings = [], expenses = [] } = await readJsonBody(req);
    const buckets = bucketWeeklyProfit({ earnings, expenses });
    const svg = renderWeeklyProfitChartSvg(buckets);
    sendJson(res, 200, { buckets, svg });
  });
}

function buildProfile(user) {
  return {
    id: user.id,
    username: user.username,
    mfaEnabled: user.mfa.enabled,
    biometricEnrolled: Boolean(user.biometrics && user.biometrics.credentials.length > 0),
    createdAt: new Date(user.createdAt).toISOString(),
  };
}
