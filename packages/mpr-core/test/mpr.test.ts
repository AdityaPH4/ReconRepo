/**
 * Behavioural tests for the ported Layer-2 (MPR) engine.
 *
 * Characterisation-test style, matching `@toit/recon-core`'s `engine.test.ts`:
 * each assertion encodes a behaviour the legacy `mpr-recon (10).html`
 * exhibited (or, where noted, a deliberate fix over it).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as XLSX from 'xlsx';

import {
  ADAPTERS,
  adjustPRDate,
  amexNormDate,
  detectAdapter,
  normDate,
  normRRN,
  parseAmexCSV,
  parseMprFile,
  parseTxnTimestamp,
  runMatch,
  splitRRNs,
  buildExportRows,
  type MatchInput,
  type TaggedLedgerRow,
} from '../dist/index.js';

// ── Adapter detection ───────────────────────────────────────────────────

describe('detectAdapter()', () => {
  it('detects each bank from filename conventions', () => {
    assert.equal(detectAdapter('KOTAK_MPR_01AUG2026.xlsx'), 'KOTAK');
    assert.equal(detectAdapter('0790431_report.xls'), 'KOTAK');
    assert.equal(detectAdapter('PINELABS_MerchantMPR.xlsx'), 'PINELABS');
    assert.equal(detectAdapter('mpr__01082026.xlsx'), 'PINELABS');
    assert.equal(detectAdapter('AMEX_Settlement.xls'), 'AMEX');
    assert.equal(detectAdapter('settlements20260801.csv'), 'AMEX');
    assert.equal(detectAdapter('daily_settlement_report.csv'), 'AMEX');
    assert.equal(detectAdapter('Merchant_Payout_Report_STID.xlsx'), 'HDFC_UPI');
    assert.equal(detectAdapter('925792_report.xlsx'), 'HDFC_UPI');
    assert.equal(detectAdapter('unknown_bank_file.xlsx'), null);
  });
});

// ── Normalisation ─────────────────────────────────────────────────────────

describe('normDate()', () => {
  it('handles all four bank date formats', () => {
    assert.equal(normDate('2026-08-01T00:00:00'), '2026-08-01');
    assert.equal(normDate('1/8/2026'), '2026-08-01');
    assert.equal(normDate('12-07-26'), '2026-07-12'); // AMEX CSV all-numeric
    assert.equal(normDate('28-JUN-2026'), '2026-06-28'); // Kotak/HDFC UPI
    assert.equal(normDate('28-Jun-26'), '2026-06-28');
    assert.equal(normDate('not a date'), null);
  });
});

describe('normRRN()', () => {
  it('left-pads to 12 digits and treats blanks as null', () => {
    assert.equal(normRRN('123456'), '000000123456');
    assert.equal(normRRN(123456), '000000123456');
    assert.equal(normRRN(''), null);
    assert.equal(normRRN('nan'), null);
    assert.equal(normRRN(null), null);
  });
});

describe('splitRRNs()', () => {
  it('splits a multi-RRN MPR cell and validates each chunk is 12 digits', () => {
    const { valid, invalid } = splitRRNs('620798201612/657399594148');
    assert.deepEqual(valid, ['620798201612', '657399594148']);
    assert.deepEqual(invalid, []);
  });
  it('flags a fat-fingered (wrong-length) RRN as invalid', () => {
    const { valid, invalid } = splitRRNs('620798201612/12345');
    assert.deepEqual(valid, ['620798201612']);
    assert.deepEqual(invalid, ['12345']);
  });
});

describe('adjustPRDate()', () => {
  it('rolls a 0-2am transaction to the next calendar day', () => {
    const d = new Date(2026, 6, 15, 1, 30, 0);
    const adjusted = adjustPRDate(d)!;
    assert.equal(adjusted.getDate(), 16);
  });
  it('leaves a daytime transaction untouched', () => {
    const d = new Date(2026, 6, 15, 14, 30, 0);
    assert.equal(adjustPRDate(d), d);
  });
});

describe('amexNormDate()', () => {
  it('rolls a 23:50-23:59 Pinelabs submission to the next day', () => {
    assert.equal(amexNormDate('01/08/2026 11:55:00 PM'), '2026-08-02');
  });
  it('leaves an earlier submission on the same day', () => {
    assert.equal(amexNormDate('01/08/2026 09:14:03 PM'), '2026-08-01');
  });
});

describe('parseTxnTimestamp()', () => {
  it('parses DD-Mon-YYYY HH:MM:SS', () => {
    const d = parseTxnTimestamp('15-Jul-2026 14:30:00')!;
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getHours(), 14);
  });
});

// ── AMEX CSV parser ───────────────────────────────────────────────────────

describe('parseAmexCSV()', () => {
  const csv = [
    'Submissions',
    'Settlement date,Submitting Merchant ID,Submission date,Submission amount,Transaction count,SOC invoice number,Submitting Business Name',
    '02-08-26,1234567,01-08-26,"1,000.00",2,101,Toit Bengaluru',
    '',
    'Summary totals',
    'some other summary row',
  ].join('\n');

  it('extracts only the Submissions detail rows, handling Indian comma-grouped amounts', () => {
    const rows = parseAmexCSV(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.mid, '1234567');
    assert.equal(rows[0]!.submissionAmount, 1000);
    assert.equal(rows[0]!.socNumber, '101');
  });

  it('does not confuse the settlement-summary header (also starting "Settlement date") with the detail header', () => {
    const summaryOnly = [
      'Submissions',
      'Settlement date,Settlement number,Settlement amount', // no "Submitting Merchant ID" — the summary header
      '02-08-26,555,1000.00',
    ].join('\n');
    assert.deepEqual(parseAmexCSV(summaryOnly), []);
  });
});

// ── XLSX adapter parsing, end-to-end via a real in-memory workbook ────────

function writeWorkbook(sheetName: string, rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('parseMprFile() — Kotak', () => {
  it('resolves columns by fingerprint and normalises rows', () => {
    const buf = writeWorkbook('Sheet1', [
      ['RRN No.', 'Txn Amt', 'PAID Date', 'Txn Date', 'MID'],
      ['123456789012', 500, '02-AUG-2026', '01-AUG-2026', 'M001'],
      ['Payout Summary', '', '', '', ''],
    ]);
    const parsed = parseMprFile('kotak_mpr.xlsx', buf, detectAdapter('kotak_mpr.xlsx'));
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.rows.length, 1);
    assert.equal((parsed.rows[0] as { rrn: string }).rrn, '123456789012');
  });

  it('errors when the RRN/amount columns cannot be resolved', () => {
    const buf = writeWorkbook('Sheet1', [
      ['RRN No.', 'Txn Amt', 'PAID Date', 'Txn Date', 'MID'],
      ['123456789012', 500, '02-AUG-2026', '01-AUG-2026', 'M001'],
    ]);
    // Adapter mismatch on purpose — pretend it's HDFC_UPI so the real RRN
    // column name ("RRN No.") isn't one of HDFC_UPI's aliases... actually
    // "RRN" is aliased there too, so force a genuinely unresolvable case:
    // strip all columns HDFC_UPI could match on gross amount.
    const bad = writeWorkbook('Sheet1', [
      ['Not RRN', 'Not Amount'],
      ['123456789012', 500],
    ]);
    const parsed = parseMprFile('unknown.xlsx', bad, 'KOTAK');
    assert.ok(parsed.error);
  });
});

describe('parseMprFile() — Pinelabs hardcoded header row', () => {
  it('reads row 1 (0-indexed) as headers regardless of fingerprint, per the adapter config', () => {
    const buf = writeWorkbook('Trxn details', [
      ['(grouping label row)', '', '', ''],
      ['RRN number', 'Gross Txn Amount', 'Store Name', 'Store ID'],
      ['200000000099', 750, 'Toit ORR East', 'S1'],
    ]);
    const parsed = parseMprFile('pinelabs_mpr.xlsx', buf, 'PINELABS');
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.rows.length, 1);
    assert.equal((parsed.rows[0] as { rrn: string }).rrn, '200000000099');
  });
});

// ── runMatch() ────────────────────────────────────────────────────────────

function ledgerRow(overrides: Partial<TaggedLedgerRow> = {}): TaggedLedgerRow {
  return {
    rrn: '100000000001',
    acquirer: 'Pinelabs',
    plAmount: 1000,
    outlet: 'BLRT',
    store: 'Toit- Bangalore',
    l1Status: 'matched',
    l1Remark: null,
    _businessDate: '2026-08-01',
    ...overrides,
  };
}

function mprRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    rrn: '100000000001',
    grossAmount: 1000,
    netAmount: 990,
    txnDate: '2026-08-01',
    txnDateRaw: '01-Aug-2026 21:00:00',
    settlementDate: '2026-08-02',
    fee: 10,
    _source: 'KOTAK',
    _file: 'kotak.xlsx',
    ...overrides,
  };
}

function emptyInput(overrides: Partial<MatchInput> = {}): MatchInput {
  return { sessions: [], mprParsed: [], upiPRRows: [], upiJustifications: [], ...overrides };
}

describe('runMatch() — primary RRN match', () => {
  it('settles a row whose amount matches within tolerance', () => {
    const result = runMatch(
      emptyInput({
        sessions: [ledgerRow()],
        mprParsed: [{ source: 'KOTAK', matchStrategy: 'rrn', rows: [mprRow()], filename: 'kotak.xlsx' }],
      }),
    );
    assert.equal(result.settled.length, 1);
    assert.equal(result.amountMismatch.length, 0);
  });

  it('flags an amount mismatch outside tolerance', () => {
    const result = runMatch(
      emptyInput({
        sessions: [ledgerRow({ plAmount: 1000 })],
        mprParsed: [{ source: 'KOTAK', matchStrategy: 'rrn', rows: [mprRow({ grossAmount: 950 })], filename: 'kotak.xlsx' }],
      }),
    );
    assert.equal(result.amountMismatch.length, 1);
    assert.equal(result.amountMismatch[0]!._diff, 50);
  });

  it('treats a row with the all-zero RRN sentinel as "No RRN" pending', () => {
    const result = runMatch(emptyInput({ sessions: [ledgerRow({ rrn: '000000000000' })] }));
    assert.equal(result.pending.length, 1);
    assert.equal(result.pending[0]!._reason, 'No RRN');
  });

  it('is pending "Not in MPR" when the RRN has no bank-side counterpart', () => {
    const result = runMatch(emptyInput({ sessions: [ledgerRow({ rrn: '999999999999' })] }));
    assert.equal(result.pending.length, 1);
    assert.equal(result.pending[0]!._reason, 'Not in MPR');
  });

  it('surfaces an unmatched Kotak MPR row as `unexpected`, not silently dropped (the fix over legacy)', () => {
    const result = runMatch(
      emptyInput({
        mprParsed: [
          {
            source: 'KOTAK',
            matchStrategy: 'rrn',
            rows: [mprRow({ rrn: '888888888888', grossAmount: 250 })],
            filename: 'kotak.xlsx',
          },
        ],
      }),
    );
    assert.equal(result.unexpected.length, 1);
    assert.equal(result.unexpected[0]!._source, 'KOTAK');
    assert.equal(result.unexpected[0]!.mprAmount, 250);
  });

  it('routes a duplicate RRN across MPR rows to `ambiguous` rather than silently keeping one (the fix over legacy)', () => {
    const result = runMatch(
      emptyInput({
        sessions: [ledgerRow()],
        mprParsed: [
          {
            source: 'KOTAK',
            matchStrategy: 'rrn',
            rows: [mprRow({ grossAmount: 1000 }), mprRow({ grossAmount: 1000, _file: 'kotak2.xlsx' })],
            filename: 'kotak.xlsx',
          },
        ],
      }),
    );
    assert.equal(result.ambiguous.length, 1);
    assert.equal(result.ambiguous[0]!.candidates.length, 2);
    // Neither candidate is available to the primary matcher — the ledger row is "Not in MPR".
    assert.equal(result.pending.length, 1);
    assert.equal(result.pending[0]!._reason, 'Not in MPR');
  });
});

describe('runMatch() — AMEX batch matching', () => {
  it('settles a batch when MID + submission date + amount (±₹1) all agree', () => {
    const session = ledgerRow({
      acquirer: 'AMEX',
      mid: '1234567',
      plSettlementDate: '01/08/2026 09:14:03 PM',
      plAmount: 1500,
      invoice: '10',
    });
    const result = runMatch(
      emptyInput({
        sessions: [session],
        mprParsed: [
          {
            source: 'AMEX',
            matchStrategy: 'batch',
            rows: [{ mid: '1234567', submissionDate: '2026-08-01', settlementDate: '2026-08-03', submissionAmount: 1500, transactionCount: 1, socNumber: '11', dbaName: 'Toit', _file: 'amex.csv' }],
            filename: 'amex.csv',
          },
        ],
      }),
    );
    assert.equal(result.amexResults.length, 1);
    assert.equal(result.amexResults[0]!._match, 'settled');
    assert.equal(result.amexResults[0]!.socMatch, true); // maxInvoice(10)+1 === socNumber(11)
  });

  it('rolls a batch submitted in the last 10 minutes of the day to the next calendar day', () => {
    const session = ledgerRow({ acquirer: 'AMEX', mid: '1234567', plSettlementDate: '01/08/2026 11:55:00 PM', plAmount: 500 });
    const result = runMatch(
      emptyInput({
        sessions: [session],
        mprParsed: [
          {
            source: 'AMEX',
            matchStrategy: 'batch',
            rows: [{ mid: '1234567', submissionDate: '2026-08-02', settlementDate: '', submissionAmount: 500, transactionCount: 1, socNumber: '1', dbaName: '', _file: 'amex.csv' }],
            filename: 'amex.csv',
          },
        ],
      }),
    );
    assert.equal(result.amexResults[0]!._match, 'settled');
  });

  it('flags an unmatched MPR AMEX batch as unexpected', () => {
    const result = runMatch(
      emptyInput({
        mprParsed: [
          {
            source: 'AMEX',
            matchStrategy: 'batch',
            rows: [{ mid: '999', submissionDate: '2026-08-01', settlementDate: '', submissionAmount: 200, transactionCount: 1, socNumber: '1', dbaName: '', _file: 'amex.csv' }],
            filename: 'amex.csv',
          },
        ],
      }),
    );
    assert.equal(result.amexResults.length, 1);
    assert.equal(result.amexResults[0]!._match, 'unexpected');
  });
});

describe('runMatch() — HDFC Static UPI', () => {
  it('settles Pass 1 (RRN match), summing multiple PR rows sharing one RRN', () => {
    const upiPRRows = [
      { orderNo: '1', date: '01-Aug-2026 10:00:00', amount: 300, paymentName: 'HDFC Static UPI', source: 'HDFC' as const, rrn: '300000000001', employee: 'E1', _businessDate: '2026-08-01' },
      { orderNo: '2', date: '01-Aug-2026 10:05:00', amount: 200, paymentName: 'HDFC Static UPI', source: 'HDFC' as const, rrn: '300000000001', employee: 'E1', _businessDate: '2026-08-01' },
    ];
    const result = runMatch(
      emptyInput({
        upiPRRows,
        mprParsed: [
          {
            source: 'HDFC_UPI',
            matchStrategy: 'rrn',
            rows: [mprRow({ rrn: '300000000001', grossAmount: 500, _source: 'HDFC_UPI' })],
            filename: 'hdfc_upi.xlsx',
          },
        ],
      }),
    );
    assert.equal(result.upiResults.length, 1);
    assert.equal(result.upiResults[0]!._match, 'settled');
    assert.equal(result.upiResults[0]!._matchBy, 'RRN');
  });

  it('flags "partial" when RRNs match but the MPR row also carries a fat-fingered fragment', () => {
    const upiPRRows = [
      { orderNo: '1', date: '01-Aug-2026 10:00:00', amount: 300, paymentName: 'HDFC Static UPI', source: 'HDFC' as const, rrn: '300000000001', employee: 'E1', _businessDate: '2026-08-01' },
    ];
    const result = runMatch(
      emptyInput({
        upiPRRows,
        mprParsed: [
          {
            source: 'HDFC_UPI',
            matchStrategy: 'rrn',
            rows: [mprRow({ rrn: '300000000001/12345', grossAmount: 300, _source: 'HDFC_UPI' })],
            filename: 'hdfc_upi.xlsx',
          },
        ],
      }),
    );
    assert.equal(result.upiResults[0]!._match, 'partial');
    assert.deepEqual(result.upiResults[0]!._invalidRRNs, ['12345']);
  });

  it('falls back to Pass 2 (amount + ±1hr timestamp window, closest wins) when RRN does not match', () => {
    const upiPRRows = [
      { orderNo: '1', date: '01-Aug-2026 22:00:00', amount: 400, paymentName: 'HDFC Static UPI', source: 'HDFC' as const, rrn: '', employee: 'E1', _businessDate: '2026-08-01' },
    ];
    const result = runMatch(
      emptyInput({
        upiPRRows,
        mprParsed: [
          {
            source: 'HDFC_UPI',
            matchStrategy: 'rrn',
            rows: [mprRow({ rrn: '', grossAmount: 400, txnDateRaw: '01-Aug-2026 22:20:00', _source: 'HDFC_UPI' })],
            filename: 'hdfc_upi.xlsx',
          },
        ],
      }),
    );
    assert.equal(result.upiResults[0]!._match, 'settled');
    assert.equal(result.upiResults[0]!._matchBy, 'Amount + Date');
  });

  it('resolves an unexpected MPR credit via an excess justification (Advance Received)', () => {
    const result = runMatch(
      emptyInput({
        upiJustifications: [
          { sign: 'excess', remark: 'Advance Received', rrn: '', description: 'Birthday advance', amount: 250, source: 'HDFC/Kotak UPI', _businessDate: '2026-08-01' },
        ],
        mprParsed: [
          {
            source: 'HDFC_UPI',
            matchStrategy: 'rrn',
            rows: [mprRow({ rrn: '', grossAmount: 250, txnDateRaw: '01-Aug-2026 10:00:00', _source: 'HDFC_UPI' })],
            filename: 'hdfc_upi.xlsx',
          },
        ],
      }),
    );
    assert.equal(result.upiResults.some((r) => r._match === 'settled' && r._matchBy === 'amount'), true);
    assert.equal(result.unexpected.length, 0);
  });

  it('leaves a genuinely unexplained MPR credit as unexpected', () => {
    const result = runMatch(
      emptyInput({
        mprParsed: [
          {
            source: 'HDFC_UPI',
            matchStrategy: 'rrn',
            rows: [mprRow({ rrn: '', grossAmount: 999, txnDateRaw: '01-Aug-2026 10:00:00', _source: 'HDFC_UPI' })],
            filename: 'hdfc_upi.xlsx',
          },
        ],
      }),
    );
    assert.equal(result.unexpected.length, 1);
    assert.equal(result.unexpected[0]!._source, 'HDFC_UPI');
  });
});

describe('buildExportRows()', () => {
  it('includes AMEX rows in the export (the fix over legacy)', () => {
    const result = runMatch(
      emptyInput({
        mprParsed: [
          {
            source: 'AMEX',
            matchStrategy: 'batch',
            rows: [{ mid: '999', submissionDate: '2026-08-01', settlementDate: '', submissionAmount: 200, transactionCount: 1, socNumber: '1', dbaName: '', _file: 'amex.csv' }],
            filename: 'amex.csv',
          },
        ],
      }),
    );
    const rows = buildExportRows(result);
    // Match-status vocabulary is bare and lowercase, matching legacy's
    // (`'settled'|'amount_mismatch'|'pending'|'unexpected'`) — the `MPR
    // Source` column ("AMEX") is what disambiguates the row, not the label.
    assert.ok(rows.some((r) => r.includes('unexpected') && r.includes('AMEX')));
  });

  it('includes "No RRN" pending rows, consistent with the on-screen Pending tab (the fix over legacy)', () => {
    const result = runMatch(emptyInput({ sessions: [ledgerRow({ rrn: '000000000000' })] }));
    const rows = buildExportRows(result);
    assert.ok(rows.some((r) => r.includes('pending')));
    assert.equal(rows.length, 2); // header + the one pending row
  });
});
