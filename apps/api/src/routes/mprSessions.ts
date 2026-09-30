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
import type {
  AddMprRowCommentRequest,
  CloseMprRowRequest,
  GmMprStatusDTO,
  MprOpenBucket,
  MprOpenRowDTO,
  MprRowCommentDTO,
  MprSessionDTO,
} from '@toit/contracts';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { requireAdmin } from '../middleware/auth.js';
import { BadMprRequestError, enrichMprMatchResult, runMprReconciliation } from '../services/mprService.js';
import { getMprSessionStore, getSessionStore } from '../storage/index.js';

/** Bucket names whose rows carry a reliable outlet — excludes `ambiguous`/`unexpected`, which can never be attributed to one outlet (see `GmMprStatusDTO`'s own doc comment). */
const OUTLET_ATTRIBUTABLE_BUCKETS: readonly MprOpenBucket[] = ['amountMismatch', 'pending', 'amexResults', 'upiResults'];

/**
 * Best-effort outlet extraction across the different row shapes — loosely
 * typed on purpose, matching `MprOpenItemsQueue.tsx`'s own `rowRrn`/
 * `rowAmount` helpers, since the row union isn't cleanly narrowable without
 * a bucket-keyed cast. `upiResults.pr` is a genuinely mixed shape (an
 * array, a single tagged transaction, or an inline object) — only the
 * inline-object variant carries `outlet` at all; the other two return
 * `null` (excluded from a GM's outlet-scoped view, same as ambiguous/
 * unexpected).
 */
function rowOutlet(bucket: MprOpenBucket, row: unknown): string | null {
  if (bucket === 'ambiguous' || bucket === 'unexpected') return null;
  if (bucket === 'upiResults') {
    const pr = (row as { pr?: unknown }).pr;
    if (pr && !Array.isArray(pr) && typeof pr === 'object' && 'outlet' in pr) {
      return (pr as { outlet?: string }).outlet ?? null;
    }
    return null;
  }
  return (row as { outlet?: string }).outlet ?? null;
}

const OPEN_BUCKETS: readonly MprOpenBucket[] = [
  'amountMismatch',
  'pending',
  'ambiguous',
  'unexpected',
  'amexResults',
  'upiResults',
] as const;

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
      result: enrichMprMatchResult(outcome.result),
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

// Registered before GET /:id — otherwise Express would match "open-rows" as an :id param.
mprSessionsRouter.get('/open-rows', requireAdmin, async (req, res, next) => {
  try {
    const summaries = await getMprSessionStore().list({ limit: 50 });
    const sessions = await Promise.all(summaries.map((s) => getMprSessionStore().get(s.id)));
    const openRows: MprOpenRowDTO[] = [];
    for (const session of sessions) {
      if (!session) continue;
      for (const bucket of OPEN_BUCKETS) {
        for (const row of session.result[bucket]) {
          if (row.status === 'open') {
            openRows.push({ sessionId: session.meta.id, sessionCreatedAt: session.meta.createdAt, bucket, row });
          }
        }
      }
    }
    res.json(openRows);
  } catch (err) {
    next(err);
  }
});

// Registered before GET /:id, same reason as /open-rows above.
mprSessionsRouter.get('/gm-status', async (req, res, next) => {
  try {
    const outlet = req.user.role === 'gm' ? req.user.outlet : null;
    if (!outlet) {
      res.status(400).json({ error: 'This view is outlet-specific — admins should use the Open MPR Items queue instead.' });
      return;
    }

    const pendingFull = await getSessionStore().listPendingMpr();
    const pendingSessions = pendingFull
      .filter((s) => s.meta.outlet === outlet)
      .map((s) => ({ sessionId: s.meta.id, businessDate: s.meta.businessDate, submittedAt: s.meta.submittedAt }));

    const summaries = await getMprSessionStore().list({ limit: 200 });
    const sessions = await Promise.all(summaries.map((s) => getMprSessionStore().get(s.id)));

    const openItems: MprOpenRowDTO[] = [];
    let settledCount = 0;
    for (const session of sessions) {
      if (!session) continue;
      for (const row of session.result.settled) {
        if (rowOutlet('amountMismatch', row) === outlet) settledCount++; // 'settled' shares the same shape as amountMismatch (both TaggedLedgerRow-derived)
      }
      for (const bucket of OUTLET_ATTRIBUTABLE_BUCKETS) {
        for (const row of session.result[bucket]) {
          if (rowOutlet(bucket, row) !== outlet) continue;
          if (row.status === 'open') {
            openItems.push({ sessionId: session.meta.id, sessionCreatedAt: session.meta.createdAt, bucket, row });
          } else {
            settledCount++;
          }
        }
      }
    }
    openItems.sort((a, b) => b.sessionCreatedAt.localeCompare(a.sessionCreatedAt));

    const status: GmMprStatusDTO = { outlet, pendingSessions, openItems, settledCount };
    res.json(status);
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

mprSessionsRouter.post('/:id/rows/:rowId/close', requireAdmin, async (req, res, next) => {
  try {
    const session = await getMprSessionStore().get(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'MPR session not found' });
      return;
    }
    let found = false;
    for (const bucket of OPEN_BUCKETS) {
      const idx = session.result[bucket].findIndex((r) => r.id === req.params.rowId);
      if (idx === -1) continue;
      found = true;
      const row = session.result[bucket][idx]!;
      if (row.status === 'closed') {
        res.status(409).json({ error: 'This item is already resolved.' });
        return;
      }
      if (!row.comments?.length) {
        res.status(400).json({ error: 'Add a comment on this item before it can be resolved.' });
        return;
      }
      const body = req.body as CloseMprRowRequest;
      if (!body?.note?.trim()) {
        res.status(400).json({ error: 'A note is required to resolve this item.' });
        return;
      }
      (session.result[bucket] as (typeof row)[])[idx] = {
        ...row,
        status: 'closed',
        closedAt: new Date().toISOString(),
        closedBy: req.user.email,
        closedNote: body.note.trim(),
      };
      break;
    }
    if (!found) {
      res.status(404).json({ error: 'MPR row not found' });
      return;
    }
    const updated = await getMprSessionStore().update(session.meta.id, session);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

/**
 * Adds a comment to any open MPR row — open to anyone who can view the MPR
 * module (no `requireAdmin`, unlike closing), for tracking investigation
 * progress before an item is ready to resolve. Closing then requires at
 * least one comment to already exist (see the gate above).
 */
mprSessionsRouter.post('/:id/rows/:rowId/comments', async (req, res, next) => {
  try {
    const session = await getMprSessionStore().get(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'MPR session not found' });
      return;
    }
    const body = req.body as AddMprRowCommentRequest;
    if (!body?.text?.trim()) {
      res.status(400).json({ error: 'Comment text is required.' });
      return;
    }
    let found = false;
    for (const bucket of OPEN_BUCKETS) {
      const idx = session.result[bucket].findIndex((r) => r.id === req.params.rowId);
      if (idx === -1) continue;
      found = true;
      const row = session.result[bucket][idx]!;
      const comment: MprRowCommentDTO = {
        id: randomUUID(),
        text: body.text.trim(),
        createdAt: new Date().toISOString(),
        createdBy: req.user.email,
      };
      (session.result[bucket] as (typeof row)[])[idx] = {
        ...row,
        comments: [...(row.comments ?? []), comment],
      };
      break;
    }
    if (!found) {
      res.status(404).json({ error: 'MPR row not found' });
      return;
    }
    const updated = await getMprSessionStore().update(session.meta.id, session);
    res.json(updated);
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
