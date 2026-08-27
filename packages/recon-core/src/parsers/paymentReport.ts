/**
 * Payment Report (POS) CSV reader.
 * Ported from `reconciliation (68).html` lines 875–906 (`readPR`).
 */

import { routePayName } from '../constants.js';
import type { CivilDate, PRParse, PRRow } from '../types.js';
import { cell, headerIndex, parseCSV } from '../util/csv.js';
import { parsePRDate } from '../util/dates.js';
import { cleanCode, cleanRRN, isAmexBank, money } from '../util/money.js';

/**
 * Reads the POS Payment Report.
 *
 * The header row is located by content rather than position — the export
 * carries a variable number of preamble lines, so the reader scans for the
 * first row mentioning an order number or a retrieval reference. Returns no
 * rows (rather than throwing) when no such row exists, matching the legacy
 * behaviour of rendering an empty result.
 *
 * `bizDate` is the first parseable date in the file and drives the whole
 * session's business window.
 */
export function parsePaymentReport(text: string): PRParse {
  const rows = parseCSV(text);

  let hi = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.some((c) => /order\s*no/i.test(c) || /retrieval/i.test(c))) {
      hi = i;
      break;
    }
  }
  if (hi === -1) return { rows: [], bizDate: null };

  const H = headerIndex(rows[hi]!);
  const C = {
    orderNo: H.loose('order'),
    date: H.loose('date'),
    customer: H.loose('customer'),
    employee: H.loose('employee'),
    paymentType: H.loose('payment type'),
    paymentName: H.loose('payment name'),
    cardNo: H.loose('card number'),
    authCode: H.loose('auth'),
    amount: H.loose('amount'),
    tips: H.loose('tip'),
    bank: H.loose('bank'),
    // Either spelling of the reference column; -1 when neither is present.
    rrn: Math.max(H.loose('retrieval'), H.loose('rrn')),
  };

  const data: PRRow[] = [];
  let bizDate: CivilDate | null = null;

  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i]!;
    // Trailing blanks and total lines are shorter than a real record.
    if (r.length < 5 || !r[0]?.trim()) continue;

    const rawDate = cell(r, C.date);
    if (!bizDate) {
      const pd = parsePRDate(rawDate);
      if (pd) bizDate = pd;
    }

    const bank = cell(r, C.bank);
    const pn = cell(r, C.paymentName);

    data.push({
      orderNo: cell(r, C.orderNo),
      date: rawDate,
      customer: cell(r, C.customer),
      employee: cell(r, C.employee),
      paymentType: cell(r, C.paymentType),
      paymentName: pn,
      cardNo: cell(r, C.cardNo),
      authCode: cleanCode(cell(r, C.authCode)),
      amount: money(cell(r, C.amount)),
      tips: money(cell(r, C.tips) || '0'),
      bank,
      rrn: cleanRRN(cell(r, C.rrn)),
      isAmex: isAmexBank(bank),
      tab: routePayName(pn),
      _src: 'PR',
    });
  }

  return { rows: data, bizDate };
}
