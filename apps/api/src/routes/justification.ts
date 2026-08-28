/**
 * Justification routes — mounted at `/api/sessions/:id/justification`.
 *
 * Every handler here: loads the session, refuses if it's already submitted
 * (legacy's `applySessionLock()` — the port's equivalent is simply refusing
 * the write), applies one pure mutation from `justificationService.ts`,
 * recomputes the submit gate, and persists the whole session back through
 * the existing `SessionStore.update()` — no new persistence primitive for
 * draft state itself.
 */

import type {
  AddBohStagingRequest,
  AddJustificationEntryRequest,
  ApplyAdvanceRequest,
  ClearBohRequest,
  RecordAdvanceRequest,
  SessionDTO,
  ToggleSquareOffRequest,
} from '@toit/contracts';
import { Router } from 'express';
import { outletScope } from '../middleware/auth.js';
import {
  JustificationError,
  addBohStaging,
  addEntry,
  applyAdvance,
  buildExplanationItems,
  clearBoh,
  computeSubmitGate,
  recordAdvance,
  removeBohStaging,
  removeEntry,
  setSquareOff,
} from '../services/justificationService.js';
import { getAdvanceStore, getBohStore, getSessionStore } from '../storage/index.js';

export const justificationRouter = Router({ mergeParams: true });

async function loadDraftSession(req: import('express').Request): Promise<SessionDTO> {
  const session = await getSessionStore().get(req.params.id!);
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
  if (session.meta.status === 'submitted') {
    const err = new Error('Session is already submitted and locked.') as Error & { status?: number };
    err.status = 409;
    throw err;
  }
  return session;
}

async function persist(session: SessionDTO): Promise<SessionDTO> {
  const withGate: SessionDTO = {
    ...session,
    submitGate: computeSubmitGate(session),
    explanation: buildExplanationItems(session),
  };
  return getSessionStore().update(session.meta.id, withGate);
}

justificationRouter.post('/entries', async (req, res, next) => {
  try {
    const session = await loadDraftSession(req);
    const body = req.body as AddJustificationEntryRequest;
    const justification = addEntry(session.justification, body);
    const updated = await persist({ ...session, justification });
    res.status(201).json(updated);
  } catch (err) {
    next(err);
  }
});

justificationRouter.delete('/entries/:entryId', async (req, res, next) => {
  try {
    const session = await loadDraftSession(req);
    const justification = removeEntry(session.justification, req.params.entryId!);
    const updated = await persist({ ...session, justification });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

justificationRouter.post('/square-off', async (req, res, next) => {
  try {
    const session = await loadDraftSession(req);
    const body = req.body as ToggleSquareOffRequest;
    const justification = setSquareOff(session.justification, body.a, body.b, true);
    const updated = await persist({ ...session, justification });
    res.status(201).json(updated);
  } catch (err) {
    next(err);
  }
});

justificationRouter.delete('/square-off', async (req, res, next) => {
  try {
    const session = await loadDraftSession(req);
    const body = req.body as ToggleSquareOffRequest;
    const justification = setSquareOff(session.justification, body.a, body.b, false);
    const updated = await persist({ ...session, justification });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

justificationRouter.post('/advances', async (req, res, next) => {
  try {
    const session = await loadDraftSession(req);
    const body = req.body as RecordAdvanceRequest;
    const justification = recordAdvance(session.justification, body, {
      sessionId: session.meta.id,
      outlet: session.meta.outlet,
      businessDate: session.meta.businessDate,
    });
    const updated = await persist({ ...session, justification });
    res.status(201).json(updated);
  } catch (err) {
    next(err);
  }
});

justificationRouter.post('/advances/apply', async (req, res, next) => {
  try {
    const session = await loadDraftSession(req);
    const body = req.body as ApplyAdvanceRequest;
    const outlet = session.meta.outlet;
    const [committedAdvances, committedApplications] = await Promise.all([
      getAdvanceStore().list(outlet),
      getAdvanceStore().listApplications(outlet),
    ]);
    const justification = applyAdvance(session.justification, body, {
      sessionId: session.meta.id,
      advances: [...committedAdvances, ...session.justification.draftAdvances],
      applications: [...committedApplications, ...session.justification.draftApplications],
    });
    const updated = await persist({ ...session, justification });
    res.status(201).json(updated);
  } catch (err) {
    next(err);
  }
});

justificationRouter.post('/boh-staging', async (req, res, next) => {
  try {
    const session = await loadDraftSession(req);
    const body = req.body as AddBohStagingRequest;
    const justification = addBohStaging(session.justification, body);
    const updated = await persist({ ...session, justification });
    res.status(201).json(updated);
  } catch (err) {
    next(err);
  }
});

justificationRouter.delete('/boh-staging/:stagingId', async (req, res, next) => {
  try {
    const session = await loadDraftSession(req);
    const justification = removeBohStaging(session.justification, req.params.stagingId!);
    const updated = await persist({ ...session, justification });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

justificationRouter.post('/boh/clear', async (req, res, next) => {
  try {
    const session = await loadDraftSession(req);
    const body = req.body as ClearBohRequest;
    const outlet = session.meta.outlet;
    const entries = await getBohStore().list(outlet);
    const justification = clearBoh(session.justification, body, {
      sessionId: session.meta.id,
      entries,
      staging: session.justification.bohStaging,
    });
    const updated = await persist({ ...session, justification });
    res.status(201).json(updated);
  } catch (err) {
    next(err);
  }
});
