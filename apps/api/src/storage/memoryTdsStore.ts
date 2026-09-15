/**
 * In-process unreconciled-TDS repository.
 *
 * Development stand-in for Postgres — see `memoryBohStore.ts`. `close()`
 * durably flips a row from `open` to `closed`, the same pattern as
 * `BohStore.clear()`.
 */

import type { TdsEntry } from '@toit/recon-core';
import type { TdsStore } from './types.js';

export function createMemoryTdsStore(): TdsStore {
  const entries = new Map<string, TdsEntry>();

  return {
    driver: 'memory',

    async create(entry) {
      entries.set(entry.id, entry);
      return entry;
    },

    async get(id) {
      return entries.get(id) ?? null;
    },

    async list(outlet, status) {
      return [...entries.values()].filter(
        (e) => (outlet === null || e.outlet === outlet) && (status === undefined || e.status === status),
      );
    },

    async close(id, closedAt, closedBy, closedNote) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`TDS entry not found: ${id}`);
      const closed: TdsEntry = { ...entry, status: 'closed', closedAt, closedBy, closedNote };
      entries.set(id, closed);
      return closed;
    },
  };
}
