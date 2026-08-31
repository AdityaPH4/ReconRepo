/**
 * Domain types for the justification & submit layer.
 * Ported from `reconciliation (68).html` lines 1930–5777 — the operator-input
 * half of the app (remarks, square-off, advances, bills-on-hold, submit).
 *
 * Legacy split this into five parallel shapes: a bare `S.actions[rmkKey]`
 * string plus three side-dictionaries (`shortCollections`, `eprDetails`,
 * `otherDetails`) for Pinelabs/HDFC-UPI row remarks, and three separate entry
 * arrays (`cashEntries`, `upiEntries`, `bankEntries`) for the aggregate tabs.
 * The fields those five shapes capture are identical, so the port unifies
 * them into one `JustificationEntry` — see README "Deliberate changes".
 */

import type { BOH_SOURCES, Remark } from '../constants.js';
import type { OutletCode } from '../types.js';

/**
 * Which panel a justification entry belongs to.
 *
 * `'boh'` is a sixth, non-contributing pseudo-source: a Bills-on-Hold
 * clearance triggered from the Bills-on-Hold tab directly (not from a
 * Pinelabs/HDFC-UPI row or the Cash/UPI/Bank tabs) has no diff to offset —
 * legacy never touches `S.actions` or an entry array for that path, so it
 * has zero effect on any residual. The port still records a
 * `JustificationEntry` for it (so cascade-undo has one uniform shape), but
 * `collectExplained` explicitly excludes `'boh'` — see `residual.ts`.
 */
export type JustificationSource = 'pinelabs' | 'upi_hdfc' | 'cash' | 'upi' | 'bank' | 'boh';

export type Direction = 'excess' | 'shortage';

/**
 * One justification, whether it explains a specific transaction-level row
 * (Pinelabs / HDFC-UPI — `targetKey` set) or stands alone on an aggregate tab
 * (Cash / UPI / Bank — `targetKey` null).
 *
 * `amount` is always populated: for a row-level entry it mirrors the row's
 * own `|diff|` at the moment the entry was created (legacy never stored this
 * for row-level remarks and instead re-derived it by re-joining `S.actions`
 * against the live recon rows every time — denormalising it here means the
 * residual calculation never needs that join).
 */
export interface JustificationEntry {
  id: string;
  source: JustificationSource;
  /** Row key (`globalId`'s stable counterpart) for row-level entries; `null` for aggregate-tab entries. */
  targetKey: string | null;
  direction: Direction;
  remark: Remark;
  amount: number;
  description: string | null;
  /** UPI aggregate entries only; required unless the remark is one of `NO_RRN_REMARKS`. */
  rrn: string | null;
  /** Cash "Paid In"/"Paid Out" and Extra Payment Received. */
  billNo: string | null;
  /** Cash "Paid In"/"Paid Out" only. */
  reason: string | null;
  /** Short Collection only. */
  staffName: string | null;
  /** Short Collection only. */
  empId: string | null;
  /** Extra Payment Received only. */
  clientName: string | null;
  /** "Other" only. */
  comment: string | null;
  notes: string | null;
  /** Set when this entry's remark is "Advance Received" — the advance it created. */
  createdAdvanceId: string | null;
  /** Set when this entry's remark is "Advance Applied" — the application it created. */
  appliedApplicationId: string | null;
  /** Set when this entry's remark is "Bill on Hold Cleared" — the clearance it created. */
  bohClearanceId: string | null;
  createdAt: string;
}

/** A symmetric pairing of two resolvable items whose diffs net to ~0. Legacy: `S.squareOff`. */
export interface SquareOffMap {
  [globalId: string]: string[];
}

// ── Advances repository — outlet-scoped (see README/plan: legacy had no
// outlet field at all; the port fixes that) ─────────────────────────────────

export interface Advance {
  id: string;
  outlet: OutletCode;
  custName: string;
  phone: string | null;
  /** ISO `yyyy-mm-dd`; must be strictly after the business date it was recorded on. */
  eventDate: string;
  notes: string | null;
  originalAmount: number;
  /** ISO `yyyy-mm-dd`. */
  recordedDate: string;
  recordedBySessionId: string;
}

export interface AdvanceApplication {
  id: string;
  advanceId: string;
  sessionId: string;
  /** The row/entry this application discharges. `null` for a freestanding aggregate-tab apply. */
  targetKey: string | null;
  amount: number;
  /** ISO `yyyy-mm-dd`. */
  appliedDate: string;
}

// ── Bills-on-hold repository — outlet-scoped ────────────────────────────────

