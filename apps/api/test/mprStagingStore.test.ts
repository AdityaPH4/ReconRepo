/**
 * Behaviour spec for the MPR staging store, run against both implementations so
 * the in-memory stand-in can't drift from Postgres.
 *
 *   npm test --workspace @toit/api                                            # in-memory only
 *   STAGING_TEST_DATABASE_URL=postgres://... npm test --workspace @toit/api   # also Postgres (a throwaway database — it truncates the staging tables)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import type { MprRow } from '@toit/mpr-core';
import { createMemoryMprStagingStore } from '../src/storage/memoryMprStagingStore.ts';
import { createPostgresMprStagingStore } from '../src/storage/postgres/postgresMprStagingStore.ts';
import type { MprStagingStore, StagedRowInput } from '../src/storage/types.ts';

const mprRow = (rrn: string): MprRow => ({ rrn, grossAmount: 100, txnDate: '2026-11-16', txnDateRaw: '16-NOV-2026', settlementDate: '2026-11-17', _source: 'KOTAK', _file: 'f.xlsx' });
const input = (rrn: string, o: Partial<StagedRowInput> = {}): StagedRowInput => ({
  bank: 'kotak', identity: `KOTAK|${rrn}|100|16-NOV-2026|2026-11-17`, occurrence: 1, rrn, txnDate: '2026-11-16', terminal: '0064746', outlet: 'BLRT', fileName: 'f.xlsx', row: mprRow(rrn), ...o,
});

function spec(name: string, make: () => Promise<MprStagingStore>) {
  describe(`${name} staging store`, () => {
    let store: MprStagingStore;
    const fresh = async () => {
      store = await make();
      await store.reset();
    };

    it('stores a row once, however many times it is inserted', async () => {
      await fresh();
      assert.equal(await store.insertRows([input('111')]), 1);
      assert.equal(await store.insertRows([input('111')]), 0);
      assert.equal((await store.listAll()).length, 1);
    });

    it('keeps identical twins inside one file, as separate occurrences', async () => {
      await fresh();
      assert.equal(await store.insertRows([input('222'), input('222', { occurrence: 2 })]), 2);
      assert.deepEqual((await store.listAll()).map((r) => r.occurrence), [1, 2]);
    });

    it('round-trips the row and its fields, in load order', async () => {
      await fresh();
      await store.insertRows([input('333'), input('444', { outlet: null, terminal: 'KOL294', txnDate: null })]);
      const [a, b] = await store.listAll();
      assert.deepEqual(a!.row, mprRow('333'));
      assert.deepEqual([a!.rrn, a!.outlet, a!.txnDate, a!.fileName], ['333', 'BLRT', '2026-11-16', 'f.xlsx']);
      assert.deepEqual([b!.rrn, b!.outlet, b!.txnDate, b!.terminal], ['444', null, null, 'KOL294']);
      assert.ok(a!.seq < b!.seq);
    });

    it('deletes every occurrence of an identity, and only for that bank', async () => {
      await fresh();
      const hdfc = input('555', { bank: 'hdfc_upi', identity: 'HDFC_UPI|555|100|x|y' });
      await store.insertRows([input('555'), input('555', { occurrence: 2 }), input('666'), hdfc]);
      assert.equal(await store.deleteByIdentity('kotak', [input('555').identity]), 2);
      assert.deepEqual((await store.listAll()).map((r) => r.rrn).sort(), ['555', '666']); // the HDFC 555 and the Kotak 666 remain
      assert.equal(await store.deleteByIdentity('kotak', []), 0);
    });

    it('reset empties both banks', async () => {
      await fresh();
      await store.insertRows([input('777'), input('888', { bank: 'hdfc_upi', identity: 'HDFC_UPI|888|100|x|y' })]);
      await store.reset();
      assert.deepEqual(await store.listAll(), []);
    });
  });
}

spec('in-memory', async () => createMemoryMprStagingStore());

const url = process.env.STAGING_TEST_DATABASE_URL;
if (url) {
  const pool = new Pool({ connectionString: url });
  before(async () => {
    await pool.query('CREATE SCHEMA IF NOT EXISTS recon');
    await pool.query(readFileSync(new URL('../src/storage/postgres/schema.sql', import.meta.url), 'utf8'));
  });
  after(() => pool.end());
  spec('Postgres', async () => createPostgresMprStagingStore(pool));
} else {
  describe('Postgres staging store', () => it('skipped — set STAGING_TEST_DATABASE_URL to a throwaway database', { skip: true }, () => {}));
}
