/**
 * End-to-end behaviour of `runMprIngest` with MPR staging: a fake S3, the
 * in-memory stores, real match engine, real file parsing. A bank file that
 * arrives before its POS day must wait, not be eaten — the BLRT 16 Nov bug.
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { beforeEach, describe, it } from 'node:test';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import * as XLSX from 'xlsx';
import type { SessionDTO } from '@toit/contracts';

// Never let this test near a real database, bucket or mailbox: blank them before the config module reads them.
for (const k of ['DATABASE_URL', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_ENDPOINT', 'SMTP_USER', 'SMTP_PASSWORD', 'IMAP_USER', 'IMAP_APP_PASSWORD', 'IMAP_APP_PASSWORD_PARAM']) process.env[k] = '';
Object.assign(process.env, { MPR_START_DATE: '2026-10-01', MPR_S3_PENDING_PREFIX: 'mpr-inbound/pending/', MPR_S3_PROCESSED_PREFIX: 'mpr-inbound/processed/', MPR_S3_FAILED_PREFIX: 'mpr-inbound/failed/', MPR_S3_RECONCILED_PREFIX: 'mpr-reconciled/' });

const { config } = await import('../src/config.ts');
const { runMprIngest } = await import('../src/services/mprIngestService.ts');
const { getMprSessionStore, getMprStagingStore, getSessionStore } = await import('../src/storage/index.ts');
assert.equal(config.sessionStore.driver, 'memory', 'refusing to run against a real database');
assert.equal(config.objectStore.driver, 'local', 'refusing to run against a real bucket');

const NOW = new Date('2026-11-18T10:00:00Z');

class FakeS3 {
  objects = new Map<string, Buffer>();
  put(key: string, body: Buffer | string) {
    this.objects.set(key, Buffer.from(body));
  }
  keys(prefix: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }
  async send(cmd: unknown): Promise<unknown> {
    if (cmd instanceof ListObjectsV2Command) {
      const { Prefix = '' } = cmd.input;
      return { Contents: this.keys(Prefix).map((Key) => ({ Key, Size: this.objects.get(Key)!.length })), IsTruncated: false };
    }
    if (cmd instanceof GetObjectCommand) {
      const body = this.objects.get(cmd.input.Key!);
      if (!body) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return { Body: Readable.from([body]) };
    }
    if (cmd instanceof PutObjectCommand) {
      this.put(cmd.input.Key!, cmd.input.Body as Buffer | string);
      return {};
    }
    if (cmd instanceof CopyObjectCommand) {
      const src = cmd.input.CopySource!.replace(/^\/+/, '');
      this.objects.set(cmd.input.Key!, this.objects.get(src)!);
      return {};
    }
    if (cmd instanceof DeleteObjectCommand) {
      this.objects.delete(cmd.input.Key!);
      return {};
    }
    throw new Error(`FakeS3: unsupported command ${(cmd as object).constructor.name}`);
  }
}

/** A Kotak file as the real ones are laid out: preamble rows, then a header row, then one row per transaction. */
function kotakFile(rows: Array<{ rrn: string; amount?: number; txnDate: string }>): Buffer {
  const aoa = [
    ['Merchant_Code :', null, null, '0790431A0064746'],
    ['S.No', 'PAID Date', 'MID', 'TID', 'RRN No.', 'Txn Date', 'Txn Amt'],
    ...rows.map((r, i) => [i + 1, '2026-11-17', '0790431A0064746', 'T1', r.rrn, r.txnDate, r.amount ?? 500]),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

const PENDING = 'mpr-inbound/pending/2026-11-17/';
const kotakName = (terminal: string, ymd: string) => `0790431A${terminal}_${ymd}.xlsx`;
const dropKotak = (s3: FakeS3, n: number, rows: Parameters<typeof kotakFile>[0], terminal = '0064746', ymd = '2026_11_17') =>
  s3.put(`${PENDING}u${n}_${kotakName(terminal, ymd)}`, kotakFile(rows));

/** An HDFC UPI payout file as the real ones are laid out: a header row, one row per transaction, a footer line without an RRN. */
function hdfcFile(rows: Array<{ rrn: string; amount: number; txn: string }>): Buffer {
  const header = ['External MID', 'External TID', 'UPI Merchant ID', 'Merchant Name', 'Merchant VPA', 'Payer VPA', 'UPI Trxn ID', 'Order ID', 'Txn ref no. (RRN)', 'Transaction Req Date', 'Settlement Date', 'Transaction Amount'];
  const aoa = [
    header,
    ...rows.map((r) => ['P15309', '1', 'HDFC0001', 'TOIT BREWPUB 1', 'toitbrewpub1.1@hdfcbank', 'x@upi', 'U1', 'O1', r.rrn, r.txn, '17-NOV-2026 05:00:00', r.amount]),
    ['Merchant GSTN No :', ...header.slice(1).map(() => null)],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), ' Merchant Payout  Report');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
const dropHdfc = (s3: FakeS3, n: number, rows: Parameters<typeof hdfcFile>[0], terminal = 'P15309') =>
  s3.put(`${PENDING}u${n}_940001-Merchant_Payout_Report_${terminal}_STID_24026629_17-Nov-2026_06.57.xlsx`, hdfcFile(rows));

function posDay(id: string, outlet: string, businessDate: string, rrns: string[], acquirer = 'KOTAK'): SessionDTO {
  return {
    meta: { id, outlet, businessDate, status: 'submitted', createdAt: `${businessDate}T20:00:00.000Z` },
    snapshot: { meta: { businessDate, outlet }, settlementLedger: rrns.map((rrn) => ({ acquirer, rrn, plAmount: 500, outlet, posOrderNo: `o-${rrn}`, plDate: `${businessDate} 20:00:00` })) },
  } as unknown as SessionDTO;
}

const run = (s3: FakeS3) => runMprIngest({ s3: s3 as unknown as S3Client, now: NOW });

/** Every POS day a test submits goes through here, so `beforeEach` can retire it — a flagged day would otherwise stay "submitted" for the next test. */
let created: SessionDTO[] = [];
const submitDay = async (day: SessionDTO) => {
  created.push(day);
  await getSessionStore().create(day);
};

beforeEach(async () => {
  await getMprStagingStore().reset();
  const store = getSessionStore();
  for (const s of created) {
    const current = await store.get(s.meta.id);
    if (current) await store.update(s.meta.id, { ...current, meta: { ...current.meta, status: 'discarded' } });
  }
  created = [];
});

describe('runMprIngest() with staging', () => {
  it('keeps a bank file\'s rows until their POS day is submitted, then settles them (BLRT 16 Nov)', async () => {
    const s3 = new FakeS3();
    dropKotak(s3, 1, [{ rrn: '100000000001', txnDate: '16-NOV-2026' }]);

    const first = await run(s3);
    assert.equal(first.staging.loaded, 1);
    assert.equal(first.staging.waiting['kotak BLRT'], 1);
    assert.equal((await getMprStagingStore().listAll()).length, 1);
    assert.deepEqual(s3.keys('mpr-inbound/pending/'), []); // the file is consumed…
    assert.equal(s3.keys('mpr-inbound/processed/').length, 1); // …but its row is not lost

    await submitDay(posDay('blrt-16', 'BLRT', '2026-11-16', ['100000000001']));
    const second = await run(s3);
    assert.equal(second.staging.consumed, 1);
    assert.equal(second.sourceSessionsFlagged, 1);
    assert.deepEqual(await getMprStagingStore().listAll(), []);
    const stored = await getMprSessionStore().get(second.mprSessionId!);
    assert.deepEqual(stored!.result.settled.map((r) => r.rrn), ['100000000001']);
    assert.equal(stored!.result.unexpected.length, 0);
  });

  it('calls an unmatched row Unexpected only once its day and the day before are both submitted, carrying its outlet', async () => {
    const s3 = new FakeS3();
    dropKotak(s3, 2, [{ rrn: '200000000002', txnDate: '16-NOV-2026' }]);
    await submitDay(posDay('blrt-16b', 'BLRT', '2026-11-16', []));

    const wait = await run(s3);
    assert.deepEqual([wait.staging.emitted, wait.staging.waiting['kotak BLRT']], [0, 1]);

    await submitDay(posDay('blrt-15b', 'BLRT', '2026-11-15', []));
    const emit = await run(s3);
    assert.equal(emit.staging.emitted, 1);
    assert.deepEqual(await getMprStagingStore().listAll(), []);
    const unexpected = (await getMprSessionStore().get(emit.mprSessionId!))!.result.unexpected;
    assert.deepEqual(unexpected.map((u) => [u.rrn, u.outlet, u.txnDate]), [['200000000002', 'BLRT', '2026-11-16']]);
  });

  it('adds nothing when a file whose rows already settled is sent again', async () => {
    const s3 = new FakeS3();
    dropKotak(s3, 3, [{ rrn: '300000000003', txnDate: '16-NOV-2026' }]);
    await submitDay(posDay('blrt-16c', 'BLRT', '2026-11-16', ['300000000003']));
    assert.equal((await run(s3)).staging.consumed, 1);

    dropKotak(s3, 4, [{ rrn: '300000000003', txnDate: '16-NOV-2026' }]); // the bank re-sends it
    const again = await run(s3);
    assert.equal(again.staging.swept, 1);
    assert.deepEqual(await getMprStagingStore().listAll(), []);
    assert.equal(again.ranReconciliation, false); // nothing left to match, so no run — and no Unexpected row for the resent one
    assert.deepEqual(s3.keys('mpr-inbound/pending/'), []);
  });

  it('moves a file that cannot be read to failed/, not processed/', async () => {
    const s3 = new FakeS3();
    s3.put(`${PENDING}u5_${kotakName('0064746', '2026_11_17')}`, 'this is not a spreadsheet');
    const res = await run(s3);
    assert.deepEqual(res.staging.failedFiles, [kotakName('0064746', '2026_11_17')]);
    assert.equal(s3.keys('mpr-inbound/failed/').length, 1);
    assert.deepEqual([s3.keys('mpr-inbound/pending/').length, s3.keys('mpr-inbound/processed/').length], [0, 0]);
  });

  it('leaves a file that errors while loading in pending/ and carries on with the rest', async () => {
    const s3 = new FakeS3();
    dropKotak(s3, 6, [{ rrn: '600000000006', txnDate: '16-NOV-2026' }]);
    dropKotak(s3, 8, [{ rrn: '800000000008', txnDate: '16-NOV-2026' }], '0215583');
    const store = getMprStagingStore();
    const real = store.insertRows;
    store.insertRows = async (rows) => {
      if (rows.some((r) => r.rrn === '600000000006')) throw new Error('database unavailable');
      return real.call(store, rows);
    };
    let res;
    try {
      res = await run(s3);
    } finally {
      store.insertRows = real;
    }
    assert.deepEqual(res.staging.erroredFiles, [kotakName('0064746', '2026_11_17')]);
    assert.equal(s3.keys('mpr-inbound/pending/').length, 1); // the one that errored stays — nothing lost
    assert.equal(s3.keys('mpr-inbound/processed/').length, 1); // the other went through
    assert.deepEqual((await store.listAll()).map((r) => r.rrn), ['800000000008']);

    const again = await run(s3); // the next run picks it up
    assert.deepEqual(again.staging.erroredFiles, []);
    assert.equal(s3.keys('mpr-inbound/pending/').length, 0);
    assert.equal((await store.listAll()).length, 2);
  });

  it('lets a row with an impossible date wait, counts it, and still finishes the run', async () => {
    const s3 = new FakeS3();
    dropKotak(s3, 10, [{ rrn: '100000000010', txnDate: '11/16/2026' }]); // read as d/m/y it is 2026-16-11
    const res = await run(s3);
    assert.equal(res.ranReconciliation, true);
    assert.deepEqual([res.staging.undated, res.staging.emitted, res.staging.waiting['kotak BLRT']], [1, 0, 1]);
  });

  it('reports which POS day each waiting row is waiting for', async () => {
    const s3 = new FakeS3();
    dropKotak(s3, 11, [{ rrn: '110000000011', txnDate: '16-NOV-2026' }, { rrn: '110000000012', txnDate: '16-NOV-2026' }]);
    await submitDay(posDay('blrt-16e', 'BLRT', '2026-11-16', []));
    const res = await run(s3);
    assert.deepEqual(res.staging.awaitingSubmission, { 'BLRT 2026-11-15': 2 });
    assert.equal(res.staging.oldestWaiting, '2026-11-16');
  });

  it('repairs itself when a run stops after saving its results but before deleting the staged rows', async () => {
    const s3 = new FakeS3();
    dropKotak(s3, 9, [{ rrn: '900000000009', txnDate: '16-NOV-2026' }]);
    await submitDay(posDay('blrt-16d', 'BLRT', '2026-11-16', ['900000000009']));
    const store = getMprStagingStore();
    const real = store.deleteByIdentity;
    store.deleteByIdentity = async () => {
      throw new Error('connection lost');
    };
    try {
      await assert.rejects(run(s3), /connection lost/);
    } finally {
      store.deleteByIdentity = real;
    }
    assert.equal((await store.listAll()).length, 1); // the matched row is still staged

    const next = await run(s3);
    assert.equal(next.staging.swept, 1); // its RRN is already reconciled, so it is dropped rather than called Unexpected
    assert.deepEqual(await store.listAll(), []);
    assert.equal(next.sourceSessionsFlagged, 1);
    assert.equal((await getMprSessionStore().get(next.mprSessionId!))!.result.unexpected.length, 0);
  });

  it('holds an HDFC UPI file\'s rows for their POS day, then settles them by RRN', async () => {
    const s3 = new FakeS3();
    dropHdfc(s3, 12, [{ rrn: '120000000012', amount: 500, txn: '16-NOV-2026 20:20:00' }]);
    const first = await run(s3);
    assert.equal(first.staging.waiting['hdfc_upi BLRT'], 1);

    await submitDay(posDay('blrt-16f', 'BLRT', '2026-11-16', ['120000000012'], 'HDFC'));
    const second = await run(s3);
    assert.equal(second.staging.consumed, 1);
    assert.deepEqual(await getMprStagingStore().listAll(), []);
    assert.deepEqual((await getMprSessionStore().get(second.mprSessionId!))!.result.settled.map((r) => r.rrn), ['120000000012']);
  });

  it('settles a Static UPI order by amount and time against a row that was waiting', async () => {
    const s3 = new FakeS3();
    dropHdfc(s3, 13, [{ rrn: '130000000013', amount: 250, txn: '16-NOV-2026 20:20:00' }]);
    await run(s3);
    assert.equal((await getMprStagingStore().listAll()).length, 1);

    const day = posDay('blrt-16g', 'BLRT', '2026-11-16', []);
    (day.snapshot as { upi?: unknown }).upi = { transactions: [{ source: 'HDFC', orderNo: 'O-13', rrn: '', amount: 250, date: '16-Nov-2026 20:15:00', paymentName: 'Static UPI', employee: 'e' }], justifications: [] };
    await submitDay(day);
    const res = await run(s3);
    assert.equal(res.staging.consumed, 1);
    assert.deepEqual(await getMprStagingStore().listAll(), []);
    const upi = (await getMprSessionStore().get(res.mprSessionId!))!.result.upiResults;
    assert.deepEqual(upi.map((u) => [u._match, u._matchBy]), [['settled', 'Amount + Date']]);
  });

  it('reads a bank that is not staged yet in memory and moves its file after the run, as before', async () => {
    const s3 = new FakeS3();
    s3.put(`${PENDING}u7_Export_Report_a.csv`, ['Record Type,Transaction Timestamp,Card Number,Charge Amount', 'ROC,16/10/2026 14:25:44,376539XXXXX2006,200.00'].join('\n'));
    const res = await run(s3);
    assert.equal(res.ranReconciliation, true);
    assert.deepEqual([s3.keys('mpr-inbound/pending/').length, s3.keys('mpr-inbound/processed/').length], [0, 1]);
    assert.deepEqual(await getMprStagingStore().listAll(), []);
  });
});
