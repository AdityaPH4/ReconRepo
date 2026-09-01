/**
 * @toit/contracts — the HTTP wire format.
 *
 * The single shared definition of what the API sends and the web app receives.
 * Types only: no runtime code, no dependencies beyond `@toit/recon-core`'s and
 * `@toit/mpr-core`'s types, so either side can import it without pulling in
 * the other's stack. `import type` is fully erased at compile time, so
 * pulling types from `@toit/mpr-core` here never bundles its `xlsx`
 * dependency into the browser.
 */

import type {
  Advance,
  AdvanceApplication,
  BohClearance,
  BohEntry,
  BohStagingEntry,
  Direction,
  FileRole,
  JustificationEntry,
  JustificationSource,
  JustificationState,
  OutletCode,
  ReconResult,
  Remark,
  Snapshot,
  SquareOffMap,
  SubmitStatus,
  SummaryData,
} from '@toit/recon-core/display';
import type {
  AdapterKey,
  AmbiguousMprRow,
  AmexResult,
  MatchResult,
  PendingRow,
  SettledRow,
  UnexpectedMprRow,
  UpiResult,
} from '@toit/mpr-core';

/**
 * Applies JSON's type erasure to a domain type.
 *
 * `Date` fields survive `JSON.stringify` as ISO strings, and `NaN` becomes
 * `null`. Saying so in the type keeps the frontend honest — a `ReconResult`
 * received over HTTP is not the same type the engine produced, and pretending
 * otherwise is how `.toISOString()` ends up called on a string.
 */
export type Jsonified<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Jsonified<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonified<T[K]> }
      : T extends number
        ? number | null
        : T;

// ── Uploads ───────────────────────────────────────────────────────────────

/** The optional fourth upload sits outside the three required roles. */
export type UploadRole = FileRole | 'hdfc';

/** One raw file as stored, byte-for-byte, in object storage. */
export interface UploadedFileDTO {
  role: UploadRole;
  originalName: string;
  size: number;
  contentType: string;
  /** Object-storage key. Resolves within the configured bucket or local root. */
  storageKey: string;
}

/** What the HDFC statement parse kept and what it dropped, and why. */
export interface HdfcStatementMetaDTO {
  rows: number;
  skippedFailed: number;
  unknownCity: number;
}

// ── Session ───────────────────────────────────────────────────────────────

export type SessionStatus = 'draft' | 'submitted';

export interface SessionMetaDTO {
  id: string;
  status: SessionStatus;
  outlet: OutletCode;
  outletName: string;
  /** `yyyy-mm-dd`, from the first parseable Payment Report date. */
  businessDate: string | null;
  /** Human-readable window label. */
  businessWindow: string | null;
  businessWindowStart: string | null;
  businessWindowEnd: string | null;
  createdAt: string;
  createdBy: string;
  submittedAt: string | null;
  submittedBy: string | null;
  prFileRows: number;
  zipRows: number;
  zipFilteredRows: number;
  files: UploadedFileDTO[];
  hdfcStatement: HdfcStatementMetaDTO | null;
  /**
   * Non-fatal problems the operator must see — an unreadable HDFC statement, a
   * missing business date, an undetectable outlet. The legacy app raised these
   * as `alert()` calls mid-run; they are carried on the session instead so they
   * survive a page refresh.
   */
  warnings: string[];
}

// ── Final Recon Summary ───────────────────────────────────────────────────

export interface FrsRowDTO {
  label: string;
  pr: number;
  drawerAmt: number | null;
  sourceAmt: number | null;
  diff: number;
  usingSource: boolean;
  basis: 'source_report' | 'drawer_summary';
  assumedReconciled: boolean;
  reconciledNote: string | null;
}

export interface FrsDTO {
  rows: FrsRowDTO[];
  grandPR: number;
  grandSum: number;
  /** `grandSum − grandPR`, excluding POS-integrated methods. */
  grandDiff: number;
}

// ── Counts, for tiles and tab badges ─────────────────────────────────────

