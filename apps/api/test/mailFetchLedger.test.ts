import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDays, classifyFile, istToday, ledgerReport, MAIL_SOURCES, missingDaily, pruneLedger, recordFile, sendersToSearch, windowStart, type Ledger } from '../src/services/mailFetchLedger.ts';

const TODAY = '2026-11-18';
const allowlist = MAIL_SOURCES.flatMap((s) => s.senders);

/** A ledger holding every daily file for the 7-day window, except those `skip` says to leave out. */
function fullLedger(skip: (bank: string, terminal: string, date: string) => boolean = () => false): Ledger {
  const ledger: Ledger = {};
  for (let i = 0; i < 7; i++) {
    const date = addDays(TODAY, -i);
    for (const s of MAIL_SOURCES) for (const t of s.daily) if (!skip(s.bank, t, date)) ledger[`${s.bank}|${t}|${date}`] = 'x';
  }
  return ledger;
}

describe('classifyFile()', () => {
  it('reads bank, terminal and day from each bank\'s real file names', () => {
    assert.deepEqual(classifyFile('0790431A0176988_2026_11_18.xlsx'), { bank: 'kotak', terminal: '0176988', date: '2026-11-18' });
    assert.deepEqual(classifyFile('941278-Merchant_Payout_Report_DPL922_STID_56158235_18-Nov-2026_06.53.xlsx'), { bank: 'hdfc_upi', terminal: 'DPL922', date: '2026-11-18' });
    assert.deepEqual(classifyFile('Export_Report11182026_200625.xls'), { bank: 'amex', terminal: '', date: '2026-11-18' });
    assert.deepEqual(classifyFile('261115_0530_Ph4food&beveragesprivatelimited_POS_AuthMerchantMpr.xlsx'), { bank: 'pinelabs', terminal: '', date: '2026-11-15' });
    assert.deepEqual(classifyFile('FTD_161126_Ph4food&beveragesprivatelimited_POS_ConsolidatedMerchantMpr.xlsx'), { bank: 'pinelabs', terminal: '', date: '2026-11-16' });
  });

  it('ignores a name it does not know', () => {
    assert.equal(classifyFile('image.png'), null);
    assert.equal(recordFile({}, 'image.png', 'x'), false);
  });
});

describe('missingDaily()', () => {
  it('lists every daily terminal for every window day when nothing is fetched', () => {
    const dailyTerminals = MAIL_SOURCES.reduce((n, s) => n + s.daily.length, 0);
    assert.equal(missingDaily({}, TODAY).length, dailyTerminals * 7);
  });

  it('lists nothing once the whole window is in', () => {
    assert.deepEqual(missingDaily(fullLedger(), TODAY), []);
  });

  it('names the one terminal-day that is absent', () => {
    const ledger = fullLedger((bank, terminal, date) => bank === 'kotak' && terminal === '0215585' && date === '2026-11-14');
    assert.deepEqual(missingDaily(ledger, TODAY), [{ bank: 'kotak', terminal: '0215585', date: '2026-11-14' }]);
  });

  it('does not look past the window', () => {
    assert.equal(windowStart(TODAY), '2026-11-12');
    assert.ok(missingDaily({}, TODAY).every((m) => m.date >= '2026-11-12'));
  });
});

describe('sendersToSearch()', () => {
  it('searches every sender while anything is missing', () => {
    assert.deepEqual(sendersToSearch(missingDaily({}, TODAY), allowlist), allowlist);
  });

  it('skips a daily bank whose window is complete, and keeps every other sender', () => {
    const ledger = fullLedger((bank) => bank === 'hdfc_upi');
    const searched = sendersToSearch(missingDaily(ledger, TODAY), [...allowlist, 'someone@else.com']);
    assert.ok(!searched.includes('kotakmerchants@edcstatements.com'));
    assert.ok(searched.includes('upi@hdfcbank.bank.in'));
    assert.ok(searched.includes('no-reply-billing@pinelabs.com'), 'a bank with no daily file is always searched');
    assert.ok(searched.includes('someone@else.com'), 'a sender outside the table is always searched');
  });
});

describe('ledgerReport()', () => {
  it('reports the newest file date per bank and only the missing days that have ended', () => {
    const ledger = fullLedger((bank, terminal, date) => (bank === 'kotak' && terminal === '0172757' && date === '2026-11-15') || (bank === 'hdfc_upi' && date === TODAY));
    recordFile(ledger, 'Export_Report11132026_1.xls', 'x');
    const r = ledgerReport(ledger, TODAY);
    assert.deepEqual(r.missing, ['kotak 0172757 2026-11-15']); // today's HDFC files may just not have arrived
    assert.equal(r.lastFetched.kotak, TODAY);
    assert.equal(r.lastFetched.hdfc_upi, '2026-11-17');
    assert.equal(r.lastFetched.amex, '2026-11-13');
  });
});

describe('ledger housekeeping', () => {
  it('prunes entries older than a month', () => {
    const ledger: Ledger = { 'kotak|1|2026-10-01': 'x', 'kotak|1|2026-11-10': 'x' };
    pruneLedger(ledger, TODAY);
    assert.deepEqual(Object.keys(ledger), ['kotak|1|2026-11-10']);
  });

  it("dates today in Indian time", () => {
    assert.equal(istToday(Date.parse('2026-11-17T20:00:00Z')), '2026-11-18'); // 01:30 IST
  });
});
