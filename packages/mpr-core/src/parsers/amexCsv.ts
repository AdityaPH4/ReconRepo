/**
 * AMEX's transaction-level settlement export (SOC/ROC CSV).
 *
 * One flat header row, then one "SOC" row per settlement batch and one
 * "ROC" row per underlying transaction, ending with a "Totals for Payment
 * on ..." footer whose columns don't line up with the header at all (it
 * naturally fails the `Record Type === 'ROC'` filter below, no special
 * casing needed). Only the ROC rows carry what Layer 2 matches on —
 * Transaction Timestamp, Card Number, Charge Amount — so SOC/footer rows
 * are read past but never kept.
 */

import { parseCSV } from '@toit/recon-core';
import type { AmexMprRow } from '../types.js';
import { cardLast4, normDate } from '../util/normalize.js';

/** Handles Indian comma-grouped amounts, e.g. `"1,32,042.00"`. */
function cleanAmt(s: unknown): number {
  return parseFloat(String(s ?? '').replace(/,/g, '').replace(/"/g, '') || '0') || 0;
}

export function parseAmexCSV(text: string): AmexMprRow[] {
  const lines = parseCSV(text);
  if (lines.length < 2) return [];

  const header = lines[0]!.map((h) => h.trim());
  const iRecordType = header.indexOf('Record Type');
  const iPaymentDate = header.indexOf('Payment Date');
  const iTxnTimestamp = header.indexOf('Transaction Timestamp');
  const iCardNumber = header.indexOf('Card Number');
  const iChargeAmount = header.indexOf('Charge Amount');
  if (iRecordType < 0 || iTxnTimestamp < 0 || iCardNumber < 0 || iChargeAmount < 0) return [];

  const rows: AmexMprRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!;
    if ((cols[iRecordType] ?? '').trim() !== 'ROC') continue;

    const amount = cleanAmt(cols[iChargeAmount]);
    const cardLast = cardLast4(cols[iCardNumber]);
    const txnDate = normDate(cols[iTxnTimestamp]);
    if (!cardLast || !txnDate || amount <= 0) continue;

    rows.push({
      txnDate,
      cardLast4: cardLast,
      amount,
      settlementDate: iPaymentDate >= 0 ? normDate(cols[iPaymentDate]) : null,
      _file: '',
    });
  }
  return rows;
}
