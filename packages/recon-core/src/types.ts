/**
 * Domain types for the reconciliation engine.
 *
 * These are the single source of truth for the shapes that flow
 * legacy HTML → API → Next.js UI. Field names are kept identical to the
 * legacy `reconciliation (68).html` implementation so the port stays
 * verifiable by diffing against it; where the legacy code was implicit,
 * the type is written out rather than changed.
 */

// ── Routing tabs ───────────────────────────────────────────────────────────
/** Which panel a Payment Report row is routed to, by payment name. */
export type Tab =
  | 'pinelabs'
  | 'swiggy'
  | 'cash'
  | 'upi'
  | 'bills'
  | 'bank'
  | 'other';

/** The three uploaded file roles. Legacy: `ROLE`. */
export type FileRole = 'pr' | 'zip' | 'sum';

/** Outlet codes. Legacy: keys of `OUTLET_NAMES`. */
export type OutletCode = 'BLRT' | 'BAGT' | 'PUNT';

// ── Civil dates & business window ─────────────────────────────────────────
/**
 * A calendar date with no time and no zone — deliberately NOT a `Date`.
 *
 * The legacy code ran in a browser on an IST machine, so `new Date(y, m, d)`
 * was implicitly IST. On a server (typically UTC) that same call silently
 * shifts the business window by 5h30m. Carrying the business date as a civil
 * date and only materialising instants through `istDate()` removes that whole
 * class of bug while preserving the original IST semantics exactly.
 */
export interface CivilDate {
  /** Full year, e.g. 2026. */
  y: number;
  /** Month index, 0–11 (matches `Date` conventions). */
  m: number;
  /** Day of month, 1–31. */
  d: number;
}

/**
 * The business-date window: 08:00 IST on the business date through
 * 07:00 IST the following morning. Legacy: `buildWin`.
 */
export interface BusinessWindow {
  start: Date;
  end: Date;
}

// ── Parsed source rows ────────────────────────────────────────────────────
/** One row of the POS Payment Report CSV. Legacy: `readPR` output row. */
export interface PRRow {
  orderNo: string;
  /** Raw date string exactly as it appeared in the CSV, e.g. `01-Aug-2026 21:14:03`. */
  date: string;
  customer: string;
  employee: string;
  paymentType: string;
  paymentName: string;
  cardNo: string;
  authCode: string;
  /** `NaN` when the source cell was blank or unparseable — legacy `money()` semantics. */
  amount: number;
  tips: number;
  bank: string;
  rrn: string;
  isAmex: boolean;
  tab: Tab;
  _src: 'PR';
}

/** One row of the Pinelabs "All Transactions" CSV inside the uploaded ZIP. */
export interface ZipRow {
  acquirer: string;
  paymentMode: string;
  name: string;
  cardIssuer: string;
  amount: number;
  tip: number;
  /** Raw date string, `dd/mm/yyyy hh:mm:ss AM/PM`. */
  date: string;
  batchStatus: string;
  txnStatus: string;
  rrn: string;
  settlementDate: string;
  billInvoice: string;
  invoice: string;
  approvalCode: string;
  type: string;
  zone: string;
  store: string;
  tid: string;
  mid: string;
  isAmex: boolean;
  _src: 'ZIP';
  _amex: boolean;
  /** Present only on rows excluded from recon; explains why. */
  _fReason?: string;
}

/** One `SaleSuccess` row from the HDFC/Mintoak UPI statement (.xlsx). */
export interface HdfcStatementRow {
  /** 12-digit RRN, non-digits stripped. */
  rrn: string;
  amount: number;
  date: Date;
  dateRaw: string;
  outlet: OutletCode;
  payer: string;
}

/** Result of parsing the HDFC statement, with counts of what was dropped. */
export interface HdfcStatementParse {
  rows: HdfcStatementRow[];
  /** Rows whose `Transaction State` was not `SaleSuccess`. */
  skippedFailed: number;
  /** Rows whose `City` did not map to a known outlet. */
  unknownCity: number;
}

/** The Payment Summary ("drawer") CSV — a single header row + single value row. */
export type SummaryData = Record<string, string>;

/** Payment Report parse result. */
export interface PRParse {
  rows: PRRow[];
  /** First parseable date found in the file; drives the business window. */
  bizDate: CivilDate | null;
}

/** ZIP parse result, split by the business-window / status / Paper-POS filters. */
export interface ZipParse {
  inside: ZipRow[];
  filtered: ZipRow[];
}

// ── Transaction-level matching ────────────────────────────────────────────
/**
 * A PR-side RRN group. Multiple orders can share one RRN (split bills),
 * so PR rows are grouped by RRN before comparison. Legacy: `prRRNMap`.
 */
