/**
 * In-process approval-request store.
 * Development stand-in for Postgres — see `memorySessionStore.ts`.
 */

import type { ApprovalRequestDTO } from '@toit/contracts';
import type { ApprovalStore } from './types.js';

export function createMemoryApprovalStore(): ApprovalStore {
  const requests = new Map<string, ApprovalRequestDTO>();

  return {
    driver: 'memory',

    async create(request) {
      requests.set(request.id, request);
      return request;
    },

    async get(id) {
      return requests.get(id) ?? null;
    },

    async list({ outlet, status, requestedBy }) {
      return [...requests.values()]
        .filter((r) => (outlet ? r.outlet === outlet : true))
        .filter((r) => (status ? r.status === status : true))
        .filter((r) => (requestedBy ? r.requestedBy === requestedBy : true))
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    },

    async decide(id, status, decidedBy, decidedAt) {
      const request = requests.get(id);
      if (!request) throw new Error(`Approval request not found: ${id}`);
      const decided: ApprovalRequestDTO = { ...request, status, decidedBy, decidedAt };
      requests.set(id, decided);
      return decided;
    },
  };
}
