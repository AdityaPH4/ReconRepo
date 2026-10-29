/**
 * In-process MPR (Layer 2) session store.
 *
 * Development stand-in for Postgres — see `memorySessionStore.ts` for the
 * same rationale. Not outlet-scoped: one MPR run can span snapshots from
 * several outlets, so there is no single outlet to filter list queries by.
 */

import type { MprSessionDTO, MprSessionListItemDTO } from '@toit/contracts';
import type { MprBucketRow, MprSessionQuery, MprSessionStore } from './types.js';

export function createMemoryMprSessionStore(): MprSessionStore {
  const sessions = new Map<string, MprSessionDTO>();

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

  return {
    driver: 'memory',

    async create(session) {
      sessions.set(session.meta.id, session);
      return session;
    },

    async get(id) {
      return sessions.get(id) ?? null;
    },

    async list({ createdBy, limit = 50 }: MprSessionQuery) {
      return [...sessions.values()]
        .filter((s) => (createdBy ? s.meta.createdBy === createdBy : true))
        .sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt))
        .slice(0, limit)
        .map(toListItem);
    },

    async listFull({ createdBy, limit = 50 }: MprSessionQuery) {
      return [...sessions.values()]
        .filter((s) => (createdBy ? s.meta.createdBy === createdBy : true))
        .sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt))
        .slice(0, limit);
    },

    async listDayRows(dates, bankSide) {
      const recent = [...sessions.values()].sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt)).slice(0, 200);
      const dateSet = new Set(dates);
      const rows: MprBucketRow[] = [];
      const bankRows: MprBucketRow[] = [];
      const settledKeys = new Set<string>();
      for (const s of recent) {
        const runId = s.meta.id;
        const r = s.result;
        for (const row of r.settled) if (dateSet.has(row._businessDate)) rows.push({ runId, bucket: 'settled', row });
        for (const row of r.amountMismatch) if (dateSet.has(row._businessDate)) rows.push({ runId, bucket: 'amountMismatch', row });
        for (const row of r.pending) if (dateSet.has(row._businessDate)) rows.push({ runId, bucket: 'pending', row });
        for (const row of r.amexResults) if (row._businessDate && dateSet.has(row._businessDate)) rows.push({ runId, bucket: 'amexResults', row });
        for (const row of r.upiResults) if (row._businessDate && dateSet.has(row._businessDate)) rows.push({ runId, bucket: 'upiResults', row });
        if (!bankSide) continue;
        for (const row of r.ambiguous) bankRows.push({ runId, bucket: 'ambiguous', row });
        for (const row of r.unexpected) bankRows.push({ runId, bucket: 'unexpected', row });
        for (const row of r.amexResults) {
          if (row._match === 'unexpected') bankRows.push({ runId, bucket: 'amexResults', row });
          if ((row._match === 'settled' || row._match === 'mismatch') && row.mprRow) settledKeys.add([row.date, row.cardLast4, row.mprRow.amount].join('|'));
        }
        for (const row of r.settled) if (row.mpr?.rrn) settledKeys.add(row.mpr.rrn);
        for (const row of r.upiResults) if (row._match === 'settled' && row.mpr?.rrn) settledKeys.add(row.mpr.rrn);
      }
      return { runs: recent.map((s) => ({ id: s.meta.id, meta: s.meta })), rows, bankRows, settledKeys };
    },

    async update(id, session) {
      if (!sessions.has(id)) throw new Error(`MPR session not found: ${id}`);
      sessions.set(id, session);
      return session;
    },
  };
}