export interface PRGroup {
  rrn: string;
  total: number;
  orders: string[];
  rows: PRRow[];
  paymentName: string;
  bank: string;
  date: string;
  employee: string;
  paymentType: string;
}

/**
 * A matched RRN: one terminal/statement row against one PR group.
 *
 * Generic over the terminal side because the same matcher serves both the
 * Pinelabs ZIP (`ZipRow`) and the HDFC statement (`HdfcStatementRow`).
 */
export interface ReconRow<T = ZipRow | HdfcStatementRow> {
  rrn: string;
  /** Terminal- (or statement-) side amount. Legacy name kept: `plAmt`. */
  plAmt: number;
  /** PR-side group total. */
  prAmt: number;
  /** `plAmt - prAmt`. Positive = excess on terminal side. */
  diff: number;
  orders: string[];
  pr: PRRow;
  prRows: PRRow[];
  /** The matched terminal-side row. Legacy name kept: `zip`. */
  zip: T;
  isManualAPOS: boolean;
  /** Manual APOS rows within ±0.50 are auto-squared-off. */
  squaredOff: boolean;
}

/** A PR row (or RRN group) with no terminal-side counterpart. */
export interface OnlyPOSRow extends Partial<PRRow> {
  orders: string[];
  amount: number;
  rrn: string;
  _note?: string;
}

/** A PR group whose RRN appeared more than once on the terminal side. */
export interface DupRRNRow extends Partial<PRRow> {
  orders: string[];
  _dupSrc: string;
  _note: string;
}

/** Output of the shared RRN-group matcher. Legacy: `matchTransactionLevel`. */
export interface MatchResult<T = ZipRow> {
  reconRows: ReconRow<T>[];
  onlyPOS: OnlyPOSRow[];
  onlyTerm: T[];
  dupRRN: DupRRNRow[];
}

// ── AMEX matching ─────────────────────────────────────────────────────────
/** An AMEX PR group flattened for code/amount matching. */
export interface AmexPR extends PRRow {
  orders: string[];
}

/** A successful AMEX match, and how it was reached. */
export interface AmexMatch {
  pr: AmexPR;
  zip: ZipRow;
  _matchBy: 'code' | 'amount';
}

/** An AMEX row that could not be matched because its key was ambiguous. */
export interface AmexDup {
  pr: AmexPR;
  _note: string;
  _dupIn: 'POS' | 'Terminal';
}

// ── Full reconciliation output ────────────────────────────────────────────
export interface PinelabsResult {
  reconRows: ReconRow[];
  onlyPOS: OnlyPOSRow[];
  onlyTerm: ZipRow[];
  dupRRN: DupRRNRow[];
  amexOk: AmexMatch[];
  amexDup: AmexDup[];
  amexDupTerm: ZipRow[];
}

/**
 * The complete output of `reconcile()` — the deterministic, side-effect-free
 * result of comparing the uploaded files. Everything a human later adds
 * (remarks, advances, BOH clears) lives in session state, not here.
 */
export interface ReconResult {
  pinelabs: PinelabsResult;
  /** Transaction-level Static UPI match; `null` when no HDFC statement was supplied. */
  upiHdfc: MatchResult<HdfcStatementRow> | null;
  swiggy: PRRow[];
  cash: PRRow[];
  upi: PRRow[];
  bills: PRRow[];
  bank: PRRow[];
  other: PRRow[];
  zipFiltered: ZipRow[];
}

/** Everything `reconcile()` needs. Replaces the legacy reads of global `S`. */
export interface ReconcileInput {
  prData: PRRow[];
  zipInside: ZipRow[];
  hdfcStmtRows?: HdfcStatementRow[] | null;
  /** Filters the HDFC statement to one outlet. Legacy read this from `S.outlet`. */
  outlet?: OutletCode | null;
}

// ── Final Recon Summary ───────────────────────────────────────────────────
/**
 * How a payment method's "expected" side is sourced.
 * - `source`  — always a transaction-level source report (Pinelabs terminal)
 * - `drawer`  — the Payment Summary drawer total
 * - `conditional` — source report when available, else drawer (HDFC Static UPI)
 */
export type FrsSourceType = 'source' | 'drawer' | 'conditional';

export interface FrsMethod {
  label: string;
  sourceType: FrsSourceType;
  /** Payment-name keys summed from the Payment Report. */
  prKeys: string[];
  /** Column keys summed from the Payment Summary. */
  sumKeys: string[];
  /** POS-integrated methods never block submission. */
  assumedReconciled?: boolean;
  reconciledNote?: string;
}

/** Resolved amounts for one FRS row. Legacy: `frsRowAmounts`. */
export interface FrsRowAmounts {
  pr: number;
  drawerAmt: number | null;
  sourceAmt: number | null;
  diff: number;
  usingSource: boolean;
}
