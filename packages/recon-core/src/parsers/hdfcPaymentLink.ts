/**
 * HDFC Payment Link reconciliation report reader (.csv).
 *
 * This is the fifth, optional upload. When present, HDFC Link is reconciled
 * transaction-by-transaction against the Payment Report, matched by ARN
 * (Acquirer Reference Number, column "ARN" in the real export) — the same
 * bank-assigned reference the Payment Report's own "Retrieval Ref No"
 * column already carries for a Payment Link transaction, exactly the same
 * shape as HDFC Static UPI's own RRN match. Merchant Order ID is kept only
 * as a display field (`merchantOrderId`) — it was the original join key
 * before a real sample showed the file also carries a genuine bank
 * reference; when no statement is uploaded, HDFC Link falls back to the
 * aggregate drawer comparison, same as before this reader existed.
 *
 * Confirmed against two real exports (`reconciliation_report_<start>_to_
 * <end> (n).csv` — the date range in the filename is the *settlement* date
 * range, not the transaction date range, so a row's own `Txn Date` can fall
 * a day or more before the file's nominal range; always filter by the row's
 * own date, never by the filename). Both samples are `Txn Type = SALE`; no
 * refund sample has been seen yet, so non-SALE rows are dropped (counted,
 * not matched) rather than guessing their sign/semantics.
 */

import { cell, headerIndex, parseCSV } from '../util/csv.js';
import { parsePaymentLinkDT, inWin } from '../util/dates.js';
import { cleanRRN, money } from '../util/money.js';
import type { BusinessWindow, PaymentLinkRow, PaymentLinkStatementParse } from '../types.js';

/**
 * Thrown when the uploaded CSV is missing required columns.
 *
 * Surfaced as a warning rather than a fatal error at the call site, same
 * tolerance `HdfcStatementFormatError` gets — a bad optional file never
 * blocks a session.
 */
export class PaymentLinkStatementFormatError extends Error {
  constructor(public readonly missing: string[]) {
    super('HDFC Payment Link report missing columns: ' + missing.join(', '));
    this.name = 'PaymentLinkStatementFormatError';
  }
}

export function parsePaymentLinkStatement(text: string, win: BusinessWindow | null): PaymentLinkStatementParse {
  const rows = parseCSV(text);
  if (rows.length < 2) return { rows: [], skippedNonSale: 0 };

  const H = headerIndex(rows[0]!);
  const cOrderId = H.loose('merchant order id');
  // Exact, not loose — a short 3-letter key like "arn" risks a false
  // substring match against some other column (e.g. a hypothetical
  // "Warning" column) that a longer, more specific key wouldn't.
  const cArn = H.exact('arn');
  const cTxnDate = H.loose('txn date');
  const cAmount = H.loose('txn amount');
  const cNetAmount = H.loose('net amount');
  const cFee = H.loose('txn fee');
  const cPaymentMode = H.loose('payment mode');
  const cTxnType = H.loose('txn type');

  const missing: string[] = [];
  if (cOrderId === -1) missing.push('Merchant Order ID');
  if (cArn === -1) missing.push('ARN');
  if (cTxnDate === -1) missing.push('Txn Date');
  if (cAmount === -1) missing.push('Txn Amount');
  if (missing.length) throw new PaymentLinkStatementFormatError(missing);

  const out: PaymentLinkRow[] = [];
  let skippedNonSale = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    // ARN is the real join key now — a row with no ARN at all can never be
    // matched, so it's dropped the same way a row with no RRN is dropped
    // elsewhere (HDFC Static UPI, Pinelabs).
    if (!r.length || !cell(r, cArn)) continue;

    // `Txn Type` is only skipped on when the column actually exists — an
    // absent column means the report format doesn't distinguish sale from
    // refund at all, so nothing to filter on.
    if (cTxnType !== -1) {
      const txnType = cell(r, cTxnType).toUpperCase();
      if (txnType && txnType !== 'SALE') {
        skippedNonSale++;
        continue;
      }
    }

    const dateRaw = cell(r, cTxnDate);
    const dt = parsePaymentLinkDT(dateRaw);
    if (!dt) continue;
    if (win && !inWin(dt, win)) continue;

    out.push({
      rrn: cleanRRN(cell(r, cArn)),
      merchantOrderId: cell(r, cOrderId),
      amount: money(cell(r, cAmount)),
      netAmount: cNetAmount !== -1 ? money(cell(r, cNetAmount)) : 0,
      fee: cFee !== -1 ? money(cell(r, cFee)) : 0,
      date: dt,
      dateRaw,
      paymentMode: cPaymentMode !== -1 ? cell(r, cPaymentMode) : '',
    });
  }

  return { rows: out, skippedNonSale };
}
