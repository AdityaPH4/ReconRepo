/**
 * In-process bills-on-hold repository.
 *
 * Development stand-in for Postgres — see `memorySessionStore.ts`. `clear()`
 * durably flips a row to `cleared`, which legacy never did (see README/plan
 * — a real defect there, invisible only because the repo lived in volatile
 * browser memory).
 */

import type { BohEntry } from '@toit/recon-core';
import type { BohStore } from './types.js';

export function createMemoryBohStore(): BohStore {
  const entries = new Map<string, BohEntry>();

  return {
    driver: 'memory',

    async create(entry) {
      entries.set(entry.id, entry);
      return entry;
    },

    async get(id) {
      return entries.get(id) ?? null;
    },

    async list(outlet) {
      return [...entries.values()].filter((e) => e.outlet === outlet);
    },

    async clear(id, clearedAt, clearedBySessionId) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`BOH entry not found: ${id}`);
      const cleared: BohEntry = { ...entry, status: 'cleared', clearedAt, clearedBySessionId };
      entries.set(id, cleared);
      return cleared;
    },
  };
}
