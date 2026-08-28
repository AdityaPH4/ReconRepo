/**
 * Resolvable-item construction for Pinelabs and HDFC-UPI transaction buckets.
 * Ported from `reconciliation (68).html` — the `globalId`/`rmkKey` schemes
 * scattered across `renderPinelabs` (1592–1879), `getHdfcCompleteness`
 * (2249–2273) and `getRmkKeyUpiHdfc` (2273–2280).
 *
 * This is the single place both a UI (creating an entry) and the completeness
 * /residual calculators (checking one) compute `globalId`/`targetKey` for a
 * row — legacy recomputed these inline at every call site, which is exactly
 * how the two independently-drifting `collectExplained` functions happened.
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
      countsTowardResidual: true,
    });
  });

  pinelabs.onlyTerm.forEach((x, i) => {
    items.push({
      globalId: `PL-${i + 1}`,
      targetKey: `term-${x.rrn}-${x.date}`,
      diff: +(x.amount || 0),
      countsTowardResidual: true,
    });
  });

  pinelabs.reconRows
    .filter((x) => Math.abs(x.diff) > AMOUNT_EPSILON && !x.squaredOff)
    .forEach((x, i) => {
      items.push({
        globalId: `MM-${i + 1}`,
        targetKey: x.rrn,
        diff: x.diff,
        countsTowardResidual: true,
      });
    });

  pinelabs.dupRRN.forEach((x, i) => {
    // Ambiguous rows need a remark to satisfy the submit gate, but — matching
    // legacy's `collectExplained`, which never lists `dupRRN` — carry no
    // amount into the residual; there is no reliable single figure to net.
    items.push({
      globalId: `DUP-${i + 1}`,
      targetKey: `dup-${x.rrn}`,
      diff: 0,
      countsTowardResidual: false,
    });
  });

  pinelabs.amexDup.forEach((x, i) => {
    items.push({
      globalId: `ADP-${i + 1}`,
      targetKey: `amexdup-${x.pr.orderNo}`,
      diff: -(x.pr.amount || 0),
      countsTowardResidual: true,
    });
  });

  pinelabs.amexDupTerm.forEach((x, i) => {
    items.push({
      globalId: `ADPL-${i + 1}`,
      targetKey: `amexdupterm-${i}-${x.amount}`,
      diff: +(x.amount || 0),
      countsTowardResidual: true,
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
      countsTowardResidual: true,
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
      countsTowardResidual: true,
    });
  });

  upiHdfc.reconRows
    .filter((x) => Math.abs(x.diff) > AMOUNT_EPSILON)
    .forEach((x, i) => {
      items.push({
        globalId: `UMM-${i + 1}`,
        targetKey: `umm-${x.rrn}`,
        diff: x.diff,
        countsTowardResidual: true,
      });
    });

  return items;
}
