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
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS advances_outlet_idx ON recon.advances (outlet);

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
