/**
 * What `mpr-mail-fetch` expects to receive, from whom, and what it has already
 * fetched. `MAIL_SOURCES` is the table of bank -> sender emails; the ledger
 * is one S3 JSON object (this Lambda has no database access) holding the
 * time each (bank, terminal, file date) was fetched. Together they tell a run
 * which days of the last `MAX_CATCH_UP_DAYS` are still missing, so it only
 * searches the senders that can fill them.
 */

export interface MailSource {
  bank: 'kotak' | 'hdfc_upi' | 'pinelabs' | 'amex';
  /** Lowercase addresses, same form as `MPR_SENDER_ALLOWLIST` (which still gates what is read). */
  senders: string[];
  /** Terminals that send a file every day. Empty: this bank doesn't send daily, so a quiet day is not a gap. */
  daily: string[];
}

export const MAIL_SOURCES: MailSource[] = [
  { bank: 'kotak', senders: ['kotakmerchants@edcstatements.com'], daily: ['0172757', '0176988', '0064746', '0215583', '0215585'] },
  { bank: 'hdfc_upi', senders: ['upi@hdfcbank.bank.in'], daily: ['JLM595', 'P15309', 'DPL922'] },
  { bank: 'pinelabs', senders: ['no-reply-billing@pinelabs.com'], daily: [] },
  { bank: 'amex', senders: ['reddybabu.bgk@ph4.in', 'aditya@ph4.in'], daily: [] },
];

/** Furthest back a normal run reaches: covers a late or skipped day; anything older is a manual backfill. */
export const MAX_CATCH_UP_DAYS = 7;

/** `${bank}|${terminal}|${yyyy-mm-dd}` -> ISO time fetched (`seeded` when read off the processed folder). */
export type Ledger = Record<string, string>;

export interface FileClass {
  bank: MailSource['bank'];
  terminal: string;
  /** `yyyy-mm-dd`: the day the file is for (Kotak/HDFC: also the day it is mailed). */
  date: string;
}

export interface MissingFile {
  bank: MailSource['bank'];
  terminal: string;
  date: string;
}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

export function classifyFile(name: string): FileClass | null {
  let m = /0790431A(\d+)_(\d{4})_(\d\d)_(\d\d)/.exec(name);
  if (m) return { bank: 'kotak', terminal: m[1]!, date: `${m[2]}-${m[3]}-${m[4]}` };
  m = /Merchant_Payout_Report_([A-Z0-9]+)_STID_\d+_(\d\d)-([A-Za-z]{3})-(\d{4})/.exec(name);
  const month = MONTHS[m?.[3]?.toLowerCase() ?? ''];
  if (m && month) return { bank: 'hdfc_upi', terminal: m[1]!, date: `${m[4]}-${month}-${m[2]}` };
  m = /Export_Report(\d\d)(\d\d)(\d{4})/.exec(name); // mmddyyyy
  if (m) return { bank: 'amex', terminal: '', date: `${m[3]}-${m[1]}-${m[2]}` };
  m = /^(?:x_)?(\d\d)(\d\d)(\d\d)_\d{4}_.*MerchantMpr/.exec(name); // batch report, yymmdd
  if (m) return { bank: 'pinelabs', terminal: '', date: `20${m[1]}-${m[2]}-${m[3]}` };
  m = /^FTD_(\d\d)(\d\d)(\d\d)_.*MerchantMpr/.exec(name); // consolidated report, ddmmyy
  if (m) return { bank: 'pinelabs', terminal: '', date: `20${m[3]}-${m[2]}-${m[1]}` };
  return null;
}

export function recordFile(ledger: Ledger, name: string, at: string): boolean {
  const c = classifyFile(name);
  if (c) ledger[`${c.bank}|${c.terminal}|${c.date}`] = at;
  return c != null;
}

export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Today as an IST `yyyy-mm-dd`: the banks' files are dated in Indian time. */
export const istToday = (now = Date.now()): string => new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 10);

/** First day a run searches: `MAX_CATCH_UP_DAYS` days ending today. */
export const windowStart = (today: string): string => addDays(today, -(MAX_CATCH_UP_DAYS - 1));

/** Daily files not yet fetched across the window, today included (today's may simply not have arrived yet). */
export function missingDaily(ledger: Ledger, today: string): MissingFile[] {
  const out: MissingFile[] = [];
  for (let i = MAX_CATCH_UP_DAYS - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    for (const src of MAIL_SOURCES) for (const terminal of src.daily) if (!ledger[`${src.bank}|${terminal}|${date}`]) out.push({ bank: src.bank, terminal, date });
  }
  return out;
}

/** Allowlisted senders worth searching. A daily bank's sender is skipped once its whole window is in; every other sender (non-daily, or not in the table) is always searched. */
export function sendersToSearch(missing: MissingFile[], allowlist: string[]): string[] {
  const complete = new Set(MAIL_SOURCES.filter((s) => s.daily.length && !missing.some((m) => m.bank === s.bank)).flatMap((s) => s.senders));
  return allowlist.filter((s) => !complete.has(s));
}

/** What a run reports: newest file date per bank, and daily files still absent for days that have already ended. */
export function ledgerReport(ledger: Ledger, today: string): { lastFetched: Record<string, string>; missing: string[] } {
  const lastFetched: Record<string, string> = {};
  for (const key of Object.keys(ledger)) {
    const [bank, , date] = key.split('|') as [string, string, string];
    if (date > (lastFetched[bank] ?? '')) lastFetched[bank] = date;
  }
  return { lastFetched, missing: missingDaily(ledger, today).filter((m) => m.date < today).map((m) => `${m.bank} ${m.terminal} ${m.date}`) };
}

/** Drops entries older than a month so the object stays small. */
export function pruneLedger(ledger: Ledger, today: string): void {
  const oldest = addDays(today, -30);
  for (const key of Object.keys(ledger)) if (key.split('|')[2]! < oldest) delete ledger[key];
}
