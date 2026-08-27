/**
 * Session routes.
 *
 * POST /api/sessions        upload the files and run a reconciliation
 * GET  /api/sessions        list sessions visible to the caller
 * GET  /api/sessions/:id    fetch one session
 * GET  /api/sessions/:id/files/:role  download a stored raw file
 */

import { randomUUID } from 'node:crypto';
import type { SessionDTO, UploadRole, UploadedFileDTO } from '@toit/contracts';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { outletScope } from '../middleware/auth.js';
import {
  BadRequestError,
  outletName,
  runReconciliation,
  windowLabel,
} from '../services/reconService.js';
import { buildStorageKey, getObjectStore, getSessionStore } from '../storage/index.js';

/**
 * Files are buffered in memory rather than spooled to disk: they are parsed
 * immediately and written to object storage in the same request, so a temp file
 * would only add a cleanup path that can fail.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 4 },
});

const UPLOAD_FIELDS = [
  { name: 'pr', maxCount: 1 },
  { name: 'zip', maxCount: 1 },
  { name: 'sum', maxCount: 1 },
  { name: 'hdfc', maxCount: 1 },
] as const;

type UploadedFiles = Record<string, Express.Multer.File[] | undefined>;

function firstFile(files: UploadedFiles, field: string): Express.Multer.File | undefined {
  return files[field]?.[0];
}

export const sessionsRouter = Router();

sessionsRouter.post('/', upload.fields([...UPLOAD_FIELDS]), async (req, res, next) => {
  try {
    const files = (req.files ?? {}) as UploadedFiles;

    const pr = firstFile(files, 'pr');
    const zip = firstFile(files, 'zip');
    const sum = firstFile(files, 'sum');
    const hdfc = firstFile(files, 'hdfc');

    // Mirrors the legacy guard: the Payment Report and the ZIP are both
    // mandatory; the summary and HDFC statement are optional.
    const missing: string[] = [];
    if (!pr) missing.push('Payment Report (pr)');
    if (!zip) missing.push('All Transactions ZIP (zip)');
    if (missing.length) {
      throw new BadRequestError(`Missing required file(s): ${missing.join(', ')}`);
    }

    const outcome = await runReconciliation({
      pr: { buffer: pr!.buffer, originalName: pr!.originalname },
      zip: { buffer: zip!.buffer, originalName: zip!.originalname },
      ...(sum ? { sum: { buffer: sum.buffer, originalName: sum.originalname } } : {}),
      ...(hdfc ? { hdfc: { buffer: hdfc.buffer, originalName: hdfc.originalname } } : {}),
    });

    // Raw files are persisted only once reconciliation has succeeded, so a
    // rejected upload leaves nothing half-written behind.
    const sessionId = randomUUID();
    const objects = getObjectStore();
    const stored: UploadedFileDTO[] = [];

    for (const [role, file] of Object.entries({ pr, zip, sum, hdfc })) {
      if (!file) continue;
      const key = buildStorageKey(sessionId, role as UploadRole, file.originalname);
      await objects.put({
        key,
        body: file.buffer,
        contentType: file.mimetype || 'application/octet-stream',
      });
      stored.push({
        role: role as UploadRole,
        originalName: file.originalname,
        size: file.size,
        contentType: file.mimetype || 'application/octet-stream',
        storageKey: key,
      });
    }

    const session: SessionDTO = {
      meta: {
        id: sessionId,
        status: 'draft',
        outlet: outcome.outlet,
        outletName: outletName(outcome.outlet),
        businessDate: outcome.businessDate,
        businessWindow: windowLabel(outcome.win),
        businessWindowStart: outcome.win ? outcome.win.start.toISOString() : null,
        businessWindowEnd: outcome.win ? outcome.win.end.toISOString() : null,
        createdAt: new Date().toISOString(),
        createdBy: req.user.email,
        submittedAt: null,
        submittedBy: null,
        prFileRows: outcome.prData.length,
        zipRows: outcome.zipInside.length,
        zipFilteredRows: outcome.zipFiltered.length,
        files: stored,
        hdfcStatement: outcome.hdfcStatementMeta,
        warnings: outcome.warnings,
      },
      // JSON.stringify performs the Date→string and NaN→null erasure that
      // `Jsonified` documents on the contract type.
      result: JSON.parse(JSON.stringify(outcome.result)),
      summaryData: outcome.summaryData,
      frs: outcome.frs,
      counts: outcome.counts,
      totals: outcome.totals,
    };

    await getSessionStore().create(session);
    res.status(201).json(session);
  } catch (err) {
    next(err);
  }
});

sessionsRouter.get('/', async (req, res, next) => {
  try {
    const items = await getSessionStore().list({ outlet: outletScope(req) });
    res.json(items);
  } catch (err) {
    next(err);
  }
});

sessionsRouter.get('/:id', async (req, res, next) => {
  try {
    const session = await getSessionStore().get(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const scope = outletScope(req);
    if (scope && session.meta.outlet !== scope) {
      // Same response as "not found" — whether a session exists at another
      // outlet is not this caller's business.
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  } catch (err) {
    next(err);
  }
});

sessionsRouter.get('/:id/files/:role', async (req, res, next) => {
  try {
    const session = await getSessionStore().get(req.params.id!);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const scope = outletScope(req);
    if (scope && session.meta.outlet !== scope) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const file = session.meta.files.find((f) => f.role === req.params.role);
    if (!file) {
      res.status(404).json({ error: 'File not found on this session' });
      return;
    }
    const body = await getObjectStore().get(file.storageKey);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.originalName.replace(/"/g, '')}"`,
    );
    res.send(body);
  } catch (err) {
    next(err);
  }
});
