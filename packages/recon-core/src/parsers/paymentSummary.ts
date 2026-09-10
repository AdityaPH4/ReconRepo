/**
 * Payment Summary ("drawer") CSV reader.
 * Ported from `reconciliation (68).html` lines 961–969 (`readSummary`).
 */

import type { SummaryData } from '../types.js';
import { parseCSV } from '../util/csv.js';
import { money } from '../util/money.js';

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

/**
 * Reads the "DRAWER SUMMARY" section embedded in a Sale Summary report — a
 * fallback for outlets that can't get the native Drawer Summary Report.
 * That section is a vertical `label,value` list (unlike the native report's
 * single header row + single data row), so this is a deliberately separate
 * reader rather than a branch inside `parsePaymentSummary`.
 *
 * Stops at the first row that no longer looks like `label,value` — either a
 * blank label or a value that doesn't parse as an amount — which in practice
 * is the next section's own header row (e.g. "Department Summary").
 */
export function parseSaleSummaryDrawerSection(text: string): SummaryData | null {
  const rows = parseCSV(text);
  const start = rows.findIndex((r) => (r[0] ?? '').trim().toUpperCase() === 'DRAWER SUMMARY');
  if (start === -1) return null;

  const obj: SummaryData = {};
  for (let i = start + 1; i < rows.length; i++) {
    const [rawLabel, rawValue] = rows[i]!;
    const label = (rawLabel ?? '').trim();
    if (!label || Number.isNaN(money(rawValue))) break;
    obj[label] = (rawValue ?? '').trim();
  }
  return Object.keys(obj).length ? obj : null;
}
