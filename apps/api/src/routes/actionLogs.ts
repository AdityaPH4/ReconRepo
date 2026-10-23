/**
 * Action-log routes — `/api/action-logs`. Admin-only: this is an audit
 * trail over everyone's actions (GM and admin alike), not a per-outlet
 * operational view, so it doesn't belong to a GM's own scope.
 */

import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { getActionLogStore } from '../storage/index.js';

export const actionLogsRouter = Router();

actionLogsRouter.get('/:role', requireAdmin, async (req, res, next) => {
  try {
    const role = req.params.role;
    if (role !== 'gm' && role !== 'admin') {
      res.status(400).json({ error: 'role must be "gm" or "admin".' });
      return;
    }
    const entries = await getActionLogStore().list(role);
    res.json(entries);
  } catch (err) {
    next(err);
  }
});
