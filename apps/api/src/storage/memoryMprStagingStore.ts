/**
 * In-process MPR staging — the development stand-in for
 * `postgres/postgresMprStagingStore.ts`, with identical behaviour.
 */

import type { MprStagingStore, StagedBank, StagedRow } from './types.js';

const BANK_ORDER: StagedBank[] = ['kotak', 'hdfc_upi']; // same order the Postgres store lists them in

export function createMemoryMprStagingStore(): MprStagingStore {
  const rows = new Map<string, StagedRow>();
  let seq = 0;
  const keyOf = (r: { bank: string; identity: string; occurrence: number }) => `${r.bank}|${r.identity}|${r.occurrence}`;

  return {
    driver: 'memory',

    async insertRows(input) {
      let added = 0;
      for (const r of input) {
        const k = keyOf(r);
        if (rows.has(k)) continue;
        rows.set(k, { ...r, seq: ++seq });
        added++;
      }
      return added;
    },

    async listAll() {
      return [...rows.values()].sort((a, b) => (a.bank === b.bank ? a.seq - b.seq : BANK_ORDER.indexOf(a.bank) - BANK_ORDER.indexOf(b.bank)));
    },

    async deleteByIdentity(bank, identities) {
      const gone = new Set(identities);
      let n = 0;
      for (const [k, r] of rows) {
        if (r.bank === bank && gone.has(r.identity)) {
          rows.delete(k);
          n++;
        }
      }
      return n;
    },

    async reset() {
      rows.clear();
      seq = 0;
    },
  };
}
