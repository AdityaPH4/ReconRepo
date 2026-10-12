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
  cardLast4,
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
    assert.equal(detectAdapter('HDFC_Link_Settlement.csv'), 'HDFC_LINK');
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

describe('cardLast4()', () => {
  it('keeps only the last 4 digits, stripping any masking characters', () => {
    assert.equal(cardLast4('374740XXXXX4000'), '4000');
  });
  it('returns an empty string for blank input', () => {
    assert.equal(cardLast4(''), '');
    assert.equal(cardLast4(null), '');
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
    'Current Date,Payment Date,Settlement Number,Submission / Transaction Reference Number,Record Type,Transaction Timestamp,Card Number,Charge Amount',
    '30/09/2026,29/09/2026,32711018,000000000000440,SOC,,,',
    '30/09/2026,29/09/2026,,439,ROC,27/09/2026 19:51:38,379863XXXXX3000,"3,781.00"',
    '30/09/2026,29/09/2026,,653,ROC,27/09/2026 16:52:45,377320XXXXX8845,"1,251.00"',
    'Totals for Payment on 29/09/2026,,,,,,,',
  ].join('\n');

  it('extracts only ROC rows, handling Indian comma-grouped amounts and masked card numbers', () => {
    const rows = parseAmexCSV(csv);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.cardLast4, '3000');
    assert.equal(rows[0]!.amount, 3781);
    assert.equal(rows[0]!.txnDate, '2026-09-27');
    assert.equal(rows[0]!.settlementDate, '2026-09-29');
    assert.equal(rows[1]!.cardLast4, '8845');
  });

  it('skips the SOC batch row and the "Totals for Payment" footer, neither of which is a Record Type === ROC row', () => {
    const socOnly = [
      'Current Date,Payment Date,Settlement Number,Record Type,Transaction Timestamp,Card Number,Charge Amount',
      '30/09/2026,29/09/2026,32711018,SOC,,,',
      'Totals for Payment on 29/09/2026,,,,,,',
    ].join('\n');
    assert.deepEqual(parseAmexCSV(socOnly), []);
  });

  it('returns empty when the header is missing a required column', () => {
    const noCardColumn = ['Record Type,Transaction Timestamp,Charge Amount', 'ROC,27/09/2026 19:51:38,"3,781.00"'].join('\n');
    assert.deepEqual(parseAmexCSV(noCardColumn), []);
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

describe('parseMprFile() — HDFC Link', () => {
  const csv = [
    'SG MID,Merchant Order ID,SG Txn ID,SG Refund ID,Txn Date,Settlement Date,Txn Amount,Net Amount,Txn Fee',
    '77734,00003,77734-00003-1,,2026-09-17 12:41:33,2026-09-18 00:00:00,40000,38702,1100',
  ].join('\n');

  it('content-fingerprint-detects a .csv with no filename hint as HDFC_LINK, not AMEX (the fix over the old unconditional CSV-is-AMEX shortcut)', () => {
    const parsed = parseMprFile('reconciliation_report_2026-09-17_to_2026-09-19.csv', Buffer.from(csv, 'utf8'), null);
    assert.equal(parsed.source, 'HDFC_LINK');
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.rows.length, 1);
    // The Merchant Order ID is aliased into `rrn` — it's the join key against
    // Layer 1, not a bank RRN, and gets the same 12-digit left-pad `normRRN`
    // applies to every adapter's rrn column (`snapshot.ts`'s
    // `hdfcLinkSettlementLedger()` pads Layer 1's own `orderNo` the same way).
    assert.equal((parsed.rows[0] as { rrn: string }).rrn, '000000000003');
    assert.equal((parsed.rows[0] as { grossAmount: number }).grossAmount, 40000);
  });

  it('still resolves a genuine AMEX .csv to AMEX when no filename hint is given either', () => {
    const amexCsv = [
      'Current Date,Payment Date,Record Type,Transaction Timestamp,Card Number,Charge Amount',
      '30/09/2026,29/09/2026,ROC,27/09/2026 19:51:38,379863XXXXX3000,"3,781.00"',
    ].join('\n');
    const parsed = parseMprFile('daily_export.csv', Buffer.from(amexCsv, 'utf8'), null);
    assert.equal(parsed.source, 'AMEX');
    assert.equal(parsed.matchStrategy, 'batch');
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

  it('settles an HDFC Link row keyed by order number instead of a bank RRN — Layer 1 puts orderNo in `rrn`, the adapter aliases Merchant Order ID into `rrn` too', () => {
    const result = runMatch(
      emptyInput({
        sessions: [ledgerRow({ rrn: '00003', acquirer: 'HDFC_LINK', plAmount: 40000 })],
        mprParsed: [
          {
            source: 'HDFC_LINK',
            matchStrategy: 'rrn',
            rows: [mprRow({ rrn: '00003', grossAmount: 40000, _source: 'HDFC_LINK', _file: 'hdfc_link.csv' })],
            filename: 'hdfc_link.csv',
          },
        ],
      }),
    );
    assert.equal(result.settled.length, 1);
    assert.equal(result.amountMismatch.length, 0);
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

function amexMprRow(overrides: Partial<{ txnDate: string | null; cardLast4: string; amount: number; settlementDate: string | null; _file: string }> = {}) {
  return { txnDate: '2026-09-27', cardLast4: '3000', amount: 3781, settlementDate: '2026-09-29', _file: 'amex.csv', ...overrides };
}

describe('runMatch() — AMEX transaction matching', () => {
  it('settles when Transaction Date + Card (last 4) + Amount (±₹0.50) all agree', () => {
    const session = ledgerRow({ acquirer: 'AMEX', plDate: '27/09/2026 07:51:38 PM', cardNo: '379863XXXXX3000', plAmount: 3781 });
    const result = runMatch(
      emptyInput({
        sessions: [session],
        mprParsed: [{ source: 'AMEX', matchStrategy: 'batch', rows: [amexMprRow()], filename: 'amex.csv' }],
      }),
    );
    assert.equal(result.amexResults.length, 1);
    assert.equal(result.amexResults[0]!._match, 'settled');
    assert.equal(result.amexResults[0]!.cardLast4, '3000');
  });

  it('flags a mismatch when the date and card match but the amount does not', () => {
    const session = ledgerRow({ acquirer: 'AMEX', plDate: '27/09/2026 07:51:38 PM', cardNo: '379863XXXXX3000', plAmount: 3700 });
    const result = runMatch(
      emptyInput({
        sessions: [session],
        mprParsed: [{ source: 'AMEX', matchStrategy: 'batch', rows: [amexMprRow({ amount: 3781 })], filename: 'amex.csv' }],
      }),
    );
    assert.equal(result.amexResults[0]!._match, 'mismatch');
    assert.equal(result.amexResults[0]!._diff, 3700 - 3781);
  });

  it('is pending when the ledger row has no AMEX row sharing its date + card', () => {
    const session = ledgerRow({ acquirer: 'AMEX', plDate: '27/09/2026 07:51:38 PM', cardNo: '379863XXXXX3000', plAmount: 3781 });
    const result = runMatch(emptyInput({ sessions: [session] }));
    assert.equal(result.amexResults[0]!._match, 'pending');
  });

  it('flags an unmatched AMEX row as unexpected rather than silently dropped', () => {
    const result = runMatch(
      emptyInput({ mprParsed: [{ source: 'AMEX', matchStrategy: 'batch', rows: [amexMprRow()], filename: 'amex.csv' }] }),
    );
    assert.equal(result.amexResults.length, 1);
    assert.equal(result.amexResults[0]!._match, 'unexpected');
    assert.equal(result.amexResults[0]!.outlet, '');
  });

  it('resolves two ledger rows on the same card and day via their distinct amounts, rather than flagging them ambiguous (the realistic repeat-customer case)', () => {
    const sessions = [
      ledgerRow({ acquirer: 'AMEX', plDate: '27/09/2026 07:51:38 PM', cardNo: '379863XXXXX3000', plAmount: 3781 }),
      ledgerRow({ acquirer: 'AMEX', plDate: '27/09/2026 07:51:38 PM', cardNo: '379863XXXXX3000', plAmount: 500 }),
    ];
    const result = runMatch(
      emptyInput({
        sessions,
        mprParsed: [
          { source: 'AMEX', matchStrategy: 'batch', rows: [amexMprRow({ amount: 3781 }), amexMprRow({ amount: 500 })], filename: 'amex.csv' },
        ],
      }),
    );
    assert.equal(result.amexResults.length, 2);
    assert.ok(result.amexResults.every((r) => r._match === 'settled'));
  });

  it('never guesses when two AMEX rows share the same date + card and neither matches the ledger amount', () => {
    const session = ledgerRow({ acquirer: 'AMEX', plDate: '27/09/2026 07:51:38 PM', cardNo: '379863XXXXX3000', plAmount: 999 });
    const result = runMatch(
      emptyInput({
        sessions: [session],
        mprParsed: [
          { source: 'AMEX', matchStrategy: 'batch', rows: [amexMprRow({ amount: 3781 }), amexMprRow({ amount: 500 })], filename: 'amex.csv' },
        ],
      }),
    );
    // The ledger row can't be attributed to either AMEX row, and both AMEX rows stay visible as unexpected rather than vanishing.
    assert.equal(result.amexResults.length, 3);
    assert.equal(result.amexResults.filter((r) => r._match === 'ambiguous').length, 1);
    assert.equal(result.amexResults.filter((r) => r._match === 'unexpected').length, 2);
  });

  it('never guesses when the full Transaction Date + Card + Amount key itself collides on both sides', () => {
    const sessions = [
      ledgerRow({ acquirer: 'AMEX', plDate: '27/09/2026 07:51:38 PM', cardNo: '379863XXXXX3000', plAmount: 3781 }),
      ledgerRow({ acquirer: 'AMEX', plDate: '27/09/2026 07:51:38 PM', cardNo: '379863XXXXX3000', plAmount: 3781 }),
    ];
    const result = runMatch(
      emptyInput({
        sessions,
        mprParsed: [{ source: 'AMEX', matchStrategy: 'batch', rows: [amexMprRow({ amount: 3781 }), amexMprRow({ amount: 3781 })], filename: 'amex.csv' }],
      }),
    );
    assert.equal(result.amexResults.filter((r) => r._match === 'ambiguous').length, 2);
    assert.equal(result.amexResults.filter((r) => r._match === 'unexpected').length, 2);
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
        mprParsed: [{ source: 'AMEX', matchStrategy: 'batch', rows: [amexMprRow()], filename: 'amex.csv' }],
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
