/**
 * Behaviour spec for the per-day MPR counter store, run against both
 * implementations so the in-memory stand-in can't drift from Postgres.
 *
 *   npm test --workspace @toit/api                                   # in-memory only
 *   COUNTER_TEST_DATABASE_URL=postgres://... npm test --workspace @toit/api   # also Postgres (a throwaway database — it truncates the counter tables)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { emptyTotals, type ClearedRow, type DayTotals } from '@toit/mpr-core';
import { createMemoryMprCounterStore } from '../src/storage/memoryMprCounterStore.ts';
import { createPostgresMprCounterStore } from '../src/storage/postgres/postgresMprCounterStore.ts';
import type { MprCounterStore } from '../src/storage/types.ts';

const D = '2026-10-11';
const totals = (o: Partial<DayTotals>): DayTotals => ({ ...emptyTotals(), ...o });
const row = (o: Partial<ClearedRow> = {}): ClearedRow => ({ businessDate: D, outlet: 'BLRT', bank: 'kotak', key: 'k1#1', state: 'settled', sessionId: 's1', ...o });
const session = (o: Record<string, unknown> = {}) => ({ sessionId: 's1', outlet: 'BLRT', businessDate: D, totals: totals({ kotak: 3, amex: 2 }), ...o });

function spec(name: string, make: () => Promise<MprCounterStore>) {
  describe(`${name} counter store`, () => {
    let store: MprCounterStore;
    const fresh = async () => {
      store = await make();
      await store.reset();
    };

    it('records a day\'s totals and what a run cleared', async () => {
      await fresh();
      await store.applyRun([session()], [row(), row({ key: 'k2#1' }), row({ bank: 'amex', key: 'a#1' })]);
      const c = await store.dayCounters(D, 'BLRT');
      assert.deepEqual([c.kotak.total, c.kotak.settled, c.amex.total, c.amex.settled], [3, 2, 2, 1]);
    });

    it('is idempotent — applying the same run twice changes nothing', async () => {
      await fresh();
      const rows = [row(), row({ key: 'k2#1' })];
      await store.applyRun([session()], rows);
      await store.applyRun([session()], rows);
      assert.equal((await store.dayCounters(D, 'BLRT')).kotak.settled, 2);
      assert.equal(await store.openTotal(), 3);
    });

    it('keeps a mismatch open, then lets a settle or an admin resolve clear it, and never downgrades', async () => {
      await fresh();
      await store.applyRun([session()], [row({ state: 'mismatch' })]);
      let c = (await store.dayCounters(D, 'BLRT')).kotak;
      assert.deepEqual([c.mismatch, c.settled, c.resolved], [1, 0, 0]);
      assert.equal(await store.openTotal(), 5); // 3 kotak + 2 amex, nothing cleared

      await store.markResolved([row({ key: 'k1#1', state: 'mismatch' })]);
      c = (await store.dayCounters(D, 'BLRT')).kotak;
      assert.deepEqual([c.mismatch, c.resolved], [0, 1]);

      await store.applyRun([session()], [row({ state: 'mismatch' })]); // a later run reports it as a mismatch again
      assert.equal((await store.dayCounters(D, 'BLRT')).kotak.resolved, 1);

      await store.applyRun([session()], [row({ state: 'settled' })]); // …then the bank settles it
      c = (await store.dayCounters(D, 'BLRT')).kotak;
      assert.deepEqual([c.settled, c.resolved], [1, 0]);
    });

    it('counts identical twin transactions separately when resolved one at a time', async () => {
      await fresh();
      await store.applyRun([session({ totals: totals({ kotak: 2 }) })], []);
      await store.markResolved([row({ key: 'dup#1', state: 'resolved' })]);
      await store.markResolved([row({ key: 'dup#1', state: 'resolved' })]);
      assert.equal((await store.dayCounters(D, 'BLRT')).kotak.resolved, 2);
      assert.equal(await store.openTotal(), 0);
    });

    it('does not number Static UPI orders', async () => {
      await fresh();
      await store.applyRun([session({ totals: totals({ hdfc_static: 2 }) })], []);
      await store.markResolved([row({ bank: 'hdfc_static', key: 'order-1' })]);
      await store.markResolved([row({ bank: 'hdfc_static', key: 'order-1' })]); // resolving the same order again is a no-op
      assert.equal((await store.dayCounters(D, 'BLRT')).hdfc_static.resolved, 1);
    });

    it('starts the day clean when it is re-submitted under a new session', async () => {
      await fresh();
      await store.applyRun([session()], [row(), row({ key: 'k2#1' })]);
      await store.applyRun([session({ sessionId: 's2', totals: totals({ kotak: 4 }) })], [row({ sessionId: 's2', key: 'z#1' })]);
      const c = (await store.dayCounters(D, 'BLRT')).kotak;
      assert.deepEqual([c.total, c.settled], [4, 1]);
      assert.equal((await store.dayCounters(D, 'BLRT')).amex.total, 0); // a bank that dropped to zero is gone
    });

    it('keeps outlets and days apart, and pools them when asked', async () => {
      await fresh();
      await store.applyRun(
        [session(), session({ sessionId: 's9', outlet: 'PUNT', totals: totals({ kotak: 10 }) }), session({ sessionId: 's3', businessDate: '2026-10-12', totals: totals({ kotak: 1 }) })],
        [row(), row({ outlet: 'PUNT', sessionId: 's9', key: 'p#1' }), row({ businessDate: '2026-10-12', sessionId: 's3', key: 'n#1' })],
      );
      assert.equal((await store.dayCounters(D, 'BLRT')).kotak.total, 3);
      assert.equal((await store.dayCounters(D, null)).kotak.total, 13);
      assert.equal((await store.dayCounters(D, null)).kotak.settled, 2);
    });

    it('summarises per date, with cleared never above the day\'s total', async () => {
      await fresh();
      await store.applyRun([session({ totals: totals({ kotak: 1 }) })], [row(), row({ key: 'extra#1' })]);
      const [s] = await store.rangeSummary([D], 'BLRT');
      assert.deepEqual([s!.total, s!.cleared], [1, 1]);
      assert.deepEqual((await store.rangeSummary(['2026-01-01'], null))[0], { date: '2026-01-01', total: 0, cleared: 0 });
    });

    it('gives per-bank cleared/total for a range, with zeros for days that have nothing', async () => {
      await fresh();
      await store.applyRun([session()], [row(), row({ bank: 'amex', key: 'a#1', state: 'mismatch' })]);
      const [d, none] = await store.rangeByBank([D, '2026-01-01'], 'BLRT');
      assert.deepEqual(d!.counts.kotak, { total: 3, cleared: 1 });
      assert.deepEqual(d!.counts.amex, { total: 2, cleared: 0 });
      assert.deepEqual(none!.counts.kotak, { total: 0, cleared: 0 });
      assert.equal((await store.rangeByBank([D], 'OTHER'))[0]!.counts.kotak.total, 0);
    });

    it('reset empties everything', async () => {
      await fresh();
      await store.applyRun([session()], [row()]);
      await store.reset();
      assert.equal(await store.openTotal(), null); // nothing recorded, which is not the same as nothing open
    });

    it('sums a day that arrives as two sessions, and keeps both sessions\' cleared rows', async () => {
      await fresh();
      await store.applyRun(
        [session({ totals: totals({ kotak: 2 }) }), session({ sessionId: 's2', totals: totals({ kotak: 3 }) })],
        [row(), row({ sessionId: 's2', key: 'z#1' })],
      );
      const c = await store.dayCounters(D, 'BLRT');
      assert.deepEqual([c.kotak.total, c.kotak.settled], [5, 2]);
    });

    it('survives the same transaction arriving twice in one run in different states', async () => {
      await fresh();
      await store.applyRun([session()], [row({ state: 'mismatch' }), row({ state: 'settled' })]);
      const c = await store.dayCounters(D, 'BLRT');
      assert.deepEqual([c.kotak.settled, c.kotak.mismatch], [1, 0]);
    });

    it('ignores a resolution from a superseded session', async () => {
      await fresh();
      await store.applyRun([session({ sessionId: 's2' })], []);
      await store.markResolved([row({ sessionId: 's1' })]);
      assert.equal((await store.dayCounters(D, 'BLRT')).kotak.resolved, 0);
      await store.markResolved([row({ sessionId: 's2' })]);
      assert.equal((await store.dayCounters(D, 'BLRT')).kotak.resolved, 1);
    });
  });
}

spec('in-memory', async () => createMemoryMprCounterStore());

const url = process.env.COUNTER_TEST_DATABASE_URL;
if (url) {
  const pool = new Pool({ connectionString: url });
  before(async () => {
    await pool.query('CREATE SCHEMA IF NOT EXISTS recon');
    const ddl = readFileSync(new URL('../src/storage/postgres/schema.sql', import.meta.url), 'utf8');
    await pool.query(ddl);
  });
  after(() => pool.end());
  spec('Postgres', async () => createPostgresMprCounterStore(pool));
} else {
  describe('Postgres counter store', () => it('skipped — set COUNTER_TEST_DATABASE_URL to a throwaway database', { skip: true }, () => {}));
}
