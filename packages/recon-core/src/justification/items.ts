/**
 * Resolvable-item construction for Pinelabs and HDFC-UPI transaction buckets.
 * Ported from `reconciliation (68).html` — the `globalId`/`rmkKey` schemes
 * scattered across `renderPinelabs` (1592–1879), `getHdfcCompleteness`
 * (2249–2273), `getRmkKeyUpiHdfc` (2273–2280) and the `source`/`label`
 * category names in `collectExplainedForSubmit` (5000–5069).
 *
 * This is the single place both a UI (creating an entry) and the completeness
 * /residual/report calculators (checking one) compute `globalId`/`targetKey`
 * for a row — legacy recomputed these inline at every call site, which is
 * exactly how the two independently-drifting `collectExplained` functions
 * happened.
 */

import { AMOUNT_EPSILON } from '../constants.js';
import type { HdfcStatementRow, MatchResult, PinelabsResult } from '../types.js';
import type { ResolvableItem } from './types.js';

export function buildPinelabsItems(pinelabs: PinelabsResult): ResolvableItem[] {
  const items: ResolvableItem[] = [];

  pinelabs.onlyPOS.forEach((x, i) => {
    items.push({
      globalId: `POS-${i + 1}`,
      targetKey: `pos-${x.orders?.[0] || x.orderNo || ''}-${x.rrn || ''}`,
      diff: -(x.amount || 0),
      label: 'Only in POS',
      orderNo: (x.orders || [x.orderNo]).filter(Boolean).join(', '),
      rrn: x.rrn || '',
      appearsInExplanation: true,
      countsTowardGate: true,
    });
  });

  pinelabs.onlyTerm.forEach((x, i) => {
    items.push({
      globalId: `PL-${i + 1}`,
      targetKey: `term-${x.rrn}-${x.date}`,
      diff: +(x.amount || 0),
      label: 'Only in Terminal',
      orderNo: '',
      rrn: x.rrn || '',
      appearsInExplanation: true,
      countsTowardGate: true,
    });
  });

  pinelabs.reconRows
    .filter((x) => Math.abs(x.diff) > AMOUNT_EPSILON && !x.squaredOff)
    .forEach((x, i) => {
      items.push({
        globalId: `MM-${i + 1}`,
        targetKey: x.rrn,
        diff: x.diff,
        label: 'Amount mismatch',
        orderNo: (x.orders || [x.pr?.orderNo]).filter(Boolean).join(', '),
        rrn: x.rrn || '',
        appearsInExplanation: true,
        countsTowardGate: true,
      });
    });

  pinelabs.dupRRN.forEach((x, i) => {
    // Ambiguous rows need a remark to satisfy the submit gate, but legacy's
    // `collectExplainedForSubmit` has no `forEach` over `pinelabs.dupRRN` at
    // all — a remarked one there never becomes a row in the "Explanation of
    // Variances" report. Unlike HDFC-UPI's own `dupRRN` bucket below, legacy's
    // `plUnresolvedItems` *does* block submission on an unremarked one here.
    items.push({
      globalId: `DUP-${i + 1}`,
      targetKey: `dup-${x.rrn}`,
      diff: 0,
      label: 'Ambiguous — duplicate RRN',
      orderNo: (x.orders || []).filter(Boolean).join(', '),
      rrn: x.rrn || '',
      appearsInExplanation: false,
      countsTowardGate: true,
    });
  });

  pinelabs.amexDup.forEach((x, i) => {
    items.push({
      globalId: `ADP-${i + 1}`,
      targetKey: `amexdup-${x.pr.orderNo}`,
      diff: -(x.pr.amount || 0),
      label: 'AMEX dup POS',
      orderNo: x.pr.orderNo || '',
      rrn: x.pr.rrn || '',
      appearsInExplanation: true,
      countsTowardGate: true,
    });
  });

  pinelabs.amexDupTerm.forEach((x, i) => {
    items.push({
      globalId: `ADPL-${i + 1}`,
      targetKey: `amexdupterm-${i}-${x.amount}`,
      diff: +(x.amount || 0),
      label: 'AMEX dup terminal',
      orderNo: '',
      rrn: x.rrn || '',
      appearsInExplanation: true,
      countsTowardGate: true,
    });
  });

  return items;
}

export function buildHdfcUpiItems(
  upiHdfc: MatchResult<HdfcStatementRow> | null,
): ResolvableItem[] {
  if (!upiHdfc) return [];
  const items: ResolvableItem[] = [];

  upiHdfc.onlyPOS.forEach((x, i) => {
    items.push({
      globalId: `UPOS-${i + 1}`,
      targetKey: `upos-${x.orders?.[0] || x.orderNo || ''}-${x.rrn || ''}`,
      diff: -(x.amount || 0),
      label: 'HDFC UPI — Only in PR',
      orderNo: (x.orders || [x.orderNo]).filter(Boolean).join(', '),
      rrn: x.rrn || '',
      appearsInExplanation: true,
      countsTowardGate: true,
    });
  });

  upiHdfc.onlyTerm.forEach((x, i) => {
    items.push({
      globalId: `USTMT-${i + 1}`,
      // `x.date` is a `Date` in a freshly-built `ReconResult`, but a plain
      // ISO string once a session has round-tripped through JSON (the
      // `Jsonified<>` erasure the API stores) — accept either.
      targetKey: `ustmt-${x.rrn}-${x.date instanceof Date ? x.date.toISOString() : x.date}`,
      diff: +(x.amount || 0),
      label: 'HDFC UPI — Only in Statement',
      orderNo: '',
      rrn: x.rrn || '',
      appearsInExplanation: true,
      countsTowardGate: true,
    });
  });

  upiHdfc.reconRows
    .filter((x) => Math.abs(x.diff) > AMOUNT_EPSILON)
    .forEach((x, i) => {
      items.push({
        globalId: `UMM-${i + 1}`,
        targetKey: `umm-${x.rrn}`,
        diff: x.diff,
        label: 'HDFC UPI — Amount mismatch',
        orderNo: (x.orders || []).filter(Boolean).join(', '),
        rrn: x.rrn || '',
        appearsInExplanation: true,
        countsTowardGate: true,
      });
    });

  // Legacy's `getRmkKeyUpiHdfc('udup', x)` lets the operator attach a remark
  // to a duplicated-RRN statement row (`renderUPIHdfcSection`, 2400–2414) for
  // their own bookkeeping — but `getHdfcCompleteness` (2249–2273), the
  // function that actually gates submission, never includes this bucket in
  // its item list at all. So — unlike Pinelabs' own `dupRRN` — this item
  // must exist for the UI's `RemarkCell` to attach to, but must never block
  // the submit gate; `countsTowardGate: false` is what keeps that true.
  // It *does* still show up in the "Explanation of Variances" report once
  // remarked, with `diff: 0` — legacy's `collectExplainedForSubmit` (5052–5057)
  // explicitly lists `upiHdfc.dupRRN`, unlike Pinelabs' own bucket above.
  upiHdfc.dupRRN.forEach((x, i) => {
    items.push({
      globalId: `UDUP-${i + 1}`,
      targetKey: `udup-${x.rrn}`,
      diff: 0,
      label: 'HDFC UPI — Duplicate RRN',
      orderNo: (x.orders || []).filter(Boolean).join(', '),
      rrn: x.rrn || '',
      appearsInExplanation: true,
      countsTowardGate: false,
    });
  });

  return items;
}
