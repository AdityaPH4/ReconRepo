/**
 * Unreconciled-TDS admin routes — `/api/tds`.
 *
 * Unlike `repositories.ts` (GM-facing, outlet-scoped, read-only "what's
 * eligible to pick" lists), this is admin-facing and cross-outlet: the
 * Accounts team verifies TDS deductions against Form 26AS independent of
 * any specific session, so both routes here require `requireAdmin` and list/
 * close across every outlet rather than scoping to the caller's own.
 */

import type { CloseTdsRequest } from '@toit/contracts';
import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { getTdsStore } from '../storage/index.js';

export const tdsRouter = Router();

tdsRouter.get('/', requireAdmin, async (req, res, next) => {
  try {
    const status = req.query.status === 'open' || req.query.status === 'closed' ? req.query.status : undefined;
    const entries = await getTdsStore().list(null, status);
    res.json(entries);
  } catch (err) {
    next(err);
  }
});

tdsRouter.post('/:id/close', requireAdmin, async (req, res, next) => {
  try {
    const store = getTdsStore();
    const entry = await store.get(req.params.id!);
    if (!entry) {
      res.status(404).json({ error: 'TDS entry not found' });
      return;
    }
    if (entry.status === 'closed') {
      res.status(409).json({ error: 'This TDS entry is already closed.' });
      return;
    }
    const body = req.body as CloseTdsRequest;
    const closed = await store.close(
      entry.id,
      new Date().toISOString(),
      req.user.email,
      body?.closedNote?.trim() || null,
    );
    res.json(closed);
  } catch (err) {
    next(err);
  }
});
