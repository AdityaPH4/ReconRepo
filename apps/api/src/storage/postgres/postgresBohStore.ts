/**
 * Postgres-backed bills-on-hold repository — same interface as
 * `memoryBohStore.ts`, including the durable `open` → `cleared` flip that
 * legacy never had.
 */

import type { BohEntry } from '@toit/recon-core';
import type { Pool } from 'pg';
import type { BohStore } from '../types.js';

export function createPostgresBohStore(pool: Pool): BohStore {
  return {
    driver: 'postgres',

    async create(entry) {
      await pool.query(
        `INSERT INTO recon.boh_entries (id, outlet, status, data) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET outlet = $2, status = $3, data = $4`,
        [entry.id, entry.outlet, entry.status, entry],
      );
      return entry;
    },

    async get(id) {
      const { rows } = await pool.query<{ data: BohEntry }>('SELECT data FROM recon.boh_entries WHERE id = $1', [
        id,
      ]);
      return rows[0]?.data ?? null;
    },

    async list(outlet) {
      const { rows } = await pool.query<{ data: BohEntry }>(
        'SELECT data FROM recon.boh_entries WHERE outlet = $1',
        [outlet],
      );
      return rows.map((r) => r.data);
    },

    async clear(id, clearedAt, clearedBySessionId) {
      const { rows } = await pool.query<{ data: BohEntry }>('SELECT data FROM recon.boh_entries WHERE id = $1', [
        id,
      ]);
      const entry = rows[0]?.data;
      if (!entry) throw new Error(`BOH entry not found: ${id}`);
      const cleared: BohEntry = { ...entry, status: 'cleared', clearedAt, clearedBySessionId };
      await pool.query(`UPDATE recon.boh_entries SET status = 'cleared', data = $2 WHERE id = $1`, [id, cleared]);
      return cleared;
    },
  };
}
