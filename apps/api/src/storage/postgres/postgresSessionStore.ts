/**
 * Postgres-backed session store — same interface as `memorySessionStore.ts`,
 * durable across process restarts and Lambda invocations. Each row keeps a
 * few indexed columns (outlet, status, created_at) for `list()`'s filters
 * plus the full DTO in `data` — see `postgres/schema.sql`.
 */

import type { SessionDTO, SessionListItemDTO } from '@toit/contracts';
import type { Pool } from 'pg';
import type { SessionQuery, SessionStore } from '../types.js';

function toListItem(s: SessionDTO): SessionListItemDTO {
  return {
    id: s.meta.id,
    status: s.meta.status,
    outlet: s.meta.outlet,
    businessDate: s.meta.businessDate,
    createdAt: s.meta.createdAt,
    grandDiff: s.frs.grandDiff,
  };
}

export function createPostgresSessionStore(pool: Pool): SessionStore {
  return {
    driver: 'postgres',

    async create(session) {
      await pool.query(
        `INSERT INTO recon.sessions (id, outlet, status, created_at, data)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET outlet = $2, status = $3, created_at = $4, data = $5`,
        [session.meta.id, session.meta.outlet, session.meta.status, session.meta.createdAt, session],
      );
      return session;
    },

    async get(id) {
      const { rows } = await pool.query<{ data: SessionDTO }>('SELECT data FROM recon.sessions WHERE id = $1', [id]);
      return rows[0]?.data ?? null;
    },

    async list({ outlet, status, limit = 50 }: SessionQuery) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (outlet) {
        params.push(outlet);
        conditions.push(`outlet = $${params.length}`);
      }
      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);
      const { rows } = await pool.query<{ data: SessionDTO }>(
        `SELECT data FROM recon.sessions ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map((r) => toListItem(r.data));
    },

    async update(id, session) {
      const { rowCount } = await pool.query(
        `UPDATE recon.sessions SET outlet = $2, status = $3, created_at = $4, data = $5 WHERE id = $1`,
        [id, session.meta.outlet, session.meta.status, session.meta.createdAt, session],
      );
      if (!rowCount) throw new Error(`Session not found: ${id}`);
      return session;
    },
  };
}
