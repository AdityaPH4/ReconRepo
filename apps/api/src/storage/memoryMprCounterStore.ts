/**
 * In-process MPR per-day counters — the development stand-in for
 * `postgresMprCounterStore.ts`, with identical behaviour.
 */

import { COUNTER_BANKS, STATE_RANK, emptyCounter, type BankCounter, type ClearedRow, type CounterBank } from '@toit/mpr-core';
import type { MprCounterStore } from './types.js';

const occurrenceBase = (key: string) => key.replace(/#\d+$/, '');

export function createMemoryMprCounterStore(): MprCounterStore {
  /** `${date}|${outlet}|${bank}` → total, with the session it came from. */
  const totals = new Map<string, { date: string; outlet: string; bank: CounterBank; total: number; sessionId: string }>();
  /** `${date}|${outlet}|${bank}|${key}` → the cleared row. */
  const cleared = new Map<string, ClearedRow>();
  const cellKey = (r: { businessDate: string; outlet: string; bank: string }) => `${r.businessDate}|${r.outlet}|${r.bank}`;

  function upsert(rows: ClearedRow[]) {
    for (const r of rows) {
      const k = `${cellKey(r)}|${r.key}`;
      const existing = cleared.get(k);
      cleared.set(k, existing && STATE_RANK[existing.state] >= STATE_RANK[r.state] ? { ...existing, sessionId: r.sessionId } : r);
    }
  }

  return {
    driver: 'memory',

    async applyRun(sessions, rows) {
      const days = new Map<string, { businessDate: string; outlet: string; ids: string[]; totals: Record<CounterBank, number> }>();
      for (const s of sessions) {
        const k = `${s.businessDate}|${s.outlet}`;
        const d = days.get(k) ?? { businessDate: s.businessDate, outlet: s.outlet, ids: [], totals: Object.fromEntries(COUNTER_BANKS.map((b) => [b, 0])) as Record<CounterBank, number> };
        d.ids.push(s.sessionId);
        for (const b of COUNTER_BANKS) d.totals[b] += s.totals[b];
        days.set(k, d);
      }
      for (const d of days.values()) {
        for (const [k, v] of totals) if (v.date === d.businessDate && v.outlet === d.outlet) totals.delete(k);
        for (const b of COUNTER_BANKS) {
          if (d.totals[b] > 0) totals.set(`${d.businessDate}|${d.outlet}|${b}`, { date: d.businessDate, outlet: d.outlet, bank: b, total: d.totals[b], sessionId: d.ids.join(',') });
        }
        for (const [k, v] of cleared) if (v.businessDate === d.businessDate && v.outlet === d.outlet && !d.ids.includes(v.sessionId)) cleared.delete(k);
      }
      upsert(rows);
    },

    async markResolved(rows) {
      for (const r of rows) {
        const current = [...totals.values()].some((t) => t.date === r.businessDate && t.outlet === r.outlet && t.sessionId.split(',').includes(r.sessionId));
        if (!current) continue; // not the day's current session
        let key = r.key;
        if (r.bank !== 'hdfc_static') {
          const base = occurrenceBase(r.key);
          let n = 1;
          for (;;) {
            const e = cleared.get(`${cellKey(r)}|${base}#${n}`);
            if (!e || e.state === 'mismatch') break;
            n++;
          }
          key = `${base}#${n}`;
        }
        upsert([{ ...r, key, state: 'resolved' }]);
      }
    },

    async dayCounters(businessDate, outlet) {
      const counters = Object.fromEntries(COUNTER_BANKS.map((b) => [b, emptyCounter()])) as Record<CounterBank, BankCounter>;
      for (const t of totals.values()) if (t.date === businessDate && (!outlet || t.outlet === outlet)) counters[t.bank].total += t.total;
      for (const c of cleared.values()) if (c.businessDate === businessDate && (!outlet || c.outlet === outlet)) counters[c.bank][c.state]++;
      return counters;
    },

    async rangeSummary(dates, outlet) {
      return dates.map((date) => {
        let total = 0;
        let done = 0;
        for (const t of totals.values()) {
          if (t.date !== date || (outlet && t.outlet !== outlet)) continue;
          total += t.total;
          let n = 0;
          for (const c of cleared.values()) if (c.businessDate === date && c.outlet === t.outlet && c.bank === t.bank && c.state !== 'mismatch') n++;
          done += Math.min(t.total, n);
        }
        return { date, total, cleared: done };
      });
    },

    async openTotal() {
      if (!totals.size) return null;
      let open = 0;
      for (const t of totals.values()) {
        let n = 0;
        for (const c of cleared.values()) if (c.businessDate === t.date && c.outlet === t.outlet && c.bank === t.bank && c.state !== 'mismatch') n++;
        open += Math.max(0, t.total - n);
      }
      return open;
    },

    async reset() {
      totals.clear();
      cleared.clear();
    },
  };
}
