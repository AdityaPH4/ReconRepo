/**
 * Justification & submit orchestration — the server-side equivalent of the
 * legacy per-remark handlers (`handleRmkChange`, `saveAdvanceReceived`,
 * `confirmAdvanceApplied`, `confirmBohClear`, `initiateSubmit`, …) and their
 * cascading-undo counterparts (`removeAdvanceForKey`,
 * `undoAdvanceApplications`, `undoBohClearForKey`).
 *
 * Everything here operates on a session's own `JustificationState` — draft
 * advance/BOH mutations never touch the cross-session stores until
 * `commitSubmit()` runs. See the plan's "draft-until-submit by
 * non-persistence" decision.
 */

import { randomUUID } from 'node:crypto';
import type {
  AddBohStagingRequest,
  AddJustificationEntryRequest,
  ApplyAdvanceRequest,
  ClearBohRequest,
  ExplainedItemDTO,
  RecordAdvanceRequest,
  SessionDTO,
  SubmitGateDTO,
} from '@toit/contracts';
import {
  NO_RRN_REMARKS,
  advanceBalance,
  canSubmit,
  isAdvanceExhausted,
  toggleSquareOff as coreToggleSquareOff,
  type Advance,
  type AdvanceApplication,
  type BohClearance,
  type BohEntry,
  type BohStagingEntry,
  type JustificationEntry,
  type JustificationState,
  type PinelabsResult,
  type MatchResult,
  type HdfcStatementRow,
} from '@toit/recon-core';

export class JustificationError extends Error {
  readonly status = 400;
}

function newEntry(base: Partial<JustificationEntry> & Pick<JustificationEntry, 'source' | 'direction' | 'remark' | 'amount'>): JustificationEntry {
  return {
    id: randomUUID(),
    targetKey: null,
    description: null,
    rrn: null,
    billNo: null,
    reason: null,
    staffName: null,
    empId: null,
    clientName: null,
    comment: null,
    notes: null,
    createdAdvanceId: null,
    appliedApplicationId: null,
    bohClearanceId: null,
    createdAt: new Date().toISOString(),
    ...base,
  };
}

// ── Plain entries (no repository interaction) ─────────────────────────────

export function addEntry(state: JustificationState, req: AddJustificationEntryRequest): JustificationState {
  // Every UPI-tab remark except `NO_RRN_REMARKS` needs a real, identifiable
  // 12-digit RRN, re-validated server-side — legacy: `addUpiEntry`
  // (reconciliation (68).html:2725-2761).
  if (req.source === 'upi' && !NO_RRN_REMARKS.includes(req.remark as never)) {
    if (!req.rrn || !/^\d{12}$/.test(req.rrn)) {
      throw new JustificationError('A 12-digit RRN is required for this remark.');
    }
    if (state.entries.some((e) => e.source === 'upi' && e.rrn === req.rrn)) {
      throw new JustificationError('This RRN has already been used elsewhere in this session.');
    }
  }

  const entry = newEntry({
    source: req.source,
    direction: req.direction,
    remark: req.remark,
    amount: req.amount,
    targetKey: req.targetKey ?? null,
    description: req.description ?? null,
    rrn: req.rrn ?? null,
    billNo: req.billNo ?? null,
    reason: req.reason ?? null,
    staffName: req.staffName ?? null,
    empId: req.empId ?? null,
    clientName: req.clientName ?? null,
    comment: req.comment ?? null,
    notes: req.notes ?? null,
  });
  return { ...state, entries: [...state.entries, entry] };
}

/**
 * Removes one entry, cascading exactly as legacy's `handleRmkChange`/
 * `removeCashEntry` do: an advance this entry created is deleted (and any
 * applications drawn from it, transitively — see `removeAppliedEntriesForAdvance`);
 * an application this entry made is undone (restoring the advance's balance,
 * which is derived, not stored); a BOH clearance this entry made is undone.
 */
export function removeEntry(state: JustificationState, entryId: string): JustificationState {
  const entry = state.entries.find((e) => e.id === entryId);
  if (!entry) return state;

  let next: JustificationState = { ...state, entries: state.entries.filter((e) => e.id !== entryId) };

  if (entry.createdAdvanceId) {
    next = removeAdvance(next, entry.createdAdvanceId);
  }
  if (entry.appliedApplicationId) {
    next = removeApplication(next, entry.appliedApplicationId);
  }
  if (entry.bohClearanceId) {
    next = removeBohClearance(next, entry.bohClearanceId);
  }
  return next;
}

