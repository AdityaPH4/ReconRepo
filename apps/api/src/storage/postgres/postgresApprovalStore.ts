/**
 * Postgres-backed approval-request store — same interface as
 * `memoryApprovalStore.ts`.
 */

import type { ApprovalRequestDTO } from '@toit/contracts';
import type { Pool } from 'pg';
import type { ApprovalQuery, ApprovalStore } from '../types.js';

export function createPostgresApprovalStore(pool: Pool): ApprovalStore {
  return {
    driver: 'postgres',

    async create(request) {
      await pool.query(
        `INSERT INTO recon.approval_requests (id, outlet, status, requested_by, requested_at, data)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET outlet = $2, status = $3, requested_by = $4, requested_at = $5, data = $6`,
        [request.id, request.outlet, request.status, request.requestedBy, request.requestedAt, request],
      );
      return request;
    },

    async get(id) {
      const { rows } = await pool.query<{ data: ApprovalRequestDTO }>(
        'SELECT data FROM recon.approval_requests WHERE id = $1',
        [id],
      );
      return rows[0]?.data ?? null;
    },

    async list({ outlet, status, requestedBy }: ApprovalQuery) {
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
      if (requestedBy) {
        params.push(requestedBy);
        conditions.push(`requested_by = $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await pool.query<{ data: ApprovalRequestDTO }>(
        `SELECT data FROM recon.approval_requests ${where} ORDER BY requested_at DESC`,
        params,
      );
      return rows.map((r) => r.data);
    },

    async decide(id, status, decidedBy, decidedAt) {
      const { rows } = await pool.query<{ data: ApprovalRequestDTO }>(
        'SELECT data FROM recon.approval_requests WHERE id = $1',
        [id],
      );
      const request = rows[0]?.data;
      if (!request) throw new Error(`Approval request not found: ${id}`);
      const decided: ApprovalRequestDTO = { ...request, status, decidedBy, decidedAt };
      await pool.query(`UPDATE recon.approval_requests SET status = $2, data = $3 WHERE id = $1`, [
        id,
        status,
        decided,
      ]);
      return decided;
    },
  };
}
