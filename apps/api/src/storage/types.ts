/**
 * Storage interfaces.
 *
 * Routes and services depend on these, never on S3 or Prisma directly. That is
 * what lets the app run today against local disk and an in-process map, and
 * move to S3 + Postgres later without a single route change.
 */

import type {
  MprSessionDTO,
  MprSessionListItemDTO,
  SessionDTO,
  SessionListItemDTO,
  SessionStatus,
  UploadRole,
} from '@toit/contracts';
import type { Advance, AdvanceApplication, BohEntry, OutletCode } from '@toit/recon-core';

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
}

export interface SessionStore {
  readonly driver: 'memory' | 'postgres';
  create(session: SessionDTO): Promise<SessionDTO>;
  get(id: string): Promise<SessionDTO | null>;
  list(query: SessionQuery): Promise<SessionListItemDTO[]>;
  /** Replaces the stored session. Used by draft edits and by submit. */
  update(id: string, session: SessionDTO): Promise<SessionDTO>;
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
  list(outlet: OutletCode): Promise<Advance[]>;
  recordApplication(application: AdvanceApplication): Promise<AdvanceApplication>;
  listApplications(outlet: OutletCode): Promise<AdvanceApplication[]>;
}

// ── Bills-on-hold repository — outlet-scoped cross-session store ─────────

export interface BohStore {
  readonly driver: 'memory' | 'postgres';
  create(entry: BohEntry): Promise<BohEntry>;
  get(id: string): Promise<BohEntry | null>;
  list(outlet: OutletCode): Promise<BohEntry[]>;
  /** Flips a row from `open` to `cleared` — the durable fix over legacy (see README/plan). */
  clear(id: string, clearedAt: string, clearedBySessionId: string): Promise<BohEntry>;
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

export interface MprSessionStore {
  readonly driver: 'memory' | 'postgres';
  create(session: MprSessionDTO): Promise<MprSessionDTO>;
  get(id: string): Promise<MprSessionDTO | null>;
  list(query: MprSessionQuery): Promise<MprSessionListItemDTO[]>;
}
