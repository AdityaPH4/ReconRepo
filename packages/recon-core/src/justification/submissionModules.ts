/**
 * Partial submission — "settling" one payment-method module at a time
 * instead of the whole session at once.
 *
 * A module is exactly a KPI tile, except Swiggy/Zomato (`assumedReconciled`
 * — POS-integrated, never blocks submission, so there's nothing for a GM to
 * ever "settle" there). "Advances" and "Bills on Hold" are cross-cutting:
 * an advance/BOH-clearance entry's own `source` is whichever tab recorded
 * it (e.g. `'cash'`), not a dedicated module of its own — `moduleForEntry()`
 * below checks the entry's `remark` first for exactly this reason, before
 * falling back to its `source`.
 */

import type { JustificationEntry, JustificationSource } from './types.js';

export const SUBMISSION_MODULES = [
  'pinelabs',
  'cash',
  'upi',
  'bank',
  'hdfc_link',
  'bills',
  'advances',
] as const;

export type SubmissionModule = (typeof SUBMISSION_MODULES)[number];

export const SUBMISSION_MODULE_LABELS: Record<SubmissionModule, string> = {
  pinelabs: 'Pinelabs',
  cash: 'Cash',
  upi: 'HDFC / Kotak UPI',
  bank: 'Bank Transfer',
  hdfc_link: 'HDFC Link',
  bills: 'Bills on Hold',
  advances: 'Advances',
};

const SOURCE_MODULE: Partial<Record<JustificationSource, SubmissionModule>> = {
  pinelabs: 'pinelabs',
  upi_hdfc: 'upi',
  cash: 'cash',
  upi: 'upi',
  bank: 'bank',
  hdfc_link: 'hdfc_link',
  hdfc_link_stmt: 'hdfc_link',
  boh: 'bills',
};

/**
 * Which module a (possibly not-yet-created) entry belongs to, for lock
 * enforcement and per-module status. Checked by `remark` first — "Advance
 * Received"/"Advance Applied"/"Bill on Hold Cleared" always belong to their
 * own cross-cutting module regardless of which tab recorded them — then
 * falls back to the source→module map above. `null` only for `'boh'`'s own
 * non-contributing pseudo-entries when the remark itself is something
 * else (shouldn't happen in practice — `'boh'` only ever carries "Bill on
 * Hold Cleared" — but typed honestly rather than asserted).
 */
export function moduleForEntry(entry: Pick<JustificationEntry, 'source' | 'remark'>): SubmissionModule | null {
  if (entry.remark === 'Advance Received' || entry.remark === 'Advance Applied') return 'advances';
  if (entry.remark === 'Bill on Hold Cleared') return 'bills';
  return SOURCE_MODULE[entry.source] ?? null;
}
