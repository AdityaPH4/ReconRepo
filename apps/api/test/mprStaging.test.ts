import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runMatch, type MprRow, type ParsedMprFile, type TaggedLedgerRow } from '@toit/mpr-core';
import { outletOfTerminal } from '../src/services/mailFetchLedger.ts';
import { partitionStaged, readyToReport, rowIdentity, rowsToParsedFiles, toStagedRows, unexpectedIdentity, type PartitionContext } from '../src/services/mprStaging.ts';
import type { StagedRow } from '../src/storage/types.ts';

const kotakRow = (rrn: string, o: Partial<MprRow> = {}): MprRow => ({
  rrn, grossAmount: 500, txnDate: '2026-11-16', txnDateRaw: '16-NOV-2026', settlementDate: '2026-11-17', _source: 'KOTAK', _file: 'a.xlsx', ...o,
});
const staged = (row: MprRow, o: Partial<StagedRow> = {}): StagedRow => ({
  bank: 'kotak', identity: rowIdentity(row), occurrence: 1, rrn: row.rrn, txnDate: '2026-11-16', terminal: '0064746', outlet: 'BLRT', fileName: row._file, row, seq: 1, ...o,
});
const ledger = (rrn: string, o: Partial<TaggedLedgerRow> = {}): TaggedLedgerRow => ({
  rrn, plAmount: 500, acquirer: 'KOTAK', outlet: 'BLRT', _businessDate: '2026-11-16', _sourceSessionId: 's1', ...o,
});
const ctx = (submitted: string[], o: Partial<PartitionContext> = {}): PartitionContext => ({
  submitted: new Set(submitted), outlets: ['BAGT', 'BLRT', 'PUNT'], startDate: '2026-10-01', ...o,
});
const BOTH_DAYS = ['BLRT|2026-11-15', 'BLRT|2026-11-16'];
const run = (rows: StagedRow[], sessions: TaggedLedgerRow[], extra: ParsedMprFile[] = []) =>
  runMatch({ sessions, mprParsed: [...rowsToParsedFiles(rows), ...extra], upiPRRows: [], upiJustifications: [] });

describe('identity', () => {
  it("matches the engine's row identity for both a settled and an unexpected row", () => {
    const a = staged(kotakRow('111111111111'));
    const b = staged(kotakRow('222222222222'));
    const result = run([a, b], [ledger('111111111111')]);
    assert.equal(rowIdentity(result.settled[0]!.mpr), a.identity);
    assert.equal(unexpectedIdentity(result.unexpected[0]!), b.identity);
  });
});

describe('toStagedRows()', () => {
  const file = (rows: MprRow[], filename = '0790431A0064746_2026_11_17.xlsx'): ParsedMprFile => ({ source: 'KOTAK', matchStrategy: 'rrn', rows, filename });

  it('numbers twins, skips rows before the start date, nulls an unreadable date, takes the outlet from the terminal', () => {
    const a = kotakRow('111111111111', { _file: '0790431A0064746_2026_11_17.xlsx' });
    const old = kotakRow('222222222222', { txnDate: '2026-09-30', txnDateRaw: '30-SEP-2026' });
    const garbled = kotakRow('333333333333', { txnDate: '2026-??-16' });
    const undated = kotakRow('444444444444', { txnDate: null, txnDateRaw: null });
    const out = toStagedRows(file([a, a, old, garbled, undated]), 'kotak', '0790431A0064746_2026_11_17.xlsx', '2026-10-01');
    assert.deepEqual(out.map((r) => [r.rrn, r.occurrence, r.txnDate]), [
      ['111111111111', 1, '2026-11-16'], ['111111111111', 2, '2026-11-16'], ['333333333333', 1, null], ['444444444444', 1, null],
    ]);
    assert.deepEqual([out[0]!.terminal, out[0]!.outlet, out[0]!.bank, out[0]!.fileName], ['0064746', 'BLRT', 'kotak', '0790431A0064746_2026_11_17.xlsx']);
  });

  it('reads the terminal of an HDFC file, and leaves the outlet empty for one nobody maps', () => {
    const hdfc = (term: string) => `940367-Merchant_Payout_Report_${term}_STID_24026629_01-Nov-2026_06.57.xlsx`;
    const row = kotakRow('555555555555', { _source: 'HDFC_UPI' });
    const [p15309] = toStagedRows({ ...file([row]), source: 'HDFC_UPI' }, 'hdfc_upi', hdfc('P15309'), '2026-10-01');
    const [kol] = toStagedRows({ ...file([row]), source: 'HDFC_UPI' }, 'hdfc_upi', hdfc('KOL294'), '2026-10-01');
    assert.deepEqual([p15309!.terminal, p15309!.outlet], ['P15309', 'BLRT']);
    assert.deepEqual([kol!.terminal, kol!.outlet], ['KOL294', null]);
    assert.equal(outletOfTerminal('kotak', '0181370'), null);
    assert.equal(outletOfTerminal('kotak', '0215585'), 'PUNT');
  });
});

