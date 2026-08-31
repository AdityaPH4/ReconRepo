/**
 * AMEX's multi-table CSV/exported-XLS format.
 * Ported from `mpr-recon (10).html` lines 651–705 (`parseAmexCSV`).
 *
 * A genuinely bespoke state machine: scans for a `Submissions` section
 * marker, then within it a header row identified by `first === 'Settlement
 * date'` *and* the presence of a `Submitting Merchant ID` column — that
 * combination distinguishes the per-submission detail header from a
 * differently-shaped "settlement summary" header that also happens to start
 * with "Settlement date". Ends the section on `Summary totals` or a blank
 * line. Rows are not grouped by MID/date here — each raw submission row is
 * matched independently against a Layer-1 group later (`engine/match.ts`).
 */

import { parseCSV } from '@toit/recon-core';
import type { AmexMprRow } from '../types.js';
import { normDate } from '../util/normalize.js';

/** Handles Indian comma-grouped amounts, e.g. `"1,32,042.00"`. */
function cleanAmt(s: unknown): number {
  return parseFloat(String(s ?? '').replace(/,/g, '').replace(/"/g, '') || '0') || 0;
}

export function parseAmexCSV(text: string): AmexMprRow[] {
  const lines = text.split(/\r?\n/);
  const submissionRows: Record<string, string>[] = [];
  let inSubmissions = false;
  let subHeaders: string[] | null = null;

  for (const line of lines) {
    const cols = parseCSV(line)[0] ?? [''];
    const trimmed = cols.map((c) => c.trim());

    const first = trimmed[0]?.replace(/﻿/g, '').trim() ?? '';
    if (!first && !trimmed.slice(1).some((c) => c)) {
      inSubmissions = false;
      subHeaders = null;
      continue;
    }
    if (first === 'Submissions') {
      inSubmissions = true;
      subHeaders = null;
      continue;
    }
    if (first === 'Summary totals') {
      inSubmissions = false;
      subHeaders = null;
      continue;
    }
    if (inSubmissions && !subHeaders && first === 'Settlement date') {
      const hasMID = trimmed.some((c) => c === 'Submitting Merchant ID');
      if (hasMID) subHeaders = trimmed;
      continue;
    }
    if (inSubmissions && subHeaders && first && first !== 'Settlement date') {
      const row: Record<string, string> = {};
      subHeaders.forEach((h, i) => {
        if (h) row[h] = (trimmed[i] || '').trim();
      });
      if (row['Settlement date']) submissionRows.push(row);
    }
  }

  return submissionRows
    .map((r) => ({
      mid: r['Submitting Merchant ID'] || '',
      submissionDate: normDate(r['Submission date']) || r['Submission date'] || '',
      settlementDate: normDate(r['Settlement date']) || r['Settlement date'] || '',
      submissionAmount: cleanAmt(r['Submission amount']),
      transactionCount: parseInt(r['Transaction count'] || '0', 10) || 0,
      socNumber: r['SOC invoice number'] || '',
      dbaName: r['Submitting Business Name'] || r['Submitting Nickname'] || '',
      _file: '',
    }))
    .filter((r) => r.submissionAmount > 0);
}
