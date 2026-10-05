/**
 * Postgres-backed advances repository — same interface as
 * `memoryAdvanceStore.ts`. `listApplications(outlet)` joins through
 * `advances` since applications carry no outlet of their own (see
 * `AdvanceApplication` in recon-core).
 */

import type { Advance, AdvanceApplication } from '@toit/recon-core';
import type { Pool } from 'pg';
import type { AdvanceStore } from '../types.js';

export function createPostgresAdvanceStore(pool: Pool): AdvanceStore {
  return {
    driver: 'postgres',

    async create(advance) {
      await pool.query(
        `INSERT INTO recon.advances (id, outlet, status, data) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET outlet = $2, status = $3, data = $4`,
        [advance.id, advance.outlet, advance.status, advance],
      );
      return advance;
    },

    async get(id) {
      const { rows } = await pool.query<{ data: Advance }>('SELECT data FROM recon.advances WHERE id = $1', [id]);
      return rows[0]?.data ?? null;
    },

    async list(outlet) {
      const { rows } = await pool.query<{ data: Advance }>(
        outlet === null
          ? 'SELECT data FROM recon.advances'
          : 'SELECT data FROM recon.advances WHERE outlet = $1',
        outlet === null ? [] : [outlet],
      );
      return rows.map((r) => r.data);
    },

    async recordApplication(application) {
      await pool.query(
        `INSERT INTO recon.advance_applications (id, advance_id, data) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET advance_id = $2, data = $3`,
        [application.id, application.advanceId, application],
      );
      return application;
    },

    async listApplications(outlet) {
      const { rows } = await pool.query<{ data: AdvanceApplication }>(
        outlet === null
          ? `SELECT aa.data FROM recon.advance_applications aa`
          : `SELECT aa.data FROM recon.advance_applications aa
             JOIN recon.advances a ON a.id = aa.advance_id
             WHERE a.outlet = $1`,
        outlet === null ? [] : [outlet],
      );
      return rows.map((r) => r.data);
    },

    async close(id, closedAt, closedBy, closedReason) {
      const { rows } = await pool.query<{ data: Advance }>('SELECT data FROM recon.advances WHERE id = $1', [id]);
      const advance = rows[0]?.data;
      if (!advance) throw new Error(`Advance not found: ${id}`);
      const closed: Advance = { ...advance, status: 'closed', closedAt, closedBy, closedReason };
      await pool.query(`UPDATE recon.advances SET status = 'closed', data = $2 WHERE id = $1`, [id, closed]);
      return closed;
    },

    async reopen(id) {
      const { rows } = await pool.query<{ data: Advance }>('SELECT data FROM recon.advances WHERE id = $1', [id]);
      const advance = rows[0]?.data;
      if (!advance) throw new Error(`Advance not found: ${id}`);
      const reopened: Advance = { ...advance, status: 'open', closedAt: null, closedBy: null, closedReason: null };
      await pool.query(`UPDATE recon.advances SET status = 'open', data = $2 WHERE id = $1`, [id, reopened]);
      return reopened;
    },
  };
}
