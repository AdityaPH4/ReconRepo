/**
 * Postgres-backed MPR (Layer 2) session store — same interface as
 * `memoryMprSessionStore.ts`. Not outlet-scoped, same as the memory version.
 */

import type { MprSessionDTO, MprSessionListItemDTO } from '@toit/contracts';
import type { Pool } from 'pg';
import type { MprBucketRow, MprSessionQuery, MprSessionStore } from '../types.js';

/** Same 200-most-recent-runs window the day views always pooled over. */
const RECENT_RUNS = `(SELECT id, created_at, data FROM recon.mpr_sessions ORDER BY created_at DESC LIMIT 200) ms`;

function toListItem(s: MprSessionDTO): MprSessionListItemDTO {
  return {
    id: s.meta.id,
    createdAt: s.meta.createdAt,
    createdBy: s.meta.createdBy,
    businessDates: s.meta.businessDates,
    outlets: s.meta.outlets,
    settledCount: s.result.settled.length,
    mismatchCount: s.result.amountMismatch.length,
    pendingCount: s.result.pending.length,
    unexpectedCount: s.result.unexpected.length,
  };
}

export function createPostgresMprSessionStore(pool: Pool): MprSessionStore {
  return {
    driver: 'postgres',

    async create(session) {
      await pool.query(
        `INSERT INTO recon.mpr_sessions (id, created_by, created_at, data) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET created_by = $2, created_at = $3, data = $4`,
        [session.meta.id, session.meta.createdBy, session.meta.createdAt, session],
      );
      return session;
    },

    async get(id) {
      const { rows } = await pool.query<{ data: MprSessionDTO }>(
        'SELECT data FROM recon.mpr_sessions WHERE id = $1',
        [id],
      );
      return rows[0]?.data ?? null;
    },

    async list({ createdBy, limit = 50 }: MprSessionQuery) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (createdBy) {
        params.push(createdBy);
        conditions.push(`created_by = $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);
      const { rows } = await pool.query<{ data: MprSessionDTO }>(
        `SELECT data FROM recon.mpr_sessions ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map((r) => toListItem(r.data));
    },

    async listFull({ createdBy, limit = 50 }: MprSessionQuery) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (createdBy) {
        params.push(createdBy);
        conditions.push(`created_by = $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);
      const { rows } = await pool.query<{ data: MprSessionDTO }>(
        `SELECT data FROM recon.mpr_sessions ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map((r) => r.data);
    },

    async listDayRows(dates, bankSide) {
      const runs = await pool.query<{ id: string; meta: MprSessionDTO['meta'] }>(
        `SELECT id, data->'meta' AS meta FROM recon.mpr_sessions ORDER BY created_at DESC LIMIT 200`,
      );
      const rows = await pool.query<MprBucketRow>(
        `SELECT ms.id AS "runId", b.bucket, r AS row
         FROM ${RECENT_RUNS}
         CROSS JOIN unnest(ARRAY['settled','amountMismatch','pending','amexResults','upiResults']) AS b(bucket)
         CROSS JOIN LATERAL jsonb_array_elements(ms.data->'result'->b.bucket) AS r
         WHERE r->>'_businessDate' = ANY($1)`,
        [dates],
      );
      if (!bankSide) return { runs: runs.rows, rows: rows.rows, bankRows: [], settledKeys: new Set() };

      const bankRows = await pool.query<MprBucketRow>(
        `SELECT ms.id AS "runId", b.bucket, r AS row
         FROM ${RECENT_RUNS}
         CROSS JOIN unnest(ARRAY['ambiguous','unexpected','amexResults']) AS b(bucket)
         CROSS JOIN LATERAL jsonb_array_elements(ms.data->'result'->b.bucket) AS r
         WHERE b.bucket <> 'amexResults' OR r->>'_match' = 'unexpected'`,
      );
      const settled = await pool.query<{ k: string }>(
        `SELECT DISTINCT k FROM (
           SELECT r->'mpr'->>'rrn' AS k FROM ${RECENT_RUNS}, jsonb_array_elements(ms.data->'result'->'settled') r
           UNION ALL
           SELECT r->'mpr'->>'rrn' FROM ${RECENT_RUNS}, jsonb_array_elements(ms.data->'result'->'upiResults') r WHERE r->>'_match' = 'settled'
           UNION ALL
           SELECT concat_ws('|', r->>'date', r->>'cardLast4', r->'mprRow'->>'amount')
           FROM ${RECENT_RUNS}, jsonb_array_elements(ms.data->'result'->'amexResults') r WHERE r->>'_match' IN ('settled','mismatch')
         ) s WHERE k IS NOT NULL`,
      );
      return { runs: runs.rows, rows: rows.rows, bankRows: bankRows.rows, settledKeys: new Set(settled.rows.map((r) => r.k)) };
    },

    async update(id, session) {
      const { rowCount } = await pool.query(`UPDATE recon.mpr_sessions SET data = $2 WHERE id = $1`, [id, session]);
      if (!rowCount) throw new Error(`MPR session not found: ${id}`);
      return session;
    },
  };
}