export interface BohEntry {
  id: string;
  outlet: OutletCode;
  orderNo: string;
  custName: string;
  phone: string | null;
  amount: number;
  /** ISO `yyyy-mm-dd` — the business date of the original PR row. */
  bohDate: string;
  notes: string | null;
  /** ISO `yyyy-mm-dd`. */
  recordedDate: string;
  /**
   * Durable clearance state — the port's fix for a real legacy defect: the
   * legacy repo never wrote clearance back to the row, so a cleared bill
   * would resurface as clearable forever once the repo genuinely persists.
   */
  status: 'open' | 'cleared';
  clearedAt: string | null;
  clearedBySessionId: string | null;
}

export type BohSource = (typeof BOH_SOURCES)[number] | (string & {});

export interface BohClearance {
  id: string;
  bohEntryId: string;
  sessionId: string;
  targetKey: string | null;
  source: BohSource;
  /** Clearing is always full — legacy hard-codes this; no partial-clear path exists. */
  amount: number;
  clearedDate: string;
}

/** A new BOH repository row proposed from the Bills-on-Hold tab, pending commit at submit. */
export interface BohStagingEntry {
  id: string;
  orderNo: string;
  custName: string;
  phone: string | null;
  amount: number;
  bohDate: string;
  notes: string | null;
}

// ── The draft session state ─────────────────────────────────────────────────

/**
 * Everything a human adds on top of a `ReconResult`, held on the draft
 * session until submit.
 *
 * Advances/BOH mutations recorded during a draft session live only here —
 * `draftAdvances`/`draftApplications`/`bohStaging`/`draftBohClearances` — and
 * are never written to the cross-session repositories until submit succeeds.
 * An abandoned draft simply never wrote anything, so there is nothing to roll
 * back (see README/plan: this replaces legacy's clone-based baseline/rollback
 * with plain non-persistence).
 */
export interface JustificationState {
  entries: JustificationEntry[];
  squareOff: SquareOffMap;
  draftAdvances: Advance[];
  draftApplications: AdvanceApplication[];
  bohStaging: BohStagingEntry[];
  draftBohClearances: BohClearance[];
}

export function emptyJustificationState(): JustificationState {
  return {
    entries: [],
    squareOff: {},
    draftAdvances: [],
    draftApplications: [],
    bohStaging: [],
    draftBohClearances: [],
  };
}

// ── Resolvable items — the shared shape `completeness.ts`/`residual.ts` walk ─

/**
 * One transaction-level row that needs either a remark or a square-off
 * partner before a session can submit. Built fresh from the `ReconResult` by
 * `buildPinelabsItems`/`buildHdfcUpiItems` — never stored — so the UI and the
 * submit gate always key against the same `targetKey`/`globalId` scheme.
 */
export interface ResolvableItem {
  /** Legacy scheme: `POS-N`/`PL-N`/`MM-N`/`DUP-N`/`ADP-N`/`ADPL-N` (Pinelabs), `UPOS-N`/`USTMT-N`/`UMM-N`/`UDUP-N` (HDFC-UPI). */
  globalId: string;
  targetKey: string;
  /** Positive = excess (terminal/statement side has more), negative = shortage. */
  diff: number;
  /**
   * The category legacy's `collectExplainedForSubmit` (5000–5069) labels this
   * row with in the "Explanation of Variances" report/snapshot — e.g. `'Only
   * in POS'`, `'HDFC UPI — Amount mismatch'`. Distinct from the internal
   * `globalId`/`targetKey` scheme, which is never shown to a user.
   */
  label: string;
  /** Order number(s), comma-joined — blank where legacy's own row has none. */
  orderNo: string;
  /** RRN, when the row has one. */
  rrn: string;
  /**
   * Whether a remarked instance of this item becomes a row in the
   * "Explanation of Variances" list. `false` only for Pinelabs' own `dupRRN`
   * bucket — legacy's `collectExplainedForSubmit` has no `forEach` over
   * `pinelabs.dupRRN` at all, so a remarked one there is invisible in the
   * report even though it satisfies the submit gate. HDFC-UPI's own `dupRRN`
   * bucket, in contrast, *is* explicitly listed there (with `diff: 0`) — see
   * `buildHdfcUpiItems`.
   */
  appearsInExplanation: boolean;
  /**
   * Whether an unresolved instance of this item blocks the submit gate.
   * Pinelabs' `dupRRN` bucket is checked by legacy's `plUnresolvedItems` (it
   * blocks submission until remarked) but HDFC-UPI's own `dupRRN`/`udup`
   * bucket is never in `getHdfcCompleteness`'s item list (2249–2273) at
   * all — legacy lets the operator attach a remark to it for their own
   * bookkeeping, but never gates on it. Defaults to `true`; only HDFC-UPI's
   * `dupRRN` items set this `false`.
   */
  countsTowardGate: boolean;
}
