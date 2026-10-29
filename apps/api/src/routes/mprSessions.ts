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
import { normDate, rowsToCsv, buildExportRows } from '@toit/mpr-core';
import type {
  AddMprRowCommentRequest,
  CloseMprRowRequest,
  GmMprStatusDTO,
  MprOpenBucket,
  MprOpenRowDTO,
  MprRowClosureDTO,
  MprRowCommentDTO,
  MprSessionDTO,
} from '@toit/contracts';
import { todayIsoIST } from '@toit/recon-core';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { requireAdmin } from '../middleware/auth.js';
import { BadMprRequestError, enrichMprMatchResult, runMprReconciliation } from '../services/mprService.js';
import { getMprSessionStore } from '../storage/index.js';
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

// Registered before GET /:id, same reason as /open-rows above.
mprSessionsRouter.get('/gm-status', async (req, res, next) => {
  try {
    const outlet = req.user.role === 'gm' ? req.user.outlet : null;
    if (!outlet) {
      res.status(400).json({ error: 'This view is outlet-specific — admins should use the Open MPR Items queue instead.' });
      return;
    }

    // Counted from the same per-row day view the drill-down shows, so a row re-checked by several ingest runs counts once.
    const dates = last15DatesIST();
    const data = await getMprSessionStore().listDayRows(dates, false);
    const days = dates.map((date) => {
      const { result } = buildDaySession(date, data, outlet);
      let reconciled = 0;
      let unreconciled = 0;
      for (const bucket of ['settled', 'amountMismatch', 'pending', 'amexResults', 'upiResults'] as const) {
        for (const row of result[bucket]) row.status === 'open' ? unreconciled++ : reconciled++;
      }
      return { date, reconciled, unreconciled };
    });

    const status: GmMprStatusDTO = { outlet, days };
    res.json(status);
  } catch (err) {
    next(err);
  }
});

type Candidate<T> = { row: T; tag: string; rank: number; run: number };

/**
 * Keeps each real row once. A still-open row is re-emitted (under its own
 * business date) by every ingest run until it settles, and a row can show
 * `pending` in one run and settle in a later one — so the same transaction
 * sits in several stored runs. Per key, keeps as many copies as the most any
 * single run held (genuinely identical transactions), best outcome first,
 * then an admin-closed copy over an open one, then the newest run.
 */
