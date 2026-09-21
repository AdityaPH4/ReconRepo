/**
 * Admin dashboard — mounted at `/api/admin/dashboard`, admin-only.
 */

import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { buildAdminDashboard } from '../services/adminDashboardService.js';

export const adminDashboardRouter = Router();

adminDashboardRouter.get('/', requireAdmin, async (req, res, next) => {
  try {
    res.json(await buildAdminDashboard());
  } catch (err) {
    next(err);
  }
});
