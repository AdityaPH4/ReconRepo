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
  /** POS Payment Report card number — AMEX transaction matching only. */
  cardNo?: string;
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

export type AdapterKey = 'KOTAK' | 'PINELABS' | 'AMEX' | 'HDFC_UPI' | 'HDFC_LINK';

/**
 * Closed shape, deliberately no index signature — `normaliseTransactionRows()`
 * only ever resolves these four column roles, regardless of adapter. An
 * adapter config listing any other alias (previously: `netAmount`, `fee`,
 * `mid`, `tid`, `store`, `channel`, `cardType`, `cardNetwork`, `foreign`,
 * `merchantVPA`, `merchantName`) would silently do nothing — this type now
 * catches that at compile time instead of letting it rot as dead config.
 */
export interface TransactionFields {
  rrn: string[];
  grossAmount: string[];
  txnDate: string[];
  settlementDate: string[];
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
  txnDate: string | null;
  /** Raw source string, kept for timestamp parsing (Pass 2 UPI matching). */
  txnDateRaw: string | null;
  settlementDate: string | null;
  _source: AdapterKey;
  _file: string;
}

/** One ROC (transaction-level) row from AMEX's settlement export (AMEX only). */
export interface AmexMprRow {
  /** Transaction Timestamp, normalised to a calendar date. */
  txnDate: string | null;
  /** Last 4 digits of Card Number. */
  cardLast4: string;
  /** Charge Amount. */
  amount: number;
  /** Payment Date — when AMEX actually paid this out. */
  settlementDate: string | null;
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

/** `ambiguous` — the Transaction Date + Card (last 4) key collided on either side; never guessed. */
export type AmexMatchStatus = 'settled' | 'mismatch' | 'pending' | 'unexpected' | 'ambiguous';

/** One matched (or unmatched) AMEX transaction — Layer-1 ledger row ↔ AMEX ROC row. */
export interface AmexResult {
  /** Transaction date — from the ledger side when present, else the MPR row's. */
  date: string | null;
  cardLast4: string;
  /** `''` for an `unexpected` row — no ledger counterpart to attribute an outlet to. */
  outlet: string;
  /** Ledger-side (Pinelabs terminal) amount; `null` for an `unexpected` MPR-only row. */
  l1Amount: number | null;
  mprRow: AmexMprRow | null;
  _match: AmexMatchStatus;
  _diff?: number | null;
  /** Set on `ambiguous` rows — which side the duplicate key was found on. */
  _note?: string;
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
