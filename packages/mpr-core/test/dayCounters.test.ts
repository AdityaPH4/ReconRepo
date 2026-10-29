/**
 * Per-day counters: totals from a saved snapshot, and which transactions a
 * run's result clears. The properties that matter are the ones that would
 * make the number silently wrong — double counting, a manual entry counted
 * as a transaction, a mismatch counted as cleared.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clearedRowsFromResult, dayTotalsFromSnapshot, openOf, type DayResultLike } from '../dist/index.js';

const ledger = (o: Partial<DayResultLike['settled'][number]> = {}): DayResultLike['settled'][number] => ({
  status: 'closed',
  outlet: 'BLRT',
  _businessDate: '2026-10-11',
  _sourceSessionId: 's1',
  acquirer: 'KOTAKATOS',
  rrn: '111111111111',
  posOrderNo: '9001',
  plAmount: 500,
  plDate: '11/10/2026 01:00:00 PM',
  ...o,
});
const empty = (): DayResultLike => ({ settled: [], amountMismatch: [], pending: [], amexResults: [], upiResults: [] });
const outlets = (sid: string) => (sid === 's1' ? 'BLRT' : undefined);

describe('dayTotalsFromSnapshot()', () => {
  it('counts ledger rows per bank and distinct Static UPI orders', () => {
    const t = dayTotalsFromSnapshot({
      settlementLedger: [
        { acquirer: 'AMEX' },
        { acquirer: 'KOTAKATOS' },
        { acquirer: 'KOTAK UPI' },
        { acquirer: 'HDFC UPI' },
        { acquirer: 'HDFC' },
        { acquirer: 'HDFC_LINK' },
        { acquirer: 'RBL_DCC' },
      ],
      upi: { transactions: [{ source: 'HDFC', orderNo: 'a' }, { source: 'HDFC', orderNo: 'a' }, { source: 'HDFC', orderNo: 'b' }, { source: 'Kotak', orderNo: 'c' }] },
    });
    assert.deepEqual(t, { amex: 1, kotak: 2, pinelabs: 1, hdfc_upi: 1, hdfc_dynamic: 1, hdfc_link: 1, hdfc_static: 2 });
  });

  it('is all zeros for a day with no snapshot data', () => {
    assert.equal(Object.values(dayTotalsFromSnapshot(null)).reduce((a, b) => a + b, 0), 0);
  });
});

describe('clearedRowsFromResult()', () => {
  it('clears a settled ledger row, files it under its bank, and skips a still-open pending row', () => {
    const r = empty();
    r.settled.push(ledger());
    r.pending.push(ledger({ status: 'open', rrn: '222222222222' }));
    const rows = clearedRowsFromResult(r, outlets);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.bank, 'kotak');
    assert.equal(rows[0]!.state, 'settled');
    assert.equal(rows[0]!.sessionId, 's1');
  });

  it('keeps a mismatch open (not cleared) until an admin resolves it', () => {
    const r = empty();
    r.amountMismatch.push(ledger({ status: 'open' }));
    assert.equal(clearedRowsFromResult(r, outlets)[0]!.state, 'mismatch');
    r.amountMismatch[0]!.status = 'closed';
    assert.equal(clearedRowsFromResult(r, outlets)[0]!.state, 'resolved');
  });

  it('counts two identical transactions as two, not one', () => {
    const r = empty();
    r.settled.push(ledger(), ledger());
    const keys = clearedRowsFromResult(r, outlets).map((x) => x.key);
    assert.equal(new Set(keys).size, 2);
  });

  it('gives the same keys for the same result every time (re-applying a run is idempotent)', () => {
    const r = empty();
    r.settled.push(ledger(), ledger(), ledger({ rrn: '333333333333' }));
    const a = clearedRowsFromResult(r, outlets).map((x) => x.key).sort();
    const b = clearedRowsFromResult(r, outlets).map((x) => x.key).sort();
    assert.deepEqual(a, b);
  });

  it('skips rows with no source session (manual upload) or no outlet', () => {
    const r = empty();
    r.settled.push(ledger({ _sourceSessionId: null }), ledger({ outlet: undefined }));
    assert.equal(clearedRowsFromResult(r, outlets).length, 0);
  });

  it('clears an AMEX row only when it matched, and ignores a bank-only (unexpected) credit', () => {
    const r = empty();
    const amex = { status: 'closed', outlet: 'BLRT', _businessDate: '2026-10-11', _sourceSessionId: 's1', date: '2026-10-11', cardLast4: '2002', l1Amount: 5199 };
    r.amexResults.push(
      { ...amex, _match: 'settled' },
      { ...amex, status: 'open', cardLast4: '1111', _match: 'pending' },
      { ...amex, status: 'open', cardLast4: '3333', _match: 'mismatch' },
      { ...amex, status: 'open', outlet: '', _sourceSessionId: undefined, _businessDate: undefined, cardLast4: '4444', _match: 'unexpected' },
    );
    const rows = clearedRowsFromResult(r, outlets);
    assert.deepEqual(rows.map((x) => [x.bank, x.state]), [['amex', 'settled'], ['amex', 'mismatch']]);
  });

  it('counts Static UPI by POS order number, and never counts a manual entry as a transaction', () => {
    const r = empty();
    const upi = { status: 'closed', _businessDate: '2026-10-11', _sourceSessionId: 's1' };
    r.upiResults.push(
      { ...upi, _match: 'settled', pr: [{ source: 'HDFC', orderNo: 'o1' }, { source: 'HDFC', orderNo: 'o2' }] },
      { ...upi, status: 'open', _match: 'pending', pr: { orderNo: '—', amount: 10000 } }, // a GM's "Advance Received" note
      { ...upi, status: 'open', _match: 'mismatch', pr: [{ source: 'HDFC', orderNo: 'o3' }] },
    );
    const rows = clearedRowsFromResult(r, outlets);
    assert.deepEqual(rows.map((x) => [x.key, x.state]), [['o1', 'settled'], ['o2', 'settled'], ['o3', 'mismatch']]);
    assert.ok(rows.every((x) => x.bank === 'hdfc_static' && x.outlet === 'BLRT'));
  });

  it('counts a Static UPI order once even when it sits in several rows, keeping its best state', () => {
    const r = empty();
    const upi = { _businessDate: '2026-10-11', _sourceSessionId: 's1' };
    r.upiResults.push(
      { ...upi, status: 'open', _match: 'mismatch', pr: [{ source: 'HDFC', orderNo: 'o1' }] },
      { ...upi, status: 'closed', _match: 'settled', pr: [{ source: 'HDFC', orderNo: 'o1' }, { source: 'HDFC', orderNo: 'o2' }] },
    );
    const rows = clearedRowsFromResult(r, outlets);
    assert.deepEqual(rows.map((x) => [x.key, x.state]).sort(), [['o1', 'settled'], ['o2', 'settled']]);
  });

  it('drops a Static UPI row whose session has no known outlet', () => {
    const r = empty();
    r.upiResults.push({ status: 'closed', _businessDate: '2026-10-11', _sourceSessionId: 'unknown', _match: 'settled', pr: [{ source: 'HDFC', orderNo: 'o1' }] });
    assert.equal(clearedRowsFromResult(r, outlets).length, 0);
  });
});

describe('openOf()', () => {
  it('is total minus cleared, never negative, and a mismatch does not reduce it', () => {
    assert.equal(openOf({ total: 10, settled: 6, resolved: 1, mismatch: 2 }), 3);
    assert.equal(openOf({ total: 2, settled: 3, resolved: 0, mismatch: 0 }), 0);
  });
});
