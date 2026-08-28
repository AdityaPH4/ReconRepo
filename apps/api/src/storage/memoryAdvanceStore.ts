/**
 * In-process advances repository.
 *
 * Development stand-in for Postgres — see `memorySessionStore.ts` for the
 * same rationale. Outlet-scoped (the port's fix over legacy — see README/
 * plan: legacy advances carried no outlet field at all).
 */

import type { Advance, AdvanceApplication } from '@toit/recon-core';
import type { AdvanceStore } from './types.js';

export function createMemoryAdvanceStore(): AdvanceStore {
  const advances = new Map<string, Advance>();
  const applications = new Map<string, AdvanceApplication>();

  return {
    driver: 'memory',

    async create(advance) {
      advances.set(advance.id, advance);
      return advance;
    },

    async list(outlet) {
      return [...advances.values()].filter((a) => a.outlet === outlet);
    },

    async recordApplication(application) {
      applications.set(application.id, application);
      return application;
    },

    async listApplications(outlet) {
      const outletAdvanceIds = new Set([...advances.values()].filter((a) => a.outlet === outlet).map((a) => a.id));
      return [...applications.values()].filter((a) => outletAdvanceIds.has(a.advanceId));
    },
  };
}
