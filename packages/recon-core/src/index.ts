/**
 * @toit/recon-core — the reconciliation engine.
 *
 * Pure domain logic: parse the four source files, match transactions, compute
 * the Final Recon Summary. No DOM, no database, no filesystem, no network, no
 * clock. Consumed by @toit/api on the server and by @toit/web for shared types
 * and display formatters.
 *
 * Ported from `legacy/reconciliation (68).html`. Each module names the legacy
 * line range it came from so the port stays auditable against the original.
 */

// ── Types ─────────────────────────────────────────────────────────────────
export type {
  AmexDup,
  AmexMatch,
  AmexPR,
  BusinessWindow,
  CivilDate,
  DupRRNRow,
  FileRole,
  FrsMethod,
  FrsRowAmounts,
  FrsSourceType,
  HdfcStatementParse,
  HdfcStatementRow,
  MatchResult,
  OnlyPOSRow,
  OutletCode,
  PRGroup,
  PRParse,
  PRRow,
  PinelabsResult,
  ReconResult,
  ReconRow,
  ReconcileInput,
  SummaryData,
  Tab,
  ZipParse,
  ZipRow,
} from './types.js';

// ── Constants & routing ───────────────────────────────────────────────────
export {
  AMOUNT_EPSILON,
  BANK_NAMES,
  BILLS_NAMES,
  BOH_SOURCES,
  CASH_BILL_REMARKS,
  CASH_NAMES,
  CASH_REMARKS_EXCESS,
  CASH_REMARKS_SHORTAGE,
  EXPLAIN_TYPES,
  FRS_METHODS,
  HDFC_STATEMENT_CITY_TO_OUTLET,
  MODAL_REMARKS,
  NO_RRN_REMARKS,
  OUTLET_CODES,
  OUTLET_NAMES,
  PINELABS_NAMES,
  REMARKS_ALL,
  REMARKS_EXCESS,
  REMARKS_SHORTAGE,
  STORE_OUTLET_MAP,
  SWIGGY_NAMES,
  THRESHOLD,
  UPI_NAMES,
  detectOutletFromZip,
  routePayName,
  storeToOutlet,
} from './constants.js';
export type { Remark, RemarkExcess, RemarkShortage } from './constants.js';

// ── Utilities ─────────────────────────────────────────────────────────────
export {
  amountsEqual,
  cleanCode,
  cleanRRN,
  fmt,
  isAmex,
  isAmexAcq,
  isAmexBank,
  isMaterial,
  money,
} from './util/money.js';

export {
  IST_TIMEZONE,
  buildWin,
  civilToISO,
  fmtCivil,
  fmtDate,
  fmtEventDate,
  fmtWin,
  inWin,
  istDate,
  parseHDFCTime12h,
  parsePRDate,
  parseZipDT,
} from './util/dates.js';

export { cell, headerIndex, parseCSV } from './util/csv.js';

// ── Parsers ───────────────────────────────────────────────────────────────
export { parsePaymentReport } from './parsers/paymentReport.js';
export { parseTransactionsZip } from './parsers/transactionsZip.js';
export { parsePaymentSummary } from './parsers/paymentSummary.js';
export { HdfcStatementFormatError, parseHdfcStatement } from './parsers/hdfcStatement.js';

// ── Engine ────────────────────────────────────────────────────────────────
export { matchTransactionLevel } from './engine/match.js';
export type { TerminalLike } from './engine/match.js';
export { groupAmexPR, matchAmex } from './engine/amex.js';
export type { AmexResult } from './engine/amex.js';
export { reconcile } from './engine/reconcile.js';

export {
  buildPRMap,
  buildSumMap,
  frsMethodTotals,
  frsRowAmounts,
  grandTotals,
  hdfcTerminalPR,
  pinelabsTerminalPR,
} from './engine/frs.js';
export type { FrsContext } from './engine/frs.js';

export { pinelabsAcquirerBreakdown } from './engine/pinelabsBreakdown.js';
export type { AcquirerGroupRow, PinelabsAcquirerBreakdown } from './engine/pinelabsBreakdown.js';

// ── Justification & submit layer ─────────────────────────────────────────
export type {
  Advance,
  AdvanceApplication,
  BohClearance,
  BohEntry,
  BohSource,
  BohStagingEntry,
  Direction,
  JustificationEntry,
  JustificationSource,
  JustificationState,
  ResolvableItem,
  SquareOffMap,
} from './justification/types.js';
export { emptyJustificationState } from './justification/types.js';

export { buildHdfcUpiItems, buildPinelabsItems } from './justification/items.js';

export {
  isEligibleSquareOffPartner,
  isSquareOffResolved,
  isSquaredOff,
  squareOffNet,
  squareOffPairList,
  squareOffPartners,
  toggleSquareOff,
} from './justification/squareOff.js';

export {
  bankOk,
  cashOk,
  entryNet,
  hdfcUpiCompleteness,
  pinelabsCompleteness,
  upiOk,
} from './justification/completeness.js';
export type { CompletenessResult, UpiOkParams } from './justification/completeness.js';

export { collectExplained, explainedTotals } from './justification/residual.js';
export type { ExplainedItem } from './justification/residual.js';

export { canSubmit } from './justification/submitGate.js';
export type { CanSubmitInput, SubmitGateResult, SubmitStatus } from './justification/submitGate.js';

export { advanceBalance, eligibleAdvances, isAdvanceExhausted } from './justification/advances.js';
export type { EligibleAdvance } from './justification/advances.js';

export { eligibleBohEntries } from './justification/boh.js';
export type { EligibleBohEntry, EligibleBohOptions } from './justification/boh.js';

export { buildSnapshot } from './justification/snapshot.js';
export type { BuildSnapshotInput, Snapshot, SettlementLedgerRow } from './justification/snapshot.js';

export { buildReportHtml } from './justification/report.js';

export type { FrsRowDTOLike } from './justification/reportTypes.js';
