/**
 * Browser-safe entry point.
 *
 * Exports only types, constants and pure formatters — deliberately nothing that
 * pulls in `xlsx` or `jszip`. The main `index.ts` re-exports the parsers, so
 * importing it from a React component would drag both spreadsheet libraries
 * into the client bundle for no benefit.
 *
 * Frontend code imports from `@toit/recon-core/display`; server code imports
 * from `@toit/recon-core`.
 */

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

export {
  AMOUNT_EPSILON,
  BOH_SOURCES,
  CASH_BILL_REMARKS,
  CASH_REMARKS_EXCESS,
  CASH_REMARKS_SHORTAGE,
  EXPLAIN_TYPES,
  FRS_METHODS,
  MODAL_REMARKS,
  NO_RRN_REMARKS,
  OUTLET_CODES,
  OUTLET_NAMES,
  REMARKS_ALL,
  REMARKS_EXCESS,
  REMARKS_SHORTAGE,
  THRESHOLD,
  routePayName,
  storeToOutlet,
} from './constants.js';
export type { Remark, RemarkExcess, RemarkShortage } from './constants.js';

export {
  amountsEqual,
  cleanCode,
  cleanRRN,
  fmt,
  isAmex,
  isMaterial,
  money,
} from './util/money.js';

export {
  IST_TIMEZONE,
  civilToISO,
  fmtCivil,
  fmtDate,
  fmtEventDate,
  fmtWin,
  parsePRDate,
} from './util/dates.js';

// ── Justification & submit layer (browser-safe subset — no snapshot/report,
// which are server-only concerns) ────────────────────────────────────────
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

// Types only — `buildSnapshot`/`buildReportHtml` themselves stay server-only
// (`@toit/recon-core`'s main entry), but the shape they produce is inert data
// the web app needs to type a submit response and a stored session against.
export type { Snapshot, SettlementLedgerRow } from './justification/snapshot.js';
