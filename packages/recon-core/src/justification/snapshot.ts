/**
 * The settlement snapshot — the persisted, submitted record of a session.
 * Ported from `reconciliation (68).html` lines 5084–5256 (`buildSnapshot`).
 *
 * Built once at submit time from the reconciliation result, the FRS figures,
 * the justification state, and whichever advance/BOH rows this session
 * touched. Pure and deterministic: same inputs, same snapshot — this is what
 * gets persisted (`SessionDTO.snapshot`) and what the printable report
 * (`report.ts`) renders from, so the two can never disagree.
 */

import { isAmexAcq, isMaterial, money } from '../util/money.js';
import { OUTLET_NAMES } from '../constants.js';
import type { FrsRowDTOLike } from './reportTypes.js';
import type { OutletCode, PinelabsResult, ReconResult, SummaryData, ZipRow } from '../types.js';
import { buildHdfcUpiItems, buildPinelabsItems } from './items.js';
import { collectExplained, explainedTotals, type ExplainedItem } from './residual.js';
import { squareOffPairList } from './squareOff.js';
import type { SubmitStatus } from './submitGate.js';
import type {
  Advance,
  AdvanceApplication,
  BohClearance,
  BohEntry,
  JustificationEntry,
  JustificationState,
} from './types.js';

export interface SettlementLedgerRow {
  rrn: string;
  authCode: string;
  acquirer: string;
  mid: string | null;
  invoice: string | null;
  plAmount: number;
  plDate: string;
  plSettlementDate: string;
  posAmount: number;
  posOrderNo: string;
  outlet: OutletCode;
  store: string;
  l1Status: 'matched' | 'squared_off' | 'explained' | 'unresolved';
  l1Remark: string | null;
  l1Diff: number;
  squaredOff: boolean;
  matchBy: string;
}

/** Cash/Bank aggregate-tab justification, as legacy's `buildSnapshot` shapes them (5183, 5227) — no `rrn`/`source`, unlike UPI's own justifications below. */
export interface AggregateJustificationSnapshot {
  sign: 'excess' | 'shortage';
  remark: string;
  description: string | null;
  billNo: string | null;
  reason: string | null;
  clientName: string | null;
  notes: string | null;
  staffName: string | null;
  empId: string | null;
  amount: number;
}

