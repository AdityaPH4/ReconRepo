/**
 * Domain types for the Layer-2 (MPR) reconciliation engine.
 * Ported from `legacy/mpr-recon (10).html` lines 227–311.
 *
 * Field names are kept identical to the legacy implementation so the port
 * stays verifiable by diffing against it, same convention as `recon-core`.
 */

// ── Layer-1 input (the first module's settlement snapshot) ─────────────────

/**
 * One row of a Layer-1 settlement ledger, tagged with which business date's
 * snapshot it came from. Deliberately untyped against `@toit/recon-core`'s
 * `SettlementLedgerRow` — Layer 2 only reads `rrn`/`plAmount`/`acquirer`/`mid`/
 * `plSettlementDate`/`invoice`/`outlet`/`store`/`l1Status`/`l1Remark`/`l1Diff`,
 * and accepting anything `Record`-shaped keeps this package decoupled from
 * `recon-core`'s snapshot type evolving.
 */
export interface TaggedLedgerRow {
  rrn: string;
  authCode?: string;
  acquirer?: string;
  mid?: string;
  invoice?: string;
  plAmount: number;
  plDate?: string;
  plSettlementDate?: string;
  posAmount?: number;
  posOrderNo?: string;
  outlet?: string;
  store?: string;
  l1Status?: string;
  l1Remark?: string | null;
  l1Diff?: number;
  _businessDate: string;
}

export interface TaggedUpiTransaction {
  orderNo: string;
  date: string;
  amount: number;
  paymentName: string;
  source: 'HDFC' | 'Kotak';
  rrn: string;
  employee: string;
  _businessDate: string;
}

export interface TaggedUpiJustification {
  sign: 'excess' | 'shortage';
  remark: string;
  rrn: string;
  description: string | null;
  outlet?: string;
  amount: number;
  source: string;
  _businessDate: string;
  /** Set during matching once this justification has explained one MPR row — prevents reuse. */
  _usedForMPR?: boolean;
}

// ── Bank adapters ────────────────────────────────────────────────────────

export type AdapterKey = 'KOTAK' | 'PINELABS' | 'AMEX' | 'HDFC_UPI';

export interface TransactionFields {
  rrn: string[];
  grossAmount: string[];
  netAmount: string[];
  txnDate: string[];
  settlementDate: string[];
  fee: string[];
  [extra: string]: string[];
}

export interface BatchFields {
  settlementDate: string[];
  settlementNumber: string[];
  submissionAmount: string[];
  merchantFees: string[];
  settlementAmount: string[];
  dbaName: string[];
}

export interface AdapterDef {
  label: string;
  color: string;
  /** AMEX only — matched by daily batch submission, not per-RRN. */
  matchStrategy?: 'batch';
  /** Pinelabs only — the export always has this sheet name. */
  sheet?: string;
  /** Pinelabs only — 0-indexed; row 0 is a grouping-label row, bypassing fingerprint scanning. */
  headerRow?: number;
  headerFingerprint: string[];
  fields: TransactionFields | BatchFields;
  /** Kotak — footer marker text; a row containing it (anywhere) ends the data. */
  nullRRNMarker?: string;
  /** HDFC UPI — footer rows have a null RRN column; drop them. */
  nullRRNStrategy?: 'skip_null';
}

// ── Parsed MPR file → normalised row shapes ─────────────────────────────

/** Transaction-level row (Kotak / Pinelabs / HDFC-UPI-terminal). */
export interface MprRow {
  rrn: string | null;
  grossAmount: number;
  netAmount: number | null;
  txnDate: string | null;
  /** Raw source string, kept for timestamp parsing (Pass 2 UPI matching). */
  txnDateRaw: string | null;
  settlementDate: string | null;
  fee: number;
  _source: AdapterKey;
  _file: string;
}

/** Batch-level row (AMEX only). */
export interface AmexMprRow {
  mid: string;
  submissionDate: string;
  settlementDate: string;
  submissionAmount: number;
  transactionCount: number;
  socNumber: string;
  dbaName: string;
  _file: string;
}

export interface ParsedMprFile {
  source: AdapterKey | 'UNKNOWN';
  matchStrategy?: 'batch' | 'rrn' | 'amex_submission';
  rows: MprRow[] | AmexMprRow[];
  error?: string;
  filename: string;
}

// ── Match engine ─────────────────────────────────────────────────────────

export interface MatchInput {
  sessions: TaggedLedgerRow[];
  mprParsed: ParsedMprFile[];
  upiPRRows: TaggedUpiTransaction[];
  upiJustifications: TaggedUpiJustification[];
}

export interface SettledRow extends TaggedLedgerRow {
  mpr: MprRow;
  _diff: number;
}

export interface PendingRow extends TaggedLedgerRow {
  _reason: 'No RRN' | 'Not in MPR';
}

/** Two or more MPR rows shared the same RRN — legacy silently drops all but the last; the port flags it instead. */
export interface AmbiguousMprRow {
  rrn: string;
  candidates: MprRow[];
}

export interface UnexpectedMprRow {
  rrn: string;
  mprAmount: number;
  mprDate: string | null;
  mprTxnDate?: string | null;
  _source: AdapterKey;
  _file: string;
}

export type AmexMatchStatus = 'settled' | 'mismatch' | 'pending' | 'unexpected';

export interface AmexResult {
  mid: string;
  date: string | null;
  timestamp: string | null;
  outlet: string;
  txnCount: number;
  l1Total: number | null;
  mprRow: AmexMprRow | null;
  _match: AmexMatchStatus;
  _diff?: number | null;
  socNumber: string;
  dbaName: string;
  socExpected?: number | null;
  socMatch?: boolean | null;
}

export type UpiMatchStatus = 'settled' | 'mismatch' | 'pending' | 'partial';
export type UpiMatchBy = 'RRN' | 'Amount + Date' | 'rrn' | 'amount' | null;

export interface UpiResult {
  pr: TaggedUpiTransaction[] | TaggedUpiTransaction | { amount: number; orderNo: string; date: string; outlet: string; rrn: string };
  mpr: MprRow | null;
  _match: UpiMatchStatus;
  _diff: number | null;
  _matchBy: UpiMatchBy;
  _multiRRN?: boolean;
  _invalidRRNs?: string[];
  _dateAdjusted?: boolean;
  _timeDiffSec?: number | null;
  _gmNote?: string;
}

export interface MatchResult {
  settled: SettledRow[];
  amountMismatch: SettledRow[];
  pending: PendingRow[];
  ambiguous: AmbiguousMprRow[];
  unexpected: UnexpectedMprRow[];
  amexResults: AmexResult[];
  upiResults: UpiResult[];
}