function removeAdvance(state: JustificationState, advanceId: string): JustificationState {
  // Cascade: any application drawn from this advance is orphaned money and
  // must go too, along with the entry that recorded it.
  const orphanedApplicationIds = new Set(
    state.draftApplications.filter((a) => a.advanceId === advanceId).map((a) => a.id),
  );
  let entries = state.entries.filter((e) => e.createdAdvanceId !== advanceId);
  entries = entries.filter((e) => !(e.appliedApplicationId && orphanedApplicationIds.has(e.appliedApplicationId)));
  return {
    ...state,
    entries,
    draftAdvances: state.draftAdvances.filter((a) => a.id !== advanceId),
    draftApplications: state.draftApplications.filter((a) => !orphanedApplicationIds.has(a.id)),
  };
}

function removeApplication(state: JustificationState, applicationId: string): JustificationState {
  return {
    ...state,
    draftApplications: state.draftApplications.filter((a) => a.id !== applicationId),
  };
}

function removeBohClearance(state: JustificationState, clearanceId: string): JustificationState {
  return {
    ...state,
    draftBohClearances: state.draftBohClearances.filter((c) => c.id !== clearanceId),
  };
}

// ── Square-off ─────────────────────────────────────────────────────────────

export function setSquareOff(state: JustificationState, a: string, b: string, on: boolean): JustificationState {
  return { ...state, squareOff: coreToggleSquareOff(state.squareOff, a, b, on) };
}

// ── Advances ────────────────────────────────────────────────────────────────

export function recordAdvance(
  state: JustificationState,
  req: RecordAdvanceRequest,
  ctx: { sessionId: string; outlet: Advance['outlet']; businessDate: string | null },
): JustificationState {
  if (!req.custName.trim()) throw new JustificationError('Customer name is required.');
  if (!req.eventDate) throw new JustificationError('Event date is required.');
  if (ctx.businessDate) {
    const minDate = addDays(ctx.businessDate, 1);
    if (req.eventDate < minDate) {
      throw new JustificationError(`Event date must be on or after ${minDate}.`);
    }
  }
  // The UPI tab requires a real, identifiable-transaction RRN for this
  // remark — legacy: `addUpiEntry` (reconciliation (68).html:2725-2761).
  // Re-validated server-side, not just trusted from the client.
  if (req.source === 'upi') {
    if (!req.rrn || !/^\d{12}$/.test(req.rrn)) {
      throw new JustificationError('A 12-digit RRN is required for this remark.');
    }
    if (state.entries.some((e) => e.source === 'upi' && e.rrn === req.rrn)) {
      throw new JustificationError('This RRN has already been used elsewhere in this session.');
    }
  }

  const advance: Advance = {
    id: randomUUID(),
    outlet: ctx.outlet,
    custName: req.custName.trim(),
    phone: req.phone?.trim() || null,
    eventDate: req.eventDate,
    notes: req.notes?.trim() || null,
    originalAmount: req.amount,
    recordedDate: new Date().toISOString().slice(0, 10),
    recordedBySessionId: ctx.sessionId,
  };

  const entry = newEntry({
    source: req.source,
    direction: 'excess',
    remark: 'Advance Received',
    amount: req.amount,
    targetKey: req.targetKey ?? null,
    createdAdvanceId: advance.id,
    rrn: req.source === 'upi' ? req.rrn! : null,
  });

  return {
    ...state,
    entries: [...state.entries, entry],
    draftAdvances: [...state.draftAdvances, advance],
  };
}

export interface AdvanceContext {
  /** Committed repository rows for this outlet, plus this session's own drafts. */
  advances: readonly Advance[];
  /** Committed applications for this outlet, plus this session's own drafts. */
  applications: readonly AdvanceApplication[];
}

