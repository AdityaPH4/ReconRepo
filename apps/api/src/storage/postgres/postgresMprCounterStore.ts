/**
 * Postgres-backed MPR per-day counters — see `schema.sql` for the two tables
 * and `memoryMprCounterStore.ts` for the same behaviour in-process.
 */

import { COUNTER_BANKS, STATE_RANK, emptyCounter, type BankCounter, type ClearedRow, type ClearState, type CounterBank } from '@toit/mpr-core';
import type { Pool } from 'pg';
import type { MprCounterStore } from '../types.js';

/** Rows per INSERT — keeps a full rebuild's statements a sane size. */
const CHUNK = 5000;
const RANK_SQL = (col: string) => `CASE ${col} WHEN 'settled' THEN ${STATE_RANK.settled} WHEN 'resolved' THEN ${STATE_RANK.resolved} ELSE ${STATE_RANK.mismatch} END`;

const occurrenceBase = (key: string) => key.replace(/#\d+$/, '');
const isNumbered = (bank: CounterBank) => bank !== 'hdfc_static';

export function createPostgresMprCounterStore(pool: Pool): MprCounterStore {
  async function upsertCleared(client: { query: Pool['query'] }, cleared: ClearedRow[]): Promise<void> {
    // One statement can't touch the same row twice, so collapse repeated keys to the highest state first.
    const best = new Map<string, ClearedRow>();
    for (const r of cleared) {
      const k = `${r.businessDate}|${r.outlet}|${r.bank}|${r.key}`;
      const e = best.get(k);
      if (!e || STATE_RANK[r.state] > STATE_RANK[e.state]) best.set(k, r);
    }
    const rows = [...best.values()];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const c = rows.slice(i, i + CHUNK);
      await client.query(
        `INSERT INTO recon.mpr_day_cleared AS e (business_date, outlet, bank, row_key, state, session_id)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
         ON CONFLICT (business_date, outlet, bank, row_key) DO UPDATE
           SET state = CASE WHEN ${RANK_SQL('EXCLUDED.state')} > ${RANK_SQL('e.state')} THEN EXCLUDED.state ELSE e.state END,
               session_id = EXCLUDED.session_id`,
        [c.map((r) => r.businessDate), c.map((r) => r.outlet), c.map((r) => r.bank), c.map((r) => r.key), c.map((r) => r.state), c.map((r) => r.sessionId)],
      );
    }
  }

  /** Serialises writers on one outlet-day, so a run and an admin resolution can't interleave on it. */
  const lockDay = (client: { query: Pool['query'] }, businessDate: string, outlet: string) =>
    client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`mpr-day|${businessDate}|${outlet}`]);

  async function inTransaction<T>(fn: (client: { query: Pool['query'] }) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client as unknown as { query: Pool['query'] });
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    driver: 'postgres',

    async applyRun(sessions, cleared) {
      // A day can arrive as several sessions in one run; its total is their sum.
      const days = new Map<string, { businessDate: string; outlet: string; ids: string[]; totals: Record<CounterBank, number> }>();
      for (const s of sessions) {
        const k = `${s.businessDate}|${s.outlet}`;
        const d = days.get(k) ?? { businessDate: s.businessDate, outlet: s.outlet, ids: [], totals: Object.fromEntries(COUNTER_BANKS.map((b) => [b, 0])) as Record<CounterBank, number> };
        d.ids.push(s.sessionId);
        for (const b of COUNTER_BANKS) d.totals[b] += s.totals[b];
        days.set(k, d);
      }
      await inTransaction(async (client) => {
        for (const d of days.values()) {
          await lockDay(client, d.businessDate, d.outlet);
          await client.query(`DELETE FROM recon.mpr_day_totals WHERE business_date = $1 AND outlet = $2`, [d.businessDate, d.outlet]);
          const banks = COUNTER_BANKS.filter((b) => d.totals[b] > 0);
          if (banks.length) {
            await client.query(
              `INSERT INTO recon.mpr_day_totals (business_date, outlet, bank, total, session_id)
               SELECT $1, $2, b, t, $3 FROM unnest($4::text[], $5::int[]) AS x(b, t)`,
              [d.businessDate, d.outlet, d.ids.join(','), banks, banks.map((b) => d.totals[b])],
            );
          }
          // A re-submitted day has a new session; whatever the old one had cleared no longer describes the day.
          await client.query(`DELETE FROM recon.mpr_day_cleared WHERE business_date = $1 AND outlet = $2 AND NOT (session_id = ANY($3::text[]))`, [d.businessDate, d.outlet, d.ids]);
        }
        await upsertCleared(client, cleared);
      });
    },

    async markResolved(rows) {
      await inTransaction(async (client) => {
        for (const r of rows) {
          await lockDay(client, r.businessDate, r.outlet);
          // Only the day's current session counts: a resolution recorded against a superseded session would describe a day that no longer exists.
          const { rowCount } = await client.query(
            `SELECT 1 FROM recon.mpr_day_totals WHERE business_date = $1 AND outlet = $2 AND $3 = ANY(string_to_array(session_id, ',')) LIMIT 1`,
            [r.businessDate, r.outlet, r.sessionId],
          );
          if (!rowCount) continue;
          let key = r.key;
          if (isNumbered(r.bank)) {
            const base = occurrenceBase(r.key);
            const { rows: existing } = await client.query<{ row_key: string; state: ClearState }>(
              `SELECT row_key, state FROM recon.mpr_day_cleared WHERE business_date = $1 AND outlet = $2 AND bank = $3 AND (row_key = $4 OR row_key LIKE $5)`,
              [r.businessDate, r.outlet, r.bank, `${base}#1`, `${base.replace(/[\\%_]/g, '\\$&')}#%`],
            );
            const taken = new Map(existing.map((e) => [e.row_key, e.state]));
            let n = 1;
            while (taken.has(`${base}#${n}`) && taken.get(`${base}#${n}`) !== 'mismatch') n++;
            key = `${base}#${n}`;
          }
          await upsertCleared(client, [{ ...r, key, state: 'resolved' }]);
        }
      });
    },

    async dayCounters(businessDate, outlet) {
      const counters = Object.fromEntries(COUNTER_BANKS.map((b) => [b, emptyCounter()])) as Record<CounterBank, BankCounter>;
      const [totals, cleared] = await Promise.all([
        pool.query<{ bank: CounterBank; n: number }>(
          `SELECT bank, sum(total)::int AS n FROM recon.mpr_day_totals WHERE business_date = $1 AND ($2::text IS NULL OR outlet = $2) GROUP BY bank`,
          [businessDate, outlet],
        ),
        pool.query<{ bank: CounterBank; state: ClearState; n: number }>(
          `SELECT bank, state, count(*)::int AS n FROM recon.mpr_day_cleared WHERE business_date = $1 AND ($2::text IS NULL OR outlet = $2) GROUP BY bank, state`,
          [businessDate, outlet],
        ),
      ]);
      for (const r of totals.rows) counters[r.bank].total = r.n;
      for (const r of cleared.rows) counters[r.bank][r.state] = r.n;
      return counters;
    },

    async rangeSummary(dates, outlet) {
      const [totals, cleared] = await Promise.all([
        pool.query<{ d: string; n: number }>(
          `SELECT business_date AS d, sum(total)::int AS n FROM recon.mpr_day_totals WHERE business_date = ANY($1) AND ($2::text IS NULL OR outlet = $2) GROUP BY 1`,
          [dates, outlet],
        ),
        // Per bank, cleared can't exceed that bank's total (e.g. a transaction cleared before a re-submission shrank the day).
        pool.query<{ d: string; n: number }>(
          `SELECT t.business_date AS d, sum(least(t.total, coalesce(c.n, 0)))::int AS n
           FROM (SELECT business_date, outlet, bank, total FROM recon.mpr_day_totals WHERE business_date = ANY($1) AND ($2::text IS NULL OR outlet = $2)) t
           LEFT JOIN (SELECT business_date, outlet, bank, count(*) AS n FROM recon.mpr_day_cleared
                      WHERE state IN ('settled','resolved') AND business_date = ANY($1) GROUP BY 1,2,3) c
             USING (business_date, outlet, bank)
           GROUP BY 1`,
          [dates, outlet],
        ),
      ]);
      const total = new Map(totals.rows.map((r) => [r.d, r.n]));
      const done = new Map(cleared.rows.map((r) => [r.d, r.n]));
      return dates.map((date) => ({ date, total: total.get(date) ?? 0, cleared: done.get(date) ?? 0 }));
    },

    async rangeByBank(dates, outlet) {
      const { rows } = await pool.query<{ d: string; bank: CounterBank; total: number; cleared: number }>(
        `SELECT t.business_date AS d, t.bank, sum(t.total)::int AS total, sum(least(t.total, coalesce(c.n, 0)))::int AS cleared
         FROM (SELECT business_date, outlet, bank, total FROM recon.mpr_day_totals WHERE business_date = ANY($1) AND ($2::text IS NULL OR outlet = $2)) t
         LEFT JOIN (SELECT business_date, outlet, bank, count(*) AS n FROM recon.mpr_day_cleared
                    WHERE state IN ('settled','resolved') AND business_date = ANY($1) AND ($2::text IS NULL OR outlet = $2) GROUP BY 1,2,3) c
           USING (business_date, outlet, bank)
         GROUP BY 1, 2`,
        [dates, outlet],
      );
      return dates.map((date) => {
        const counts = Object.fromEntries(COUNTER_BANKS.map((b) => [b, { total: 0, cleared: 0 }])) as Record<CounterBank, { total: number; cleared: number }>;
        for (const r of rows) if (r.d === date) counts[r.bank] = { total: r.total, cleared: r.cleared };
        return { date, counts };
      });
    },

    async openTotal() {
      const { rows } = await pool.query<{ n: number | null }>(
        `SELECT sum(greatest(t.total - coalesce(c.n, 0), 0))::int AS n
         FROM recon.mpr_day_totals t
         LEFT JOIN (SELECT business_date, outlet, bank, count(*) AS n FROM recon.mpr_day_cleared WHERE state IN ('settled','resolved') GROUP BY 1,2,3) c
           USING (business_date, outlet, bank)`,
      );
      return rows[0]?.n ?? null;
    },

    async reset() {
      await pool.query(`TRUNCATE recon.mpr_day_totals, recon.mpr_day_cleared`);
    },
  };
}
