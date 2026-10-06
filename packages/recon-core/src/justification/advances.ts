/**
 * Advance repository — balance and eligibility.
 * Ported from `reconciliation (68).html` lines 3963–4183 (`advBalance`,
 * `advExhausted`, `renderAdvList`, `confirmAdvanceApplied`), since extended
 * for multi-advance apply (a shortage is often the sum of *several*
 * advances — e.g. ₹2,000 and ₹4,000 received separately toward one
 * ₹6,000 gap, neither of which matches it alone).
 *
 * Matching/lookup is deliberately manual, not automated: there is no date or
 * outlet-of-origin heuristic pairing an advance to a shortage. Every open,
 * non-exhausted advance is always selectable — the exact-match constraint
 * that used to gate a *single* advance's own eligibility now applies to the
 * *sum* of whichever advances the operator picks, enforced by the caller
 * (the modal's own running total client-side; `applyAdvance()`'s existing
 * square-off-group check server-side, unchanged in shape, just fed a sum
 * instead of one advance's balance). Applying always consumes each selected
 * advance's full remaining balance — there is no partial-apply path in
 * legacy, and the port preserves that.
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
}

/** A durable closure independent of balance — see `Advance.status`. */
export function isAdvanceClosed(advance: Advance): boolean {
  return advance.status === 'closed';
}

/** Every open, non-exhausted advance for an outlet — all universally selectable; see this module's own doc comment for why there is no longer a per-advance amount gate here. */
export function eligibleAdvances(
  advances: readonly Advance[],
  applications: readonly AdvanceApplication[],
): EligibleAdvance[] {
  return advances
    // Written as `status !== 'closed'`, not `=== 'open'` — defensive
    // against a pre-existing row whose stored JSON predates this field and
    // so deserializes with `status: undefined`.
    .filter((a) => a.status !== 'closed' && !isAdvanceExhausted(a, applications))
    .map((a) => ({ advance: a, balance: advanceBalance(a, applications) }));
}
