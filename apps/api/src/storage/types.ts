/**
 * Storage interfaces.
 *
 * Routes and services depend on these, never on S3 or Prisma directly. That is
 * what lets the app run today against local disk and an in-process map, and
 * move to S3 + Postgres later without a single route change.
 */

import type {
  ActionLogEntryDTO,
  ApprovalRequestDTO,
  ApprovalStatus,
  MprSessionDTO,
  MprSessionListItemDTO,
  SessionDTO,
  SessionListItemDTO,
  SessionStatus,
  UploadRole,
  UserRole,
} from '@toit/contracts';
import type { Advance, AdvanceApplication, BohEntry, OutletCode, TdsEntry } from '@toit/recon-core';

// ── Object storage: raw uploaded files, byte-for-byte ────────────────────

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
}

/**
 * Raw file storage. Objects are write-once: a session's source files are never
 * mutated, so any past reconciliation can be re-run from its original inputs.
 */
export interface ObjectStore {
  readonly driver: 'local' | 's3';
  put(input: PutObjectInput): Promise<{ key: string }>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
}

/** Builds the storage key for one upload. Keyed so a session's files sort together. */
export function buildStorageKey(
  sessionId: string,
  role: UploadRole,
  originalName: string,
): string {
  // Keep the original extension — it is the only hint of file type that
  // survives if someone inspects the bucket by hand.
  const ext = originalName.includes('.')
    ? originalName.slice(originalName.lastIndexOf('.')).toLowerCase()
    : '';
  const safe = ext.replace(/[^.a-z0-9]/g, '');
  return `sessions/${sessionId}/${role}${safe}`;
}

// ── Session storage: the queryable reconciliation record ────────────────

export interface SessionQuery {
  /** Admins pass `null` to see every outlet. */
  outlet?: OutletCode | null;
  status?: SessionStatus;
  limit?: number;
  /** Exact match on the persisted business date (`yyyy-mm-dd`) — the admin by-date lookup, for reaching further back than `limit` would otherwise show. */
  businessDate?: string;
}

export interface SessionStore {
  readonly driver: 'memory' | 'postgres';
  create(session: SessionDTO): Promise<SessionDTO>;
  get(id: string): Promise<SessionDTO | null>;
  list(query: SessionQuery): Promise<SessionListItemDTO[]>;
  /** Replaces the stored session. Used by draft edits and by submit. */
  update(id: string, session: SessionDTO): Promise<SessionDTO>;
  /**
   * Every `submitted` session not yet folded into a completed automated MPR
   * run (`meta.mprIncludedInSessionId` unset) — the automated MPR ingest
   * Lambda's input, not a UI-facing query. Returns full `SessionDTO`s
   * (including `.snapshot`), unlike `list()`'s slim `SessionListItemDTO`.
   */
  listPendingMpr(): Promise<SessionDTO[]>;
  /**
   * What the saved POS-recon JSON of one business day holds, counted in the
   * database without loading the snapshots: settlement-ledger rows per
   * acquirer, and distinct HDFC Static UPI order numbers. Only `submitted`
   * sessions count (a draft or discarded one isn't the day's record).
   * `outlet` null pools every outlet.
   */
  snapshotCountsForDay(businessDate: string, outlet: string | null): Promise<SnapshotDayCounts>;
}

export interface SnapshotDayCounts {
  sessions: number;
  byAcquirer: Record<string, number>;
  staticUpiOrders: number;
}

// ── Advances repository — outlet-scoped cross-session store ──────────────
//
// A draft session's own advances/applications are NOT written here until
// submit succeeds — see `packages/recon-core/src/justification/types.ts`
// (`JustificationState`) and the plan's "draft-until-submit by
// non-persistence" decision. This store only ever holds committed rows.

export interface AdvanceStore {
  readonly driver: 'memory' | 'postgres';
  create(advance: Advance): Promise<Advance>;
  get(id: string): Promise<Advance | null>;
  /** `outlet: null` lists across every outlet — for an admin viewing the standalone Advance Closure module. */
  list(outlet: OutletCode | null): Promise<Advance[]>;
  recordApplication(application: AdvanceApplication): Promise<AdvanceApplication>;
  listApplications(outlet: OutletCode | null): Promise<AdvanceApplication[]>;
  /** Durable closure outside any recon session — see `Advance.status`. */
  close(id: string, closedAt: string, closedBy: string, closedReason: string): Promise<Advance>;
  /** Undoes a mistaken closure — back to `open`, clearing `closedAt`/`closedBy`/`closedReason`. Mirrors `TdsStore.reopen()`; the 7-day eligibility window is enforced by the route, not here. */
  reopen(id: string): Promise<Advance>;
}

// ── Bills-on-hold repository — outlet-scoped cross-session store ─────────

