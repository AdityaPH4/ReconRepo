-- Postgres schema for the recon app's persisted storage.
--
-- Every DTO here is already a JSON-safe nested object (see `Jsonified<>` in
-- @toit/contracts), so each store is one table: an id, a handful of indexed
-- columns for exactly what its query methods filter on, and the full DTO in
-- a `data JSONB` column. Run this once against the target database — it is
-- idempotent (safe to re-run).
--
-- Scoped to its own schema so this app never touches any other schema in a
-- shared database.

CREATE SCHEMA IF NOT EXISTS recon;

CREATE TABLE IF NOT EXISTS recon.sessions (
  id TEXT PRIMARY KEY,
  outlet TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_outlet_status_idx ON recon.sessions (outlet, status);
CREATE INDEX IF NOT EXISTS sessions_created_at_idx ON recon.sessions (created_at DESC);

CREATE TABLE IF NOT EXISTS recon.advances (
  id TEXT PRIMARY KEY,
  outlet TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS advances_outlet_idx ON recon.advances (outlet);

-- Advance closure: a corporate-booking advance returned directly to the POC
-- (outside recon) is never drawn down via `advance_applications`, so it
-- needs a durable open/closed status of its own. `CREATE TABLE` above
-- already declares `status` for a fresh install; the two statements below
-- are what actually apply to the already-deployed production table, which
-- predates this column entirely.
--
-- `ADD COLUMN ... DEFAULT 'open'` with a constant default is a fast,
-- metadata-only change on Postgres 11+ (existing rows are not rewritten).
-- `lock_timeout` makes it fail fast/retryable instead of queueing
-- indefinitely behind a long-running transaction on this table.
SET lock_timeout = '5s';
ALTER TABLE recon.advances ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
CREATE INDEX IF NOT EXISTS advances_outlet_status_idx ON recon.advances (outlet, status);

-- The ADD COLUMN above only patches the promoted SQL column — every
-- pre-existing row's `data` JSON has no "status"/"closedAt"/"closedBy"/
-- "closedReason" keys at all (they didn't exist yet when those rows were
-- written), so a naive reader deserializes `status: undefined` for every
-- legacy advance without this backfill. Idempotent — a no-op once run.
UPDATE recon.advances
SET data = data || jsonb_build_object('status', 'open', 'closedAt', null, 'closedBy', null, 'closedReason', null)
WHERE NOT (data ? 'status');

CREATE TABLE IF NOT EXISTS recon.advance_applications (
  id TEXT PRIMARY KEY,
  advance_id TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS advance_applications_advance_id_idx ON recon.advance_applications (advance_id);

CREATE TABLE IF NOT EXISTS recon.boh_entries (
  id TEXT PRIMARY KEY,
  outlet TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS boh_entries_outlet_status_idx ON recon.boh_entries (outlet, status);

CREATE TABLE IF NOT EXISTS recon.tds_entries (
  id TEXT PRIMARY KEY,
  outlet TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tds_entries_outlet_status_idx ON recon.tds_entries (outlet, status);
CREATE INDEX IF NOT EXISTS tds_entries_status_idx ON recon.tds_entries (status);

CREATE TABLE IF NOT EXISTS recon.mpr_sessions (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS mpr_sessions_created_by_idx ON recon.mpr_sessions (created_by);
CREATE INDEX IF NOT EXISTS mpr_sessions_created_at_idx ON recon.mpr_sessions (created_at DESC);

CREATE TABLE IF NOT EXISTS recon.approval_requests (
  id TEXT PRIMARY KEY,
  outlet TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  data JSONB NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS approval_requests_outlet_status_idx ON recon.approval_requests (outlet, status);

-- Rolling audit trail of every mutating request, split by role — 10-day
-- retention, pruned by the app itself on every write (see
-- postgresActionLogStore.ts), not a scheduled job. Flat columns, no JSONB —
-- nothing here needs a richer per-row shape.
CREATE TABLE IF NOT EXISTS recon.action_logs (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  outlet TEXT,
  performed_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS action_logs_role_created_at_idx ON recon.action_logs (role, created_at DESC);

-- Per-day MPR progress counters. `mpr_day_totals` is how many POS transactions
-- an outlet's day has per bank, taken from that day's saved JSON snapshot when
-- it's imported. `mpr_day_cleared` is the set of those transactions MPR has
-- cleared so far (settled by the bank, or resolved by an admin) plus the
-- mismatched ones. It holds the transactions themselves, not a number, so
-- re-applying a run or a resent bank file can never count one twice. Open =
-- total - cleared. `session_id` ties both to the Layer-1 session they were
-- built from, so a re-submitted day starts clean.
CREATE TABLE IF NOT EXISTS recon.mpr_day_totals (
  business_date TEXT NOT NULL,
  outlet TEXT NOT NULL,
  bank TEXT NOT NULL,
  total INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_date, outlet, bank)
);
CREATE TABLE IF NOT EXISTS recon.mpr_day_cleared (
  business_date TEXT NOT NULL,
  outlet TEXT NOT NULL,
  bank TEXT NOT NULL,
  row_key TEXT NOT NULL,
  state TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (business_date, outlet, bank, row_key)
);
