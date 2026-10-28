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

/** Case-insensitive exact-match column lookup — real exports vary casing (e.g. "Card number" vs "Card Number"). */
function indexOfCI(header: readonly string[], name: string): number {
  return header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
}

export function parseAmexCSV(text: string): AmexMprRow[] {
  const lines = parseCSV(text);
  if (lines.length < 2) return [];

  // The header isn't always the file's first line — some real exports lead
  // with a couple of blank rows first. Scan for the row that actually has
  // every column this parser needs, same as other adapters' header scans.
  const headerIdx = lines.findIndex((line) => {
    const header = line.map((h) => h.trim());
    return (
      indexOfCI(header, 'Record Type') >= 0 &&
      indexOfCI(header, 'Transaction Timestamp') >= 0 &&
      indexOfCI(header, 'Card Number') >= 0 &&
      indexOfCI(header, 'Charge Amount') >= 0
    );
  });
  if (headerIdx < 0) return [];

  const header = lines[headerIdx]!.map((h) => h.trim());
  const iRecordType = indexOfCI(header, 'Record Type');
  const iPaymentDate = indexOfCI(header, 'Payment Date');
  const iTxnTimestamp = indexOfCI(header, 'Transaction Timestamp');
  const iCardNumber = indexOfCI(header, 'Card Number');
  const iChargeAmount = indexOfCI(header, 'Charge Amount');

  const rows: AmexMprRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
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