export interface Snapshot {
  meta: {
    appVersion: string;
    businessDate: string | null;
    businessWindow: string | null;
    businessWindowStart: string | null;
    businessWindowEnd: string | null;
    submittedAt: string;
    submittedBy: string;
    outlet: OutletCode;
    outletName: string;
    prFileRows: number;
    zipRows: number;
  };
  finalReconSummary: {
    grandDiff: number;
    residual: number;
    status: SubmitStatus;
    methodBreakdown: FrsRowDTOLike[];
    drawerSummary: SummaryData | null;
    totalExcess: number;
    totalShortage: number;
    explanations: ExplainedItem[];
  };
  settlementLedger: SettlementLedgerRow[];
  pinelabs: {
    squareOffPairs: Array<{ from: string; to: string[] }>;
  };
  cash: {
    prTotal: number;
    summaryTotal: number | null;
    /** Every Cash PR row — legacy `buildSnapshot` 5182–5183. */
    transactions: Array<{ outlet: OutletCode; orderNo: string; date: string; amount: number }>;
    justifications: AggregateJustificationSnapshot[];
  };
  upi: {
    hdfcPR: number;
    hdfcSummary: number | null;
    kotakPR: number;
    kotakSummary: number | null;
    /**
     * Every PR-side Static UPI transaction, HDFC and Kotak alike — the
     * per-transaction feed the second-layer MPR reconciliation tool matches
     * against actual bank settlement files. Legacy: `buildSnapshot`
     * (reconciliation (68).html) 5216–5220.
     */
    transactions: Array<{
      orderNo: string;
      date: string;
      amount: number;
      paymentName: string;
      source: 'HDFC' | 'Kotak';
      rrn: string;
      employee: string;
    }>;
    /**
     * Aggregate-tab UPI justifications only (`JustificationEntry.source ===
     * 'upi'`) — an MPR-side credit with no natural transaction counterpart
     * (e.g. an Advance Received entered on the UPI tab) is what the
     * second-layer tool cross-checks unexpected bank credits against.
     * Row-level `upi_hdfc` remarks aren't included: those already resolved a
     * specific transaction-level row in this session's own ledger and need
     * no further explanation downstream. Legacy: 5206–5215.
     */
    justifications: Array<{
      sign: 'excess' | 'shortage';
      remark: string;
      rrn: string;
      description: string | null;
      billNo: string | null;
      reason: string | null;
      clientName: string | null;
      notes: string | null;
      staffName: string | null;
      empId: string | null;
      amount: number;
      source: string;
    }>;
  };
  bank: {
    prTotal: number;
    summaryTotal: number | null;
    /** Every Bank Transfer PR row — legacy `buildSnapshot` 5225 (no `outlet` on this one, matching legacy exactly). */
    transactions: Array<{ orderNo: string; date: string; amount: number }>;
    justifications: AggregateJustificationSnapshot[];
  };
  swiggy: {
    total: number;
    count: number;
    /** Every Swiggy/Zomato PR row — legacy `buildSnapshot` 5229. */
    transactions: Array<{ outlet: OutletCode; orderNo: string; date: string; paymentName: string; amount: number }>;
  };
  billsOnHold: {
    open: Array<{ id: string; orderNo: string; custName: string; amount: number; bohDate: string }>;
    cleared: Array<{ id: string; orderNo: string; source: string; clearedDate: string; amount: number }>;
  };
  advances: {
    repository: Array<{
      id: string;
      custName: string;
      phone: string | null;
      eventDate: string;
      originalAmount: number;
      appliedAmount: number;
      balance: number;
      recordedDate: string;
    }>;
    applications: Array<{
      advanceId: string;
      advanceCustName: string;
      amount: number;
      targetKey: string | null;
      appliedDate: string;
    }>;
  };
  justifications: JustificationState['entries'];
  /**
   * Every "Extra Payment Received" entry, regardless of which tab it was
   * recorded from — legacy's own `S.eprEntries` is a global list separate
   * from any one tab's entries (`buildSnapshot` 5253). Recoverable by
   * filtering `justifications` by remark, but kept as its own top-level
   * field to match legacy's snapshot shape exactly.
   */
  extraPayments: Array<{ billNo: string; clientName: string; amount: number; notes: string | null }>;
}

export interface BuildSnapshotInput {
  outlet: OutletCode;
  businessDate: string | null;
  businessWindow: string | null;
  businessWindowStart: string | null;
  businessWindowEnd: string | null;
  submittedAt: string;
  submittedBy: string;
  prFileRows: number;
  zipRows: number;
  result: ReconResult;
  summaryData: SummaryData | null;
  methodBreakdown: FrsRowDTOLike[];
  grandDiff: number;
  residual: number;
  status: SubmitStatus;
  justification: JustificationState;
  /** Every advance this session's entries/applications reference (committed + this session's own drafts, now committed). */
  advances: readonly Advance[];
  applications: readonly AdvanceApplication[];
  /** Open BOH entries for this outlet, post-commit. */
  bohOpen: readonly BohEntry[];
  /** This session's own clearances, joined against the entries they closed. */
  bohClearedThisSession: ReadonlyArray<{ clearance: BohClearance; entry: BohEntry }>;
}

