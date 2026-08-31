/**
 * In-process MPR (Layer 2) session store.
 *
 * Development stand-in for Postgres — see `memorySessionStore.ts` for the
 * same rationale. Not outlet-scoped: one MPR run can span snapshots from
 * several outlets, so there is no single outlet to filter list queries by.
 */

import type { MprSessionDTO, MprSessionListItemDTO } from '@toit/contracts';
import type { MprSessionQuery, MprSessionStore } from './types.js';

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
  };
}
