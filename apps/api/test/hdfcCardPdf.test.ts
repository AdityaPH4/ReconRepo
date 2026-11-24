/**
 * `parseHdfcCardText`/`toHdfcCardCsv` only — pure text-in, CSV-out. Uses a
 * synthetic sample shaped like the real HDFC card report (not real customer
 * transaction data). `extractText`'s pdfjs-dist decrypt step was verified by
 * hand against 19 real files (see docs/superpowers/specs and the chat log),
 * not re-asserted here — no real bank PDF is checked into this repo.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HdfcCardPasswordError, parseHdfcCardText, toHdfcCardCsv } from '../src/services/hdfcCardPdf.ts';

const SAMPLE = [
  'Merchant : 1 Of 1                                   Page : 1',
  'MERCHANT PAYMENT REPORT FOR 20-Nov-2026',
  '',
  'CR   P2M 9000000000@axl          18-11-26 19-11-26      105.00    111111111111 AXLabc',
  'CR   P2M someone@okhdfcbank      18-11-26 19-11-26     1951.00    222222222222 HDFxyz',
  '',
  'Permanant Account Number : AAACH2702H',
].join('\n');

describe('parseHdfcCardText()', () => {
  it('extracts RRN/amount/dates from the free-text CR P2M lines, ignoring everything else', () => {
    const rows = parseHdfcCardText(SAMPLE, 'f.pdf');
    assert.deepEqual(rows, [
      { rrn: '111111111111', grossAmount: 105, txnDate: '18-11-26', settlementDate: '19-11-26' },
      { rrn: '222222222222', grossAmount: 1951, txnDate: '18-11-26', settlementDate: '19-11-26' },
    ]);
  });

  it('returns nothing for a day with no transactions (a real, observed case) without erroring', () => {
    assert.deepEqual(parseHdfcCardText('Merchant : 1 Of 1\nPage : 1\nNo transactions.', 'f.pdf'), []);
  });

  it('refuses to guess when a transaction-shaped line does not fully match (layout drift / a split line)', () => {
    const broken = SAMPLE.replace('105.00    111111111111 AXLabc', '105.00'); // RRN/ref truncated off the line
    assert.throws(() => parseHdfcCardText(broken, 'f.pdf'), /didn't match the expected layout/);
  });
});

describe('toHdfcCardCsv()', () => {
  it('writes the header `ADAPTERS.HDFC_CARD` expects, one row per transaction', () => {
    const csv = toHdfcCardCsv([{ rrn: '111111111111', grossAmount: 105, txnDate: '18-11-26', settlementDate: '19-11-26' }]);
    assert.equal(csv, 'RRN,Txn Amt,Txn Date,Settlement Date\n111111111111,105,18-11-26,19-11-26');
  });
});

describe('HdfcCardPasswordError', () => {
  it('is a distinct, catchable error class', () => {
    assert.ok(new HdfcCardPasswordError('wrong password') instanceof Error);
  });
});
