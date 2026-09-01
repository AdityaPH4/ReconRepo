/**
 * Authentication.
 *
 * With `AUTH_SECRET` set, every `/api/*` request must carry the bearer token
 * Google sign-in minted (`routes/auth.ts`, `services/authToken.ts`) — missing
 * or invalid is a 401, not a fallback identity. Without `AUTH_SECRET` (no
 * Google credentials wired up yet), this injects a fixed development
 * identity instead, so `npm run dev` keeps working with zero setup; every
 * route below is already written user-aware and outlet-scoped either way.
 *
 * `describeConfig()` prints `auth=DEV STUB` at boot so the fallback is never
 * mistaken for a secured deployment.
 */

import type { CurrentUserDTO } from '@toit/contracts';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { verifyToken } from '../services/authToken.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user: CurrentUserDTO;
    }
  }
}

export function attachUser(req: Request, res: Response, next: NextFunction): void {
  if (!config.auth.enabled) {
    req.user = {
      email: config.auth.devUser.email,
      role: config.auth.devUser.role,
      outlet: config.auth.devUser.outlet,
    };
    next();
    return;
  }

  const header = req.header('authorization') ?? '';
  const headerToken = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  // A plain `<a href>` download (report/snapshot/CSV export) can't attach a
  // header, so those links carry the same token as `?token=` instead — same
  // token, just a different transport for the one case that needs it.
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
  const token = headerToken ?? queryToken;
  const payload = token ? verifyToken(token, config.auth.secret) : null;
  if (!payload) {
    res.status(401).json({ error: 'Sign in required.' });
    return;
  }
  req.user = { email: payload.email, role: payload.role, outlet: payload.outlet };
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

/** Blocks a route to admins only — the approval queue, deciding a request. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admins only.' });
    return;
  }
  next();
}