function onePerRow<T extends MprRowClosureDTO>(candidates: Candidate<T>[], key: (row: T) => string): Candidate<T>[] {
  const groups = new Map<string, Candidate<T>[]>();
  for (const c of candidates) {
    const k = key(c.row);
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  const kept: Candidate<T>[] = [];
  for (const group of groups.values()) {
    const perRun = new Map<number, number>();
    for (const c of group) perRun.set(c.run, (perRun.get(c.run) ?? 0) + 1);
    const copies = Math.max(...perRun.values());
    // A copy with comments wins a tie so the next comment/Resolve lands on the copy that already holds the thread.
    const score = (c: Candidate<T>) => c.rank * 4 + (c.row.status === 'closed' ? 2 : 0) + (c.row.comments?.length ? 1 : 0);
    group.sort((a, b) => score(b) - score(a) || a.run - b.run); // runs are newest-first, so a lower run index is newer
    // Each stored copy only holds the comments posted to it — show them all on the kept copy.
    const comments = [...new Map(group.flatMap((c) => c.row.comments ?? []).map((m) => [m.id, m] as const)).values()];
    for (const c of group.slice(0, copies)) kept.push(comments.length ? { ...c, row: { ...c.row, comments } } : c);
  }
  return kept;
}

const LEDGER_RANK: Record<string, number> = { settled: 3, amountMismatch: 2, pending: 1 };
const AMEX_RANK: Record<string, number> = { settled: 4, mismatch: 3, ambiguous: 2, pending: 1 };
const UPI_RANK: Record<string, number> = { settled: 4, partial: 3, mismatch: 3, pending: 1 };

/** Static UPI transactions carry no outlet of their own — it comes from the snapshot they were folded in from. */
function upiOutlet(row: MprSessionDTO['result']['upiResults'][number], outletBySourceSession: Map<string, string>): string | null {
  const pr = row.pr as { outlet?: string } | Array<{ _sourceSessionId?: string | null }>;
  if (pr && !Array.isArray(pr) && pr.outlet) return pr.outlet;
  return (row._sourceSessionId && outletBySourceSession.get(row._sourceSessionId)) || null;
}

function upiPrs(row: MprSessionDTO['result']['upiResults'][number]) {
  return (Array.isArray(row.pr) ? row.pr : [row.pr]) as Array<{ orderNo?: string; amount?: number }>;
}

function upiKey(row: MprSessionDTO['result']['upiResults'][number]): string {
  const prs = upiPrs(row);
  return `${prs.map((p) => p?.orderNo ?? '').join(',')}|${prs.reduce((s, p) => s + (p?.amount || 0), 0)}`;
}

const amexBase = (r: MprSessionDTO['result']['amexResults'][number]) => [r.outlet, r.date, r.l1Amount].join('|');

/**
 * One business date's rows across every stored run — optionally scoped to
 * one outlet, or (`outlet` null) every outlet for the admin dashboard —
 * counted once per real row (see `onePerRow`). Rows only ever appear under
 * their own business date. `ambiguous`/`unexpected` are bank-side rows with
 * no outlet, so they're included (by bank transaction date) only in the
 * all-outlets view, and dropped once their RRN has settled in any run.
 * Shaped as an ordinary `MprSessionDTO` so `MprWorkspace` renders it as-is.
 */
function buildDaySession(date: string, data: MprDayRows, outlet: string | null): MprSessionDTO {
  const outlets = new Set<string>();
  const inScope = (rowOutletCode: string | null | undefined) => {
    if (outlet) return rowOutletCode === outlet;
    if (rowOutletCode) outlets.add(rowOutletCode);
    return true;
  };
  const runIndex = new Map(data.runs.map((r, i) => [r.id, i] as const)); // newest-first
  const outletBySourceSession = new Map<string, string>();
  for (const r of data.runs) for (const f of r.meta.jsonFiles) if (f.sourceSessionId && f.outlet) outletBySourceSession.set(f.sourceSessionId, f.outlet);

  type Result = MprSessionDTO['result'];
  type LedgerRow = Result['settled'][number] | Result['pending'][number];
  const ledger: Candidate<LedgerRow>[] = [];
  let amex: Candidate<Result['amexResults'][number]>[] = [];
  let upi: Candidate<Result['upiResults'][number]>[] = [];
  const ambiguous: Candidate<Result['ambiguous'][number]>[] = [];
  const unexpected: Candidate<Result['unexpected'][number]>[] = [];
  const amexUnexpected: Candidate<Result['amexResults'][number]>[] = [];

  for (const { runId, bucket, row } of data.rows) {
    const run = runIndex.get(runId) ?? Number.MAX_SAFE_INTEGER;
    // Stamped onto every pooled row — the *real* run it's stored in, since this view's own id is synthetic (see `_storageSessionId` in contracts).
    const stamped = { ...row, _storageSessionId: runId };
    if (bucket === 'settled' || bucket === 'amountMismatch' || bucket === 'pending') {
      const r = stamped as LedgerRow;
      if (r._businessDate === date && inScope(r.outlet)) ledger.push({ row: r, tag: bucket, rank: LEDGER_RANK[bucket]!, run });
    } else if (bucket === 'amexResults') {
      const r = stamped as Result['amexResults'][number];
      if (r._businessDate === date && inScope(r.outlet)) amex.push({ row: r, tag: '', rank: AMEX_RANK[r._match] ?? 0, run });
    } else if (bucket === 'upiResults') {
      const r = stamped as Result['upiResults'][number];
      if (r._businessDate === date && inScope(upiOutlet(r, outletBySourceSession))) upi.push({ row: r, tag: '', rank: UPI_RANK[r._match] ?? 0, run });
    }
  }
  // shortcut: bank-only rows are attributed by bank transaction date, which can differ from the business date for a sale just after midnight; upgrade if bank rows ever carry the outlet's business date.
  for (const { runId, bucket, row } of outlet ? [] : data.bankRows) {
    const run = runIndex.get(runId) ?? Number.MAX_SAFE_INTEGER;
    const stamped = { ...row, _storageSessionId: runId };
    if (bucket === 'ambiguous') {
      const r = stamped as Result['ambiguous'][number];
      if (r.candidates.some((c) => normDate(c.txnDateRaw || c.txnDate) === date)) ambiguous.push({ row: r, tag: '', rank: 0, run });
    } else if (bucket === 'unexpected') {
      const r = stamped as Result['unexpected'][number];
      if (normDate(r.mprTxnDate || r.mprDate) === date) unexpected.push({ row: r, tag: '', rank: 0, run });
    } else if (bucket === 'amexResults') {
      const r = stamped as Result['amexResults'][number];
      if (normDate(r.date) === date) amexUnexpected.push({ row: r, tag: '', rank: 0, run });
    }
  }

  // Runs from before the card-number backfill hold the same AMEX rows with an empty card — drop those copies where a carded one exists.
  const cardedRuns = new Set(amex.filter((c) => c.row.cardLast4).map((c) => c.run));
  const cardedBases = new Set(amex.filter((c) => c.row.cardLast4).map((c) => amexBase(c.row)));
  amex = amex.filter((c) => c.row.cardLast4 || cardedRuns.has(c.run) || !cardedBases.has(amexBase(c.row)));

  // A run that settles several orders as one grouped Static UPI row leaves single-order pending copies of them in earlier runs.
  const orderKeys = (r: Result['upiResults'][number]) => upiPrs(r).flatMap((p) => (p?.orderNo ? [`${upiOutlet(r, outletBySourceSession)}|${p.orderNo}`] : []));
  const coveredOrders = new Set(upi.filter((c) => c.row._match !== 'pending').flatMap((c) => orderKeys(c.row)));
  upi = upi.filter((c) => {
    const keys = c.row._match === 'pending' ? orderKeys(c.row) : [];
    return !keys.length || !keys.every((k) => coveredOrders.has(k));
  });

  const amexKey = (r: Result['amexResults'][number]) => [r.date, r.cardLast4, r.mprRow?.amount].join('|');
  const keptLedger = onePerRow(ledger, (r) => [r.outlet, r.rrn, r.posOrderNo, r.plAmount, r.plDate].join('|'));
  const result: Result = {
    settled: keptLedger.filter((c) => c.tag === 'settled').map((c) => c.row as Result['settled'][number]),
    amountMismatch: keptLedger.filter((c) => c.tag === 'amountMismatch').map((c) => c.row as Result['amountMismatch'][number]),
    pending: keptLedger.filter((c) => c.tag === 'pending').map((c) => c.row as Result['pending'][number]),
    ambiguous: onePerRow(ambiguous, (r) => r.rrn).map((c) => c.row).filter((r) => !data.settledKeys.has(r.rrn)),
    unexpected: onePerRow(unexpected, (r) => `${r._source}|${r.rrn}|${r.mprAmount}`).map((c) => c.row).filter((r) => !(r.rrn && data.settledKeys.has(r.rrn))),
    amexResults: [
      ...onePerRow(amex, (r) => `${amexBase(r)}|${r.cardLast4}`).map((c) => c.row),
      ...onePerRow(amexUnexpected, amexKey).map((c) => c.row).filter((r) => !data.settledKeys.has(amexKey(r))),
    ],
    upiResults: onePerRow(upi, (r) => `${upiOutlet(r, outletBySourceSession)}|${upiKey(r)}`).map((c) => c.row),
  };

  // This date's own snapshot(s), and the bank files of the runs that covered it — each listed once (a retried session is re-listed by every run that re-checked it).
  const touchedRuns = data.runs.filter((r) => r.meta.businessDates.includes(date));
  const jsonFiles = new Map(
    touchedRuns
      .flatMap((r) => r.meta.jsonFiles)
      .filter((f) => f.businessDate === date && (!outlet || f.outlet === outlet))
      .map((f) => [f.sourceSessionId ?? f.filename, f] as const),
  );
  const mprFiles = new Map(touchedRuns.flatMap((r) => r.meta.mprFiles).map((f) => [f.filename, f] as const));

  return {
    meta: {
      id: outlet ? `gm-day:${outlet}:${date}` : `day:${date}`,
      createdAt: new Date().toISOString(),
      createdBy: '',
      jsonFiles: [...jsonFiles.values()],
      mprFiles: [...mprFiles.values()],
      businessDates: [date],
      outlets: outlet ? [outlet] : [...outlets].sort(),
    },
    result,
  };
}

/** Bank-only rows carry no outlet, so they're only fetched for the all-outlets view. */
async function loadDay(date: string, outlet: string | null): Promise<MprSessionDTO> {
  return buildDaySession(date, await getMprSessionStore().listDayRows([date], !outlet), outlet);
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
