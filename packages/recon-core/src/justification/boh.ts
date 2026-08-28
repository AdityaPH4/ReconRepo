/**
 * Bills-on-hold repository — eligibility for clearing.
 * Ported from `reconciliation (68).html` lines 4331–4441 (`openBohClearModal`
 * and its filtering), 4622 (same-day exclusion).
 *
 * Outlet-scoped (unlike legacy advances, which had no scoping at all — see
 * `advances.ts`). Same-business-day entries are hidden by default — a bill
 * "rarely clears same day" — with an explicit opt-in to show them. An exact
 * amount match is required only when the modal was opened from a recon row
 * that already carries a known excess amount; opened from the Bills-on-Hold
 * tab directly, any open entry is selectable.
 */

import { AMOUNT_EPSILON } from '../constants.js';
import type { OutletCode } from '../types.js';
import type { BohEntry } from './types.js';

export interface EligibleBohEntry {
  entry: BohEntry;
  eligible: boolean;
  ineligibleReason: string | null;
}

export interface EligibleBohOptions {
  outlet: OutletCode;
  /** ISO `yyyy-mm-dd` business date of the current session, or `null` if unknown. */
  businessDate: string | null;
  /** Reveals same-business-day entries. Defaults to hidden, matching legacy. */
  includeToday?: boolean;
  /** The excess amount already known from the originating row, if any. */
  exactAmount?: number;
}

export function eligibleBohEntries(
  entries: readonly BohEntry[],
  opts: EligibleBohOptions,
): EligibleBohEntry[] {
  const { outlet, businessDate, includeToday = false, exactAmount } = opts;
  const requiresExact = exactAmount !== undefined && exactAmount > AMOUNT_EPSILON;

  return entries
    .filter((b) => b.outlet === outlet && b.status === 'open')
    .filter((b) => includeToday || !businessDate || b.bohDate !== businessDate)
    .map((b) => {
      const eligible = !requiresExact || Math.abs(b.amount - exactAmount!) < AMOUNT_EPSILON;
      return {
        entry: b,
        eligible,
        ineligibleReason: eligible
          ? null
          : `Amount ${b.amount.toFixed(2)} does not match ${exactAmount!.toFixed(2)} — cannot select.`,
      };
    });
}