function pinelabsSettlementLedger(
  pinelabs: PinelabsResult,
  outlet: OutletCode,
  justification: JustificationState,
): SettlementLedgerRow[] {
  const rows: SettlementLedgerRow[] = [];
  const squaredOffIds = new Set(
    Object.entries(justification.squareOff)
      .filter(([, v]) => v.length > 0)
      .map(([k]) => k),
  );
  const remarkByTargetKey = new Map(
    justification.entries.filter((e) => e.source === 'pinelabs').map((e) => [e.targetKey, e.remark]),
  );

  // Pinelabs' terminal side is always a ZipRow — the union with
  // `HdfcStatementRow` on `ReconRow`'s generic only matters for the separate
  // HDFC-UPI transaction-level match, which never flows through here.
  pinelabs.reconRows.forEach((x) => {
    const zip = x.zip as ZipRow;
    let status: SettlementLedgerRow['l1Status'] = 'matched';
    if (x.squaredOff) status = 'squared_off';
    else if (isMaterial(x.diff)) status = remarkByTargetKey.has(x.rrn) ? 'explained' : 'unresolved';
    const isAmex = isAmexAcq(zip?.acquirer || '');
    rows.push({
      rrn: x.rrn,
      authCode: x.pr?.authCode || '',
      acquirer: zip?.acquirer || '',
      mid: isAmex ? zip?.mid || null : null,
      invoice: null,
      plAmount: x.plAmt,
      plDate: zip?.date || '',
      plSettlementDate: zip?.settlementDate || '',
      posAmount: x.prAmt,
      posOrderNo: (x.orders || [x.pr?.orderNo]).filter(Boolean).join(','),
      outlet,
      store: zip?.store || '',
      l1Status: status,
      l1Remark: remarkByTargetKey.get(x.rrn) ?? null,
      l1Diff: x.diff,
      squaredOff: x.squaredOff || false,
      matchBy: 'rrn',
    });
  });

  pinelabs.onlyTerm.forEach((x, i) => {
    const key = `term-${x.rrn}-${x.date}`;
    const globalId = `PL-${i + 1}`;
    const isSq = squaredOffIds.has(globalId);
    rows.push({
      rrn: x.rrn,
      authCode: '',
      acquirer: x.acquirer || '',
      mid: isAmexAcq(x.acquirer) ? x.mid || null : null,
      invoice: null,
      plAmount: x.amount,
      plDate: x.date,
      plSettlementDate: x.settlementDate || '',
      posAmount: 0,
      posOrderNo: '',
      outlet,
      store: x.store || '',
      l1Status: isSq ? 'squared_off' : remarkByTargetKey.has(key) ? 'explained' : 'unresolved',
      l1Remark: remarkByTargetKey.get(key) ?? null,
      l1Diff: x.amount,
      squaredOff: isSq,
      matchBy: isSq ? 'square_off' : 'none',
    });
  });

  pinelabs.amexOk.forEach((x) => {
    rows.push({
      rrn: x.zip?.rrn || '',
      authCode: x.pr?.authCode || '',
      acquirer: 'AMEX',
      mid: x.zip?.mid || null,
      invoice: x.zip?.invoice || null,
      plAmount: x.zip?.amount || 0,
      plDate: x.zip?.date || '',
      plSettlementDate: x.zip?.settlementDate || '',
      posAmount: x.pr?.amount || 0,
      posOrderNo: x.pr?.orderNo || '',
      outlet,
      store: x.zip?.store || '',
      l1Status: 'matched',
      l1Remark: null,
      l1Diff: 0,
      squaredOff: false,
      matchBy: x._matchBy,
    });
  });

  return rows;
}

function toAggregateJustification(e: JustificationEntry): AggregateJustificationSnapshot {
  return {
    sign: e.direction,
    remark: e.remark,
    description: e.description,
    billNo: e.billNo,
    reason: e.reason,
    clientName: e.clientName,
    notes: e.notes,
    staffName: e.staffName,
    empId: e.empId,
    amount: e.amount,
  };
}

