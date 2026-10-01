/**
 * Filename-based upload role detection.
 * Ported from `reconciliation (68).html` lines 575–585 (`detectRole`).
 *
 * Stays client-side deliberately: it decides which slot a dropped file lands
 * in, which is a UI concern. The server re-checks that the required roles are
 * present and does not trust these names.
 */

import type { UploadRole } from '@toit/contracts';

export function detectRole(name: string): UploadRole | null {
  const l = name.toLowerCase();

  if (l.endsWith('.zip')) return 'zip';

  // Checked before the blanket ".xlsx -> hdfc" rule below, since a Payment
  // Link statement could plausibly also export as .xlsx — "link" in the
  // name is the more specific match, same reasoning as summary-before-PR
  // just below. `reconciliation_report_<start>_to_<end>` is the real
  // export's actual filename, confirmed against a genuine sample — it
  // carries no "hdfc"/"link" substring at all, so without this the file
  // fell through every rule and was silently rejected as unrecognised,
  // never even reaching the upload.
  if (l.includes('link') || l.includes('reconciliation_report') || l.includes('reconciliation report')) {
    return 'hdfc_link';
  }

  // The optional HDFC (Static UPI) statement is otherwise the only .xlsx the flow accepts.
  if (l.endsWith('.xlsx')) return 'hdfc';

  // Sales Summary (or a native Drawer Summary Report) first — it is the more specific match.
  if (l.includes('summary') || l.includes('drawer') || l.includes('payment_summary')) {
    return 'sum';
  }

  if (
    l.includes('paymentreport') ||
    l.includes('payment_report') ||
    (l.includes('payment') && l.includes('report') && l.endsWith('.csv'))
  ) {
    return 'pr';
  }

  // Anything else is reported back to the operator rather than guessed at.
  return null;
}

export const ROLE_LABELS: Record<UploadRole, string> = {
  pr: 'Payment Report',
  zip: 'All Transactions',
  sum: 'Sales Summary',
  hdfc: 'HDFC UPI Statement',
  hdfc_link: 'HDFC Payment Link Statement',
};

export const ROLE_ICONS: Record<UploadRole, string> = {
  pr: '📄',
  zip: '🗜',
  sum: '📊',
  hdfc: '📶',
  hdfc_link: '🔗',
};