describe('readyToReport()', () => {
  const row = (o: { txnDate?: string | null; outlet?: string | null } = {}) => ({ txnDate: '2026-11-16', outlet: 'BLRT', ...o });

  it('needs the row\'s day and the day before both submitted at its outlet', () => {
    assert.equal(readyToReport(row(), ctx(BOTH_DAYS)), true);
    assert.equal(readyToReport(row(), ctx(['BLRT|2026-11-16'])), false);
    assert.equal(readyToReport(row(), ctx(['BLRT|2026-11-15'])), false);
    assert.equal(readyToReport(row(), ctx(['PUNT|2026-11-15', 'PUNT|2026-11-16'])), false); // another outlet's days don't count
  });

  it('counts a day before the MPR start date as submitted', () => {
    assert.equal(readyToReport(row({ txnDate: '2026-10-01' }), ctx(['BLRT|2026-10-01'])), true);
  });

  it('needs every outlet when the terminal has no outlet', () => {
    const all = ['BAGT', 'BLRT', 'PUNT'].flatMap((o) => [`${o}|2026-11-15`, `${o}|2026-11-16`]);
    assert.equal(readyToReport(row({ outlet: null }), ctx(all)), true);
    assert.equal(readyToReport(row({ outlet: null }), ctx(all.filter((k) => k !== 'PUNT|2026-11-16'))), false);
  });

  it('never reports a row whose date could not be read', () => {
    assert.equal(readyToReport(row({ txnDate: null }), ctx(BOTH_DAYS)), false);
  });
});

describe('partitionStaged()', () => {
  it('consumes a matched row', () => {
    const a = staged(kotakRow('111111111111'));
    const out = partitionStaged([a], run([a], [ledger('111111111111')]), ctx([]));
    assert.deepEqual([out.consumed.length, out.emitted.length, out.waiting.length, out.result.settled.length], [1, 0, 0, 1]);
  });

  it('reports an unmatched row as Unexpected, with its outlet and day, once both days are submitted', () => {
    const a = staged(kotakRow('111111111111'));
    const out = partitionStaged([a], run([a], []), ctx(BOTH_DAYS));
    assert.deepEqual([out.consumed.length, out.emitted.length, out.waiting.length], [0, 1, 0]);
    assert.equal(out.result.unexpected.length, 1);
    assert.deepEqual([out.result.unexpected[0]!.outlet, out.result.unexpected[0]!.txnDate], ['BLRT', '2026-11-16']);
  });

  it('keeps an unmatched row waiting, and out of the result, until then', () => {
    const a = staged(kotakRow('111111111111'));
    const out = partitionStaged([a], run([a], []), ctx(['BLRT|2026-11-16']));
    assert.deepEqual([out.emitted.length, out.waiting.length, out.result.unexpected.length], [0, 1, 0]);
  });

  it('treats rows sharing an RRN (Duplicate RRN) by the same rule', () => {
    const a = staged(kotakRow('111111111111'));
    const b = staged(kotakRow('111111111111', { grossAmount: 750 }), { seq: 2 });
    const wait = partitionStaged([a, b], run([a, b], []), ctx([]));
    assert.deepEqual([wait.waiting.length, wait.result.ambiguous.length], [2, 0]);
    const emit = partitionStaged([a, b], run([a, b], []), ctx(BOTH_DAYS));
    assert.deepEqual([emit.emitted.length, emit.result.ambiguous.length], [2, 1]);
  });

  it('keeps identical twins from one file as a Duplicate RRN', () => {
    const row = kotakRow('111111111111');
    const a = staged(row);
    const b = staged(row, { occurrence: 2, seq: 2 });
    const out = partitionStaged([a, b], run([a, b], [ledger('111111111111')]), ctx(BOTH_DAYS));
    assert.equal(out.result.ambiguous.length, 1);
    assert.equal(out.result.settled.length, 0);
  });

  it('leaves an Unexpected row that came from a file outside staging untouched', () => {
    const a = staged(kotakRow('111111111111'));
    const other: ParsedMprFile = { source: 'PINELABS', matchStrategy: 'rrn', filename: 'p.xlsx', rows: [kotakRow('999999999999', { _source: 'PINELABS', _file: 'p.xlsx' })] };
    const out = partitionStaged([a], run([a], [], [other]), ctx([]));
    assert.deepEqual(out.result.unexpected.map((u) => u.rrn), ['999999999999']);
    assert.equal(out.waiting.length, 1);
  });

  it('gives every staged row exactly one fate', () => {
    const rows = [staged(kotakRow('111111111111')), staged(kotakRow('222222222222'), { seq: 2 }), staged(kotakRow('333333333333'), { seq: 3, txnDate: null })];
    const out = partitionStaged(rows, run(rows, [ledger('111111111111')]), ctx(BOTH_DAYS));
    const fates = [...out.consumed, ...out.emitted, ...out.waiting].map((r) => r.identity).sort();
    assert.deepEqual(fates, rows.map((r) => r.identity).sort());
    assert.deepEqual([out.consumed.length, out.emitted.length, out.waiting.length], [1, 1, 1]);
  });
});
