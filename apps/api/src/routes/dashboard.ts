/**
 * Manager dashboard — mounted at `/api/dashboard`.
 */

import { OUTLET_CODES, type OutletCode } from '@toit/recon-core';
import { Router } from 'express';
import { buildDashboard } from '../services/dashboardService.js';

export const dashboardRouter = Router();

dashboardRouter.get('/', async (req, res, next) => {
  try {
    let outlet: OutletCode | null = req.user.outlet;
    if (req.user.role === 'admin') {
      const requested = typeof req.query.outlet === 'string' ? (req.query.outlet as OutletCode) : undefined;
      if (requested && (OUTLET_CODES as string[]).includes(requested)) {
        outlet = requested;
      } else {
        outlet = OUTLET_CODES[0]!;
      }
    }
    if (!outlet) {
      res.status(400).json({ error: 'No outlet to show a dashboard for.' });
      return;
    }
    const dashboard = await buildDashboard(outlet);
    res.json(dashboard);
  } catch (err) {
    next(err);
  }
});
