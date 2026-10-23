/**
 * Postgres-backed action-log store — flat columns, no JSONB blob (nothing
 * here needs the richer per-row shape every other store carries). 10-day
 * retention, pruned on every write — see `ActionLogStore`'s own doc comment.
 */

import { randomUUID } from 'node:crypto';
import type { ActionLogEntryDTO } from '@toit/contracts';
import type { Pool } from 'pg';
import type { ActionLogStore } from '../types.js';

const RETENTION_DAYS = 10;

export function createPostgresActionLogStore(pool: Pool): ActionLogStore {
  return {
    driver: 'postgres',

    async record(entry) {
      await pool.query(
        `INSERT INTO recon.action_logs (id, role, action, outlet, performed_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), entry.role, entry.action, entry.outlet, entry.performedBy, entry.createdAt],
      );
      await pool.query(`DELETE FROM recon.action_logs WHERE created_at < now() - make_interval(days => $1)`, [
        RETENTION_DAYS,
      ]);
    },

    async list(role, limit = 200) {
      const { rows } = await pool.query<ActionLogEntryDTO>(
        `SELECT id, role, action, outlet, performed_by AS "performedBy", created_at AS "createdAt"
         FROM recon.action_logs
         WHERE role = $1 AND created_at >= now() - make_interval(days => $2)
         ORDER BY created_at DESC
         LIMIT $3`,
        [role, RETENTION_DAYS, limit],
      );
      return rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt).toISOString() }));
    },
  };
}
