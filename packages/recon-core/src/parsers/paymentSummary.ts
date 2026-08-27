/**
 * Payment Summary ("drawer") CSV reader.
 * Ported from `reconciliation (68).html` lines 961–969 (`readSummary`).
 */

import type { SummaryData } from '../types.js';
import { parseCSV } from '../util/csv.js';

/**
 * Reads the drawer summary — a single header row followed by a single row of
 * per-payment-method totals.
 *
 * The header is located by scanning for a row mentioning "business date".
 * Returns `null` when that row is absent or has no data row after it; this
 * file is optional, and the whole FRS falls back to transaction-level sources
 * when it is missing.
 */
export function parsePaymentSummary(text: string): SummaryData | null {
  const rows = parseCSV(text);

  let hi = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.some((c) => /business date/i.test(c))) {
      hi = i;
      break;
    }
  }
  if (hi === -1 || hi + 1 >= rows.length) return null;

  const hdrs = rows[hi]!.map((h) => (h || '').trim());
  const vals = rows[hi + 1]!;

  const obj: SummaryData = {};
  hdrs.forEach((h, i) => {
    if (h) obj[h] = (vals[i] ?? '').trim();
  });
  return obj;
}
