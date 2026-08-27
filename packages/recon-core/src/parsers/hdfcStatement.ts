/**
 * HDFC / Mintoak Static UPI statement reader (.xlsx).
 * Ported from `reconciliation (68).html` lines 810–861 (`parseHDFCStatement`).
 *
 * This is the optional fourth upload. When present, Static UPI is reconciled
 * transaction-by-transaction through the same matcher as Pinelabs; when
 * absent, Static UPI falls back to the aggregate drawer comparison.
 */

import * as XLSX from 'xlsx';
import { HDFC_STATEMENT_CITY_TO_OUTLET } from '../constants.js';
import type { BusinessWindow, HdfcStatementParse, HdfcStatementRow } from '../types.js';
import { inWin, parseHDFCTime12h } from '../util/dates.js';

/** Columns the statement must contain; a missing one is a hard error. */
const REQUIRED_COLUMNS = [
  'Transaction Date',
  'Transaction Time',
  'City',
  'Transaction State',
  'Amount(Rs.)',
  'RRN No',
] as const;

/**
 * Thrown when the uploaded workbook is missing required columns.
 *
 * Surfaced as a warning rather than a fatal error at the call site: the legacy
 * flow tells the operator the statement could not be read and continues with
 * the aggregate UPI flow, so a bad optional file never blocks a session.
 */
export class HdfcStatementFormatError extends Error {
  constructor(public readonly missing: string[]) {
    super('HDFC statement missing columns: ' + missing.join(', '));
    this.name = 'HdfcStatementFormatError';
  }
}

/**
 * Parses the statement into `{rrn, amount, date, outlet}` rows — structurally
 * the same shape the Pinelabs ZIP produces, which is what lets both feed the
 * shared matcher.
 *
 * Rows are dropped, with counts returned, when they are not `SaleSuccess`
 * (`skippedFailed`) or their `City` maps to no known outlet (`unknownCity`).
 * Rows outside the business window, with no RRN, with an unparseable
 * timestamp, or with an RRN that is not exactly 12 digits are dropped silently
 * — as in the legacy reader.
 */
export function parseHdfcStatement(
  data: Buffer | ArrayBuffer | Uint8Array,
  win: BusinessWindow | null,
): HdfcStatementParse {
  const wb = XLSX.read(data, { type: 'buffer', cellDates: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { rows: [], skippedFailed: 0, unknownCity: 0 };

  const ws = wb.Sheets[sheetName]!;
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    defval: null,
  });
  if (!rows.length) return { rows: [], skippedFailed: 0, unknownCity: 0 };

  const headers = (rows[0] as unknown[]).map((h) => String(h ?? '').trim());
  const col = (name: string) => headers.indexOf(name);

  const cDate = col('Transaction Date');
  const cTime = col('Transaction Time');
  const cCity = col('City');
  const cState = col('Transaction State');
  const cAmt = col('Amount(Rs.)');
  const cRRN = col('RRN No');
  const cPayer = col("Payer's name");

  const missing = REQUIRED_COLUMNS.filter((name) => col(name) === -1);
  if (missing.length) throw new HdfcStatementFormatError([...missing]);

  const out: HdfcStatementRow[] = [];
  let skippedFailed = 0;
  let unknownCity = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] as unknown[] | undefined;
    if (!r || !r[cRRN]) continue;

    if (String(r[cState] ?? '').trim() !== 'SaleSuccess') {
      skippedFailed++;
      continue;
    }

    const city = String(r[cCity] ?? '').trim().toUpperCase();
    const outlet = HDFC_STATEMENT_CITY_TO_OUTLET[city];
    if (!outlet) {
      unknownCity++;
      continue;
    }

    const dt = parseHDFCTime12h(String(r[cDate] ?? ''), String(r[cTime] ?? ''));
    if (!dt) continue;
    if (win && !inWin(dt, win)) continue;

    const rrn = String(r[cRRN]).replace(/\D/g, '');
    if (rrn.length !== 12) continue;

    out.push({
      rrn,
      amount: parseFloat(String(r[cAmt])) || 0,
      date: dt,
      dateRaw: `${r[cDate]} ${r[cTime]}`,
      outlet,
      payer: cPayer !== -1 ? String(r[cPayer] ?? '').trim() : '',
    });
  }

  return { rows: out, skippedFailed, unknownCity };
}
