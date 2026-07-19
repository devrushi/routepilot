// HTTP server entry point for RoutePilot.
//
// A composition root: builds shared services (db client, session manager,
// auth service, ...more as modules gain Postgres-backed repos), wires each
// resource's routes (src/routes/*.js) onto a small hand-rolled Router — no
// framework, matching this repo's original zero-dependency server.js, just
// organized to stay readable as the route count grows past what a single
// if/else chain can hold.

import { createServer as createHttpServer } from 'node:http';
import { createSessionManager } from './session.js';
import { createAuthService, createPostgresUserRepo } from './auth.js';
import { createShiftTracker, createPostgresShiftRepo } from './shifts.js';
import { createFuelLogger, createPostgresFuelRepo } from './fuel.js';
import { createReceiptProcessor, createPostgresReceiptRepo } from './receipts.js';
import { createExpenseTracker, createPostgresExpenseRepo } from './expenses.js';
import { createEstimatedPaymentTracker, createPostgresEstimatedPaymentRepo } from './estimated-payments.js';
import { createDspConnectionManager, createPostgresDspLinkRepo } from './dsp.js';
import { createRouteHistorySyncWorker, createPostgresRouteSyncRepo } from './route-sync.js';
import { createVehicleRegistry, createPostgresVehicleRepo } from './vehicles.js';
import { createProfileWizard, createPostgresOnboardingRepo } from './onboarding.js';
import { createRouteCostTracker, createPostgresRouteCostRepo } from './cost-anomaly.js';
import { createDriverPatternIndex, createVectorStore, createPostgresVectorRepo } from './embeddings.js';
import { createDbClient } from './db.js';
import { createRouter } from './router.js';
import { sendJson, handleError } from './http-utils.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerShiftRoutes } from './routes/shifts.js';
import { registerFuelRoutes } from './routes/fuel.js';
import { registerReceiptRoutes } from './routes/receipts.js';
import { registerExpenseRoutes } from './routes/expenses.js';
import { registerEstimatedPaymentRoutes } from './routes/estimated-payments.js';
import { registerDspRoutes } from './routes/dsp.js';
import { registerRouteSyncRoutes } from './routes/route-sync.js';
import { registerVehicleRoutes } from './routes/vehicles.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerCostAnomalyRoutes } from './routes/cost-anomaly.js';
import { registerEmbeddingRoutes } from './routes/embeddings.js';

export const DEFAULT_PORT = 3000;

// Dev-only fallback secrets so the server is runnable out of the box locally
// and in tests. Set SESSION_ACCESS_SECRET / SESSION_REFRESH_SECRET /
// AUTH_CHALLENGE_SECRET in any real deployment — these fallbacks are public
// (checked into this repo), so leaving them in place lets anyone forge
// sessions. Warns (not throws) so `npm start`/tests keep working unchanged.
const DEV_FALLBACK_SECRETS = {
  SESSION_ACCESS_SECRET: 'dev-only-access-secret-change-me',
  SESSION_REFRESH_SECRET: 'dev-only-refresh-secret-change-me',
  AUTH_CHALLENGE_SECRET: 'dev-only-challenge-secret-change-me',
};

function envSecret(name) {
  const value = process.env[name];
  if (value) return value;
  console.warn(`[routepilot] ${name} is not set — using an insecure, publicly-known dev fallback. Set it before deploying anywhere real.`);
  return DEV_FALLBACK_SECRETS[name];
}

