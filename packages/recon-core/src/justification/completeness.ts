/**
 * Per-source "is this fully explained" checks.
 * Ported from `reconciliation (68).html` lines 3690–3793 (`renderFRS`'s gate)
 * and `getHdfcCompleteness` (2249–2273).
 *
 * Deliberately count-based for Pinelabs and HDFC-UPI transaction-level data,
 * not net-amount-based: two opposite-sign unresolved items can net to near
 * zero and would otherwise falsely look resolved. Cash/Bank/UPI aggregate
 * checks are net-amount-based because there is no per-transaction source to
 * count against.
 *
 * The ₹300 leniency band is intentionally asymmetric, exactly as legacy has
 * it: only Cash (and, separately, the final aggregate residual at submit —
 * see `submitGate.ts`) get it. Bank and per-source UPI require exactness.
 */

import { AMOUNT_EPSILON, THRESHOLD } from '../constants.js';
import type { HdfcStatementRow, MatchResult, PinelabsResult } from '../types.js';
import { buildHdfcUpiItems, buildPinelabsItems } from './items.js';
import { isSquareOffResolved } from './squareOff.js';
import type { JustificationEntry, JustificationSource, ResolvableItem, SquareOffMap } from './types.js';

export interface CompletenessResult {
  /** Net diff of every still-unresolved item — informational only; never use alone (see module doc). */
  netDiff: number;
  unresolvedCount: number;
  allResolved: boolean;
}

function itemsCompleteness(
  items: ResolvableItem[],
  entries: JustificationEntry[],
  squareOff: SquareOffMap,
): CompletenessResult {
  const resolvedKeys = new Set(entries.map((e) => e.targetKey));
  const unresolved = items.filter(
    (item) => !resolvedKeys.has(item.targetKey) && !isSquareOffResolved(squareOff, item.globalId, items),
  );
  return {
    netDiff: unresolved.reduce((s, u) => s + u.diff, 0),
    unresolvedCount: unresolved.length,
    allResolved: unresolved.length === 0,
  };
}

export function pinelabsCompleteness(
  pinelabs: PinelabsResult,
  entries: readonly JustificationEntry[],
  squareOff: SquareOffMap,
): CompletenessResult {
  const items = buildPinelabsItems(pinelabs);
  return itemsCompleteness(
    items,
    entries.filter((e) => e.source === 'pinelabs'),
    squareOff,
  );
}

/** `null` when no HDFC statement was uploaded — there is nothing transaction-level to check. */
export function hdfcUpiCompleteness(
  upiHdfc: MatchResult<HdfcStatementRow> | null,
  entries: readonly JustificationEntry[],
  squareOff: SquareOffMap,
): CompletenessResult | null {
  if (!upiHdfc) return null;
  const items = buildHdfcUpiItems(upiHdfc);
  return itemsCompleteness(
    items,
    entries.filter((e) => e.source === 'upi_hdfc'),
    squareOff,
  );
}

/** Net signed total of every aggregate-tab entry for one source (Cash/UPI/Bank). */
export function entryNet(entries: readonly JustificationEntry[], source: JustificationSource): number {
  return entries
    .filter((e) => e.source === source)
    .reduce((s, e) => s + (e.direction === 'excess' ? e.amount : -e.amount), 0);
}

/** Cash is the only source with the ₹300 leniency band, both on the raw diff and on the residual. */
export function cashOk(diff: number, entries: readonly JustificationEntry[]): boolean {
  const absDiff = Math.abs(diff);
  if (absDiff < AMOUNT_EPSILON || absDiff <= THRESHOLD) return true;
  const residual = diff - entryNet(entries, 'cash');
  return Math.abs(residual) <= THRESHOLD;
}

/** No leniency band — Bank must be justified to within ε once a Payment Summary exists. */
export function bankOk(hasSummary: boolean, diff: number, entries: readonly JustificationEntry[]): boolean {
  if (!hasSummary) return true;
  if (Math.abs(diff) < AMOUNT_EPSILON) return true;
  const residual = diff - entryNet(entries, 'bank');
  return Math.abs(residual) < AMOUNT_EPSILON;
}

export interface UpiOkParams {
  hasSummary: boolean;
  /** From `hdfcUpiCompleteness()` — `null` when no HDFC statement was uploaded. */
  hdfcCompleteness: CompletenessResult | null;
  /** Aggregate HDFC diff (summary − PR), used only when no statement exists. */
  hdfcAggregateDiff: number;
  kotakDiff: number;
  entries: readonly JustificationEntry[];
}

/**
 * With a statement: HDFC must be fully resolved (count-based) and Kotak must
 * be within ε either directly or via the combined residual. Without one:
 * falls back to a single amount-threshold check across both, matching legacy.
 */
export function upiOk({ hasSummary, hdfcCompleteness, hdfcAggregateDiff, kotakDiff, entries }: UpiOkParams): boolean {
  if (!hasSummary) return true;
  const net = entryNet(entries, 'upi');

  if (!hdfcCompleteness) {
    const upiDiffAmt = hdfcAggregateDiff + kotakDiff;
    const residual = upiDiffAmt - net;
    return Math.abs(upiDiffAmt) < AMOUNT_EPSILON || Math.abs(residual) < AMOUNT_EPSILON;
  }

  const upiDiffAmt = hdfcCompleteness.netDiff + kotakDiff;
  const residual = upiDiffAmt - net;
  const kotakResolvedByThreshold =
    Math.abs(kotakDiff - net) < AMOUNT_EPSILON || Math.abs(residual) < AMOUNT_EPSILON;
  return hdfcCompleteness.allResolved && kotakResolvedByThreshold;
}
