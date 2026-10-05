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
import type { PinelabsAcquirerBreakdown } from '../engine/pinelabsBreakdown.js';
import { advanceBalance, isAdvanceExhausted } from './advances.js';
import type { FrsRowDTOLike } from './reportTypes.js';
import type { OutletCode, PinelabsResult, PRRow, ReconResult, SummaryData, ZipRow } from '../types.js';
import { buildHdfcLinkItems, buildHdfcUpiItems, buildPinelabsItems } from './items.js';
import { collectExplained, explainedTotals, type ExplainedItem } from './residual.js';
import { squareOffGroupKey, squareOffPairList } from './squareOff.js';
import type { SubmitStatus } from './submitGate.js';
import type {
  Advance,
  AdvanceApplication,
  BohClearance,
  BohEntry,
  JustificationEntry,
  JustificationState,
  ResolvableItem,
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

/** Net Sales / net CGST / net SGST / VAT, from the optional Sale Summary upload's `TAXES` section — recon-core-native mirror of `@toit/contracts`' `TaxesSummaryDTO`. */
export interface TaxesSummary {
  netSales: number | null;
  netCgst: number;
  netSgst: number;
  vat: number | null;
  total: number | null;
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
    /** Absent on snapshots predating this field — the report renders no acquirer-breakdown table for those. */
    acquirerBreakdown?: PinelabsAcquirerBreakdown;
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
    /** Every currently-open BOH entry for this outlet, regardless of which session opened it. */
    open: Array<{ id: string; orderNo: string; custName: string; amount: number; bohDate: string }>;
    /**
     * Subset of `open` whose entry was staged (opened) in this session —
     * ids matching `justification.bohStaging`. Absent on snapshots
     * predating this field; the report then shows only "Total open BOH".
     */
    openThisSession?: Array<{ id: string; orderNo: string; custName: string; amount: number; bohDate: string }>;
    cleared: Array<{ id: string; orderNo: string; source: string; clearedDate: string; amount: number }>;
  };
  advances: {
    /** Every currently open advance for this outlet (not closed, balance > 0) — regardless of which session touched it, mirroring `billsOnHold.open`'s own outlet-wide scope. */
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
    /** This session's own newly-recorded applications only. */
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
  /** From the optional Sale Summary upload. Absent when none was uploaded, it had no `TAXES` section, or the snapshot predates this field. */
  taxes?: TaxesSummary;
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
  /** Every advance recorded for this outlet, open and closed alike — `repository` is filtered to currently-open ones, but the full list is kept here too, so a `sessionApplications` entry that itself exhausts an advance can still resolve that advance's name. */
  advances: readonly Advance[];
  /** Every application ever recorded against these advances (not just this session's) — used to compute each advance's live balance. */
  applications: readonly AdvanceApplication[];
  /** This session's own newly-recorded applications — a subset of `applications`, feeding the "Applied this session" report table. */
  sessionApplications: readonly AdvanceApplication[];
  /** Open BOH entries for this outlet, post-commit. */
  bohOpen: readonly BohEntry[];
  /** This session's own clearances, joined against the entries they closed. */
  bohClearedThisSession: ReadonlyArray<{ clearance: BohClearance; entry: BohEntry }>;
  /** BOH entry ids staged (opened) in this session — post-commit, these reuse their staging id. Used to split `billsOnHold.open` into `openThisSession` vs the rest. */
  bohStagedIds: readonly string[];
  pinelabsBreakdown: PinelabsAcquirerBreakdown;
  taxes: TaxesSummary | null;
}

function pinelabsSettlementLedger(
  pinelabs: PinelabsResult,
  outlet: OutletCode,
  justification: JustificationState,
  pinelabsItems: readonly ResolvableItem[],
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
  // A reconRow (`MM-N`) that's part of a GM-driven square-off has no fixed
  // index correspondence to its position in `pinelabs.reconRows` — `items.ts`
  // assigns `MM-N` only to rows that pass its own filter, indexed among just
  // those. Rebuilding that same globalId from `pinelabsItems` (already
  // filtered/indexed identically) is the only way to look up its manual
  // square-off state without duplicating that filter here.
  const mmGlobalIdByRrn = new Map(
    pinelabsItems.filter((i) => i.globalId.startsWith('MM-')).map((i) => [i.targetKey, i.globalId]),
  );
  const groupResidualRemark = new Map(
    justification.entries.filter((e) => e.source === 'pinelabs' && e.targetKey?.startsWith('sqoff:')).map((e) => [e.targetKey!, e.remark]),
  );

  // Pinelabs' terminal side is always a ZipRow — the union with
  // `HdfcStatementRow` on `ReconRow`'s generic only matters for the separate
  // HDFC-UPI transaction-level match, which never flows through here.
  pinelabs.reconRows.forEach((x) => {
    const zip = x.zip as ZipRow;
    const mmGlobalId = mmGlobalIdByRrn.get(x.rrn);
    const manuallySquaredOff = mmGlobalId ? squaredOffIds.has(mmGlobalId) : false;
    const groupKey = mmGlobalId && manuallySquaredOff ? squareOffGroupKey(justification.squareOff, mmGlobalId) : null;
    const residualRemark = groupKey ? groupResidualRemark.get(groupKey) : undefined;
    let status: SettlementLedgerRow['l1Status'] = 'matched';
    if (x.squaredOff || manuallySquaredOff) status = 'squared_off';
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
      l1Remark: remarkByTargetKey.get(x.rrn) ?? residualRemark ?? null,
      l1Diff: x.diff,
      squaredOff: x.squaredOff || manuallySquaredOff,
      matchBy: manuallySquaredOff && !x.squaredOff ? 'square_off' : 'rrn',
    });
  });

  pinelabs.onlyTerm.forEach((x, i) => {
    const key = `term-${x.rrn}-${x.date}`;
    const globalId = `PL-${i + 1}`;
    const isSq = squaredOffIds.has(globalId);
    const groupKey = isSq ? squareOffGroupKey(justification.squareOff, globalId) : null;
    const residualRemark = groupKey ? groupResidualRemark.get(groupKey) : undefined;
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
      l1Remark: remarkByTargetKey.get(key) ?? residualRemark ?? null,
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

/**
 * HDFC Link rows join Layer 2 (MPR) by order number, not RRN — the
 * settlement file has no reference column populated on every row (UPI rows
 * carry a UTR, card rows an ARN instead), but every row carries the same
 * Merchant Order ID this outlet's own POS assigned. Reusing `rrn` as that
 * join key lets these rows flow through the existing RRN-keyed MPR matcher
 * unchanged — see `packages/mpr-core`'s `HDFC_LINK` adapter. mpr-core's
 * shared row normaliser left-pads every adapter's `rrn` column to 12
 * digits (`normRRN()`), Merchant Order ID included — matching that padding
 * here is what makes the two sides' join keys equal as strings.
 */
function hdfcLinkSettlementLedger(rows: readonly PRRow[], outlet: OutletCode): SettlementLedgerRow[] {
  return rows.map((r) => ({
    rrn: r.orderNo.padStart(12, '0'),
    authCode: r.authCode || '',
    acquirer: 'HDFC_LINK',
    mid: null,
    invoice: null,
    plAmount: r.amount,
    plDate: r.date,
    plSettlementDate: '',
    posAmount: r.amount,
    posOrderNo: r.orderNo,
    outlet,
    store: '',
    l1Status: 'matched',
    l1Remark: null,
    l1Diff: 0,
    squaredOff: false,
    matchBy: 'order_id',
  }));
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
  const {
    result,
    outlet,
    justification,
    advances,
    applications,
    sessionApplications,
    bohOpen,
    bohClearedThisSession,
    bohStagedIds,
  } = input;
  const stagedIds = new Set(bohStagedIds);

  const hdfcRows = result.upi.filter((x) => /hdfc/i.test(x.paymentName));
  const kotakRows = result.upi.filter((x) => /kotak/i.test(x.paymentName));
  const drawer = (key: string): number | null => {
    if (!input.summaryData) return null;
    const raw = input.summaryData[key];
    if (raw === undefined) return null;
    const n = money(raw);
    return Number.isNaN(n) ? null : n;
  };

  const pinelabsItems = buildPinelabsItems(result.pinelabs);
  const explanations = collectExplained(
    justification.entries,
    pinelabsItems,
    buildHdfcUpiItems(result.upiHdfc),
    buildHdfcLinkItems(result.linkStmt),
    justification.squareOff,
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
    settlementLedger: [
      ...pinelabsSettlementLedger(result.pinelabs, outlet, justification, pinelabsItems),
      ...hdfcLinkSettlementLedger(result.hdfcLink, outlet),
    ],
    pinelabs: {
      squareOffPairs: squareOffPairList(justification.squareOff),
      acquirerBreakdown: input.pinelabsBreakdown,
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
      openThisSession: bohOpen
        .filter((b) => stagedIds.has(b.id))
        .map((b) => ({
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
      // `status !== 'closed'`, not `=== 'open'` — defensive against a
      // pre-existing row whose stored JSON predates that field, matching
      // `eligibleAdvances()`'s own filter exactly.
      repository: advances
        .filter((a) => a.status !== 'closed' && !isAdvanceExhausted(a, applications))
        .map((a) => {
          const balance = advanceBalance(a, applications);
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
      applications: sessionApplications.map((ap) => {
        // Looked up against the full (unfiltered) `advances` list, not
        // `repository` above — an application that itself exhausts its
        // advance this session must still resolve that advance's name here.
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
    taxes: input.taxes ?? undefined,
  };
}
