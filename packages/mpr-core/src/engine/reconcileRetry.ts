/**
 * Post-processes one ingest run's `MatchResult` against each touched
 * business date's already-known-reconciled accumulator (see the API's
 * `reconciledStore.ts` for *why* that accumulator exists at all).
 *
 * Two things this does, together:
 *
 *  1. Suppresses a `pending` row this run produced if an *earlier* run
 *     already resolved the exact same row (same source session + RRN, or
 *     + Transaction Date/Card for AMEX). Without this, a session that gets
 *     retried in a later run would wrongly show an already-settled row as
 *     `pending` again — the bank file that settled it has since been
 *     relocated out of the pending S3 prefix, so this run's own fresh
 *     match has nothing to re-find it with.
 *
 *  2. Reports which source sessions still have at least one genuinely
 *     open row after that suppression. The caller must NOT flag those as
 *     `mprIncludedInSessionId` yet, so `listPendingMpr()` naturally offers
 *     them to the next run.
 *
 * "No RRN" pending (missing/all-zero RRN) is deliberately excluded from
 * the retry check — a missing RRN is a data problem on the ledger side,
 * not a late-arriving bank file, and no future run will ever resolve it.
 * Same reasoning for an AMEX row `pending` because its own date or card
 * is missing (as opposed to pending because no AMEX row matched *yet*).
 * `ambiguous` rows (either side) are also excluded — more bank data won't
 * resolve an ambiguity, only a human can.
 */

import type { AmexResult, MatchResult, PendingRow, ReconciledDay, ReconciledItem } from '../types.js';

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
): ReconcileRetryOutcome {
  const newItemsByBusinessDate = new Map<string, ReconciledItem[]>();
  const stillOpenSessionIds = new Set<string>();

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
          key: `${r._sourceSessionId}|amex|${r.date}|${r.cardLast4}`,
          sourceSessionId: r._sourceSessionId,
          rrn: null,
          acquirer: 'AMEX',
          outlet: r.outlet,
          plAmount: r.l1Amount ?? 0,
          mprAmount: r.mprRow.amount,
          diff: r._diff ?? 0,
          matchStatus: r._match,
          mprFile: r.mprRow._file ?? null,
          resolvedInMprSessionId: mprSessionId,
          resolvedAt,
        });
      }
      stillAmex.push(r);
      continue;
    }

    if (r._match === 'pending' && r._sourceSessionId && r._businessDate && r.date && r.cardLast4) {
      const key = `${r._sourceSessionId}|amex|${r.date}|${r.cardLast4}`;
      if (accumulatorHas(accumulatorsByDate.get(r._businessDate), key)) continue; // already resolved by an earlier run
      stillAmex.push(r);
      stillOpenSessionIds.add(r._sourceSessionId);
      continue;
    }

    stillAmex.push(r);
  }

  return {
    result: { ...result, pending: stillPending, amexResults: stillAmex },
    newItemsByBusinessDate,
    stillOpenSessionIds,
  };
}
