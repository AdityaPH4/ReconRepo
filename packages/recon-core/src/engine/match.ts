/**
 * Shared RRN-group matcher.
 * Ported from `reconciliation (68).html` lines 1062–1116 (`matchTransactionLevel`).
 *
 * Deliberately generic over the terminal side so the identical algorithm serves
 * both comparisons in the system:
 *   - Pinelabs  — Payment Report vs the terminal ZIP
 *   - Static UPI — Payment Report vs the HDFC statement (when uploaded)
 *
 * AMEX is *not* handled here; it has no usable RRN and is matched on auth code
 * in `reconcile()`. UPI transactions are never AMEX, so nothing is lost by
 * keeping that logic Pinelabs-only.
 */

import type {
  DupRRNRow,
  MatchResult,
  OnlyPOSRow,
  PRGroup,
  PRRow,
  ReconRow,
} from '../types.js';
import { AMOUNT_EPSILON } from '../constants.js';

/** Minimum shape a terminal-side row must have to be matchable. */
export interface TerminalLike {
  rrn: string;
  amount: number;
}

/**
 * Groups PR rows by RRN, then matches each group against the terminal side.
 *
 * Grouping matters: a single card tap can settle several POS orders (split
 * bills), so the comparison is *group total vs terminal amount*, never
 * row-by-row. `diff` is therefore `terminal − PR group total`, i.e. positive
 * means the terminal collected more than the POS recorded.
 *
 * Four buckets come out:
 *  - `reconRows` — RRN present on both sides
 *  - `onlyPOS`   — in the Payment Report but not on the terminal (plus every
 *                  PR row that carries no RRN at all)
 *  - `onlyTerm`  — on the terminal but not in the Payment Report
 *  - `dupRRN`    — RRN appears more than once on the terminal side, so no
 *                  one-to-one match can be asserted; needs a human
 */
export function matchTransactionLevel<T extends TerminalLike>(
  prRows: readonly PRRow[],
  terminalRows: readonly T[],
): MatchResult<T> {
  const prNoRRN = prRows.filter((r) => !r.rrn);

  // ── Group PR rows by RRN ────────────────────────────────────────────────
  const prRRNMap: Record<string, PRGroup> = {};
  for (const r of prRows) {
    if (!r.rrn) continue;
    let g = prRRNMap[r.rrn];
    if (!g) {
      g = prRRNMap[r.rrn] = {
        rrn: r.rrn,
        total: 0,
        orders: [],
        rows: [],
        paymentName: r.paymentName,
        bank: r.bank,
        date: r.date,
        employee: r.employee,
        paymentType: r.paymentType,
      };
    }
    g.total += r.amount;
    g.orders.push(r.orderNo);
    g.rows.push(r);
  }
  const prGroups = Object.values(prRRNMap);

  // ── Index the terminal side by RRN, flagging duplicates ─────────────────
  // A duplicated RRN keeps its first index entry but is marked in `termDup`;
  // every consumer below checks `termDup` first, so the stale entry is never
  // matched against.
  const termIdx: Record<string, T> = {};
  const termDup: Record<string, boolean> = {};
  for (const r of terminalRows) {
    if (!r.rrn) continue;
    if (termDup[r.rrn]) continue;
    if (termIdx[r.rrn]) termDup[r.rrn] = true;
    else termIdx[r.rrn] = r;
  }

  const reconRows: ReconRow<T>[] = [];
  const onlyPOS: OnlyPOSRow[] = [];
  const onlyTerm: T[] = [];
  const dupRRN: DupRRNRow[] = [];
  const usedTerm = new Set<string>();

  for (const grp of prGroups) {
    const first = grp.rows[0]!;

    if (termDup[grp.rrn]) {
      dupRRN.push({
        ...first,
        orders: grp.orders,
        _dupSrc: 'Terminal',
        _note: 'Duplicate RRN in terminal',
      });
      continue;
    }

    const term = termIdx[grp.rrn];
    if (term) {
      usedTerm.add(grp.rrn);
      const diff = term.amount - grp.total;
      // Manual APOS is keyed in by hand, so an exact tie is treated as
      // self-evidently settled and needs no operator remark.
      const isManualAPOS = grp.rows.some((r) => /manual apos/i.test(r.paymentName || ''));
      const squaredOff = isManualAPOS && Math.abs(diff) <= AMOUNT_EPSILON;
      reconRows.push({
        rrn: grp.rrn,
        plAmt: term.amount,
        prAmt: grp.total,
        diff,
        orders: grp.orders,
        pr: first,
        prRows: grp.rows,
        zip: term,
        isManualAPOS,
        squaredOff,
      });
    } else {
      onlyPOS.push({
        ...first,
        orders: grp.orders,
        amount: grp.total,
        _note: grp.orders.length > 1 ? `${grp.orders.length} orders grouped` : '',
      });
    }
  }

  // Terminal rows with no PR counterpart. Rows with no RRN, and rows whose RRN
  // was duplicated, are excluded — neither can be asserted as unmatched.
  for (const z of terminalRows) {
    if (!z.rrn || usedTerm.has(z.rrn) || termDup[z.rrn]) continue;
    onlyTerm.push(z);
  }

  // PR rows with no RRN can never match; they surface as POS-only.
  for (const pr of prNoRRN) {
    onlyPOS.push({ ...pr, orders: [pr.orderNo], _note: 'No RRN' });
  }

  return { reconRows, onlyPOS, onlyTerm, dupRRN };
}