export interface PinelabsCountsDTO {
  /** Matched rows within tolerance, or auto-squared-off Manual APOS. */
  reconciled: number;
  /** Matched rows still carrying a material difference. */
  unreconciled: number;
  onlyPOS: number;
  onlyTerm: number;
  dupRRN: number;
  amexOk: number;
  amexDup: number;
  amexDupTerm: number;
}

export interface UpiHdfcCountsDTO {
  reconciled: number;
  unreconciled: number;
  onlyPOS: number;
  onlyTerm: number;
  dupRRN: number;
}

export interface ReconCountsDTO {
  pinelabs: PinelabsCountsDTO;
  /** `null` when no HDFC statement was uploaded. */
  upiHdfc: UpiHdfcCountsDTO | null;
  swiggy: number;
  cash: number;
  upi: number;
  bills: number;
  bank: number;
  other: number;
  zipFiltered: number;
}

// ── Per-panel totals ─────────────────────────────────────────────────────

/** PR-side total against the drawer figure, for the aggregate panels. */
export interface PanelTotalsDTO {
  prTotal: number;
  summaryTotal: number | null;
  diff: number | null;
}

export interface PanelSummariesDTO {
  cash: PanelTotalsDTO;
  hdfcUpi: PanelTotalsDTO;
  kotakUpi: PanelTotalsDTO;
  bank: PanelTotalsDTO;
  bills: PanelTotalsDTO;
  /**
   * Swiggy/Zomato never block submission, but legacy still compared each
   * brand separately against its own drawer-summary row (`summaryData['Swiggy']`
   * and `summaryData['ZOMATO']` are distinct keys). `prTotal` is the combined
   * total (the KPI tile's figure); `swiggy`/`zomato` carry the per-brand
   * PR-vs-drawer comparison.
   */
  swiggy: { prTotal: number; swiggy: PanelTotalsDTO; zomato: PanelTotalsDTO };
  /** Pinelabs is transaction-level, so it reports terminal vs POS instead. */
  pinelabs: { prTotal: number; terminalTotal: number; diff: number };
}

// ── Pinelabs terminal breakdown by acquirer ───────────────────────────────

export interface AcquirerGroupRowDTO {
  acquirer: string;
  count: number;
  pinelabsTotal: number;
  /** `null` — no PR-side figure exists for this group (e.g. "Other"). */
  prTotal: number | null;
  diff: number | null;
}

export interface PinelabsBreakdownDTO {
  rows: AcquirerGroupRowDTO[];
  totalCount: number;
  totalPinelabs: number;
  totalPR: number;
  totalDiff: number;
  amexDupCount: number;
}

// ── FRS explanation of excess/shortage ────────────────────────────────────
// One row per justification entry that has a resolvable transaction-level
// row or an aggregate-tab entry behind it — the flat list the FRS screen
// groups by remark client-side. Ported from legacy's `collectExplained` /
// `groupByRemark` (reconciliation (68).html lines 3570–3650).

export interface ExplainedItemDTO {
  source: string;
  remark: string;
  label: string;
  orderNo: string;
  rrn: string;
  plAmt: number;
  prAmt: number;
  diff: number;
}

// ── The full session payload ──────────────────────────────────────────────

export interface SessionDTO {
  meta: SessionMetaDTO;
  /** Engine output, as it survives JSON. */
  result: Jsonified<ReconResult>;
  summaryData: SummaryData | null;
  frs: FrsDTO;
  counts: ReconCountsDTO;
  totals: PanelSummariesDTO;
  pinelabsBreakdown: PinelabsBreakdownDTO;
  /** Everything a human has added on top of `result` — remarks, square-off, draft advance/BOH mutations. */
  justification: JustificationStateDTO;
  /** Recomputed on every fetch from `justification` + `result` — never stored, so it can never drift from what submit actually gates on. */
  submitGate: SubmitGateDTO;
  /** Flat, recomputed-on-every-fetch list backing the FRS "Explanation of Excess/Shortage" tables. */
  explanation: ExplainedItemDTO[];
  /** Set only once `meta.status === 'submitted'` — the persisted, immutable settlement record. */
  snapshot: SnapshotDTO | null;
}

