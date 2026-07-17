/**
 * REST endpoints for the authentication & MFA flows.
 *
 *   POST /auth/register        { email, password }
 *   POST /auth/login           { email, password }        -> tokens | mfa_required
 *   POST /auth/mfa/verify      { mfaToken, code }          -> tokens
 *   POST /auth/refresh         { refreshToken }            -> tokens
 *   GET  /auth/me                                          (protected)
 *   POST /auth/mfa/setup                                   (protected) -> otpauth uri
 *   POST /auth/mfa/activate    { code }                    (protected)
 *   POST /auth/mfa/disable     { code }                    (protected)
 */

import { NextFunction, Request, Response, Router } from 'express';
import { AuthError, SessionService } from '../session/sessionService';
import { requireAuth } from './authMiddleware';

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Wrap an async handler so rejected promises reach Express error handling. */
function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createAuthRouter(sessions: SessionService): Router {
  const router = Router();

  router.post(
    '/register',
    handle(async (req, res) => {
      const { email, password } = req.body ?? {};
      const result = await sessions.register(asString(email), asString(password));
      res.status(201).json(result);
    }),
  );

  router.post(
    '/login',
    handle(async (req, res) => {
      const { email, password } = req.body ?? {};
      const result = await sessions.login(asString(email), asString(password));
      res.status(200).json(result);
    }),
  );

  router.post(
    '/mfa/verify',
    handle(async (req, res) => {
      const { mfaToken, code } = req.body ?? {};
      const result = await sessions.completeMfa(asString(mfaToken), asString(code));
      res.status(200).json(result);
    }),
  );

  router.post(
    '/refresh',
    handle(async (req, res) => {
      const { refreshToken } = req.body ?? {};
      const tokens = await sessions.refresh(asString(refreshToken));
      res.status(200).json({ tokens });
    }),
  );

  router.get(
    '/me',
    requireAuth(sessions),
    handle(async (req, res) => {
      res.status(200).json({ user: req.user });
    }),
  );

  router.post(
    '/mfa/setup',
    requireAuth(sessions),
    handle(async (req, res) => {
      const enrollment = await sessions.beginMfaEnrollment(req.user!.id);
      res.status(200).json(enrollment);
    }),
  );

  router.post(
    '/mfa/activate',
    requireAuth(sessions),
    handle(async (req, res) => {
      const { code } = req.body ?? {};
      const user = await sessions.activateMfa(req.user!.id, asString(code));
      res.status(200).json({ user });
    }),
  );

  router.post(
    '/mfa/disable',
    requireAuth(sessions),
    handle(async (req, res) => {
      const { code } = req.body ?? {};
      const user = await sessions.disableMfa(req.user!.id, asString(code));
      res.status(200).json({ user });
    }),
  );

  return router;
}

/** Express error handler that maps AuthError to a clean JSON response. */
export function authErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof AuthError) {
    res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
    return;
  }
  res.status(500).json({ error: { code: 'internal_error', message: 'Unexpected error' } });
}
