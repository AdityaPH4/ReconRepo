/**
 * @toit/contracts — the HTTP wire format.
 *
 * The single shared definition of what the API sends and the web app receives.
 * Types only: no runtime code, no dependencies beyond `@toit/recon-core` types,
 * so either side can import it without pulling in the other's stack.
 */

import type {
  FileRole,
  OutletCode,
  ReconResult,
  SummaryData,
} from '@toit/recon-core/display';

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
  swiggy: { prTotal: number };
  /** Pinelabs is transaction-level, so it reports terminal vs POS instead. */
  pinelabs: { prTotal: number; terminalTotal: number; diff: number };
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

// ── Auth ──────────────────────────────────────────────────────────────────

export type UserRole = 'gm' | 'admin';

export interface CurrentUserDTO {
  email: string;
  role: UserRole;
  /** `null` for admins, who see every outlet. */
  outlet: OutletCode | null;
}

// ── Errors ────────────────────────────────────────────────────────────────

export interface ApiErrorDTO {
  error: string;
  /** Field-level detail for validation failures. */
  details?: Record<string, string>;
}
