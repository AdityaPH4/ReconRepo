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

import type { EligibleAdvanceDTO, EligibleBohEntryDTO } from '@toit/contracts';
import { eligibleAdvances, eligibleBohEntries, type BohEntry } from '@toit/recon-core';
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
