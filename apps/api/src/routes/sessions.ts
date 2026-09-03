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
import { autoStageBohRows, buildReportHtml, buildSnapshot, emptyJustificationState } from '@toit/recon-core';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { outletScope } from '../middleware/auth.js';
import { assertReconAllowed } from '../services/approvalService.js';
import { buildExplanationItems, computeSubmitGate } from '../services/justificationService.js';
import {
  BadRequestError,
  outletName,
  runReconciliation,
  windowLabel,
} from '../services/reconService.js';
import { buildStorageKey, getAdvanceStore, getBohStore, getObjectStore, getSessionStore } from '../storage/index.js';

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

    // A GM re-reconciling the same outlet+date needs an admin's approval —
    // parsing is pure (nothing written yet), so this throws before anything
    // is persisted. Admins are exempt; they're the approvers.
    if (req.user.role === 'gm') {
      await assertReconAllowed(outcome.outlet, outcome.businessDate);
    }

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

    // Every bills-on-hold PR row not already a known repository entry (open
    // or cleared, from any prior session) is staged automatically, with no
    // customer-name requirement — legacy's `runReconciliation` (1263–1284)
    // does this unconditionally on every recon run. The manual "+ Add to
    // repository" flow stays available for a bills-on-hold row that arrives
    // after this point (e.g. a remark reclassifies it) or was skipped here.
    const existingBoh = await getBohStore().list(outcome.outlet);
    const existingOrderNos = new Set(existingBoh.map((b) => b.orderNo));
    const bohStaging = autoStageBohRows(outcome.result.bills, existingOrderNos).map((b) => ({
      id: randomUUID(),
      orderNo: b.orderNo,
      custName: b.custName,
      phone: null,
      amount: b.amount,
      bohDate: b.bohDate,
      notes: null,
    }));

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
      pinelabsBreakdown: outcome.pinelabsBreakdown,
      justification: { ...emptyJustificationState(), bohStaging },
      // Placeholders — replaced below once `session` is fully built, since
      // both read the very object they're being attached to.
      submitGate: null as never,
      explanation: [],
      snapshot: null,
    };
    session.submitGate = computeSubmitGate(session);
    session.explanation = buildExplanationItems(session);

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
    // Recomputed fresh on every read, not trusted from storage — this is the
    // one thing that must never silently drift from what submit actually
    // gates on (see the plan's "one canonical completeness/residual
    // calculation" decision).
    res.json({
      ...session,
      submitGate: computeSubmitGate(session),
      explanation: buildExplanationItems(session),
    } satisfies SessionDTO);
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

/**
 * Submit — the one-way `draft` → `submitted` transition.
 * Ported from `reconciliation (68).html` lines 4895–4999 (`initiateSubmit`).
 *
 * Re-derives the gate independently rather than trusting whatever the caller
 * last saw (mirrors legacy's own re-derivation at submit time, now unified
 * with the display gate through one `canSubmit()` — see the plan). On
 * success: commits this session's draft advances/applications/BOH
 * staging/clearances into the cross-session repositories, builds the
 * snapshot, and locks the session.
 */
