/**
 * The pooled "one business date" view of MPR results — one row per real
 * transaction, however many stored ingest runs re-listed it. Used by the day
 * routes and by the counter rebuild script.
 */

import type { MprRowClosureDTO, MprSessionDTO } from '@toit/contracts';
import { normDate } from '@toit/mpr-core';
import type { MprDayRows } from '../storage/types.js';

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
export function buildDaySession(date: string, data: MprDayRows, outlet: string | null): MprSessionDTO {
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

/** The same data `MprSessionStore.listDayRows` returns, built from runs already in memory — for the counter rebuild, which loads every run once rather than querying per day. */
export function dayRowsFromRuns(runs: MprSessionDTO[], dates: Set<string>): MprDayRows {
  const rows: MprDayRows['rows'] = [];
  for (const run of runs) {
    const runId = run.meta.id;
    const r = run.result;
    for (const row of r.settled) if (dates.has(row._businessDate)) rows.push({ runId, bucket: 'settled', row });
    for (const row of r.amountMismatch) if (dates.has(row._businessDate)) rows.push({ runId, bucket: 'amountMismatch', row });
    for (const row of r.pending) if (dates.has(row._businessDate)) rows.push({ runId, bucket: 'pending', row });
    for (const row of r.amexResults) if (row._businessDate && dates.has(row._businessDate)) rows.push({ runId, bucket: 'amexResults', row });
    for (const row of r.upiResults) if (row._businessDate && dates.has(row._businessDate)) rows.push({ runId, bucket: 'upiResults', row });
  }
  return { runs: runs.map((s) => ({ id: s.meta.id, meta: s.meta })), rows, bankRows: [], settledKeys: new Set() };
}
