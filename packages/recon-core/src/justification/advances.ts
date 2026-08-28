/**
 * Advance repository — balance and eligibility.
 * Ported from `reconciliation (68).html` lines 3963–4183 (`advBalance`,
 * `advExhausted`, `renderAdvList`, `confirmAdvanceApplied`).
 *
 * Matching/lookup is deliberately manual, not automated: there is no date or
 * outlet-of-origin heuristic pairing an advance to a shortage. The only
 * automated constraint is the exact-balance-match gate, and it is only active
 * when a real shortage amount is already known (i.e. the modal was opened
 * from a Pinelabs/HDFC-UPI row) — opened from Cash/UPI/Bank, any advance with
 * remaining balance is selectable, and its full balance is always applied.
 * There is no partial-apply path in legacy, and the port preserves that.
 */

import { AMOUNT_EPSILON } from '../constants.js';
import type { Advance, AdvanceApplication } from './types.js';

export function advanceBalance(
  advance: Advance,
  applications: readonly AdvanceApplication[],
): number {
  const applied = applications
    .filter((a) => a.advanceId === advance.id)
    .reduce((s, a) => s + a.amount, 0);
  return advance.originalAmount - applied;
}

export function isAdvanceExhausted(
  advance: Advance,
  applications: readonly AdvanceApplication[],
): boolean {
  return advanceBalance(advance, applications) < AMOUNT_EPSILON;
}

export interface EligibleAdvance {
  advance: Advance;
  balance: number;
  eligible: boolean;
  ineligibleReason: string | null;
}

/**
 * `exactAmount` is the shortage a Pinelabs/HDFC-UPI row already carries. Pass
 * `undefined` (or an amount `<= ε`) from Cash/UPI/Bank, where no shortage is
 * known yet at modal-open time — every advance with remaining balance is then
 * eligible, and applying it always consumes the full balance.
 */
export function eligibleAdvances(
  advances: readonly Advance[],
  applications: readonly AdvanceApplication[],
  exactAmount?: number,
): EligibleAdvance[] {
  const requiresExact = exactAmount !== undefined && exactAmount > AMOUNT_EPSILON;
  return advances
    .filter((a) => !isAdvanceExhausted(a, applications))
    .map((a) => {
      const balance = advanceBalance(a, applications);
      const eligible = !requiresExact || Math.abs(balance - exactAmount!) < AMOUNT_EPSILON;
      return {
        advance: a,
        balance,
        eligible,
        ineligibleReason: eligible
          ? null
          : `Balance ${balance.toFixed(2)} does not match the shortage amount ${exactAmount!.toFixed(2)} — cannot select.`,
      };
    });
}
