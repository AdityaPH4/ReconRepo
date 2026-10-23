/**
 * In-process action-log store — development stand-in for Postgres.
 * 10-day retention, pruned on every write — see `ActionLogStore`'s own doc
 * comment for why there's no separate scheduled cleanup job.
 */

import { randomUUID } from 'node:crypto';
import type { ActionLogEntryDTO } from '@toit/contracts';
import type { ActionLogStore } from './types.js';

const RETENTION_DAYS = 10;

export function createMemoryActionLogStore(): ActionLogStore {
  let entries: ActionLogEntryDTO[] = [];

  function prune(): void {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    entries = entries.filter((e) => new Date(e.createdAt).getTime() >= cutoff);
  }

  return {
    driver: 'memory',

    async record(entry) {
      entries.push({ ...entry, id: randomUUID() });
      prune();
    },

    async list(role, limit = 200) {
      prune();
      return entries
        .filter((e) => e.role === role)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    },
  };
}
