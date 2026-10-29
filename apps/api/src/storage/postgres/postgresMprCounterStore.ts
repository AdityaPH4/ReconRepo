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
    for (let i = 0; i < cleared.length; i += CHUNK) {
      const c = cleared.slice(i, i + CHUNK);
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
      await inTransaction(async (client) => {
        for (const s of sessions) {
          await client.query(`DELETE FROM recon.mpr_day_totals WHERE business_date = $1 AND outlet = $2`, [s.businessDate, s.outlet]);
          const banks = COUNTER_BANKS.filter((b) => s.totals[b] > 0);
          if (banks.length) {
            await client.query(
              `INSERT INTO recon.mpr_day_totals (business_date, outlet, bank, total, session_id)
               SELECT $1, $2, b, t, $3 FROM unnest($4::text[], $5::int[]) AS x(b, t)`,
              [s.businessDate, s.outlet, s.sessionId, banks, banks.map((b) => s.totals[b])],
            );
          }
          // A re-submitted day has a new session; whatever the old one had cleared no longer describes the day.
          await client.query(`DELETE FROM recon.mpr_day_cleared WHERE business_date = $1 AND outlet = $2 AND session_id <> $3`, [
            s.businessDate,
            s.outlet,
            s.sessionId,
          ]);
        }
        await upsertCleared(client, cleared);
      });
    },

    async markResolved(rows) {
      await inTransaction(async (client) => {
        for (const r of rows) {
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

    async openTotal() {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT coalesce(sum(greatest(t.total - coalesce(c.n, 0), 0)), 0)::int AS n
         FROM recon.mpr_day_totals t
         LEFT JOIN (SELECT business_date, outlet, bank, count(*) AS n FROM recon.mpr_day_cleared WHERE state IN ('settled','resolved') GROUP BY 1,2,3) c
           USING (business_date, outlet, bank)`,
      );
      return rows[0]?.n ?? 0;
    },

    async reset() {
      await pool.query(`TRUNCATE recon.mpr_day_totals, recon.mpr_day_cleared`);
    },
  };
}
