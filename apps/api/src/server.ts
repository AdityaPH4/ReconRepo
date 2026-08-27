/**
 * API entry point.
 */

import type { ApiErrorDTO } from '@toit/contracts';
import cors from 'cors';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { config, describeConfig } from './config.js';
import { attachUser } from './middleware/auth.js';
import { sessionsRouter } from './routes/sessions.js';
import { BadRequestError } from './services/reconService.js';

const app = express();

app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(attachUser);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    objectStore: config.objectStore.driver,
    sessionStore: config.sessionStore.driver,
    authEnabled: config.auth.enabled,
  });
});

app.get('/api/me', (req, res) => {
  res.json(req.user);
});

app.use('/api/sessions', sessionsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' } satisfies ApiErrorDTO);
});

// Error handler. Upload and parse problems are the caller's to fix and must say
// what is wrong; anything else is logged in full and reported generically.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof BadRequestError) {
    res.status(400).json({ error: err.message } satisfies ApiErrorDTO);
    return;
  }
  if (err instanceof MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File too large. Limit is ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`
        : `Upload rejected: ${err.message}`;
    res.status(400).json({ error: message } satisfies ApiErrorDTO);
    return;
  }

  console.error('[api] unhandled error:', err);
  res.status(500).json({
    error: err instanceof Error ? err.message : 'Internal server error',
  } satisfies ApiErrorDTO);
});

app.listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port}`);
  console.log(`[api] ${describeConfig()}`);
  if (config.sessionStore.driver === 'memory') {
    console.log('[api] NOTE: sessions are in-memory and will be lost on restart.');
  }
  if (!config.auth.enabled) {
    console.log(
      `[api] NOTE: auth is stubbed — every request runs as ${config.auth.devUser.email}.`,
    );
  }
});