export interface BohStore {
  readonly driver: 'memory' | 'postgres';
  create(entry: BohEntry): Promise<BohEntry>;
  get(id: string): Promise<BohEntry | null>;
  list(outlet: OutletCode): Promise<BohEntry[]>;
  /** Flips a row from `open` to `cleared` — the durable fix over legacy (see README/plan). */
  clear(id: string, clearedAt: string, clearedBySessionId: string): Promise<BohEntry>;
  /** Undoes a mistaken clearance — back to `open`, clearing `clearedAt`/`clearedBySessionId`. Mirrors `AdvanceStore.reopen()`; the reopen-window eligibility is enforced by the route, not here. */
  reopen(id: string): Promise<BohEntry>;
}

// ── Unreconciled TDS repository — outlet-scoped, admin closes cross-outlet ──

export interface TdsStore {
  readonly driver: 'memory' | 'postgres';
  create(entry: TdsEntry): Promise<TdsEntry>;
  get(id: string): Promise<TdsEntry | null>;
  /** `outlet: null` lists across every outlet — for the admin/Accounts view. */
  list(outlet: OutletCode | null, status?: 'open' | 'closed'): Promise<TdsEntry[]>;
  close(id: string, closedAt: string, closedBy: string, closedNote: string | null): Promise<TdsEntry>;
  /** Undoes a mistaken closure — back to `open`, clearing `closedAt`/`closedBy`/`closedNote`. */
  reopen(id: string): Promise<TdsEntry>;
}

// ── MPR (Layer 2) session storage ─────────────────────────────────────────
//
// Unlike the legacy `mpr-recon` tool (stateless — upload, view, reset,
// nothing saved), runs are persisted here so a GM can revisit one later.
// Not outlet-scoped: one run can span snapshots from several outlets.

export interface MprSessionQuery {
  createdBy?: string;
  limit?: number;
}

type MprResult = MprSessionDTO['result'];
/** One stored row tagged with the run it lives in and its bucket — discriminated on `bucket`. */
export type MprBucketRow = { [B in keyof MprResult]: { runId: string; bucket: B; row: MprResult[B][number] } }[keyof MprResult];

export interface MprDayRows {
  runs: Array<{ id: string; meta: MprSessionDTO['meta'] }>;
  rows: MprBucketRow[];
  bankRows: MprBucketRow[];
  /** Settled bank RRNs, plus `date|cardLast4|amount` for settled/mismatched AMEX — used to drop bank-only rows that have since reconciled. */
  settledKeys: Set<string>;
}

export interface MprSessionStore {
  readonly driver: 'memory' | 'postgres';
  create(session: MprSessionDTO): Promise<MprSessionDTO>;
  get(id: string): Promise<MprSessionDTO | null>;
  list(query: MprSessionQuery): Promise<MprSessionListItemDTO[]>;
  /**
   * Every matching session, in full — for the day-pooling routes
   * (`gm-status`/`gm-day`/`day`), which need every row of every session, not
   * just the summary counts `list()` returns. A single full MPR session's
   * JSON can run tens of MB, so this exists specifically so those routes
   * fetch it once each, not once via `list()` (to get the id) and again via
   * `get()` (to get the actual rows).
   */
  listFull(query: MprSessionQuery): Promise<MprSessionDTO[]>;
  /**
   * Just what the day views need, filtered in the database: every run's meta
   * (newest first), the rows of the date-keyed buckets whose `_businessDate`
   * is one of `dates`, and — only when `bankSide` — the bank-only rows
   * (ambiguous, unexpected, AMEX unexpected) plus every settled key, which
   * carry no business date and are filtered by the caller. Fetching whole
   * runs instead is hundreds of MB per request.
   */
  listDayRows(dates: string[], bankSide: boolean): Promise<MprDayRows>;
  /**
   * How many rows are still `open` across the newest `limit` runs — counted
   * in the database, so the admin home badge never has to download runs.
   */
  countOpenRows(limit: number): Promise<number>;
  /** Whole-object replace — used to persist a row's close-with-note mutation. */
  update(id: string, session: MprSessionDTO): Promise<MprSessionDTO>;
}

// ── Approval requests — a GM re-reconciling the same outlet+date needs an ──
// admin to unblock it. See `services/approvalService.ts`.

export interface ApprovalQuery {
  outlet?: OutletCode;
  status?: ApprovalStatus;
  requestedBy?: string;
}

export interface ApprovalStore {
  readonly driver: 'memory' | 'postgres';
  create(request: ApprovalRequestDTO): Promise<ApprovalRequestDTO>;
  get(id: string): Promise<ApprovalRequestDTO | null>;
  list(query: ApprovalQuery): Promise<ApprovalRequestDTO[]>;
  decide(id: string, status: 'approved' | 'denied', decidedBy: string, decidedAt: string): Promise<ApprovalRequestDTO>;
}

// ── Action log — a rolling audit trail of every mutating request, split by ──
// role, 10-day retention. See `middleware/actionLog.ts`.

export interface ActionLogStore {
  readonly driver: 'memory' | 'postgres';
  /** Also prunes anything past the retention window — self-cleaning, no separate scheduled job. */
  record(entry: Omit<ActionLogEntryDTO, 'id'>): Promise<void>;
  list(role: UserRole, limit?: number): Promise<ActionLogEntryDTO[]>;
}