sessionsRouter.post('/:id/submit', async (req, res, next) => {
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
    if (session.meta.status === 'submitted') {
      res.status(409).json({ error: 'Session is already submitted.' });
      return;
    }

    const gate = computeSubmitGate(session);
    if (!gate.ok) {
      res.status(409).json({ error: 'Cannot submit: not fully justified.', details: { blockers: gate.blockers.join(' ') } });
      return;
    }

    const { justification } = session;
    const outlet = session.meta.outlet;
    const advanceStore = getAdvanceStore();
    const bohStore = getBohStore();

    // Commit draft advances and applications.
    for (const advance of justification.draftAdvances) {
      await advanceStore.create(advance);
    }
    for (const application of justification.draftApplications) {
      await advanceStore.recordApplication(application);
    }

    // Commit staged BOH additions — reusing the staging id so a queued
    // clearance referencing it still resolves after commit.
    for (const staged of justification.bohStaging) {
      await bohStore.create({
        id: staged.id,
        outlet,
        orderNo: staged.orderNo,
        custName: staged.custName,
        phone: staged.phone,
        amount: staged.amount,
        bohDate: staged.bohDate,
        notes: staged.notes,
        recordedDate: new Date().toISOString().slice(0, 10),
        status: 'open',
        clearedAt: null,
        clearedBySessionId: null,
      });
    }
    // Commit clearances — flips the row to `cleared`, durably (the port's
    // fix over legacy; see README/plan).
    const submittedAt = new Date().toISOString();
    for (const clearance of justification.draftBohClearances) {
      await bohStore.clear(clearance.bohEntryId, clearance.clearedDate, session.meta.id);
    }

    const [allAdvances, allApplications, bohOpen] = await Promise.all([
      advanceStore.list(outlet),
      advanceStore.listApplications(outlet),
      bohStore.list(outlet),
    ]);
    const touchedAdvanceIds = new Set([
      ...justification.draftAdvances.map((a) => a.id),
      ...justification.draftApplications.map((a) => a.advanceId),
    ]);
    const bohEntryById = new Map(bohOpen.map((b) => [b.id, b] as const));
    // A cleared entry no longer shows in `bohOpen` (status flipped above), so
    // fetch it directly for the snapshot's "cleared this session" section.
    const bohClearedThisSession = await Promise.all(
      justification.draftBohClearances.map(async (clearance) => {
        const entry = bohEntryById.get(clearance.bohEntryId) ?? (await bohStore.get(clearance.bohEntryId));
        return { clearance, entry: entry! };
      }),
    );

    const snapshot = buildSnapshot({
      outlet,
      businessDate: session.meta.businessDate,
      businessWindow: session.meta.businessWindow,
      businessWindowStart: session.meta.businessWindowStart,
      businessWindowEnd: session.meta.businessWindowEnd,
      submittedAt,
      submittedBy: req.user.email,
      prFileRows: session.meta.prFileRows,
      zipRows: session.meta.zipRows,
      result: session.result as never,
      summaryData: session.summaryData,
      methodBreakdown: session.frs.rows,
      grandDiff: session.frs.grandDiff,
      residual: gate.residual,
      status: gate.status,
      justification,
      advances: allAdvances.filter((a) => touchedAdvanceIds.has(a.id)),
      applications: justification.draftApplications,
      bohOpen: bohOpen.filter((b) => b.status === 'open'),
      bohClearedThisSession,
    });

    const submitted: SessionDTO = {
      ...session,
      meta: { ...session.meta, status: 'submitted', submittedAt, submittedBy: req.user.email },
      snapshot,
      submitGate: { ...gate },
      explanation: buildExplanationItems(session),
    };
    const saved = await getSessionStore().update(session.meta.id, submitted);
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

/**
 * The printable settlement report — regenerated from the persisted snapshot
 * on every request, so (unlike legacy's one-shot client-side download) it
 * can be reprinted at any time after submit.
 */
sessionsRouter.get('/:id/report', async (req, res, next) => {
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
    if (!session.snapshot) {
      res.status(409).json({ error: 'Session has not been submitted yet.' });
      return;
    }
    const html = buildReportHtml(session.snapshot as never);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

/**
 * The raw settlement snapshot as a downloadable JSON file — legacy's
 * `downloadSnapshot()` alongside `downloadReport()`. This is what the MPR
 * (Layer 2) module's "Recon Snapshots (JSON)" upload slot expects, one file
 * per business date.
 */
sessionsRouter.get('/:id/snapshot.json', async (req, res, next) => {
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
    if (!session.snapshot) {
      res.status(409).json({ error: 'Session has not been submitted yet.' });
      return;
    }
    const biz = (session.meta.businessDate ?? 'unknown').replace(/-/g, '');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="toit-recon-${biz}_${session.meta.outlet}.json"`);
    res.json(session.snapshot);
  } catch (err) {
    next(err);
  }
});