export function buildSnapshot(input: BuildSnapshotInput): Snapshot {
  const { result, outlet, justification, advances, applications, bohOpen, bohClearedThisSession } = input;

  const hdfcRows = result.upi.filter((x) => /hdfc/i.test(x.paymentName));
  const kotakRows = result.upi.filter((x) => /kotak/i.test(x.paymentName));
  const drawer = (key: string): number | null => {
    if (!input.summaryData) return null;
    const raw = input.summaryData[key];
    if (raw === undefined) return null;
    const n = money(raw);
    return Number.isNaN(n) ? null : n;
  };

  const explanations = collectExplained(
    justification.entries,
    buildPinelabsItems(result.pinelabs),
    buildHdfcUpiItems(result.upiHdfc),
  );
  const { excessTotal, shortTotal } = explainedTotals(explanations);

  return {
    meta: {
      appVersion: '2.0',
      businessDate: input.businessDate,
      businessWindow: input.businessWindow,
      businessWindowStart: input.businessWindowStart,
      businessWindowEnd: input.businessWindowEnd,
      submittedAt: input.submittedAt,
      submittedBy: input.submittedBy,
      outlet,
      outletName: OUTLET_NAMES[outlet] ?? outlet,
      prFileRows: input.prFileRows,
      zipRows: input.zipRows,
    },
    finalReconSummary: {
      grandDiff: input.grandDiff,
      residual: input.residual,
      status: input.status,
      methodBreakdown: input.methodBreakdown,
      drawerSummary: input.summaryData,
      totalExcess: excessTotal,
      totalShortage: shortTotal,
      explanations,
    },
    settlementLedger: pinelabsSettlementLedger(result.pinelabs, outlet, justification),
    pinelabs: {
      squareOffPairs: squareOffPairList(justification.squareOff),
    },
    cash: {
      prTotal: result.cash.reduce((s, x) => s + (Number.isNaN(x.amount) ? 0 : x.amount), 0),
      summaryTotal: drawer('Cash'),
      transactions: result.cash.map((x) => ({ outlet, orderNo: x.orderNo, date: x.date, amount: x.amount })),
      justifications: justification.entries.filter((e) => e.source === 'cash').map(toAggregateJustification),
    },
    upi: {
      hdfcPR: hdfcRows.reduce((s, x) => s + (Number.isNaN(x.amount) ? 0 : x.amount), 0),
      hdfcSummary: drawer('HDFC Static UPI'),
      kotakPR: kotakRows.reduce((s, x) => s + (Number.isNaN(x.amount) ? 0 : x.amount), 0),
      kotakSummary: drawer('Kotak Static UPI'),
      transactions: result.upi.map((x) => ({
        orderNo: x.orderNo,
        date: x.date,
        amount: x.amount,
        paymentName: x.paymentName,
        source: /hdfc/i.test(x.paymentName) ? 'HDFC' : 'Kotak',
        rrn: x.rrn || '',
        employee: x.employee || '',
      })),
      justifications: justification.entries
        .filter((e) => e.source === 'upi')
        .map((e) => ({
          sign: e.direction,
          remark: e.remark,
          rrn: e.rrn || '',
          description: e.description,
          billNo: e.billNo,
          reason: e.reason,
          clientName: e.clientName,
          notes: e.notes,
          staffName: e.staffName,
          empId: e.empId,
          amount: e.amount,
          source: 'HDFC/Kotak UPI',
        })),
    },
    bank: {
      prTotal: result.bank.reduce((s, x) => s + (Number.isNaN(x.amount) ? 0 : x.amount), 0),
      summaryTotal: drawer('Bank transfer'),
      transactions: result.bank.map((x) => ({ orderNo: x.orderNo, date: x.date, amount: x.amount })),
      justifications: justification.entries.filter((e) => e.source === 'bank').map(toAggregateJustification),
    },
    swiggy: {
      total: result.swiggy.reduce((s, x) => s + (Number.isNaN(x.amount) ? 0 : x.amount), 0),
      count: result.swiggy.length,
      transactions: result.swiggy.map((x) => ({
        outlet,
        orderNo: x.orderNo,
        date: x.date,
        paymentName: x.paymentName,
        amount: x.amount,
      })),
    },
    billsOnHold: {
      open: bohOpen.map((b) => ({
        id: b.id,
        orderNo: b.orderNo,
        custName: b.custName,
        amount: b.amount,
        bohDate: b.bohDate,
      })),
      cleared: bohClearedThisSession.map(({ clearance, entry }) => ({
        id: clearance.id,
        orderNo: entry.orderNo,
        source: clearance.source,
        clearedDate: clearance.clearedDate,
        amount: clearance.amount,
      })),
    },
    advances: {
      repository: advances.map((a) => {
        const balance =
          a.originalAmount - applications.filter((ap) => ap.advanceId === a.id).reduce((s, ap) => s + ap.amount, 0);
        return {
          id: a.id,
          custName: a.custName,
          phone: a.phone,
          eventDate: a.eventDate,
          originalAmount: a.originalAmount,
          appliedAmount: a.originalAmount - balance,
          balance,
          recordedDate: a.recordedDate,
        };
      }),
      applications: applications.map((ap) => {
        const advance = advances.find((a) => a.id === ap.advanceId);
        return {
          advanceId: ap.advanceId,
          advanceCustName: advance?.custName ?? '',
          amount: ap.amount,
          targetKey: ap.targetKey,
          appliedDate: ap.appliedDate,
        };
      }),
    },
    justifications: justification.entries,
    extraPayments: justification.entries
      .filter((e) => e.remark === 'Extra Payment Received')
      .map((e) => ({
        billNo: e.billNo ?? '',
        clientName: e.clientName ?? '',
        amount: e.amount,
        notes: e.notes,
      })),
  };
}
