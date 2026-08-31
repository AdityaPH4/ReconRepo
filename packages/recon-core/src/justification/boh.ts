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
import type { OutletCode, PRRow } from '../types.js';
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

export interface AutoStagedBohRow {
  orderNo: string;
  custName: string;
  amount: number;
  bohDate: string;
}

/**
 * Every bills-on-hold PR row that isn't already a known repository entry
 * (open or cleared, from any prior session) gets staged automatically —
 * legacy's `runReconciliation` (1263–1284) does this unconditionally on
 * every recon run, with no customer-name requirement (`custName` falls back
 * to `''`, unlike the port's manual "+ Add to repository" flow, which
 * requires one). `bohDate` is the current session's business date, matching
 * the manual-add flow's own convention — legacy's `r.date` is a PR row's raw
 * timestamp string, not the ISO date `BohEntry.bohDate` expects.
 */
export function autoStageBohRows(
  bills: readonly PRRow[],
  existingOrderNos: ReadonlySet<string>,
  businessDate: string | null,
): AutoStagedBohRow[] {
  return bills
    .filter((b) => !existingOrderNos.has(b.orderNo))
    .map((b) => ({
      orderNo: b.orderNo,
      custName: b.customer || '',
      amount: Number.isNaN(b.amount) ? 0 : b.amount,
      bohDate: businessDate ?? '',
    }));
}
