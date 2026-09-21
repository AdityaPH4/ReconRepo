/**
 * Cross-session repository routes — `/api/advances` and `/api/boh`.
 *
 * These list what's eligible to pick from an "Advance Applied" or "Bill on
 * Hold Cleared" modal: committed repository rows for the caller's outlet,
 * merged with whatever this draft session has itself recorded but not yet
 * committed (a session's own new advance/BOH-staging additions must be
 * usable within the same session before submit — see legacy's combined
 * `[...S.bohRepo, ...S.bohRepoStaging]` read).
 */

import type { AdvanceWithBalanceDTO, CloseAdvanceRequest, EligibleAdvanceDTO, EligibleBohEntryDTO } from '@toit/contracts';
import {
  OUTLET_CODES,
  advanceBalance,
  eligibleAdvances,
  eligibleBohEntries,
  type BohEntry,
  type OutletCode,
} from '@toit/recon-core';
import { Router } from 'express';
import { outletScope } from '../middleware/auth.js';
import { getAdvanceStore, getBohStore, getSessionStore } from '../storage/index.js';

async function loadSessionInScope(req: import('express').Request, sessionId: string) {
  const session = await getSessionStore().get(sessionId);
  if (!session) {
    const err = new Error('Session not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const scope = outletScope(req);
  if (scope && session.meta.outlet !== scope) {
    const err = new Error('Session not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  return session;
}

export const advancesRouter = Router();

advancesRouter.get('/eligible', async (req, res, next) => {
  try {
    const sessionId = String(req.query.sessionId ?? '');
    if (!sessionId) throw Object.assign(new Error('sessionId is required'), { status: 400 });
    const session = await loadSessionInScope(req, sessionId);
    const outlet = session.meta.outlet;

    const [committedAdvances, committedApplications] = await Promise.all([
      getAdvanceStore().list(outlet),
      getAdvanceStore().listApplications(outlet),
    ]);
    const advances = [...committedAdvances, ...session.justification.draftAdvances];
    const applications = [...committedApplications, ...session.justification.draftApplications];

    const amount = req.query.amount ? Number(req.query.amount) : undefined;
    const eligible = eligibleAdvances(advances, applications, amount);
    res.json(eligible satisfies EligibleAdvanceDTO[]);
  } catch (err) {
    next(err);
  }
});

// GET /api/advances — every committed advance for the caller's outlet (open
// + closed), with its derived balance. Unlike `/eligible`, this has no
// sessionId and merges no draft state — it only ever deals with committed,
// closeable rows, for the standalone Advance Closure module.
advancesRouter.get('/', async (req, res, next) => {
  try {
    let outlet: OutletCode | null;
    if (req.user.role === 'admin') {
      // An admin with no `?outlet=` sees every outlet at once; passing one
      // filters down to it, same as a GM's own implicit scope.
      const requested = typeof req.query.outlet === 'string' ? (req.query.outlet as OutletCode) : undefined;
      outlet = requested && (OUTLET_CODES as string[]).includes(requested) ? requested : null;
    } else {
      outlet = req.user.outlet;
      if (!outlet) {
        res.status(400).json({ error: 'No outlet to show advances for.' });
        return;
      }
    }
    const [advances, applications] = await Promise.all([
      getAdvanceStore().list(outlet),
      getAdvanceStore().listApplications(outlet),
    ]);
    const withBalance = advances.map((advance) => ({ advance, balance: advanceBalance(advance, applications) }));
    res.json(withBalance satisfies AdvanceWithBalanceDTO[]);
  } catch (err) {
    next(err);
  }
});

// POST /api/advances/:id/close — outlet-scoped: a GM closes their own
// outlet's advance (an admin, like every other outletScope()-gated route,
// incidentally retains blanket cross-outlet access via the same primitive).
// Lives directly in the route handler, not `justificationService.ts` —
// this is store-mutating and session-independent, the same reasoning
// `recordTds`'s doc comment gives for why `closeTds` isn't a pure
// JustificationState transform either.
advancesRouter.post('/:id/close', async (req, res, next) => {
  try {
    const store = getAdvanceStore();
    const advance = await store.get(req.params.id!);
    if (!advance) {
      res.status(404).json({ error: 'Advance not found' });
      return;
    }
    const scope = outletScope(req);
    if (scope && advance.outlet !== scope) {
      res.status(404).json({ error: 'Advance not found' });
      return;
    }
    if (advance.status === 'closed') {
      res.status(409).json({ error: 'This advance is already closed.' });
      return;
    }
    const body = req.body as CloseAdvanceRequest;
    if (!body?.closedReason?.trim()) {
      res.status(400).json({ error: 'A reason is required to close an advance.' });
      return;
    }
    const closed = await store.close(advance.id, new Date().toISOString(), req.user.email, body.closedReason.trim());
    res.json(closed);
  } catch (err) {
    next(err);
  }
});

export const bohRouter = Router();

bohRouter.get('/eligible', async (req, res, next) => {
  try {
    const sessionId = String(req.query.sessionId ?? '');
    if (!sessionId) throw Object.assign(new Error('sessionId is required'), { status: 400 });
    const session = await loadSessionInScope(req, sessionId);
    const outlet = session.meta.outlet;

    const committed = await getBohStore().list(outlet);
    // A session's own staged (not-yet-committed) BOH additions are clearable
    // in the same session — legacy reads `[...S.bohRepo, ...S.bohRepoStaging]`
    // as one combined list.
    const staged: BohEntry[] = session.justification.bohStaging.map((s) => ({
      id: s.id,
      outlet,
      orderNo: s.orderNo,
      custName: s.custName,
      phone: s.phone,
      amount: s.amount,
      bohDate: s.bohDate,
      notes: s.notes,
      recordedDate: new Date().toISOString().slice(0, 10),
      status: 'open',
      clearedAt: null,
      clearedBySessionId: null,
    }));
    // Exclude anything this draft session has already queued a clearance for
    // — its clearance isn't committed yet, so the store still shows `open`.
    const pendingClearanceIds = new Set(session.justification.draftBohClearances.map((c) => c.bohEntryId));
    const combined = [...committed, ...staged].filter((b) => !pendingClearanceIds.has(b.id));

    const amount = req.query.amount ? Number(req.query.amount) : undefined;
    const includeToday = req.query.includeToday === 'true';
    const eligible = eligibleBohEntries(combined, {
      outlet,
      businessDate: session.meta.businessDate,
      includeToday,
      exactAmount: amount,
    });
    res.json(eligible satisfies EligibleBohEntryDTO[]);
  } catch (err) {
    next(err);
  }
});
