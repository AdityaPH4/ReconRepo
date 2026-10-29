/**
 * MPR (Layer 2) session routes.
 *
 * POST /api/mpr-sessions               upload snapshots + bank files, run, persist
 * GET  /api/mpr-sessions                list past runs
 * GET  /api/mpr-sessions/:id            fetch one
 * GET  /api/mpr-sessions/:id/export.csv regenerate the CSV export from the stored result
 * GET  /api/mpr-sessions/gm-day         one GM's outlet, pooled across every stored run, for one business date
 * GET  /api/mpr-sessions/day            admin-only: one business date, pooled across every stored run — ?outlet= scopes to one outlet, omitted/"ALL" pools every outlet
 * GET  /api/mpr-sessions/day/export.csv CSV export of the above
 */

import { randomUUID } from 'node:crypto';
import { bankFamily, COUNTER_BANKS, normDate, rowsToCsv, buildExportRows } from '@toit/mpr-core';
import type { CounterBank } from '@toit/mpr-core';
import type {
  AddMprRowCommentRequest,
  CloseMprRowRequest,
  GmMprDaySummaryDTO,
  GmMprStatusDTO,
  MprOpenBucket,
  MprOpenRowDTO,
  MprDayCountersDTO,
  MprRangeCountersDTO,
  MprRowClosureDTO,
  MprRowCommentDTO,
  MprSessionDTO,
  MprSnapshotCountsDTO,
} from '@toit/contracts';
import { todayIsoIST } from '@toit/recon-core';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { requireAdmin } from '../middleware/auth.js';
import { BadMprRequestError, enrichMprMatchResult, runMprReconciliation } from '../services/mprService.js';
import { recordResolvedRow } from '../services/mprCounterService.js';
import { buildDaySession } from '../services/mprDayView.js';
import { getMprCounterStore, getMprSessionStore, getSessionStore } from '../storage/index.js';
import type { MprDayRows } from '../storage/types.js';

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

// Registered before GET /:id, same reason as /open-rows below. Backs the admin home badge, which only shows a number — so it must not download runs. Concurrent callers share one query and the answer is kept for 5 minutes.
const OPEN_COUNT_TTL_MS = 5 * 60 * 1000;
let openCount: { value: number; at: number } | null = null;
let openCountInFlight: Promise<number> | null = null;
mprSessionsRouter.get('/open-count', requireAdmin, async (req, res, next) => {
  try {
    if (!openCount || Date.now() - openCount.at > OPEN_COUNT_TTL_MS) {
      // The counters answer instantly and exactly (open = every day's transactions minus what's cleared). Until they've been filled — or if the tables aren't there — count stored open rows instead.
      openCountInFlight ??= getMprCounterStore()
        .openTotal()
        .then((n) => n ?? getMprSessionStore().countOpenRows(50))
        .catch(() => getMprSessionStore().countOpenRows(50))
        .finally(() => { openCountInFlight = null; });
      openCount = { value: await openCountInFlight, at: Date.now() };
    }
    res.json({ count: openCount.value });
  } catch (err) {
    next(err);
  }
});

