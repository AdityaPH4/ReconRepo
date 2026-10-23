/**
 * Logs every mutating (non-GET) request that succeeds (2xx) to
 * `ActionLogStore`, split by the caller's role — a rolling, 10-day audit
 * trail of who did what, when, at which outlet. Generic on purpose: one
 * middleware covers every route (uploads, submits, justification entries,
 * advance/BOH/TDS close-reopen, approvals, …) rather than a bespoke log
 * call threaded through each one individually.
 *
 * `action` is simply `METHOD /real/url` (ids included, since
 * `req.originalUrl` is already the fully-resolved path) — not pretty
 * prose, but unambiguous and complete.
 *
 * Outlet is best-effort: most responses here are a `SessionDTO`
 * (`body.meta.outlet`) or a repository row with its own top-level
 * `outlet` (`AdvanceDTO`/`BohEntryDTO`/`ApprovalRequestDTO`/...). Falls
 * back to the caller's own locked outlet (a GM always has one); `null`
 * only for an admin action whose response carries no outlet at all.
 */

import type { OutletCode } from '@toit/recon-core';
import type { NextFunction, Request, Response } from 'express';
import { getActionLogStore } from '../storage/index.js';

/** Best-effort, runtime-only extraction from an untyped response body — the `OutletCode` cast trusts that a response really does carry one of the real outlet codes whenever this finds a string at all. */
function extractOutlet(req: Request, body: unknown): OutletCode | null {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const meta = b.meta;
    if (meta && typeof meta === 'object' && typeof (meta as Record<string, unknown>).outlet === 'string') {
      return (meta as Record<string, unknown>).outlet as OutletCode;
    }
    if (typeof b.outlet === 'string') return b.outlet as OutletCode;
  }
  return req.user?.outlet ?? null;
}

export function logActions(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET') {
    next();
    return;
  }

  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (req.user && res.statusCode >= 200 && res.statusCode < 300) {
      getActionLogStore()
        .record({
          role: req.user.role,
          action: `${req.method} ${req.originalUrl}`,
          outlet: extractOutlet(req, body),
          performedBy: req.user.email,
          createdAt: new Date().toISOString(),
        })
        .catch((err) => console.error('[action-log] failed to record:', err));
    }
    return originalJson(body);
  }) as Response['json'];

  next();
}
