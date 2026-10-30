import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runMprReconciliation } from '../src/services/mprService.ts';

const amexCsv = Buffer.from(
  ['Record Type,Transaction Timestamp,Card Number,Charge Amount', 'ROC,16/10/2026 14:25:44,376539XXXXX2006,200.00'].join('\n'),
  'utf8',
);
const snapshot = {
  meta: { businessDate: '2026-10-16', outlet: 'BAGT' },
  settlementLedger: [{ acquirer: 'AMEX', plDate: '16/10/2026 02:25:44 PM', cardNo: '***********2006', plAmount: 200, rrn: '', outlet: 'BAGT' }],
};

describe('runMprReconciliation() — the same bank file twice in one run', () => {
  it('counts a byte-identical copy once, so its rows settle instead of turning into duplicates', () => {
    const out = runMprReconciliation(
      [{ snapshot, sourceSessionId: 's1', label: 'BAGT.json' }],
      [{ originalName: 'Export_Report_a.csv', buffer: amexCsv }, { originalName: 'x_Export_Report_a.csv', buffer: Buffer.from(amexCsv) }],
    );
    assert.deepEqual(out.result.amexResults.map((r) => r._match), ['settled']);
    assert.deepEqual(out.mprFiles.map((f) => f.filename), ['Export_Report_a.csv']);
  });

  it('keeps two different files even when they share a name', () => {
    const other = Buffer.from(['Record Type,Transaction Timestamp,Card Number,Charge Amount', 'ROC,16/10/2026 19:47:33,376539XXXXX2006,200.00'].join('\n'), 'utf8');
    const out = runMprReconciliation([{ snapshot, sourceSessionId: 's1', label: 'BAGT.json' }], [{ originalName: 'amex.csv', buffer: amexCsv }, { originalName: 'amex.csv', buffer: other }]);
    assert.equal(out.mprFiles.filter((f) => f.error).length, 0);
    assert.deepEqual(out.result.amexResults.map((r) => r._match).sort(), ['settled', 'unexpected']);
  });
});
