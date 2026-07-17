/** Express middleware that gates routes behind a valid access token. */

import { NextFunction, Request, Response } from 'express';
import { AuthError, SessionService } from '../session/sessionService';
import { PublicUser } from '../session/types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by `requireAuth` once a valid access token is verified. */
      user?: PublicUser;
    }
  }
}

/** Extract a bearer token from the Authorization header, if present. */
export function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

export function requireAuth(sessions: SessionService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = extractBearerToken(req.header('authorization'));
    if (!token) {
      res.status(401).json({
        error: { code: 'missing_token', message: 'Authorization bearer token required' },
      });
      return;
    }

    try {
      req.user = await sessions.authenticate(token);
      next();
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
        return;
      }
      next(err);
    }
  };
}
