/**
 * Post-processes one ingest run's `MatchResult` against each touched
 * business date's already-known-reconciled accumulator (see the API's
 * `reconciledStore.ts` for *why* that accumulator exists at all).
 *
 * Three things this does, together:
 *
 *  1. Suppresses a `pending` row this run produced if an *earlier* run
 *     already resolved the exact same row (same source session + RRN, +
 *     Transaction Date/Card for AMEX, or + order number(s) for HDFC
 *     Static UPI). Without this, a session that gets retried in a later
 *     run would wrongly show an already-settled row as `pending` again —
 *     the bank file that settled it has since been relocated out of the
 *     pending S3 prefix, so this run's own fresh match has nothing to
 *     re-find it with.
 *
 *  2. Suppresses an `unexpected` bank row (Kotak/Pinelabs/HDFC-UPI's own,
 *     or AMEX's `_match === 'unexpected'`) if its bare RRN (or, for AMEX,
 *     its date+card) already appears in `recentSettledKeys` — a bank
 *     simply resending a file it already sent produces rows with no
 *     Layer-1 session to pair with this time (that session was already
 *     folded in on the earlier run), so without this they'd be flagged as
 *     new, real-money-with-no-record every time the same file resurfaces.
 *     See `reconciledStore.ts`'s `loadRecentSettledKeys`.
 *
 *  3. Reports which source sessions still have at least one genuinely
 *     open row after the `pending` suppression. The caller must NOT flag
 *     those as `mprIncludedInSessionId` yet, so `listPendingMpr()`
 *     naturally offers them to the next run.
 *
 * "No RRN" pending (missing/all-zero RRN) is deliberately excluded from
 * the retry check — a missing RRN is a data problem on the ledger side,
 * not a late-arriving bank file, and no future run will ever resolve it.
 * Same reasoning for an AMEX row `pending` because its own date or card
 * is missing (as opposed to pending because no AMEX row matched *yet*).
 * `ambiguous` rows (either side) are also excluded — more bank data won't
 * resolve an ambiguity, only a human can.
 */

import type { AmexResult, MatchResult, PendingRow, ReconciledDay, ReconciledItem, TaggedUpiTransaction, UnexpectedMprRow, UpiResult } from '../types.js';

export interface ReconcileRetryOutcome {
  result: MatchResult;
  /** New (this-run) resolutions, grouped by business date, ready to upsert into that date's accumulator. */
  newItemsByBusinessDate: Map<string, ReconciledItem[]>;
  /** Source session ids with at least one row still genuinely open after the accumulator lookup. */
  stillOpenSessionIds: Set<string>;
}

function accumulatorHas(day: ReconciledDay | undefined, key: string): boolean {
  return !!day?.items.some((i) => i.key === key);
}

/** One ledger AMEX transaction's accumulator key — amount and date-time included, so a same-card, same-day twin in one session isn't mistaken for it. */
export function amexItemKey(r: Pick<AmexResult, 'date' | 'at' | 'cardLast4' | 'l1Amount'> & { _sourceSessionId: string }): string {
  return `${r._sourceSessionId}|amex|${r.date}|${r.cardLast4}|${r.l1Amount ?? ''}|${r.at ?? ''}`;
}

/**
 * Already resolved by an earlier run — by the current key, or by an item
 * written before amount/time were part of it. Such an item kept only the last
 * of a session's same-card, same-day rows (they shared its key), so it still
 * means what it did then: every one of them is resolved.
 */
function amexResolvedEarlier(day: ReconciledDay | undefined, r: AmexResult & { _sourceSessionId: string }): boolean {
  const key = amexItemKey(r);
  const legacy = `${r._sourceSessionId}|amex|${r.date}|${r.cardLast4}`;
  return !!day?.items.some((i) => i.key === key || i.key === legacy);
}

/**
 * Keys under which a settled/mismatched AMEX bank row is remembered, so a
 * bank-only (`unexpected`) copy of that same row — a resent file, or an older
 * run — can be recognised: with its Transaction Timestamp when known (plus a
 * `@*` wildcard for bank rows parsed before timestamps were), else the
 * date|card|amount alone.
 */
export function amexSettledKeys(date: string | null | undefined, card: string, amount: number, txnAt: string | null | undefined): string[] {
  const base = `${date}|${card}|${amount}`;
  return txnAt ? [`${base}@${txnAt}`, `${base}@*`] : [base];
}

/** Whether a bank-only AMEX row is one already recorded under `amexSettledKeys` — or under a bare `date|card`, which older accumulator items are recorded as (see `loadRecentSettledKeys`). */
export function isAmexBankRowSettled(keys: ReadonlySet<string>, date: string | null | undefined, card: string, amount: number, txnAt: string | null | undefined): boolean {
  const base = `${date}|${card}|${amount}`;
  return keys.has(`${date}|${card}`) || keys.has(base) || keys.has(txnAt ? `${base}@${txnAt}` : `${base}@*`);
}

function pushItem(byDate: Map<string, ReconciledItem[]>, businessDate: string, item: ReconciledItem): void {
  const list = byDate.get(businessDate) ?? [];
  list.push(item);
  byDate.set(businessDate, list);
}

