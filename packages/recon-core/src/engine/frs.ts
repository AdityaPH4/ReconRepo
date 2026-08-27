/**
 * Final Recon Summary arithmetic.
 * Ported from `reconciliation (68).html` lines 3354–3408.
 *
 * Every consumer of FRS numbers — the on-screen table, the submission gate,
 * and the downloaded report — routes through `frsRowAmounts` here. That is
 * deliberate: the legacy comment notes it exists so those three "can never
 * silently disagree about which column a method's amount belongs in or what
 * its diff means".
 */

import { FRS_METHODS } from '../constants.js';
import type {
  FrsMethod,
  FrsRowAmounts,
  HdfcStatementRow,
  MatchResult,
  PRRow,
  SummaryData,
  ZipRow,
} from '../types.js';
import { money } from '../util/money.js';

/** Payment name → total, summed over the Payment Report. */
export function buildPRMap(prData: readonly PRRow[]): Record<string, number> {
  const prMap: Record<string, number> = {};
  for (const row of prData) {
    const pn = (row.paymentName || '').trim();
    prMap[pn] = (prMap[pn] || 0) + row.amount;
  }
  return prMap;
}

/** Drawer summary column → numeric total. Unparseable cells become 0. */
export function buildSumMap(summaryData: SummaryData | null): Record<string, number> {
  const sumMap: Record<string, number> = {};
  if (!summaryData) return sumMap;
  for (const [k, v] of Object.entries(summaryData)) {
    sumMap[k] = money(v) || 0;
  }
  return sumMap;
}

/** Drawer-based totals for one method: PR side vs Payment Summary side. */
export function frsMethodTotals(
  m: FrsMethod,
  prMap: Record<string, number>,
  sumMap: Record<string, number>,
): { pr: number; sum: number } {
  const pr = m.prKeys.reduce((s, k) => s + (prMap[k] || 0), 0);
  const sum = m.sumKeys.reduce((s, k) => s + (sumMap[k] || 0), 0);
  return { pr, sum };
}

/**
 * Pinelabs' true expected total is the terminal report, not the drawer
 * summary — the drawer figure is hand-entered and can itself carry clerical
 * errors, so reconciling against it would compare one error to another.
 */
export function pinelabsTerminalPR(
  prData: readonly PRRow[],
  zipInside: readonly ZipRow[],
): { pr: number; term: number } {
  const pr = prData
    .filter((row) => row.tab === 'pinelabs')
    .reduce((s, row) => s + row.amount, 0);
  const term = zipInside.reduce((s, z) => s + (z.amount || 0), 0);
  return { pr, term };
}

/**
 * HDFC Static UPI's transaction-level totals, reconstructed from the match
 * buckets (only those are retained, not the raw statement).
 * Returns `null` when no statement was uploaded.
 */
export function hdfcTerminalPR(
  upiHdfc: MatchResult<HdfcStatementRow> | null,
): { pr: number; term: number } | null {
  if (!upiHdfc) return null;
  const pr =
    upiHdfc.reconRows.reduce((s, x) => s + (x.prAmt || 0), 0) +
    upiHdfc.onlyPOS.reduce((s, x) => s + (x.amount || 0), 0);
  const term =
    upiHdfc.reconRows.reduce((s, x) => s + (x.plAmt || 0), 0) +
    upiHdfc.onlyTerm.reduce((s, x) => s + (x.amount || 0), 0);
  return { pr, term };
}

/** Context `frsRowAmounts` needs to resolve the transaction-level rows. */
export interface FrsContext {
  prData: readonly PRRow[];
  zipInside: readonly ZipRow[];
  upiHdfc: MatchResult<HdfcStatementRow> | null;
}

/**
 * Resolves one FRS row to its PR amount, its expected amount, and the diff —
 * choosing a transaction-level source over the drawer summary where one
 * exists.
 *
 * `usingSource` tells the caller which column the expected figure belongs in,
 * so the table, the gate and the report all render and total it identically.
 * `diff` is always `expected − pr`.
 */
export function frsRowAmounts(
  m: FrsMethod,
  prMap: Record<string, number>,
  sumMap: Record<string, number>,
  ctx: FrsContext,
): FrsRowAmounts {
  if (m.sourceType === 'source' && m.label === 'Pinelabs') {
    const { pr, term } = pinelabsTerminalPR(ctx.prData, ctx.zipInside);
    return { pr, drawerAmt: null, sourceAmt: term, diff: term - pr, usingSource: true };
  }
  if (m.sourceType === 'conditional' && m.label === 'HDFC Static UPI' && ctx.upiHdfc) {
    const t = hdfcTerminalPR(ctx.upiHdfc)!;
    return {
      pr: t.pr,
      drawerAmt: null,
      sourceAmt: t.term,
      diff: t.term - t.pr,
      usingSource: true,
    };
  }
  const { pr, sum } = frsMethodTotals(m, prMap, sumMap);
  return { pr, drawerAmt: sum, sourceAmt: null, diff: sum - pr, usingSource: false };
}

/**
 * The session-wide difference: expected minus recorded, across every method.
 *
 * POS-integrated methods (Swiggy, Zomato) are excluded — they are assumed
 * reconciled by the integration and must never hold up a submission.
 */
export function grandTotals(
  prMap: Record<string, number>,
  sumMap: Record<string, number>,
  ctx: FrsContext,
): { grandPR: number; grandSum: number; grandDiff: number } {
  let grandPR = 0;
  let grandSum = 0;
  for (const m of FRS_METHODS) {
    if (m.assumedReconciled) continue;
    const { pr, drawerAmt, sourceAmt, usingSource } = frsRowAmounts(m, prMap, sumMap, ctx);
    grandPR += pr;
    grandSum += usingSource ? (sourceAmt ?? 0) : (drawerAmt ?? 0);
  }
  return { grandPR, grandSum, grandDiff: grandSum - grandPR };
}
