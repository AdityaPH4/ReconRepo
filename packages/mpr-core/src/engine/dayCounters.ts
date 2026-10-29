/**
 * Per-day progress counters: how many POS transactions a day has (from the
 * day's saved JSON) and which of them MPR has cleared so far.
 *
 * A counter is not a bare number — it is the *set* of cleared transactions
 * (`ClearedRow`), so applying the same run twice, or a bank resending a file,
 * can never count a transaction twice. Open = total − cleared.
 *
 * Pure: no I/O. The API feeds it a run's result (or a pooled day view) and
 * stores what comes back.
 */

import { bankFamily } from '../util/bankFamily.js';

export const COUNTER_BANKS = ['amex', 'kotak', 'pinelabs', 'hdfc_upi', 'hdfc_dynamic', 'hdfc_link', 'hdfc_static'] as const;
export type CounterBank = (typeof COUNTER_BANKS)[number];

/** `mismatch` is not cleared (the amount differs and a human must look); `resolved` is an admin's close-with-note. */
export type ClearState = 'settled' | 'resolved' | 'mismatch';

export interface ClearedRow {
  businessDate: string;
  outlet: string;
  bank: CounterBank;
  /** Identifies one transaction within its outlet-day-bank. */
  key: string;
  state: ClearState;
  /** The Layer-1 session this transaction belongs to — a re-submitted day gets a new session, which wipes the old session's cleared rows. */
  sessionId: string;
}

export type DayTotals = Record<CounterBank, number>;

export const emptyTotals = (): DayTotals => Object.fromEntries(COUNTER_BANKS.map((b) => [b, 0])) as DayTotals;

/** Cleared means settled by the bank or resolved by an admin; a mismatch is still open. */
export const isCleared = (s: ClearState): boolean => s === 'settled' || s === 'resolved';

/** Higher wins when the same transaction is reported in several states across runs. */
export const STATE_RANK: Record<ClearState, number> = { mismatch: 1, resolved: 2, settled: 3 };

interface Closure {
  status: string;
}
type LedgerRowLike = Closure & {
  outlet?: string;
  _businessDate: string;
  _sourceSessionId?: string | null;
  acquirer?: string;
  rrn: string;
  posOrderNo?: string;
  plAmount: number;
  plDate?: string;
};
type AmexRowLike = Closure & {
  _match: string;
  outlet: string;
  _businessDate?: string;
  _sourceSessionId?: string | null;
  date: string | null;
  cardLast4: string;
  l1Amount: number | null;
};
type UpiRowLike = Closure & {
  _match: string;
  _businessDate?: string;
  _sourceSessionId?: string | null;
  pr: unknown;
};

/** Structural view of a match result — satisfied by both a run's stored result and a pooled day view. */
export interface DayResultLike {
  settled: LedgerRowLike[];
  amountMismatch: LedgerRowLike[];
  pending: LedgerRowLike[];
  amexResults: AmexRowLike[];
  upiResults: UpiRowLike[];
}

/** What the saved snapshot holds, per bank: ledger rows by acquirer, plus distinct HDFC Static UPI order numbers. */
export function dayTotalsFromSnapshot(snapshot: unknown): DayTotals {
  const totals = emptyTotals();
  const snap = snapshot as {
    settlementLedger?: Array<{ acquirer?: string }>;
    upi?: { transactions?: Array<{ source?: string; orderNo?: string }> };
  } | null;
  for (const r of snap?.settlementLedger ?? []) totals[bankFamily(r.acquirer)]++;
  totals.hdfc_static = new Set((snap?.upi?.transactions ?? []).filter((t) => t.source === 'HDFC').map((t) => t.orderNo)).size;
  return totals;
}

function realOrders(pr: unknown): string[] {
  const entries = Array.isArray(pr) ? pr : [pr];
  const orders = new Set<string>();
  for (const p of entries) {
    const t = p as { source?: string; orderNo?: string } | null;
    if (t?.source === 'HDFC' && t.orderNo) orders.add(t.orderNo);
  }
  return [...orders];
}

