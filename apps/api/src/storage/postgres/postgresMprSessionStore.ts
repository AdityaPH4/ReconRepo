/**
 * Postgres-backed MPR (Layer 2) session store — same interface as
 * `memoryMprSessionStore.ts`. Not outlet-scoped, same as the memory version.
 */

import type { MprSessionDTO, MprSessionListItemDTO } from '@toit/contracts';
import type { Pool } from 'pg';
import type { MprSessionQuery, MprSessionStore } from '../types.js';

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
  };
}