// Builds every shared service, each overridable via config (tests inject
// their own; production relies on the env-var-driven defaults). `db` is
// `null` when DATABASE_URL is unset — every module's tracker/service falls
// back to an in-memory repo in that case, so local dev/tests need no
// database at all.
function resolveServices(config = {}) {
  const {
    now = () => Date.now(),
    db = createDbClient(),
    sessionManager = createSessionManager({
      accessSecret: envSecret('SESSION_ACCESS_SECRET'),
      refreshSecret: envSecret('SESSION_REFRESH_SECRET'),
      now,
    }),
    authService = createAuthService({
      sessionManager,
      challengeSecret: envSecret('AUTH_CHALLENGE_SECRET'),
      now,
      userStore: db ? createPostgresUserRepo(db) : undefined,
    }),
    shiftTracker = createShiftTracker({ now, repo: db ? createPostgresShiftRepo(db) : undefined }),
    fuelLogger = createFuelLogger({ now, repo: db ? createPostgresFuelRepo(db) : undefined }),
    receiptProcessor = createReceiptProcessor({ now, repo: db ? createPostgresReceiptRepo(db) : undefined }),
    expenseTracker = createExpenseTracker({ now, repo: db ? createPostgresExpenseRepo(db) : undefined }),
    paymentTracker = createEstimatedPaymentTracker({ now, repo: db ? createPostgresEstimatedPaymentRepo(db) : undefined }),
    connections = createDspConnectionManager({ now, repo: db ? createPostgresDspLinkRepo(db) : undefined }),
    // No real DSP portal integrated yet — only route-sync's read-only routes
    // (listRoutes/getSyncState) are exposed over HTTP, so `portal` is never
    // actually invoked from a request; the worker just requires one to construct.
    routeSync = createRouteHistorySyncWorker({
      now,
      connections,
      portal: async () => [],
      repo: db ? createPostgresRouteSyncRepo(db) : undefined,
    }),
    vehicleRegistry = createVehicleRegistry({ now, repo: db ? createPostgresVehicleRepo(db) : undefined }),
    profileWizard = createProfileWizard({ now, repo: db ? createPostgresOnboardingRepo(db) : undefined }),
    routeCostTracker = createRouteCostTracker({ repo: db ? createPostgresRouteCostRepo(db) : undefined }),
    patternIndex = createDriverPatternIndex({
      vectorStore: createVectorStore({ repo: db ? createPostgresVectorRepo(db) : undefined }),
    }),
  } = config;
  return {
    now,
    db,
    sessionManager,
    authService,
    shiftTracker,
    fuelLogger,
    receiptProcessor,
    expenseTracker,
    paymentTracker,
    connections,
    routeSync,
    vehicleRegistry,
    profileWizard,
    routeCostTracker,
    patternIndex,
  };
}

function buildRouter(services) {
  const router = createRouter();
  registerHealthRoutes(router, services);
  registerAuthRoutes(router, services);
  registerDashboardRoutes(router, services);
  registerShiftRoutes(router, services);
  registerFuelRoutes(router, services);
  registerReceiptRoutes(router, services);
  registerExpenseRoutes(router, services);
  registerEstimatedPaymentRoutes(router, services);
  registerDspRoutes(router, services);
  registerRouteSyncRoutes(router, services);
  registerVehicleRoutes(router, services);
  registerOnboardingRoutes(router, services);
  registerCostAnomalyRoutes(router, services);
  registerEmbeddingRoutes(router, services);
  return router;
}

/**
 * Build the RoutePilot request handler: `(req, res) => Promise<void>`,
 * compatible with both Node's `http.createServer` and Vercel/most other
 * Node serverless runtimes (they pass through standard
 * `IncomingMessage`/`ServerResponse`-shaped objects). Use this directly for
 * a serverless deployment; use {@link createServer} to also get a listening
 * `http.Server` for local/traditional hosting.
 * @param {object} [config] See {@link resolveServices}.
 */
export function createRequestHandler(config = {}) {
  const router = buildRouter(resolveServices(config));

  return async function handleRequest(req, res) {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const found = router.match(req.method, pathname);
      if (!found) {
        sendJson(res, 404, { error: 'Not Found' });
        return;
      }
      await found.handler(req, res, found.params);
    } catch (err) {
      handleError(res, err);
    }
  };
}

/**
 * Create (but do not start) the RoutePilot HTTP server.
 * @param {object} [config]
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 * @param {import('@neondatabase/serverless').NeonQueryFunction<false,false>|null} [config.db]
 * @param {ReturnType<import('./session.js').createSessionManager>} [config.sessionManager]
 * @param {ReturnType<import('./auth.js').createAuthService>} [config.authService]
 * @param {ReturnType<import('./shifts.js').createShiftTracker>} [config.shiftTracker]
 * @param {ReturnType<import('./fuel.js').createFuelLogger>} [config.fuelLogger]
 * @param {ReturnType<import('./receipts.js').createReceiptProcessor>} [config.receiptProcessor]
 * @param {ReturnType<import('./expenses.js').createExpenseTracker>} [config.expenseTracker]
 * @param {ReturnType<import('./estimated-payments.js').createEstimatedPaymentTracker>} [config.paymentTracker]
 * @param {ReturnType<import('./dsp.js').createDspConnectionManager>} [config.connections]
 * @param {ReturnType<import('./route-sync.js').createRouteHistorySyncWorker>} [config.routeSync]
 * @param {ReturnType<import('./vehicles.js').createVehicleRegistry>} [config.vehicleRegistry]
 * @param {ReturnType<import('./onboarding.js').createProfileWizard>} [config.profileWizard]
 * @param {ReturnType<import('./cost-anomaly.js').createRouteCostTracker>} [config.routeCostTracker]
 * @param {ReturnType<import('./embeddings.js').createDriverPatternIndex>} [config.patternIndex]
 * @returns {import('node:http').Server}
 */
export function createServer(config = {}) {
  return createHttpServer(createRequestHandler(config));
}

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const server = createServer();
  server.listen(port, () => {
    console.log(`RoutePilot server listening on port ${port}`);
  });
}
