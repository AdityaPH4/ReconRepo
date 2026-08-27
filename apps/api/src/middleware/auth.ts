/**
 * Authentication.
 *
 * Credential auth arrives with the Postgres layer. Until then this injects a
 * fixed development identity — but every route below it is already written
 * user-aware and outlet-scoped, so switching on real auth means replacing this
 * one function, not touching the routes.
 *
 * `describeConfig()` prints `auth=DEV STUB` at boot so this is never mistaken
 * for a secured deployment.
 */

import type { CurrentUserDTO } from '@toit/contracts';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user: CurrentUserDTO;
    }
  }
}

export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  req.user = {
    email: config.auth.devUser.email,
    role: config.auth.devUser.role,
    outlet: config.auth.devUser.outlet,
  };
  next();
}

/**
 * The outlet filter for a request: `null` for admins (all outlets), otherwise
 * the user's own outlet. Every list/read query passes through this so a GM can
 * never see another outlet's sessions.
 */
export function outletScope(req: Request) {
  return req.user.role === 'admin' ? null : req.user.outlet;
}