/**
 * Every transaction in `result` that is cleared (settled or resolved) or
 * mismatched, as `ClearedRow`s. Rows that are simply still open are not
 * returned — "open" is what's left of the day's total.
 *
 * `outletOfSession` supplies the outlet for Static UPI rows, which carry none
 * of their own. Rows without a source session (a manual upload) are skipped:
 * there's no snapshot behind them to count against.
 *
 * Identical ledger rows (same RRN, order, amount and time) get an occurrence
 * suffix so each counts once; it's numbered per state within one result.
 */
export function clearedRowsFromResult(result: DayResultLike, outletOfSession: (sessionId: string) => string | undefined): ClearedRow[] {
  const out: ClearedRow[] = [];
  const seen = new Map<string, number>();
  const occurrence = (scope: string) => {
    const n = (seen.get(scope) ?? 0) + 1;
    seen.set(scope, n);
    return n;
  };
  const byKey = new Map<string, ClearedRow>();
  const push = (sessionId: string, outlet: string, businessDate: string, bank: CounterBank, base: string, state: ClearState, numbered: boolean) => {
    if (!numbered) {
      // An order can sit in more than one row (a split payment) but is one transaction: keep it once, at its best state.
      const k = `${outlet}|${businessDate}|${bank}|${base}`;
      const existing = byKey.get(k);
      if (existing) {
        if (STATE_RANK[state] > STATE_RANK[existing.state]) existing.state = state;
        return;
      }
      const row: ClearedRow = { businessDate, outlet, bank, key: base, state, sessionId };
      byKey.set(k, row);
      out.push(row);
      return;
    }
    out.push({ businessDate, outlet, bank, key: `${base}#${occurrence(`${outlet}|${businessDate}|${bank}|${state}|${base}`)}`, state, sessionId });
  };

  for (const tag of ['settled', 'amountMismatch', 'pending'] as const) {
    for (const r of result[tag]) {
      if (!r._sourceSessionId || !r.outlet) continue;
      const state: ClearState | null = tag === 'settled' ? 'settled' : r.status === 'closed' ? 'resolved' : tag === 'amountMismatch' ? 'mismatch' : null;
      if (!state) continue;
      push(r._sourceSessionId, r.outlet, r._businessDate, bankFamily(r.acquirer), `${r.rrn}|${r.posOrderNo ?? ''}|${r.plAmount}|${r.plDate ?? ''}`, state, true);
    }
  }

  for (const r of result.amexResults) {
    if (!r._sourceSessionId || !r._businessDate || !r.outlet) continue; // a bank-only (unexpected) row has no ledger side
    const state: ClearState | null =
      r._match === 'settled' ? 'settled' : r.status === 'closed' ? 'resolved' : r._match === 'mismatch' ? 'mismatch' : null;
    if (!state) continue;
    push(r._sourceSessionId, r.outlet, r._businessDate, 'amex', `${r.date}|${r.cardLast4}|${r.l1Amount}`, state, true);
  }

  for (const r of result.upiResults) {
    if (!r._sourceSessionId || !r._businessDate) continue;
    const outlet = outletOfSession(r._sourceSessionId);
    if (!outlet) continue;
    const state: ClearState | null =
      r._match === 'settled' ? 'settled' : r.status === 'closed' ? 'resolved' : r._match === 'mismatch' || r._match === 'partial' ? 'mismatch' : null;
    if (!state) continue;
    for (const orderNo of realOrders(r.pr)) push(r._sourceSessionId, outlet, r._businessDate, 'hdfc_static', orderNo, state, false);
  }
  return out;
}

export interface BankCounter {
  total: number;
  settled: number;
  resolved: number;
  mismatch: number;
}
export const emptyCounter = (): BankCounter => ({ total: 0, settled: 0, resolved: 0, mismatch: 0 });
/** Cleared / open for one bank's counter. */
export const clearedOf = (c: BankCounter): number => c.settled + c.resolved;
export const openOf = (c: BankCounter): number => Math.max(0, c.total - clearedOf(c));
