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
  CASH_NAMES,
  EXPLAIN_TYPES,
  FRS_METHODS,
  HDFC_STATEMENT_CITY_TO_OUTLET,
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