export function applyReconciledAccumulator(
  result: MatchResult,
  accumulatorsByDate: ReadonlyMap<string, ReconciledDay>,
  mprSessionId: string,
  resolvedAt: string,
  recentSettledKeys: ReadonlySet<string> = new Set(),
): ReconcileRetryOutcome {
  const newItemsByBusinessDate = new Map<string, ReconciledItem[]>();
  const stillOpenSessionIds = new Set<string>();

  const stillUnexpected: UnexpectedMprRow[] = result.unexpected.filter((r) => !(r.rrn && recentSettledKeys.has(r.rrn)));

  for (const [rows, matchStatus] of [
    [result.settled, 'settled'],
    [result.amountMismatch, 'amountMismatch'],
  ] as const) {
    for (const r of rows) {
      if (!r._sourceSessionId) continue; // a manual file upload has no session to track
      pushItem(newItemsByBusinessDate, r._businessDate, {
        key: `${r._sourceSessionId}|${r.rrn}`,
        sourceSessionId: r._sourceSessionId,
        rrn: r.rrn,
        acquirer: r.acquirer ?? '',
        outlet: r.outlet ?? '',
        plAmount: r.plAmount,
        mprAmount: r.mpr.grossAmount,
        diff: r._diff,
        matchStatus,
        mprFile: r.mpr._file ?? null,
        resolvedInMprSessionId: mprSessionId,
        resolvedAt,
      });
    }
  }

  const stillPending: PendingRow[] = [];
  for (const r of result.pending) {
    if (r._reason !== 'Not in MPR' || !r._sourceSessionId) {
      stillPending.push(r);
      continue;
    }
    const key = `${r._sourceSessionId}|${r.rrn}`;
    if (accumulatorHas(accumulatorsByDate.get(r._businessDate), key)) continue; // already resolved by an earlier run
    stillPending.push(r);
    stillOpenSessionIds.add(r._sourceSessionId);
  }

  const stillAmex: AmexResult[] = [];
  for (const r of result.amexResults) {
    if ((r._match === 'settled' || r._match === 'mismatch') && r.mprRow) {
      if (r._sourceSessionId && r._businessDate) {
        pushItem(newItemsByBusinessDate, r._businessDate, {
          key: amexItemKey({ ...r, _sourceSessionId: r._sourceSessionId }),
          sourceSessionId: r._sourceSessionId,
          rrn: null,
          acquirer: 'AMEX',
          outlet: r.outlet,
          plAmount: r.l1Amount ?? 0,
          mprAmount: r.mprRow.amount,
          diff: r._diff ?? 0,
          matchStatus: r._match,
          mprFile: r.mprRow._file ?? null,
          mprTxnAt: r.mprRow.txnAt ?? null,
          resolvedInMprSessionId: mprSessionId,
          resolvedAt,
        });
      }
      stillAmex.push(r);
      continue;
    }

    if (r._match === 'pending' && r._sourceSessionId && r._businessDate && r.date && r.cardLast4) {
      if (amexResolvedEarlier(accumulatorsByDate.get(r._businessDate), { ...r, _sourceSessionId: r._sourceSessionId })) continue; // already resolved by an earlier run
      stillAmex.push(r);
      stillOpenSessionIds.add(r._sourceSessionId);
      continue;
    }

    if (r._match === 'unexpected' && r.mprRow && r.date && r.cardLast4 && isAmexBankRowSettled(recentSettledKeys, r.date, r.cardLast4, r.mprRow.amount, r.mprRow.txnAt)) continue;

    stillAmex.push(r);
  }

  // HDFC Static UPI — `_retryKey` is only ever set by the matcher for a row
  // backed by a real `TaggedUpiTransaction` (Pass 1 RRN match, Pass 2
  // amount+timestamp fallback), so `pr` is guaranteed to be that shape
  // whenever it's present. A justification-synthetic row (no stable id to
  // key a later lookup on) never has `_retryKey` set, so it always falls
  // through to the last branch unchanged — same standing-open-item
  // treatment as "No RRN" pending elsewhere.
  const stillUpi: UpiResult[] = [];
  for (const r of result.upiResults) {
    if ((r._match === 'settled' || r._match === 'mismatch' || r._match === 'partial') && r._retryKey && r._sourceSessionId && r._businessDate && r.mpr) {
      const prRows = r.pr as TaggedUpiTransaction[];
      pushItem(newItemsByBusinessDate, r._businessDate, {
        key: r._retryKey,
        sourceSessionId: r._sourceSessionId,
        rrn: prRows[0]?.rrn ?? r.mpr.rrn ?? null,
        acquirer: 'HDFC_UPI',
        outlet: '', // TaggedUpiTransaction carries no outlet field
        plAmount: prRows.reduce((s, p) => s + (p.amount || 0), 0),
        mprAmount: r.mpr.grossAmount,
        diff: r._diff ?? 0,
        matchStatus: r._match,
        mprFile: r.mpr._file ?? null,
        resolvedInMprSessionId: mprSessionId,
        resolvedAt,
      });
      stillUpi.push(r);
      continue;
    }

    if (r._match === 'pending' && r._retryKey && r._sourceSessionId && r._businessDate) {
      if (accumulatorHas(accumulatorsByDate.get(r._businessDate), r._retryKey)) continue; // already resolved by an earlier run
      stillUpi.push(r);
      stillOpenSessionIds.add(r._sourceSessionId);
      continue;
    }

    stillUpi.push(r);
  }

  return {
    result: { ...result, pending: stillPending, unexpected: stillUnexpected, amexResults: stillAmex, upiResults: stillUpi },
    newItemsByBusinessDate,
    stillOpenSessionIds,
  };
}
