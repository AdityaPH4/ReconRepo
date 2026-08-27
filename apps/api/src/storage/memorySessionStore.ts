/**
 * In-process session store.
 *
 * Development stand-in for Postgres. Sessions are lost on restart — acceptable
 * while iterating on the UI, not acceptable in production, which is why the
 * boot log says loudly which driver is active.
 */

import type { SessionDTO, SessionListItemDTO } from '@toit/contracts';
import type { SessionQuery, SessionStore } from './types.js';

export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, SessionDTO>();

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

  return {
    driver: 'memory',

    async create(session) {
      sessions.set(session.meta.id, session);
      return session;
    },

    async get(id) {
      return sessions.get(id) ?? null;
    },

    async list({ outlet, status, limit = 50 }: SessionQuery) {
      return [...sessions.values()]
        .filter((s) => (outlet ? s.meta.outlet === outlet : true))
        .filter((s) => (status ? s.meta.status === status : true))
        .sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt))
        .slice(0, limit)
        .map(toListItem);
    },

    async update(id, session) {
      if (!sessions.has(id)) throw new Error(`Session not found: ${id}`);
      sessions.set(id, session);
      return session;
    },
  };
}
