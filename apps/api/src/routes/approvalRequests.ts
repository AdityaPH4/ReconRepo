/**
 * Approval-request routes — the async queue a blocked GM's re-run waits in.
 * Mounted at `/api/approval-requests`. See `services/approvalService.ts` for
 * the gate this unblocks.
 */

import type { RequestApprovalRequest } from '@toit/contracts';
import { OUTLET_CODES, type OutletCode } from '@toit/recon-core';
import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { assertReconAllowed, createApprovalRequest } from '../services/approvalService.js';
import { getApprovalStore } from '../storage/index.js';

export const approvalRequestsRouter = Router();

approvalRequestsRouter.post('/', async (req, res, next) => {
  try {
    const body = req.body as RequestApprovalRequest;
    if (req.user.role !== 'gm') {
      res.status(403).json({ error: 'Only a GM can request approval for their own outlet.' });
      return;
    }
    if (body.outlet !== req.user.outlet) {
      res.status(403).json({ error: 'You can only request approval for your own outlet.' });
      return;
    }
    if (!body.businessDate) {
      res.status(400).json({ error: 'businessDate is required.' });
      return;
    }

    // Re-check server-side — don't trust the client that this is genuinely
    // blocked. If it isn't (already approved, or was never blocked), there's
    // nothing to request.
    try {
      await assertReconAllowed(body.outlet, body.businessDate);
      res.status(400).json({ error: 'This outlet/date is not currently blocked — nothing to request.' });
      return;
    } catch {
      // Expected — it IS blocked, which is exactly when a request is valid.
    }

    const request = await createApprovalRequest(body.outlet, body.businessDate, body.reason ?? null, req.user.email);
    res.status(201).json(request);
  } catch (err) {
    next(err);
  }
});

approvalRequestsRouter.get('/', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const outletParam = typeof req.query.outlet === 'string' ? (req.query.outlet as OutletCode) : undefined;
    const outlet = outletParam && (OUTLET_CODES as string[]).includes(outletParam) ? outletParam : undefined;

    const requests =
      req.user.role === 'admin'
        ? await getApprovalStore().list({ status: status as never, outlet })
        : await getApprovalStore().list({ requestedBy: req.user.email, status: status as never });
    res.json(requests);
  } catch (err) {
    next(err);
  }
});

approvalRequestsRouter.post('/:id/approve', requireAdmin, async (req, res, next) => {
  try {
    const decided = await getApprovalStore().decide(req.params.id!, 'approved', req.user.email, new Date().toISOString());
    res.json(decided);
  } catch (err) {
    next(err);
  }
});

approvalRequestsRouter.post('/:id/deny', requireAdmin, async (req, res, next) => {
  try {
    const decided = await getApprovalStore().decide(req.params.id!, 'denied', req.user.email, new Date().toISOString());
    res.json(decided);
  } catch (err) {
    next(err);
  }
});
