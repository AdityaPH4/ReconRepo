/**
 * Postgres-backed unreconciled-TDS repository — same interface as
 * `memoryTdsStore.ts`, including the durable `open` → `closed` flip.
 */

import type { TdsEntry } from '@toit/recon-core';
import type { Pool } from 'pg';
import type { TdsStore } from '../types.js';

export function createPostgresTdsStore(pool: Pool): TdsStore {
  return {
    driver: 'postgres',

    async create(entry) {
      await pool.query(
        `INSERT INTO recon.tds_entries (id, outlet, status, data) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET outlet = $2, status = $3, data = $4`,
        [entry.id, entry.outlet, entry.status, entry],
      );
      return entry;
    },

    async get(id) {
      const { rows } = await pool.query<{ data: TdsEntry }>('SELECT data FROM recon.tds_entries WHERE id = $1', [
        id,
      ]);
      return rows[0]?.data ?? null;
    },

    async list(outlet, status) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (outlet !== null) {
        params.push(outlet);
        conditions.push(`outlet = $${params.length}`);
      }
      if (status !== undefined) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await pool.query<{ data: TdsEntry }>(
        `SELECT data FROM recon.tds_entries ${where}`,
        params,
      );
      return rows.map((r) => r.data);
    },

    async close(id, closedAt, closedBy, closedNote) {
      const { rows } = await pool.query<{ data: TdsEntry }>('SELECT data FROM recon.tds_entries WHERE id = $1', [
        id,
      ]);
      const entry = rows[0]?.data;
      if (!entry) throw new Error(`TDS entry not found: ${id}`);
      const closed: TdsEntry = { ...entry, status: 'closed', closedAt, closedBy, closedNote };
      await pool.query(`UPDATE recon.tds_entries SET status = 'closed', data = $2 WHERE id = $1`, [id, closed]);
      return closed;
    },

    async reopen(id) {
      const { rows } = await pool.query<{ data: TdsEntry }>('SELECT data FROM recon.tds_entries WHERE id = $1', [
        id,
      ]);
      const entry = rows[0]?.data;
      if (!entry) throw new Error(`TDS entry not found: ${id}`);
      const reopened: TdsEntry = { ...entry, status: 'open', closedAt: null, closedBy: null, closedNote: null };
      await pool.query(`UPDATE recon.tds_entries SET status = 'open', data = $2 WHERE id = $1`, [id, reopened]);
      return reopened;
    },
  };
}
