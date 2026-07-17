/** Express application wiring for RoutePilot. */

import express, { Express } from 'express';
import { AuthConfig, authConfig } from '../config';
import { SessionService } from '../session/sessionService';
import { InMemoryUserStore, UserStore } from '../session/userStore';
import { authErrorHandler, createAuthRouter } from './authRoutes';

export interface AppDependencies {
  store?: UserStore;
  config?: AuthConfig;
  sessions?: SessionService;
}

export interface BuiltApp {
  app: Express;
  sessions: SessionService;
  store: UserStore;
}

/**
 * Build the Express app with its authentication routes. Dependencies can be
 * injected (used by tests); otherwise sensible in-memory defaults are created.
 */
export function createApp(deps: AppDependencies = {}): BuiltApp {
  const config = deps.config ?? authConfig;
  const store = deps.store ?? new InMemoryUserStore();
  const sessions = deps.sessions ?? new SessionService(store, config);

  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'routepilot' });
  });

  app.use('/auth', createAuthRouter(sessions));
  app.use(authErrorHandler);

  return { app, sessions, store };
}