export function applyAdvance(
  state: JustificationState,
  req: ApplyAdvanceRequest,
  ctx: { sessionId: string } & AdvanceContext,
): JustificationState {
  const advance = ctx.advances.find((a) => a.id === req.advanceId);
  if (!advance) throw new JustificationError('Advance not found.');
  const balance = advanceBalance(advance, ctx.applications);
  if (isAdvanceExhausted(advance, ctx.applications)) {
    throw new JustificationError('This advance has no remaining balance.');
  }

  const application: AdvanceApplication = {
    id: randomUUID(),
    advanceId: advance.id,
    sessionId: ctx.sessionId,
    targetKey: req.targetKey ?? null,
    // Applying an advance always consumes its full remaining balance —
    // legacy has no partial-apply path (`applyAmt = bal`, unconditionally).
    amount: balance,
    appliedDate: new Date().toISOString().slice(0, 10),
  };

  const entry = newEntry({
    source: req.source,
    direction: 'shortage',
    remark: 'Advance Applied',
    amount: balance,
    targetKey: req.targetKey ?? null,
    appliedApplicationId: application.id,
  });

  return {
    ...state,
    entries: [...state.entries, entry],
    draftApplications: [...state.draftApplications, application],
  };
}

// ── Bills on hold ──────────────────────────────────────────────────────────

export function addBohStaging(state: JustificationState, req: AddBohStagingRequest): JustificationState {
  if (!req.orderNo.trim()) throw new JustificationError('Order number is required.');
  if (!req.custName.trim()) throw new JustificationError('Customer name is required.');
  const staged: BohStagingEntry = {
    id: randomUUID(),
    orderNo: req.orderNo.trim(),
    custName: req.custName.trim(),
    phone: req.phone?.trim() || null,
    amount: req.amount,
    bohDate: req.bohDate,
    notes: req.notes?.trim() || null,
  };
  return { ...state, bohStaging: [...state.bohStaging, staged] };
}

export function removeBohStaging(state: JustificationState, id: string): JustificationState {
  return { ...state, bohStaging: state.bohStaging.filter((b) => b.id !== id) };
}

export function clearBoh(
  state: JustificationState,
  req: ClearBohRequest,
  ctx: { sessionId: string; entries: readonly BohEntry[]; staging: readonly BohStagingEntry[] },
): JustificationState {
  const entry = ctx.entries.find((b) => b.id === req.bohEntryId);
  const staged = ctx.staging.find((b) => b.id === req.bohEntryId);
  if (!entry && !staged) throw new JustificationError('Bills-on-hold entry not found.');
  if (entry && entry.status !== 'open') throw new JustificationError('This entry is already cleared.');

  const bill = entry ?? staged!;
  const amount = bill.amount;
  const clearance: BohClearance = {
    id: randomUUID(),
    bohEntryId: req.bohEntryId,
    sessionId: ctx.sessionId,
    targetKey: req.targetKey ?? null,
    source: req.clearSource,
    // Clearing is always full — legacy hard-codes this; no partial-clear path.
    amount,
    clearedDate: new Date().toISOString().slice(0, 10),
    orderNo: bill.orderNo,
    custName: bill.custName,
    bohDate: bill.bohDate,
  };

  const justificationEntry = newEntry({
    source: req.source,
    direction: 'excess',
    remark: 'Bill on Hold Cleared',
    amount,
    targetKey: req.targetKey ?? null,
    bohClearanceId: clearance.id,
  });

  return {
    ...state,
    entries: [...state.entries, justificationEntry],
    draftBohClearances: [...state.draftBohClearances, clearance],
  };
}

// ── Submit gate ──────────────────────────────────────────────────────────

