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
        `INSERT INTO recon.advances (id, outlet, data) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET outlet = $2, data = $3`,
        [advance.id, advance.outlet, advance],
      );
      return advance;
    },

    async list(outlet) {
      const { rows } = await pool.query<{ data: Advance }>(
        'SELECT data FROM recon.advances WHERE outlet = $1',
        [outlet],
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
        `SELECT aa.data FROM recon.advance_applications aa
         JOIN recon.advances a ON a.id = aa.advance_id
         WHERE a.outlet = $1`,
        [outlet],
      );
      return rows.map((r) => r.data);
    },
  };
}
