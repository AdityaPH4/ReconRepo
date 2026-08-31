/**
 * CSV export.
 * Ported from `mpr-recon (10).html` lines 1723–1737 (`downloadCSV`) — matched
 * field-for-field, column-for-column, including legacy's exact per-row
 * values (e.g. `0` hardcoded for every settled row's Difference, not the
 * real sub-tolerance diff; blank Difference for pending; lowercase
 * `settled`/`amount_mismatch`/`pending`/`unexpected` match-status strings).
 *
 * Two approved, documented deliberate differences remain (see README):
 * `amexResults` is included (legacy's export omits AMEX entirely despite it
 * having a full results tab), and "No RRN" pending rows are included on the
 * same terms as every other pending row (legacy's CSV already does this —
 * it's the on-screen Pending tab/tile that used to disagree, which the port
 * also fixed).
 */

import type { MatchResult } from '../types.js';

const HEADER = [
  'RRN',
  'Outlet',
  'Store (Pinelabs)',
  'Business Date',
  'Acquirer',
  'Txn Date (MPR)',
  'MPR Settlement Date',
  'L1 Amount',
  'MPR Amount',
  'Difference',
  'L1 Status',
  'L1 Remark',
  'Match Status',
  'MPR Source',
  'MPR File',
];

export function buildExportRows(result: MatchResult): string[][] {
  const rows: string[][] = [HEADER];

  for (const r of result.settled) {
    rows.push([
      r.rrn ?? '',
      r.outlet ?? '',
      r.store ?? '',
      r._businessDate,
      r.acquirer ?? '',
      r.mpr.txnDateRaw || r.mpr.txnDate || '',
      r.mpr.settlementDate ?? '',
      String(r.plAmount),
      String(r.mpr.grossAmount),
      '0', // legacy hardcodes this — a settled row is within tolerance by definition.
      r.l1Status ?? '',
      r.l1Remark ?? '',
      'settled',
      r.mpr._source ?? '',
      r.mpr._file ?? '',
    ]);
  }

  for (const r of result.amountMismatch) {
    rows.push([
      r.rrn ?? '',
      r.outlet ?? '',
      r.store ?? '',
      r._businessDate,
      r.acquirer ?? '',
      r.mpr.txnDateRaw || r.mpr.txnDate || '',
      r.mpr.settlementDate ?? '',
      String(r.plAmount),
      String(r.mpr.grossAmount),
      String(r._diff),
      r.l1Status ?? '',
      r.l1Remark ?? '',
      'amount_mismatch',
      r.mpr._source ?? '',
      r.mpr._file ?? '',
    ]);
  }

  for (const r of result.pending) {
    rows.push([
      r.rrn ?? '',
      r.outlet ?? '',
      r.store ?? '',
      r._businessDate,
      r.acquirer ?? '',
      r.plDate ?? '',
      '',
      String(r.plAmount),
      '',
      '',
      r.l1Status ?? '',
      r.l1Remark ?? '',
      'pending',
      '',
      '',
    ]);
  }

  for (const r of result.unexpected) {
    rows.push([
      r.rrn,
      '',
      '',
      '',
      '',
      r.mprTxnDate ?? '',
      r.mprDate ?? '',
      '',
      String(r.mprAmount),
      '',
      '',
      '',
      'unexpected',
      r._source ?? '',
      r._file ?? '',
    ]);
  }

  for (const r of result.amexResults) {
    rows.push([
      '',
      r.outlet,
      '',
      r.date ?? '',
      'AMEX',
      r.timestamp ?? '',
      r.mprRow?.settlementDate ?? '',
      r.l1Total != null ? String(r.l1Total) : '',
      r.mprRow ? String(r.mprRow.submissionAmount) : '',
      r._diff != null ? String(r._diff) : '',
      '',
      '',
      r._match,
      'AMEX',
      r.mprRow?._file ?? '',
    ]);
  }

  // Legacy accesses `row.pr?.orderNo`/`.outlet`/`._businessDate`/`.amount`
  // directly, un-array-aware — for a Pass-1/Pass-2 match `pr` is an array,
  // so those columns come out blank there in legacy too; only the
  // justification-synthetic pending rows (`pr` a plain object) populate
  // them. Reproduced as-is for export parity; the UPI *tab* in the UI does
  // not have this gap, since legacy's own tab rendering iterates `pr` with
  // `.map()` correctly — only this export function has the bug.
  for (const r of result.upiResults) {
    const pr = r.pr as { orderNo?: string; outlet?: string; _businessDate?: string; date?: string; amount?: number } | undefined;
    rows.push([
      pr?.orderNo ?? '',
      '',
      '',
      pr?._businessDate ?? '',
      'HDFC Static UPI',
      r.mpr?.txnDateRaw || r.mpr?.txnDate || '',
      r.mpr?.settlementDate ?? '',
      pr?.amount != null ? String(pr.amount) : '',
      r.mpr ? String(r.mpr.grossAmount) : '',
      r._diff != null ? String(r._diff) : '',
      '',
      '',
      r._match,
      'HDFC_UPI',
      r.mpr?._file ?? '',
    ]);
  }

  return rows;
}

/** Renders rows (header included) to CSV text — legacy quotes every field unconditionally. */
export function rowsToCsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => `"${(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}
