/**
 * The canonical "what has been explained" calculation.
 *
 * Legacy has two independently-drifting versions of this: `collectExplained`
 * (3577–3646, used for the live on-screen Explanation tables and the "Net
 * unexplained" figure) and `collectExplainedForSubmit` (5001–5082, used only
 * at actual submit time) — the display version never walks the HDFC-UPI
 * transaction-level buckets, so for any outlet with an HDFC statement the
 * operator-visible residual during editing under-counts relative to what
 * submit actually gates on. The port has one function, used everywhere.
 */

import { AMOUNT_EPSILON } from '../constants.js';
import type { Remark } from '../constants.js';
import type { JustificationEntry, JustificationSource, ResolvableItem } from './types.js';

export interface ExplainedItem {
  source: JustificationSource;
  remark: Remark;
  /** Positive = excess, negative = shortage. */
  diff: number;
  targetKey: string | null;
  entryId: string;
}

/**
 * Walks every entry and resolves it to a signed diff: row-level entries
 * (Pinelabs/HDFC-UPI) look up their row's own diff; aggregate entries
 * (Cash/UPI/Bank) use their own signed `amount`. A row-level entry whose
 * item doesn't `countsTowardResidual` (ambiguous `dupRRN` rows) satisfies the
 * completeness gate but contributes nothing here — matching legacy.
 */
export function collectExplained(
  entries: readonly JustificationEntry[],
  pinelabsItems: readonly ResolvableItem[],
  hdfcItems: readonly ResolvableItem[],
): ExplainedItem[] {
  const plByKey = new Map(pinelabsItems.map((i) => [i.targetKey, i]));
  const hdfcByKey = new Map(hdfcItems.map((i) => [i.targetKey, i]));

  const out: ExplainedItem[] = [];
  for (const e of entries) {
    let diff: number;
    if (e.source === 'pinelabs' || e.source === 'upi_hdfc') {
      const item = e.targetKey === null ? undefined : (e.source === 'pinelabs' ? plByKey : hdfcByKey).get(e.targetKey);
      if (!item || !item.countsTowardResidual) continue;
      diff = item.diff;
    } else if (e.source === 'cash' || e.source === 'upi' || e.source === 'bank') {
      diff = e.direction === 'excess' ? e.amount : -e.amount;
    } else {
      // `'boh'` — a Bills-on-Hold clearance triggered from the BOH tab
      // directly has no diff to offset; see the `JustificationSource` doc.
      continue;
    }
    out.push({ source: e.source, remark: e.remark, diff, targetKey: e.targetKey, entryId: e.id });
  }
  return out;
}

export function explainedTotals(items: readonly ExplainedItem[]): {
  excessTotal: number;
  shortTotal: number;
} {
  const excessTotal = items.filter((x) => x.diff > AMOUNT_EPSILON).reduce((s, x) => s + x.diff, 0);
  const shortTotal = items
    .filter((x) => x.diff < -AMOUNT_EPSILON)
    .reduce((s, x) => s + Math.abs(x.diff), 0);
  return { excessTotal, shortTotal };
}
