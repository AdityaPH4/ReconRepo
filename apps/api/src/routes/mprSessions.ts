/**
 * MPR (Layer 2) session routes.
 *
 * POST /api/mpr-sessions               upload snapshots + bank files, run, persist
 * GET  /api/mpr-sessions                list past runs
 * GET  /api/mpr-sessions/:id            fetch one
 * GET  /api/mpr-sessions/:id/export.csv regenerate the CSV export from the stored result
 */

import { randomUUID } from 'node:crypto';
import { rowsToCsv, buildExportRows } from '@toit/mpr-core';
import type { MprSessionDTO } from '@toit/contracts';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { BadMprRequestError, runMprReconciliation } from '../services/mprService.js';
import { getMprSessionStore } from '../storage/index.js';

// MPR reconciliation is a bulk operation by nature — a single run commonly
// spans many days' worth of JSON snapshots and bank MPR files at once (the
// upload panel's own hint text says "any count" for MPR files). A low
// per-field cap here doesn't reject with a clear "too many files" message —
// multer throws a generic `LIMIT_UNEXPECTED_FILE` ("Unexpected field") once
// a field's count is exceeded, which reads like an unrelated failure. These
// caps exist only to bound a single request, not to limit real usage.
const MAX_FILES_PER_FIELD = 500;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: MAX_FILES_PER_FIELD * 2 },
});

const UPLOAD_FIELDS = [
  { name: 'json', maxCount: MAX_FILES_PER_FIELD },
  { name: 'mpr', maxCount: MAX_FILES_PER_FIELD },
] as const;

type UploadedFiles = Record<string, Express.Multer.File[] | undefined>;

export const mprSessionsRouter = Router();

mprSessionsRouter.post('/', upload.fields([...UPLOAD_FIELDS]), async (req, res, next) => {
  try {
    const files = (req.files ?? {}) as UploadedFiles;
    const jsonFiles = files.json ?? [];
    const mprFiles = files.mpr ?? [];

    if (!jsonFiles.length || !mprFiles.length) {
      throw new BadMprRequestError('Upload at least one JSON snapshot and one MPR file.');
    }

    const outcome = runMprReconciliation(
      jsonFiles.map((f) => ({ buffer: f.buffer, originalName: f.originalname })),
      mprFiles.map((f) => ({ buffer: f.buffer, originalName: f.originalname })),
    );

    const session: MprSessionDTO = {
      meta: {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        createdBy: req.user.email,
        jsonFiles: outcome.jsonFiles,
        mprFiles: outcome.mprFiles,
        businessDates: outcome.businessDates,
        outlets: outcome.outlets,
      },
      result: outcome.result,
    };

    await getMprSessionStore().create(session);
    res.status(201).json(session);
  } catch (err) {
    next(err);
  }
});

mprSessionsRouter.get('/', async (req, res, next) => {
  try {
    const items = await getMprSessionStore().list({});
    res.json(items);
  } catch (err) {
    next(err);
  }
});

mprSessionsRouter.get('/:id', async (req, res, next) => {
  try {
    const session = await getMprSessionStore().get(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'MPR session not found' });
      return;
    }
    res.json(session);
  } catch (err) {
    next(err);
  }
});

mprSessionsRouter.get('/:id/export.csv', async (req, res, next) => {
  try {
    const session = await getMprSessionStore().get(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'MPR session not found' });
      return;
    }
    const csv = rowsToCsv(buildExportRows(session.result));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="mpr-recon-${session.meta.id}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});
