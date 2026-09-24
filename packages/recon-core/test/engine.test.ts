/**
 * Behavioural tests for the ported engine.
 *
 * These are written as characterisation tests: each assertion encodes a
 * behaviour the legacy `reconciliation (68).html` exhibited, so a future change
 * that alters reconciliation outcomes fails here loudly rather than quietly
 * shifting numbers in a GM's report.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';

import {
  buildPRMap,
  buildSumMap,
  buildWin,
  civilToISO,
  detectOutletFromZip,
  findUnsettledSuccessRows,
  fmtDate,
  frsRowAmounts,
  grandTotals,
  istDate,
  money,
  parseHdfcStatement,
  parsePaymentReport,
  parsePaymentSummary,
  parsePRDate,
  parseSaleSummaryDrawerSection,
  parseSaleSummarySalesSection,
  parseSaleSummaryTaxesSection,
  parseTransactionsZip,
  reconcile,
  routePayName,
  todayIsoIST,
  FRS_METHODS,
} from '../dist/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const PR_CSV = [
  'Toit Payment Report,,,,,,,,,,,',
  'Order No,Date,Customer Name,Employee,Payment Type,Payment Name,Card Number,Auth Code,Amount,Tip,Bank,Retrieval Reference No',
  '1001,01-Aug-2026 21:14:03,Alice,E1,Card,Pinelabs APOS,411111,A1,1000.00,0,HDFC,100000000001',
  '1002,01-Aug-2026 21:20:00,Bob,E1,Card,Pinelabs APOS,411111,A2,600.00,0,HDFC,100000000002',
  '1003,01-Aug-2026 21:21:00,Bob,E1,Card,Pinelabs APOS,411111,A3,400.00,0,HDFC,100000000002',
  '1004,01-Aug-2026 21:30:00,Carol,E2,Card,Pinelabs APOS,411111,A4,500.00,0,HDFC,100000000003',
  '1005,01-Aug-2026 21:40:00,Dan,E2,Card,Manual APOS,,A5,300.00,0,HDFC,100000000004',
  '1006,01-Aug-2026 21:50:00,Eve,E3,Card,Pinelabs APOS,411111,A6,700.00,0,HDFC,100000000005',
  '1007,01-Aug-2026 22:00:00,Fay,E3,Card,Pinelabs APOS,411111,A7,900.00,0,HDFC,100000000007',
  '1008,01-Aug-2026 22:05:00,Gil,E3,Card,Pinelabs APOS,411111,A8,250.00,0,HDFC,',
  '1009,01-Aug-2026 22:10:00,Hal,E4,Card,Pinelabs APOS,371111,AUTH01,1500.00,0,AMEX,200000000001',
  '1010,01-Aug-2026 22:15:00,Ivy,E4,Card,Pinelabs APOS,371111,,1600.00,0,American Express,200000000002',
  '1011,01-Aug-2026 22:20:00,Jon,E4,Card,Pinelabs APOS,371111,AUTH03,1700.00,0,AMEX,200000000003',
  '1012,01-Aug-2026 22:25:00,Kim,E5,Cash,Cash,,,450.00,0,,',
  '1013,01-Aug-2026 22:30:00,Lea,E5,UPI,HDFC Static UPI,,,350.00,0,,300000000001',
  '1014,01-Aug-2026 22:35:00,Moe,E5,Hold,Bills on Hold,,,275.00,0,,',
  '1015,01-Aug-2026 22:40:00,Ned,E5,Bank,Bank transfer,,,525.00,0,,',
  '1016,01-Aug-2026 22:45:00,Oli,E5,Online,Swiggy,,,199.00,0,,',
].join('\n');

const ZIP_HEADER =
  'Acquirer,Payment Mode,Name,Card Issuer,Amount,Tip Amount,Date,Batch Status,' +
  'Txn Status,RRN,Settlement Date,Bill Invoice,Invoice,Approval Code,Type,Zone,' +
  'Store Name,TID,MID,Hardware Model';

const ZIP_CSV = [
  ZIP_HEADER,
  // matched exactly
  'PINELABS,CARD,Alice,VISA,1000.00,0,01/08/2026 09:14:03 PM,Settled,Success,100000000001,02/08/2026,B1,INV1,A1,Sale,South,Toit- Bangalore,T1,M1,APOS',
  // matched against a two-order PR group
  'PINELABS,CARD,Bob,VISA,1000.00,0,01/08/2026 09:20:30 PM,Settled,Success,100000000002,02/08/2026,B2,INV2,A2,Sale,South,Toit- Bangalore,T1,M1,APOS',
  // terminal collected 20 more than POS recorded
  'PINELABS,CARD,Carol,VISA,520.00,0,01/08/2026 09:30:00 PM,Settled,Success,100000000003,02/08/2026,B3,INV3,A3,Sale,South,Toit- Bangalore,T1,M1,APOS',
  // Manual APOS, exact tie — auto square-off
  'PINELABS,CARD,Dan,VISA,300.00,0,01/08/2026 09:40:00 PM,Settled,Success,100000000004,02/08/2026,B4,INV4,A4,Sale,South,Toit- Bangalore,T1,M1,APOS',
  // terminal-only
  'PINELABS,CARD,Zed,VISA,800.00,0,01/08/2026 09:45:00 PM,Settled,Success,100000000006,02/08/2026,B5,INV5,A5,Sale,South,Toit- Bangalore,T1,M1,APOS',
  // duplicate RRN on the terminal side
  'PINELABS,CARD,Fay,VISA,900.00,0,01/08/2026 10:00:00 PM,Settled,Success,100000000007,02/08/2026,B6,INV6,A6,Sale,South,Toit- Bangalore,T1,M1,APOS',
  'PINELABS,CARD,Fay,VISA,900.00,0,01/08/2026 10:00:05 PM,Settled,Success,100000000007,02/08/2026,B7,INV7,A7,Sale,South,Toit- Bangalore,T1,M1,APOS',
  // AMEX with an approval code
  'AMEX,CARD,Hal,AMEX,1500.00,0,01/08/2026 10:10:00 PM,Settled,Success,,02/08/2026,B8,INV8,AUTH01,Sale,South,Toit- Bangalore,T1,M2,APOS',
  // AMEX with no code — amount fallback
  'AMEX,CARD,Ivy,AMEX,1600.00,0,01/08/2026 10:15:00 PM,Settled,Success,,02/08/2026,B9,INV9,,Sale,South,Toit- Bangalore,T1,M2,APOS',
  // 09:00 next morning — past the 07:00 window end
  'PINELABS,CARD,Late,VISA,111.00,0,02/08/2026 09:00:00 AM,Settled,Success,100000000099,02/08/2026,B10,INV10,A10,Sale,South,Toit- Bangalore,T1,M1,APOS',
  // not successful
  'PINELABS,CARD,Fail,VISA,222.00,0,01/08/2026 10:20:00 PM,Pending,FAILED,100000000098,02/08/2026,B11,INV11,A11,Sale,South,Toit- Bangalore,T1,M1,APOS',
  // Paper POS — excluded from electronic settlement recon
  'PINELABS,PAPER POS,Paper,VISA,333.00,0,01/08/2026 10:25:00 PM,Settled,Success,100000000097,02/08/2026,B12,INV12,A12,Sale,South,Toit- Bangalore,T1,M1,PAPER POS',
].join('\n');

const SUMMARY_CSV = [
  'Business Date,Cash,Pinelabs APOS,HDFC Static UPI,Kotak Static UPI,Bills on Hold,Bank transfer',
  '01-Aug-2026,"450.00","5,020.00","350.00","0.00","275.00","525.00"',
].join('\n');

// A trimmed-down excerpt of a real Sale Summary export — the PAYMENT SUMMARY
// section before the DRAWER SUMMARY one, and the start of the Department
// Summary section after it, are kept to exercise the "stop at the next
// section" boundary the same way a full export would.
const SALE_SUMMARY_CSV = [
  'Sale Summary,Toit(Toit - Bengaluru),From : 01/09/2026  To : 09/09/2026,Generated On : 10-Sep-2026 11:25 AM',
  'PAYMENT SUMMARY',
  'Bills on Hold ,"38,022.00"',
  'Cash,"685,890.00"',
  'Total,"14,272,816.36"',
  'DRAWER SUMMARY',
  'Opening Balance,0.00',
  'Paid In,0.00',
  'Paid Out,"1,770.00"',
  'Refund,0.00',
  'Cash Drop,0.00',
  'Total Expected,"14,271,046.36"',
  'Pinelabs APOS,"13,081,221.00"',
  'Swiggy,"203,667.00"',
  'Bills on Hold ,"38,022.00"',
  'HDFC Static UPI ,"11,183.00"',
  'PINELABS-CI,0.00',
  'Card/UPI ,0.00',
  'Cash,"684,590.00"',
  'Manual APOS ,"257,319.00"',
  'Closing Balance,"14,276,002.00"',
  'Over Shortage,"4,955.64"',
  'Department Summary',
  'Label,Quantity,Base Price,Net Sales',
  'ALCOHOL,6059,"2,901,715.00","2,893,391.24"',
].join('\n');

const SALE_SUMMARY_TAXES_CSV = [
  'Sale Summary,Toit(Toit - Bengaluru),From : 01/09/2026  To : 09/09/2026,Generated On : 10-Sep-2026 11:25 AM',
  'SALES',
  'Total Orders,120',
  'Net Sales,"2,557,998.06"',
  'TAXES',
  'SGST- MERCHANDISE (9.00),291.74',
  'CGST - TOBACCO (20%),"2,071.30"',
  'CGST- F&B,"26,778.23"',
  'SGST- F&B,"26,778.23"',
  'VAT,"4,087.39"',
  'Total,"60,006.66"',
  'DISCOUNT SUMMARY',
  'Discount Type,Amount',
  'Complimentary,0.00',
].join('\n');

async function makeZip(csv: string): Promise<Buffer> {
  const z = new JSZip();
  z.file('AllTransactions.csv', csv);
  return z.generateAsync({ type: 'nodebuffer' });
}

function makeHdfcStatement(): Buffer {
  const aoa = [
    [
      'Transaction Date',
      'Transaction Time',
      'City',
      'Transaction State',
      'Amount(Rs.)',
      'RRN No',
      "Payer's name",
    ],
    ['2026-08-01', '10:30:00 PM', 'BANGALORE', 'SaleSuccess', 350, '300000000001', 'Lea'],
    ['2026-08-01', '10:36:00 PM', 'BANGALORE', 'SaleFailed', 100, '300000000002', 'Nope'],
    ['2026-08-01', '10:37:00 PM', 'DELHI', 'SaleSuccess', 200, '300000000003', 'Far'],
    ['2026-08-01', '10:38:00 PM', 'BANGALORE', 'SaleSuccess', 275, '300000000004', 'Xtra'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Statement');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ── Unit-level behaviour ──────────────────────────────────────────────────

describe('money()', () => {
  it('strips separators, spaces and the rupee sign', () => {
    assert.equal(money('1,234.56'), 1234.56);
    assert.equal(money('₹ 2,000'), 2000);
    assert.equal(money(' 500 '), 500);
  });

  it('returns NaN for absent values so "no value" stays distinct from zero', () => {
    assert.ok(Number.isNaN(money(null)));
    assert.ok(Number.isNaN(money(undefined)));
    assert.ok(Number.isNaN(money('')));
  });
});

describe('routePayName()', () => {
  it('routes each payment family to its panel', () => {
    assert.equal(routePayName('Pinelabs APOS'), 'pinelabs');
    assert.equal(routePayName('Manual APOS'), 'pinelabs');
    assert.equal(routePayName('Card/UPI'), 'pinelabs');
    assert.equal(routePayName('Swiggy-Online'), 'swiggy');
    assert.equal(routePayName('ZOMATO'), 'swiggy');
    assert.equal(routePayName('Cash'), 'cash');
    assert.equal(routePayName('HDFC Static UPI'), 'upi');
    assert.equal(routePayName('Kotak Static UPI'), 'upi');
    assert.equal(routePayName('Bills on Hold'), 'bills');
    assert.equal(routePayName('Bank transfer'), 'bank');
    // Confirmed against a real Payment Report export: the actual payment
    // name is "HDFC Payment Link" — "HDFC Link" alone is also accepted
    // (substring match) in case a different export uses the shorter form.
    assert.equal(routePayName('HDFC Payment Link'), 'hdfc_link');
    assert.equal(routePayName('HDFC Link'), 'hdfc_link');
    assert.equal(routePayName('hdfc payment link'), 'hdfc_link');
    assert.equal(routePayName('Gift From Toit'), 'other');
  });

  it('matches Cash and UPI exactly, not by substring', () => {
    // 'Cash' routes to cash, but 'Cash Card' must not — the legacy code used
    // exact equality for these two families specifically.
    assert.equal(routePayName('Cashback Voucher'), 'other');
  });
});

describe('business window', () => {
  it('runs 08:00 IST to 07:00 IST the next morning', () => {
    const w = buildWin({ y: 2026, m: 7, d: 1 });
    assert.equal(w.start.toISOString(), '2026-08-01T02:30:00.000Z'); // 08:00 IST
    assert.equal(w.end.toISOString(), '2026-08-02T01:30:00.000Z'); // 07:00 IST next day
  });

  it('is independent of the host timezone', () => {
    // istDate() pins the wall clock to Asia/Kolkata regardless of TZ.
    assert.equal(istDate(2026, 7, 1, 8).toISOString(), '2026-08-01T02:30:00.000Z');
  });
});

describe('parsePRDate()', () => {
  it('reads dd-Mon-yyyy (the original, most common shape)', () => {
    assert.deepEqual(parsePRDate('23-Sep-2026 20:14:03'), { y: 2026, m: 8, d: 23 });
  });

  it('reads M/D/yyyy H:MM, no leading zeros or seconds — a real confirmed Toit Bagmane export shape', () => {
    // The exact row shape that motivated this: "9/23/2026 0:04" — single-
    // digit month AND hour, day of month unambiguously >12.
    assert.deepEqual(parsePRDate('9/23/2026 12:34'), { y: 2026, m: 8, d: 23 });
    assert.deepEqual(parsePRDate('9/23/2026 0:04'), { y: 2026, m: 8, d: 23 });
  });

  it('rejects an out-of-range month/day in the slash form rather than guessing', () => {
    assert.equal(parsePRDate('13/40/2026 12:00'), null);
  });

  it('returns null for garbage or an empty value', () => {
    assert.equal(parsePRDate('not a date'), null);
    assert.equal(parsePRDate(''), null);
    assert.equal(parsePRDate(null), null);
    assert.equal(parsePRDate(undefined), null);
  });
});

describe('fmtDate()', () => {
  it('normalises all three source formats to dd/mm/yy 12-hour', () => {
    assert.equal(fmtDate('01/08/2026 09:14:03 PM'), '01/08/26 09:14:03 PM');
    assert.equal(fmtDate('01-Aug-2026 21:14:03'), '01/08/26 09:14:03 PM');
    assert.equal(fmtDate('01-Aug-2026 00:05:00'), '01/08/26 12:05:00 AM');
    assert.equal(fmtDate('9/23/2026 12:34'), '23/09/26 12:34:00 PM');
    assert.equal(fmtDate('9/23/2026 0:04'), '23/09/26 12:04:00 AM');
  });

  it('passes through anything it does not recognise', () => {
    assert.equal(fmtDate('not a date'), 'not a date');
    assert.equal(fmtDate(''), '—');
  });
});

// ── Parsers ───────────────────────────────────────────────────────────────

describe('parsePaymentReport()', () => {
  const parsed = parsePaymentReport(PR_CSV);

  it('finds the header row past the preamble', () => {
    assert.equal(parsed.rows.length, 16);
  });

  it('takes the business date from the first parseable row', () => {
    assert.deepEqual(parsed.bizDate, { y: 2026, m: 7, d: 1 });
    assert.equal(civilToISO(parsed.bizDate!), '2026-08-01');
  });

  it('flags AMEX from either bank spelling', () => {
    const amex = parsed.rows.filter((r) => r.isAmex).map((r) => r.orderNo);
    assert.deepEqual(amex, ['1009', '1010', '1011']);
  });

  it('routes rows onto panels', () => {
    const counts: Record<string, number> = {};
    for (const r of parsed.rows) counts[r.tab] = (counts[r.tab] || 0) + 1;
    assert.equal(counts.pinelabs, 11);
    assert.equal(counts.cash, 1);
    assert.equal(counts.upi, 1);
    assert.equal(counts.bills, 1);
    assert.equal(counts.bank, 1);
    assert.equal(counts.swiggy, 1);
  });

  it('excludes the per-outlet subtotal line and the trailing Grand Total line — both have a non-blank first cell (outlet name / "Grand Total") but no Payment Name', () => {
    const csvWithBoundaryRows = [
      'Payment Report,Toit(Toit Bangalore),From : 17/09/2026  To : 17/09/2026,Generated On : 18-Sep-2026',
      'Order No,Vendor ID,Transaction Date,Customer Name,Employee Name,Payment Type,Payment Name,Reason,Comment,Card Number,Auth Code,Amount,Tips,Bank Name,Retrieval Ref. No',
      '',
      'Toit Bangalore,,,,,,,,,,,"1,630.00",0.00,,',
      '1001,,17-Sep-2026 12:05:55,Nitesh,,OnlineOrder,SWIGGY-Online,,,,,630.00,0.00,,',
      '1002,,17-Sep-2026 12:53:47,Walk-in,Deepak,PINELABS-APOS,Pinelabs APOS,,,\'@axl\',\'721762\',1000.00,0.00,HDFC UPI,698346708753',
      '',
      'Grand Total,,,,,,,,,,,"1,630.00",0.00,,',
    ].join('\n');

    const { rows } = parsePaymentReport(csvWithBoundaryRows);
    assert.equal(rows.length, 2, 'only the two real transaction rows parsed');
    assert.ok(rows.every((r) => r.paymentName.trim() !== ''), 'no phantom blank-payment-name row');
    assert.ok(!rows.some((r) => r.orderNo === 'Toit Bangalore'), 'subtotal line excluded');
    assert.ok(!rows.some((r) => r.orderNo === 'Grand Total'), 'Grand Total line excluded');
  });

  it('reads the business date from a report using the alternate M/D/yyyy H:MM export shape (real Toit Bagmane sample)', () => {
    const csvAltDateFormat = [
      'Payment Report,Toit(Toit Bangalore - Mahadevapura),From : 23/09/2026  To : 23/09/2026,Generated On : 24-Sep-2026 12:07 PM,,,,,,,,,,,',
      'Order No,Vendor ID,Transaction Date,Customer Name,Employee Name,Payment Type,Payment Name,Reason,Comment,Card Number,Auth Code,Amount,Tips,Bank Name,Retrieval Ref. No',
      ',,,,,,,,,,,,,,',
      'Toit Bangalore - Mahadevapura,,,,,,,,,,,"1,047,789.97",0,,',
      "11044670,,9/23/2026 12:34,Walk-in,Arjun BAGT,PINELABS-APOS,Pinelabs APOS,,,'cici','753505',269,0,HDFC UPI,626677739313",
      // A row past physical midnight, still labelled with the same business
      // date — the actual file this was confirmed against does this too.
      "11044916,,9/23/2026 0:04,Walk-in,Ningamwon Vakhong,PINELABS-APOS,Pinelabs APOS,,,'8979','052755',\"1,505.00\",0,KOTAKATOS BANK,626618291089",
      ',,,,,,,,,,,,,,',
      'Grand Total,,,,,,,,,,,"1,047,789.97",0,,',
    ].join('\n');

    const { rows, bizDate } = parsePaymentReport(csvAltDateFormat);
    assert.equal(rows.length, 2);
    assert.deepEqual(bizDate, { y: 2026, m: 8, d: 23 });
    assert.equal(civilToISO(bizDate!), '2026-09-23');
  });
});

describe('parseTransactionsZip()', () => {
  it('applies all three exclusions and records why', async () => {
    const win = buildWin({ y: 2026, m: 7, d: 1 });
    const { inside, filtered } = await parseTransactionsZip(await makeZip(ZIP_CSV), win);

    assert.equal(inside.length, 9);
    assert.equal(filtered.length, 3);

    const reasons = filtered.map((f) => f._fReason).sort();
    assert.deepEqual(reasons, [
      'Not successful (FAILED)',
      'Outside business window',
      'Paper POS — excluded from recon',
    ]);
  });

  it('resolves the outlet from the terminal store name', async () => {
    const win = buildWin({ y: 2026, m: 7, d: 1 });
    const { inside } = await parseTransactionsZip(await makeZip(ZIP_CSV), win);
    assert.equal(detectOutletFromZip(inside), 'BLRT');
  });
});

describe('findUnsettledSuccessRows() — Batch Settle Check', () => {
  it('finds nothing when every Success row is Settled', async () => {
    const win = buildWin({ y: 2026, m: 7, d: 1 });
    const { inside, filtered } = await parseTransactionsZip(await makeZip(ZIP_CSV), win);
    assert.deepEqual(findUnsettledSuccessRows(inside, filtered), []);
  });

  it('flags a Success row whose Batch Status is not Settled', async () => {
    const win = buildWin({ y: 2026, m: 7, d: 1 });
    const csv =
      ZIP_CSV +
      '\nPINELABS,CARD,Unsettled,VISA,444.00,0,01/08/2026 10:30:00 PM,Pending,Success,100000000096,02/08/2026,B13,INV13,A13,Sale,South,Toit- Bangalore,T1,M1,APOS';
    const { inside, filtered } = await parseTransactionsZip(await makeZip(csv), win);
    const unsettled = findUnsettledSuccessRows(inside, filtered);
    assert.equal(unsettled.length, 1);
    assert.equal(unsettled[0]!.rrn, '100000000096');
    assert.equal(unsettled[0]!.batchStatus, 'Pending');
  });

  it('still flags an unsettled row even when Paper-POS/window filtering excluded it from `inside`', async () => {
    const win = buildWin({ y: 2026, m: 7, d: 1 });
    // Paper POS *and* unsettled — a row can be excluded from reconciliation
    // math for one reason while still surfacing a genuine settle problem.
    const csv =
      ZIP_CSV +
      '\nPINELABS,PAPER POS,UnsettledPaper,VISA,555.00,0,01/08/2026 10:35:00 PM,Pending,Success,100000000095,02/08/2026,B14,INV14,A14,Sale,South,Toit- Bangalore,T1,M1,PAPER POS';
    const { inside, filtered } = await parseTransactionsZip(await makeZip(csv), win);
    assert.equal(inside.some((r) => r.rrn === '100000000095'), false);
    const unsettled = findUnsettledSuccessRows(inside, filtered);
    assert.ok(unsettled.some((r) => r.rrn === '100000000095'));
  });

  it('does not flag a row excluded for being non-successful, even if also unsettled', async () => {
    const win = buildWin({ y: 2026, m: 7, d: 1 });
    const { inside, filtered } = await parseTransactionsZip(await makeZip(ZIP_CSV), win);
    // The fixture's own FAILED row is `Pending` in Batch Status — confirms the
    // check is scoped to Success rows only, not "any non-Settled row".
    const failedRow = filtered.find((f) => f._fReason?.startsWith('Not successful'));
    assert.equal(failedRow?.batchStatus, 'Pending');
    assert.equal(
      findUnsettledSuccessRows(inside, filtered).some((r) => r.rrn === failedRow?.rrn),
      false,
    );
  });
});

describe('parsePaymentSummary()', () => {
  it('reads the header/value pair into a map', () => {
    const sum = parsePaymentSummary(SUMMARY_CSV);
    assert.ok(sum);
    assert.equal(sum!['Cash'], '450.00');
    assert.equal(sum!['Pinelabs APOS'], '5,020.00');
  });

  it('returns null when the business-date header is absent', () => {
    assert.equal(parsePaymentSummary('a,b,c\n1,2,3'), null);
  });
});

describe('parseSaleSummaryDrawerSection()', () => {
  it('reads the DRAWER SUMMARY section, trimming labels with a trailing space', () => {
    const sum = parseSaleSummaryDrawerSection(SALE_SUMMARY_CSV);
    assert.ok(sum);
    assert.equal(sum!['Cash'], '684,590.00');
    assert.equal(sum!['HDFC Static UPI'], '11,183.00');
    assert.equal(sum!['Bills on Hold'], '38,022.00');
    assert.equal(sum!['Card/UPI'], '0.00');
  });

  it('stops at the next section rather than reading past it', () => {
    const sum = parseSaleSummaryDrawerSection(SALE_SUMMARY_CSV);
    assert.ok(sum);
    assert.equal('Label' in sum!, false);
    assert.equal('ALCOHOL' in sum!, false);
  });

  it('returns null when no DRAWER SUMMARY section exists', () => {
    assert.equal(parseSaleSummaryDrawerSection('a,b,c\n1,2,3'), null);
  });
});

describe('parseSaleSummarySalesSection()', () => {
  it('reads the SALES section, including Net Sales', () => {
    const sales = parseSaleSummarySalesSection(SALE_SUMMARY_TAXES_CSV);
    assert.ok(sales);
    assert.equal(sales!['Net Sales'], '2,557,998.06');
    assert.equal(sales!['Total Orders'], '120');
  });

  it('stops at the next section (TAXES) rather than reading past it', () => {
    const sales = parseSaleSummarySalesSection(SALE_SUMMARY_TAXES_CSV);
    assert.ok(sales);
    assert.equal('VAT' in sales!, false);
  });

  it('returns null when no SALES section exists', () => {
    assert.equal(parseSaleSummarySalesSection(SALE_SUMMARY_CSV), null);
  });
});

describe('parseSaleSummaryTaxesSection()', () => {
  it('reads every free-form CGST/SGST/VAT line plus the Total row', () => {
    const taxes = parseSaleSummaryTaxesSection(SALE_SUMMARY_TAXES_CSV);
    assert.ok(taxes);
    assert.equal(taxes!['SGST- MERCHANDISE (9.00)'], '291.74');
    assert.equal(taxes!['CGST - TOBACCO (20%)'], '2,071.30');
    assert.equal(taxes!['VAT'], '4,087.39');
    assert.equal(taxes!['Total'], '60,006.66');
  });

  it('stops at the next section (DISCOUNT SUMMARY) rather than reading past it', () => {
    const taxes = parseSaleSummaryTaxesSection(SALE_SUMMARY_TAXES_CSV);
    assert.ok(taxes);
    assert.equal('Discount Type' in taxes!, false);
    assert.equal('Complimentary' in taxes!, false);
  });

  it('returns null when no TAXES section exists', () => {
    assert.equal(parseSaleSummaryTaxesSection(SALE_SUMMARY_CSV), null);
  });
});

describe('todayIsoIST()', () => {
  it('reads the IST calendar date, not the UTC one — differs for 5h30m every night', () => {
    // 2026-09-23T19:00:00Z is 2026-09-24 00:30 IST — already tomorrow in IST,
    // but a raw `new Date().toISOString().slice(0, 10)` would still say the 23rd.
    const justAfterMidnightIST = new Date('2026-09-23T19:00:00.000Z');
    assert.equal(todayIsoIST(justAfterMidnightIST), '2026-09-24');
    assert.equal(justAfterMidnightIST.toISOString().slice(0, 10), '2026-09-23');
  });

  it('agrees with a UTC slice comfortably inside the IST day (no boundary ambiguity)', () => {
    const midDayIST = new Date('2026-01-01T05:00:00.000Z'); // 2026-01-01 10:30 IST
    assert.equal(todayIsoIST(midDayIST), '2026-01-01');
  });

  it('rolls over the year correctly', () => {
    const newYearEveLateIST = new Date('2027-12-31T20:00:00.000Z'); // 2028-01-01 01:30 IST
    assert.equal(todayIsoIST(newYearEveLateIST), '2028-01-01');
  });
});

describe('parseHdfcStatement()', () => {
  it('keeps SaleSuccess rows in window and counts what it dropped', () => {
    const win = buildWin({ y: 2026, m: 7, d: 1 });
    const out = parseHdfcStatement(makeHdfcStatement(), win);

    assert.equal(out.rows.length, 2);
    assert.equal(out.skippedFailed, 1);
    assert.equal(out.unknownCity, 1);
    assert.deepEqual(
      out.rows.map((r) => r.rrn),
      ['300000000001', '300000000004'],
    );
    assert.equal(out.rows[0]!.outlet, 'BLRT');
  });
});

// ── Reconciliation ────────────────────────────────────────────────────────

describe('reconcile()', () => {
  async function runRecon(withStatement: boolean) {
    const win = buildWin({ y: 2026, m: 7, d: 1 });
    const { rows: prData } = parsePaymentReport(PR_CSV);
    const { inside, filtered } = await parseTransactionsZip(await makeZip(ZIP_CSV), win);
    const hdfcStmtRows = withStatement
      ? parseHdfcStatement(makeHdfcStatement(), win).rows
      : null;
    const result = reconcile({ prData, zipInside: inside, hdfcStmtRows, outlet: 'BLRT' });
    return { result, prData, inside, filtered, win };
  }

  it('groups PR rows sharing an RRN and compares group totals', async () => {
    const { result } = await runRecon(false);
    const grouped = result.pinelabs.reconRows.find((x) => x.rrn === '100000000002');
    assert.ok(grouped);
    assert.equal(grouped!.orders.length, 2);
    assert.equal(grouped!.prAmt, 1000);
    assert.equal(grouped!.plAmt, 1000);
    assert.equal(grouped!.diff, 0);
  });

  it('reports diff as terminal minus POS', async () => {
    const { result } = await runRecon(false);
    const over = result.pinelabs.reconRows.find((x) => x.rrn === '100000000003');
    assert.equal(over!.diff, 20); // terminal 520 − POS 500
  });

  it('auto-squares-off Manual APOS ties', async () => {
    const { result } = await runRecon(false);
    const manual = result.pinelabs.reconRows.find((x) => x.rrn === '100000000004');
    assert.equal(manual!.isManualAPOS, true);
    assert.equal(manual!.squaredOff, true);
  });

  it('does not square off non-Manual-APOS ties', async () => {
    const { result } = await runRecon(false);
    const plain = result.pinelabs.reconRows.find((x) => x.rrn === '100000000001');
    assert.equal(plain!.diff, 0);
    assert.equal(plain!.squaredOff, false);
  });

  it('separates POS-only, terminal-only and duplicate RRNs', async () => {
    const { result } = await runRecon(false);
    const p = result.pinelabs;

    assert.equal(p.reconRows.length, 4);

    // 100000000005 (no terminal), the no-RRN row, and the unmatched AMEX row
    assert.deepEqual(
      p.onlyPOS.map((x) => x.orderNo).sort(),
      ['1006', '1008', '1011'],
    );

    assert.deepEqual(p.onlyTerm.map((x) => x.rrn), ['100000000006']);

    assert.equal(p.dupRRN.length, 1);
    assert.equal(p.dupRRN[0]!._dupSrc, 'Terminal');
  });

  it('marks a PR row with no RRN rather than dropping it', async () => {
    const { result } = await runRecon(false);
    const noRRN = result.pinelabs.onlyPOS.find((x) => x.orderNo === '1008');
    assert.equal(noRRN!._note, 'No RRN');
  });

  it('excludes a duplicated terminal RRN from the terminal-only bucket', async () => {
    // Neither side can be asserted unmatched when the key is ambiguous.
    const { result } = await runRecon(false);
    assert.ok(!result.pinelabs.onlyTerm.some((x) => x.rrn === '100000000007'));
  });

  it('matches AMEX by auth code first, then by amount', async () => {
    const { result } = await runRecon(false);
    const ok = result.pinelabs.amexOk;
    assert.equal(ok.length, 2);

    const byCode = ok.find((x) => x._matchBy === 'code');
    assert.equal(byCode!.pr.authCode, 'AUTH01');
    assert.equal(byCode!.zip.approvalCode, 'AUTH01');

    const byAmount = ok.find((x) => x._matchBy === 'amount');
    assert.equal(byAmount!.pr.amount, 1600);
    assert.equal(byAmount!.zip.amount, 1600);
  });

  it('leaves an AMEX row with no counterpart as POS-only', async () => {
    const { result } = await runRecon(false);
    const jon = result.pinelabs.onlyPOS.find((x) => x.orderNo === '1011');
    assert.ok(jon);
    assert.equal(jon!.amount, 1700);
  });

  it('buckets non-Pinelabs rows by panel', async () => {
    const { result } = await runRecon(false);
    assert.equal(result.cash.length, 1);
    assert.equal(result.cash[0]!.amount, 450);
    assert.equal(result.upi.length, 1);
    assert.equal(result.bills.length, 1);
    assert.equal(result.bank.length, 1);
    assert.equal(result.swiggy.length, 1);
  });

  it('skips transaction-level UPI when no statement was uploaded', async () => {
    const { result } = await runRecon(false);
    assert.equal(result.upiHdfc, null);
  });

  it('reconciles Static UPI transaction-by-transaction when a statement is uploaded', async () => {
    const { result } = await runRecon(true);
    assert.ok(result.upiHdfc);
    const u = result.upiHdfc!;
    assert.equal(u.reconRows.length, 1);
    assert.equal(u.reconRows[0]!.rrn, '300000000001');
    assert.equal(u.reconRows[0]!.diff, 0);
    assert.equal(u.onlyPOS.length, 0);
    assert.deepEqual(u.onlyTerm.map((x) => x.rrn), ['300000000004']);
  });
});

// ── Final Recon Summary ───────────────────────────────────────────────────

describe('FRS amounts', () => {
  async function frsCtx(withStatement: boolean) {
    const win = buildWin({ y: 2026, m: 7, d: 1 });
    const { rows: prData } = parsePaymentReport(PR_CSV);
    const { inside } = await parseTransactionsZip(await makeZip(ZIP_CSV), win);
    const hdfcStmtRows = withStatement
      ? parseHdfcStatement(makeHdfcStatement(), win).rows
      : null;
    const result = reconcile({ prData, zipInside: inside, hdfcStmtRows, outlet: 'BLRT' });
    return {
      prMap: buildPRMap(prData),
      sumMap: buildSumMap(parsePaymentSummary(SUMMARY_CSV)),
      ctx: { prData, zipInside: inside, upiHdfc: result.upiHdfc },
    };
  }

  it('reconciles Pinelabs against the terminal report, not the drawer', async () => {
    const { prMap, sumMap, ctx } = await frsCtx(false);
    const m = FRS_METHODS.find((x) => x.label === 'Pinelabs')!;
    const a = frsRowAmounts(m, prMap, sumMap, ctx);

    assert.equal(a.usingSource, true);
    assert.equal(a.drawerAmt, null);
    // Terminal side = every in-window ZIP row, AMEX included:
    // 1000+1000+520+300+800+900+900+1500+1600.
    assert.equal(a.sourceAmt, 8520);
    // POS side = every Pinelabs-routed PR row, matched or not.
    assert.equal(a.pr, 9450);
    // Negative: the POS recorded more than the terminal settled — the
    // unmatched POS rows (700 + 250 + 1700) less the terminal-only 800
    // and the +20 overcollection.
    assert.equal(a.diff, -930);
    // The drawer figure for Pinelabs (5,020) is deliberately ignored.
    assert.notEqual(a.sourceAmt, sumMap['Pinelabs APOS']);
  });

  it('uses the drawer summary for Cash', async () => {
    const { prMap, sumMap, ctx } = await frsCtx(false);
    const m = FRS_METHODS.find((x) => x.label === 'Cash')!;
    const a = frsRowAmounts(m, prMap, sumMap, ctx);

    assert.equal(a.usingSource, false);
    assert.equal(a.pr, 450);
    assert.equal(a.drawerAmt, 450);
    assert.equal(a.diff, 0);
  });

  it('feeds a Sale-Summary-extracted drawer figure into FRS amounts the same way a native summary does', async () => {
    const { prMap, ctx } = await frsCtx(false);
    const sumMap = buildSumMap(parseSaleSummaryDrawerSection(SALE_SUMMARY_CSV));
    const m = FRS_METHODS.find((x) => x.label === 'Cash')!;
    const a = frsRowAmounts(m, prMap, sumMap, ctx);

    assert.equal(a.usingSource, false);
    assert.equal(a.drawerAmt, 684590);
  });

  it('switches HDFC Static UPI to transaction level once a statement exists', async () => {
    const m = FRS_METHODS.find((x) => x.label === 'HDFC Static UPI')!;

    const without = await frsCtx(false);
    const a1 = frsRowAmounts(m, without.prMap, without.sumMap, without.ctx);
    assert.equal(a1.usingSource, false);
    assert.equal(a1.drawerAmt, 350);

    const withStmt = await frsCtx(true);
    const a2 = frsRowAmounts(m, withStmt.prMap, withStmt.sumMap, withStmt.ctx);
    assert.equal(a2.usingSource, true);
    assert.equal(a2.sourceAmt, 625); // 350 matched + 275 statement-only
    assert.equal(a2.diff, 275);
  });

  it('excludes POS-integrated methods from the grand total', async () => {
    const { prMap, sumMap, ctx } = await frsCtx(false);
    const { grandPR } = grandTotals(prMap, sumMap, ctx);
    // Pinelabs 9450 + Cash 450 + HDFC UPI 350 + BOH 275 + Bank 525.
    // Swiggy's 199 is assumed reconciled and must not reach the grand total.
    assert.equal(grandPR, 9450 + 450 + 350 + 275 + 525);
    assert.equal(grandPR, 11050);
  });
});
