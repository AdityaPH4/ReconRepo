/**
 * Lambda entry point (behind API Gateway, container image runtime).
 * Same `app` as `server.ts` — no port binding, just wrapped for the
 * Lambda/API Gateway request-response shape.
 */

import serverless from 'serverless-http';
import { app } from './app.js';

export const handler = serverless(app);
