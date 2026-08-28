/**
 * The submit gate — one canonical check used both by the live "can I submit"
 * display and the actual `POST /submit` route.
 *
 * Legacy has two gates that can disagree: the button-enable check in
 * `renderFRS` (3690–3793) and a second, independently-computed check inside
 * `initiateSubmit` (4895–4943) — the latter additionally checks for orphaned
 * advance applications and re-derives the residual through a different
 * `collectExplainedForSubmit`. The port has one function; both the UI and the
 * submit route call it, so they can never disagree about whether a session
 * is ready.
 */

import { AMOUNT_EPSILON, THRESHOLD } from '../constants.js';
import type { HdfcStatementRow, MatchResult, PinelabsResult } from '../types.js';
import { bankOk, cashOk, hdfcUpiCompleteness, pinelabsCompleteness, upiOk } from './completeness.js';
import { buildHdfcUpiItems, buildPinelabsItems } from './items.js';
import { collectExplained, explainedTotals } from './residual.js';
import type { AdvanceApplication, JustificationState } from './types.js';

export type SubmitStatus = 'balanced' | 'within_threshold' | 'needs_explanation';

export interface SubmitGateResult {
  ok: boolean;
  blockers: string[];
  residual: number;
  status: SubmitStatus;
  perSource: {
    pinelabs: boolean;
    /** `null` when no HDFC statement was uploaded. */
    hdfcUpi: boolean | null;
    cash: boolean;
    upi: boolean;
    bank: boolean;
  };
}

export interface CanSubmitInput {
  pinelabs: PinelabsResult;
  upiHdfc: MatchResult<HdfcStatementRow> | null;
  justification: JustificationState;
  /** `grandSum − grandPR` from `grandTotals()` (`engine/frs.ts`), excluding POS-integrated methods. */
  grandDiff: number;
  hasSummary: boolean;
  /** Drawer Cash total minus PR Cash total. */
  cashDiff: number;
  /** Drawer Bank total minus PR Bank total. */
  bankDiff: number;
  /** Drawer HDFC total minus PR HDFC total — used only when no HDFC statement was uploaded. */
  hdfcAggregateDiff: number;
  /** Drawer Kotak total minus PR Kotak total. */
  kotakDiff: number;
  /** Every application — committed repository rows plus this session's own drafts — for the orphan check. */
  applications: readonly AdvanceApplication[];
}

export function canSubmit(input: CanSubmitInput): SubmitGateResult {
  const {
    pinelabs,
    upiHdfc,
    justification,
    grandDiff,
    hasSummary,
    cashDiff,
    bankDiff,
    hdfcAggregateDiff,
    kotakDiff,
    applications,
  } = input;
  const { entries, squareOff } = justification;
  const blockers: string[] = [];

  const plCompleteness = pinelabsCompleteness(pinelabs, entries, squareOff);
  if (!plCompleteness.allResolved) {
    blockers.push(
      `${plCompleteness.unresolvedCount} Pinelabs transaction${plCompleteness.unresolvedCount === 1 ? '' : 's'} still need a remark or square-off.`,
    );
  }

  const hdfcCompleteness = hdfcUpiCompleteness(upiHdfc, entries, squareOff);
  if (hdfcCompleteness && !hdfcCompleteness.allResolved) {
    blockers.push(
      `${hdfcCompleteness.unresolvedCount} HDFC Static UPI transaction${hdfcCompleteness.unresolvedCount === 1 ? '' : 's'} still need a remark or square-off.`,
    );
  }

  const cashResolved = cashOk(cashDiff, entries);
  if (!cashResolved) blockers.push(`Cash difference exceeds the ₹${THRESHOLD} threshold and is not fully justified.`);

  const bankResolved = bankOk(hasSummary, bankDiff, entries);
  if (!bankResolved) blockers.push('Bank transfer difference is not fully justified.');

  const upiResolved = upiOk({ hasSummary, hdfcCompleteness, hdfcAggregateDiff, kotakDiff, entries });
  if (!upiResolved) blockers.push('Static UPI difference is not fully justified.');

  const orphaned = entries.filter(
    (e) =>
      e.remark === 'Advance Applied' &&
      (!e.appliedApplicationId || !applications.some((a) => a.id === e.appliedApplicationId)),
  );
  if (orphaned.length) {
    blockers.push(
      `${orphaned.length} "Advance Applied" entr${orphaned.length === 1 ? 'y' : 'ies'} no longer have a backing advance — remove or re-record before submitting.`,
    );
  }

  const pinelabsItems = buildPinelabsItems(pinelabs);
  const hdfcItems = buildHdfcUpiItems(upiHdfc);
  const explained = collectExplained(entries, pinelabsItems, hdfcItems);
  const { excessTotal, shortTotal } = explainedTotals(explained);
  const residual = grandDiff - (excessTotal - shortTotal);

  if (Math.abs(residual) > THRESHOLD) {
    blockers.push(`Net unexplained (₹${Math.abs(residual).toFixed(2)}) exceeds the ₹${THRESHOLD} threshold.`);
  }

  const status: SubmitStatus =
    Math.abs(residual) < AMOUNT_EPSILON
      ? 'balanced'
      : Math.abs(residual) <= THRESHOLD
        ? 'within_threshold'
        : 'needs_explanation';

  return {
    ok: blockers.length === 0,
    blockers,
    residual,
    status,
    perSource: {
      pinelabs: plCompleteness.allResolved,
      hdfcUpi: hdfcCompleteness ? hdfcCompleteness.allResolved : null,
      cash: cashResolved,
      upi: upiResolved,
      bank: bankResolved,
    },
  };
}