export function computeSubmitGate(session: SessionDTO): SubmitGateDTO {
  const pinelabs = session.result.pinelabs as unknown as PinelabsResult;
  const upiHdfc = session.result.upiHdfc as unknown as MatchResult<HdfcStatementRow> | null;

  return canSubmit({
    pinelabs,
    upiHdfc,
    justification: session.justification,
    grandDiff: session.frs.grandDiff,
    hasSummary: session.summaryData !== null,
    cashDiff: session.totals.cash.diff ?? 0,
    bankDiff: session.totals.bank.diff ?? 0,
    hdfcAggregateDiff: session.totals.hdfcUpi.diff ?? 0,
    kotakDiff: session.totals.kotakUpi.diff ?? 0,
    // A draft session's own "Advance Applied" entries always point at a
    // draft application recorded in the same request that created them (see
    // `applyAdvance` above) — nothing committed is relevant to the orphan
    // check until submit, at which point the session is locked anyway.
    applications: session.justification.draftApplications,
  });
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── FRS "Explanation of Excess/Shortage" — the rich, display-only view ────
//
// Ported from legacy's `collectExplained` (reconciliation (68).html
// 3570–3646), which is richer than recon-core's `collectExplained` (label,
// order no, RRN, both-side amounts) — that one exists purely to compute the
// residual number, this one is for showing the operator *why*. Unlike
// legacy, this also walks HDFC-UPI transaction-level entries, matching the
// same canonical-everywhere principle the submit gate already follows — see
// the plan's "one canonical completeness/residual calculation" decision.

function targetKeyForPinelabs(bucket: 'onlyPOS' | 'onlyTerm' | 'mismatch', x: Record<string, unknown>): string {
  if (bucket === 'onlyPOS') {
    const orders = x.orders as string[] | undefined;
    return `pos-${orders?.[0] || (x.orderNo as string) || ''}-${(x.rrn as string) || ''}`;
  }
  if (bucket === 'onlyTerm') return `term-${x.rrn as string}-${x.date as string}`;
  return x.rrn as string;
}

function targetKeyForUpiHdfc(bucket: 'onlyPOS' | 'onlyTerm' | 'mismatch', x: Record<string, unknown>): string {
  if (bucket === 'onlyPOS') {
    const orders = x.orders as string[] | undefined;
    return `upos-${orders?.[0] || (x.orderNo as string) || ''}-${(x.rrn as string) || ''}`;
  }
  if (bucket === 'onlyTerm') return `ustmt-${x.rrn as string}-${x.date as string}`;
  return `umm-${x.rrn as string}`;
}

export function buildExplanationItems(session: SessionDTO): ExplainedItemDTO[] {
  const result = session.result as unknown as {
    pinelabs: {
      onlyPOS: Array<Record<string, unknown>>;
      onlyTerm: Array<Record<string, unknown>>;
      reconRows: Array<{ rrn: string; diff: number; squaredOff: boolean; plAmt: number; prAmt: number; orders?: string[]; pr?: { orderNo?: string; paymentName?: string } }>;
      amexDup: Array<{ pr: { orderNo: string; amount: number } }>;
      amexDupTerm: Array<{ amount: number; rrn?: string }>;
    };
    upiHdfc: {
      onlyPOS: Array<Record<string, unknown>>;
      onlyTerm: Array<Record<string, unknown>>;
      reconRows: Array<{ rrn: string; diff: number; plAmt: number; prAmt: number; orders?: string[]; pr?: { orderNo?: string; paymentName?: string } }>;
    } | null;
  };
  const entryByKey = (source: string) => {
    const map = new Map<string, (typeof session.justification.entries)[number]>();
    for (const e of session.justification.entries) {
      if (e.source === source && e.targetKey !== null) map.set(e.targetKey, e);
    }
    return map;
  };

  const items: ExplainedItemDTO[] = [];

  const plEntries = entryByKey('pinelabs');
  const p = result.pinelabs;
  p.onlyPOS.forEach((x) => {
    const e = plEntries.get(targetKeyForPinelabs('onlyPOS', x));
    if (!e) return;
    const amount = (x.amount as number) || 0;
    items.push({
      source: 'Only in POS',
      remark: e.remark,
      label: (x.paymentName as string) || '',
      orderNo: ((x.orders as string[]) || [x.orderNo as string]).filter(Boolean).join(', '),
      rrn: (x.rrn as string) || '',
      plAmt: 0,
      prAmt: amount,
      diff: -amount,
    });
  });
  p.onlyTerm.forEach((x) => {
    const e = plEntries.get(targetKeyForPinelabs('onlyTerm', x));
    if (!e) return;
    const amount = (x.amount as number) || 0;
    items.push({
      source: 'Only in Pinelabs',
      remark: e.remark,
      label: (x.acquirer as string) || '',
      orderNo: '',
      rrn: (x.rrn as string) || '',
      plAmt: amount,
      prAmt: 0,
      diff: amount,
    });
  });
  p.reconRows
    .filter((x) => Math.abs(x.diff) > 0.5 && !x.squaredOff)
    .forEach((x) => {
      const e = plEntries.get(x.rrn);
      if (!e) return;
      items.push({
        source: 'Amount mismatch',
        remark: e.remark,
        label: x.pr?.paymentName || '',
        orderNo: (x.orders || [x.pr?.orderNo]).filter(Boolean).join(', '),
        rrn: x.rrn,
        plAmt: x.plAmt,
        prAmt: x.prAmt,
        diff: x.diff,
      });
    });
  p.amexDup.forEach((x) => {
    const e = plEntries.get(`amexdup-${x.pr.orderNo}`);
    if (!e) return;
    items.push({
      source: 'AMEX dup — POS',
      remark: e.remark,
      label: 'AMEX',
      orderNo: x.pr.orderNo || '',
      rrn: '',
      plAmt: 0,
      prAmt: x.pr.amount,
      diff: -(x.pr.amount || 0),
    });
  });
  p.amexDupTerm.forEach((x, i) => {
    const e = plEntries.get(`amexdupterm-${i}-${x.amount}`);
    if (!e) return;
    items.push({
      source: 'AMEX dup — terminal',
      remark: e.remark,
      label: 'AMEX',
      orderNo: '',
      rrn: x.rrn || '',
      plAmt: x.amount,
      prAmt: 0,
      diff: x.amount || 0,
    });
  });

  if (result.upiHdfc) {
    const hdfcEntries = entryByKey('upi_hdfc');
    const u = result.upiHdfc;
    u.onlyPOS.forEach((x) => {
      const e = hdfcEntries.get(targetKeyForUpiHdfc('onlyPOS', x));
      if (!e) return;
      const amount = (x.amount as number) || 0;
      items.push({
        source: 'HDFC Static UPI — only in POS',
        remark: e.remark,
        label: (x.paymentName as string) || '',
        orderNo: ((x.orders as string[]) || [x.orderNo as string]).filter(Boolean).join(', '),
        rrn: (x.rrn as string) || '',
        plAmt: 0,
        prAmt: amount,
        diff: -amount,
      });
    });
    u.onlyTerm.forEach((x) => {
      const e = hdfcEntries.get(targetKeyForUpiHdfc('onlyTerm', x));
      if (!e) return;
      const amount = (x.amount as number) || 0;
      items.push({
        source: 'HDFC Static UPI — only in statement',
        remark: e.remark,
        label: (x.payer as string) || '',
        orderNo: '',
        rrn: (x.rrn as string) || '',
        plAmt: amount,
        prAmt: 0,
        diff: amount,
      });
    });
    u.reconRows
      .filter((x) => Math.abs(x.diff) > 0.5)
      .forEach((x) => {
        const e = hdfcEntries.get(`umm-${x.rrn}`);
        if (!e) return;
        items.push({
          source: 'HDFC Static UPI — amount mismatch',
          remark: e.remark,
          label: x.pr?.paymentName || '',
          orderNo: (x.orders || [x.pr?.orderNo]).filter(Boolean).join(', '),
          rrn: x.rrn,
          plAmt: x.plAmt,
          prAmt: x.prAmt,
          diff: x.diff,
        });
      });
  }

  const aggregateLabel: Record<string, string> = { cash: 'Cash', upi: 'HDFC/Kotak UPI', bank: 'Bank Transfer' };
  for (const source of ['cash', 'upi', 'bank'] as const) {
    session.justification.entries
      .filter((e) => e.source === source && e.amount)
      .forEach((e) => {
        const diff = e.direction === 'excess' ? e.amount : -e.amount;
        const label =
          e.description || (e.billNo ? `Bill: ${e.billNo}${e.reason ? ` — ${e.reason}` : ''}` : '') || e.remark;
        items.push({
          source: aggregateLabel[source]!,
          remark: e.remark,
          label,
          orderNo: '',
          rrn: e.rrn || '',
          plAmt: e.direction === 'excess' ? e.amount : 0,
          prAmt: e.direction === 'shortage' ? e.amount : 0,
          diff,
        });
      });
  }

  return items;
}
