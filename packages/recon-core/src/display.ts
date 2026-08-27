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
  EXPLAIN_TYPES,
  FRS_METHODS,
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
} from './util/dates.js';