/** Row shown in the session list. */
export interface SessionListItemDTO {
  id: string;
  status: SessionStatus;
  outlet: OutletCode;
  businessDate: string | null;
  createdAt: string;
  grandDiff: number;
}

// ── Justification & submit layer ─────────────────────────────────────────
// None of these carry `Date`/`NaN` fields (dates are ISO strings throughout,
// amounts are validated numbers) — so unlike `ReconResult` they need no
// `Jsonified<>` wrapping and are re-exported as-is.

export type JustificationSourceDTO = JustificationSource;
export type DirectionDTO = Direction;
export type JustificationEntryDTO = JustificationEntry;
export type SquareOffMapDTO = SquareOffMap;
export type JustificationStateDTO = JustificationState;

export type AdvanceDTO = Advance;
export type AdvanceApplicationDTO = AdvanceApplication;
export type BohEntryDTO = BohEntry;
export type BohClearanceDTO = BohClearance;
export type BohStagingEntryDTO = BohStagingEntry;
export type SnapshotDTO = Snapshot;

export interface EligibleAdvanceDTO {
  advance: AdvanceDTO;
  balance: number;
  eligible: boolean;
  ineligibleReason: string | null;
}

export interface EligibleBohEntryDTO {
  entry: BohEntryDTO;
  eligible: boolean;
  ineligibleReason: string | null;
}

/** Mirrors `canSubmit()`'s return — the single gate the FRS display and the submit route both read. */
export interface SubmitGateDTO {
  ok: boolean;
  blockers: string[];
  residual: number;
  status: SubmitStatus;
  perSource: {
    pinelabs: boolean;
    /** `null` when no HDFC statement was uploaded. */
    hdfcUpi: boolean | null;
    cash: boolean;
    upi: boolean;
    bank: boolean;
  };
}

// ── Justification request bodies ──────────────────────────────────────────

/** A justification needing no repository interaction — Tips, Paid In/Out, EPR, Short Collection, Other. */
export interface AddJustificationEntryRequest {
  source: JustificationSourceDTO;
  targetKey: string | null;
  direction: DirectionDTO;
  remark: Remark;
  amount: number;
  description?: string | null;
  rrn?: string | null;
  billNo?: string | null;
  reason?: string | null;
  staffName?: string | null;
  empId?: string | null;
  clientName?: string | null;
  comment?: string | null;
  notes?: string | null;
}

export interface ToggleSquareOffRequest {
  a: string;
  b: string;
}

/** Backs the "Advance Received" modal. */
export interface RecordAdvanceRequest {
  source: JustificationSourceDTO;
  targetKey: string | null;
  amount: number;
  custName: string;
  phone?: string | null;
  /** ISO `yyyy-mm-dd`, must be strictly after the session's business date. */
  eventDate: string;
  notes?: string | null;
  /** The UPI tab's 12-digit RRN, when this advance was recorded from there — a real, identifiable transaction. */
  rrn?: string | null;
}

/** Backs the "Advance Applied" modal — always consumes the advance's full remaining balance. */
export interface ApplyAdvanceRequest {
  source: JustificationSourceDTO;
  targetKey: string | null;
  advanceId: string;
}

/** Backs "add to BOH repository" from the Bills-on-Hold tab — staged until submit. */
export interface AddBohStagingRequest {
  orderNo: string;
  custName: string;
  phone?: string | null;
  amount: number;
  bohDate: string;
  notes?: string | null;
}

/** Backs the "Bill on Hold Cleared" modal — always clears in full. */
export interface ClearBohRequest {
  source: JustificationSourceDTO;
  targetKey: string | null;
  bohEntryId: string;
  clearSource: string;
}

// ── MPR reconciliation (Layer 2) ──────────────────────────────────────────
// None of `@toit/mpr-core`'s output types carry `Date`/`NaN` fields (every
// date is already a normalised `YYYY-MM-DD` string, every amount a validated
// number) — no `Jsonified<>` wrapping needed, they're re-exported as-is, the
// same reasoning as the justification-layer DTOs above.

