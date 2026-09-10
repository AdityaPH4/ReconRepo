/**
 * The Google-sign-in app — deliberately separate from `app.ts`/the main API.
 *
 * The main API Lambda is VPC-attached (needed for RDS access), which cuts
 * off its default internet route — so it can't reach Google's OAuth servers
 * to exchange a code for tokens. This app carries only `/auth/*`, has no
 * VPC config, and keeps normal internet access. Both apps share the same
 * `AUTH_SECRET`, so a bearer token minted here verifies fine against the
 * main API's `attachUser` middleware.
 */

import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { authRouter } from './routes/auth.js';

export const authApp = express();

authApp.use(cors({ origin: config.corsOrigins, credentials: true }));
authApp.use(express.json({ limit: '2mb' }));

authApp.get('/auth/health', (_req, res) => {
  res.json({ ok: true });
});

authApp.use('/auth', authRouter);