// Registered before GET /:id — otherwise Express would match "open-rows" as an :id param.
mprSessionsRouter.get('/open-rows', requireAdmin, async (req, res, next) => {
  try {
    const sessions = await getMprSessionStore().listFull({ limit: 50 });
    const openRows: MprOpenRowDTO[] = [];
    for (const session of sessions) {
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

/** Last 15 calendar dates (IST), most recent first — IST has no DST, so a flat 24h subtraction always lands on the right civil day. */
function last15DatesIST(now: Date = new Date()): string[] {
  return Array.from({ length: 15 }, (_, i) => todayIsoIST(new Date(now.getTime() - i * 86_400_000)));
}

// Registered before GET /:id, same reason as /open-rows above. Reads only the per-day counters (a few small indexed queries) — never the stored runs — so a month-long strip is cheap.
mprSessionsRouter.get('/range-counters', requireAdmin, async (req, res, next) => {
  try {
    const outlet = typeof req.query.outlet === 'string' && req.query.outlet !== 'ALL' ? req.query.outlet : null;
    const dates = Array.from({ length: 30 }, (_, i) => todayIsoIST(new Date(Date.now() - i * 86_400_000)));
    const body: MprRangeCountersDTO = { days: await getMprCounterStore().rangeByBank(dates, outlet) };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

const HDFC_COUNTER_BANKS = ['hdfc_upi', 'hdfc_dynamic', 'hdfc_link', 'hdfc_static'] as const;

/** Folds the 7 counter families down to the day-drill-down's own 4 tiles (AMEX/HDFC/Pinelabs/Kotak) — HDFC's 4 sub-families summed into one. */
function consolidateBanks(counts: Record<CounterBank, { total: number; cleared: number }>): GmMprDaySummaryDTO['banks'] {
  const hdfc = HDFC_COUNTER_BANKS.reduce(
    (acc, b) => ({ total: acc.total + counts[b].total, reconciled: acc.reconciled + counts[b].cleared }),
    { total: 0, reconciled: 0 },
  );
  return {
    amex: { total: counts.amex.total, reconciled: counts.amex.cleared },
    kotak: { total: counts.kotak.total, reconciled: counts.kotak.cleared },
    pinelabs: { total: counts.pinelabs.total, reconciled: counts.pinelabs.cleared },
    hdfc,
  };
}

function emptyBankCounts(): Record<CounterBank, { total: number; cleared: number }> {
  return Object.fromEntries(COUNTER_BANKS.map((b) => [b, { total: 0, cleared: 0 }])) as Record<
    CounterBank,
    { total: number; cleared: number }
  >;
}

mprSessionsRouter.get('/gm-status', async (req, res, next) => {
  try {
    const outlet = req.user.role === 'gm' ? req.user.outlet : null;
    if (!outlet) {
      res.status(400).json({ error: 'This view is outlet-specific — admins should use the Open MPR Items queue instead.' });
      return;
    }

    const dates = last15DatesIST();
    // Fast path: the per-day, per-bank counters (transactions from each day's JSON, and how many MPR has cleared). They hold nothing
    // until the first rebuild or import has filled them, and the tables may not exist yet — in either case fall back to counting the
    // stored rows directly.
    const byBank = await getMprCounterStore().rangeByBank(dates, outlet).catch((err) => {
      console.error('[mpr-counters] rangeByBank unavailable:', err);
      return null;
    });
    let days: GmMprStatusDTO['days'];
    if (byBank && byBank.some((d) => COUNTER_BANKS.some((b) => d.counts[b].total > 0))) {
      days = byBank.map((d) => {
        const total = COUNTER_BANKS.reduce((s, b) => s + d.counts[b].total, 0);
        const cleared = COUNTER_BANKS.reduce((s, b) => s + d.counts[b].cleared, 0);
        return { date: d.date, reconciled: cleared, unreconciled: total - cleared, banks: consolidateBanks(d.counts) };
      });
    } else {
      // Counted from the same per-row day view the drill-down shows, so a row re-checked by several ingest runs counts once.
      const data = await getMprSessionStore().listDayRows(dates, false);
      days = dates.map((date) => {
        const { result } = buildDaySession(date, data, outlet);
        let reconciled = 0;
        let unreconciled = 0;
        const bankCounts = emptyBankCounts();
        const BUCKET_BANK = {
          settled: (r: { acquirer?: string }) => bankFamily(r.acquirer),
          amountMismatch: (r: { acquirer?: string }) => bankFamily(r.acquirer),
          pending: (r: { acquirer?: string }) => bankFamily(r.acquirer),
          amexResults: () => 'amex' as const,
          upiResults: () => 'hdfc_static' as const,
        };
        for (const bucket of ['settled', 'amountMismatch', 'pending', 'amexResults', 'upiResults'] as const) {
          for (const row of result[bucket]) {
            const fam = BUCKET_BANK[bucket](row as never);
            bankCounts[fam].total++;
            if (row.status === 'open') {
              unreconciled++;
            } else {
              reconciled++;
              bankCounts[fam].cleared++;
            }
          }
        }
        return { date, reconciled, unreconciled, banks: consolidateBanks(bankCounts) };
      });
    }

    const status: GmMprStatusDTO = { outlet, days };
    res.json(status);
  } catch (err) {
    next(err);
  }
});

/** Bank-only rows carry no outlet, so they're only fetched for the all-outlets view. */
async function loadDay(date: string, outlet: string | null): Promise<MprSessionDTO> {
  const [data, snapshot] = await Promise.all([
    getMprSessionStore().listDayRows([date], !outlet),
    getSessionStore().snapshotCountsForDay(date, outlet),
  ]);
  const counts: MprSnapshotCountsDTO['counts'] = { amex: 0, kotak: 0, pinelabs: 0, hdfc_upi: 0, hdfc_dynamic: 0, hdfc_link: 0, hdfc_static: snapshot.staticUpiOrders };
  for (const [acquirer, n] of Object.entries(snapshot.byAcquirer)) counts[bankFamily(acquirer)] += n;
  // The day's running counters. They only ever add to the page — if the tables aren't there yet or the read fails, the page still renders from the rows.
  const dayCounters: MprDayCountersDTO | undefined = await getMprCounterStore()
    .dayCounters(date, outlet)
    .then((counts) => ({ counts }))
    .catch((err) => {
      console.error('[mpr-counters] day counters unavailable:', err);
      return undefined;
    });
  return { ...buildDaySession(date, data, outlet), snapshotCounts: { sessions: snapshot.sessions, counts }, dayCounters };
}

// Registered before GET /:id, same reason as /open-rows above.
mprSessionsRouter.get('/gm-day', async (req, res, next) => {
  try {
    const outlet = req.user.role === 'gm' ? req.user.outlet : null;
    if (!outlet) {
      res.status(400).json({ error: 'This view is outlet-specific — admins should use the main dashboard instead.' });
      return;
    }
    const date = typeof req.query.date === 'string' ? req.query.date : null;
    if (!date) {
      res.status(400).json({ error: 'A date (YYYY-MM-DD) is required.' });
      return;
    }

    res.json(await loadDay(date, outlet));
  } catch (err) {
    next(err);
  }
});

// Registered before GET /:id, same reason as /open-rows above.
mprSessionsRouter.get('/day', requireAdmin, async (req, res, next) => {
  try {
    const date = typeof req.query.date === 'string' ? req.query.date : null;
    if (!date) {
      res.status(400).json({ error: 'A date (YYYY-MM-DD) is required.' });
      return;
    }
    // `outlet` is optional — absent (or "ALL") means every outlet pooled together, same as before an outlet picker existed.
    const outlet = typeof req.query.outlet === 'string' && req.query.outlet !== 'ALL' ? req.query.outlet : null;

    res.json(await loadDay(date, outlet));
  } catch (err) {
    next(err);
  }
});

// Registered before GET /:id/export.csv for the same reason — "day" would otherwise be swallowed as an :id value.
mprSessionsRouter.get('/day/export.csv', requireAdmin, async (req, res, next) => {
  try {
    const date = typeof req.query.date === 'string' ? req.query.date : null;
    if (!date) {
      res.status(400).json({ error: 'A date (YYYY-MM-DD) is required.' });
      return;
    }
    const outlet = typeof req.query.outlet === 'string' && req.query.outlet !== 'ALL' ? req.query.outlet : null;

    const session = await loadDay(date, outlet);
    const csv = rowsToCsv(buildExportRows(session.result));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="mpr-recon-${outlet ?? 'all'}-${date}.csv"`);
    res.send(csv);
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
    let resolved: { bucket: MprOpenBucket; row: MprRowClosureDTO } | null = null;
    for (const bucket of OPEN_BUCKETS) {
      const idx = session.result[bucket].findIndex((r) => r.id === req.params.rowId);
      if (idx === -1) continue;
      found = true;
      const row = session.result[bucket][idx]!;
      if (row.status === 'closed') {
        res.status(409).json({ error: 'This item is already resolved.' });
        return;
      }
      const body = req.body as CloseMprRowRequest;
      if (!body?.note?.trim()) {
        res.status(400).json({ error: 'A note is required to resolve this item.' });
        return;
      }
      const closed = {
        ...row,
        status: 'closed' as const,
        closedAt: new Date().toISOString(),
        closedBy: req.user.email,
        closedNote: body.note.trim(),
      };
      (session.result[bucket] as (typeof row)[])[idx] = closed;
      resolved = { bucket, row: closed };
      break;
    }
    if (!found) {
      res.status(404).json({ error: 'MPR row not found' });
      return;
    }
    const updated = await getMprSessionStore().update(session.meta.id, session);
    if (resolved) await recordResolvedRow(updated, resolved.bucket, resolved.row as never);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

/**
 * Adds a comment to any open MPR row — open to anyone who can view the MPR
 * module (no `requireAdmin`, unlike closing), for tracking investigation
 * progress (e.g. a GM flagging what they know). An admin can resolve a row
 * directly with just a closing note, with or without a prior comment.
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