export type MprAdapterKey = AdapterKey;
export type MprMatchResultDTO = MatchResult;
export type MprSettledRowDTO = SettledRow;
export type MprPendingRowDTO = PendingRow;
export type MprAmbiguousRowDTO = AmbiguousMprRow;
export type MprUnexpectedRowDTO = UnexpectedMprRow;
export type MprAmexResultDTO = AmexResult;
export type MprUpiResultDTO = UpiResult;

export interface ParsedMprFileMetaDTO {
  filename: string;
  detected: MprAdapterKey | 'UNKNOWN';
  rowCount: number;
  error: string | null;
}

export interface JsonSnapshotFileMetaDTO {
  filename: string;
  businessDate: string | null;
  outlet: string | null;
  /** Set when this file was skipped (bad JSON / missing `settlementLedger`) — legacy's `alert()`-and-`continue`, surfaced as a warning instead of aborting the whole upload. */
  error?: string | null;
}

export interface MprSessionMetaDTO {
  id: string;
  createdAt: string;
  createdBy: string;
  jsonFiles: JsonSnapshotFileMetaDTO[];
  mprFiles: ParsedMprFileMetaDTO[];
  /** Sorted union of business dates across every uploaded JSON snapshot. */
  businessDates: string[];
  /** Union of outlets seen across every uploaded JSON snapshot. */
  outlets: string[];
}

export interface MprSessionDTO {
  meta: MprSessionMetaDTO;
  result: MprMatchResultDTO;
}

/** Row shown in the MPR session list. */
export interface MprSessionListItemDTO {
  id: string;
  createdAt: string;
  createdBy: string;
  businessDates: string[];
  outlets: string[];
  settledCount: number;
  mismatchCount: number;
  pendingCount: number;
  unexpectedCount: number;
}

// ── Auth ──────────────────────────────────────────────────────────────────

export type UserRole = 'gm' | 'admin';

export interface CurrentUserDTO {
  email: string;
  role: UserRole;
  /** `null` for admins, who see every outlet. */
  outlet: OutletCode | null;
}

// ── Approval workflow — a GM re-reconciling the same outlet+date needs an ──
// admin to unblock it (guards against a wrong-file re-run going unnoticed).

export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface ApprovalRequestDTO {
  id: string;
  outlet: OutletCode;
  /** `yyyy-mm-dd` — the business date this unblocks a re-run for. */
  businessDate: string;
  requestedBy: string;
  requestedAt: string;
  reason: string | null;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface RequestApprovalRequest {
  outlet: OutletCode;
  businessDate: string;
  reason: string | null;
}

// ── Manager dashboard ────────────────────────────────────────────────────

export interface DashboardTipsRowDTO {
  /** `'T'`, `'T-1'` … `'T-7'`. */
  label: string;
  /** `yyyy-mm-dd`. */
  date: string;
  amount: number;
}

export type BohAgingBucket = '1' | '2' | '3' | '4' | '5' | '5+';

export interface DashboardBohAgingRowDTO {
  bucket: BohAgingBucket;
  count: number;
  amount: number;
}

export interface DashboardTodayStatusDTO {
  /** `null` when no session exists yet for `(outlet, today)`. */
  sessionId: string | null;
  status: SessionStatus | null;
  grandDiff: number | null;
}

export interface DashboardDTO {
  outlet: OutletCode;
  today: string;
  todayStatus: DashboardTodayStatusDTO;
  tips: DashboardTipsRowDTO[];
  tipsWeekCurrent: number;
  tipsWeekPrevious: number;
  bohAging: DashboardBohAgingRowDTO[];
  bohTotal: { count: number; amount: number };
}

// ── Errors ────────────────────────────────────────────────────────────────

export interface ApiErrorDTO {
  error: string;
  /** Field-level detail for validation failures. */
  details?: Record<string, string>;
  /** Set only on the "already reconciled today" block, so the frontend can offer "Request approval" without string-matching `error`. */
  code?: 'APPROVAL_REQUIRED';
  outlet?: OutletCode;
  businessDate?: string;
}
