/**
 * Pinelabs terminal breakdown by acquirer.
 * Ported from `reconciliation (68).html` lines 3496–3557 (`renderFRS`'s
 * "Pinelabs terminal breakdown" table).
 *
 * A second view onto the same Pinelabs numbers as `pinelabsTerminalPR`
 * (`frs.ts`), split by acquirer (HDFC / Kotak-RBL / AMEX / everything else)
 * so a GM can see which acquirer is driving a Pinelabs-wide diff.
 *
 * Every acquirer row's own Payment Report figure only ever covers
 * *matched* transactions (`pinelabs.reconRows`) — a Payment Report row with
 * no corresponding Pinelabs terminal transaction at all ("Only in POS") has
 * no ZIP-side acquirer to classify it by, so it can't appear in any
 * acquirer's own row. The grand total's own Payment Report figure, though,
 * is every Payment-Report row tagged Pinelabs, matched or not — so without
 * an explicit plug row, the rows would visibly fail to add up to the total
 * by exactly that unmatched amount (reads as "something's wrong" even
 * though nothing is). The `'Only in POS'` row below is exactly that plug —
 * by construction, every row's `diff` always sums to `totalDiff`.
 */

import { AMOUNT_EPSILON } from '../constants.js';
import type { PinelabsResult, PRRow, ZipRow } from '../types.js';

export interface AcquirerGroupRow {
  acquirer: string;
  count: number;
  pinelabsTotal: number;
  /** `null` renders as "—" — no PR-side figure exists for this group (e.g. "Other"). */
  prTotal: number | null;
  diff: number | null;
}

export interface PinelabsAcquirerBreakdown {
  rows: AcquirerGroupRow[];
  totalCount: number;
  totalPinelabs: number;
  totalPR: number;
  totalDiff: number;
  amexDupCount: number;
}

type AcquirerGroup = 'AMEX' | 'HDFC' | 'Kotak' | 'Other';

function classifyAcquirer(acquirer: string | null | undefined): AcquirerGroup {
  const a = (acquirer || '').toUpperCase();
  if (a.includes('AMEX') || a.includes('AMERICAN EXPRESS')) return 'AMEX';
  if (a.includes('HDFC')) return 'HDFC';
  if (a.includes('KOTAK') || a.includes('RBL')) return 'Kotak';
  return 'Other';
}

export function pinelabsAcquirerBreakdown(
  prData: readonly PRRow[],
  zipInside: readonly ZipRow[],
  pinelabs: PinelabsResult,
): PinelabsAcquirerBreakdown {
  const amounts: Record<AcquirerGroup, number> = { AMEX: 0, HDFC: 0, Kotak: 0, Other: 0 };
  const counts: Record<AcquirerGroup, number> = { AMEX: 0, HDFC: 0, Kotak: 0, Other: 0 };

  for (const z of zipInside) {
    const grp = classifyAcquirer(z.acquirer);
    amounts[grp] += z.amount || 0;
    counts[grp] += 1;
  }

  const totalPinelabs = amounts.AMEX + amounts.HDFC + amounts.Kotak + amounts.Other;
  const totalPR = prData
    .filter((r) => r.tab === 'pinelabs')
    .reduce((s, r) => s + (Number.isNaN(r.amount) ? 0 : r.amount), 0);

  // Non-AMEX matched rows only — AMEX is matched separately (auth code /
  // amount), never through `reconRows`. `'Other'` included (unlike before)
  // so a matched row whose acquirer is neither HDFC/Kotak/RBL/AMEX still
  // ends up counted somewhere, rather than silently vanishing from both
  // this group's own total and the unmatched plug row below.
  const prForGroup = (grp: 'HDFC' | 'Kotak' | 'Other'): number =>
    pinelabs.reconRows
      .filter((x) => classifyAcquirer((x.zip as ZipRow)?.acquirer) === grp)
      .reduce((s, x) => s + x.prAmt, 0);

  const hdfcPR = prForGroup('HDFC');
  const kotakPR = prForGroup('Kotak');
  const otherPR = prForGroup('Other');
  const amexPR = prData.filter((r) => r.isAmex).reduce((s, r) => s + (Number.isNaN(r.amount) ? 0 : r.amount), 0);

  const rows: AcquirerGroupRow[] = [
    // `prTotal` displays as "—" when zero (legacy: `prTot?fmt(prTot):'—'`), but
    // `diff` is always the real computed value — legacy never suppresses it
    // just because the PR-side total happens to be zero.
    { acquirer: 'HDFC', count: counts.HDFC, pinelabsTotal: amounts.HDFC, prTotal: hdfcPR || null, diff: amounts.HDFC - hdfcPR },
    {
      acquirer: 'Kotak / RBL',
      count: counts.Kotak,
      pinelabsTotal: amounts.Kotak,
      prTotal: kotakPR || null,
      diff: amounts.Kotak - kotakPR,
    },
    { acquirer: 'AMEX', count: counts.AMEX, pinelabsTotal: amounts.AMEX, prTotal: amexPR, diff: amounts.AMEX - amexPR },
  ];
  if (amounts.Other > 0) {
    rows.push({
      acquirer: 'Other',
      count: counts.Other,
      pinelabsTotal: amounts.Other,
      prTotal: otherPR || null,
      diff: amounts.Other - otherPR,
    });
  }

  // Plug row — see this module's own doc comment. Whatever of `totalPR`
  // isn't already accounted for above has no terminal transaction at all
  // ("Only in POS"); without this row the table's own rows would fail to
  // visibly add up to `totalDiff`, reading as a bug rather than the real,
  // correctly-computed shortfall it is.
  const unmatchedPR = totalPR - (hdfcPR + kotakPR + otherPR + amexPR);
  if (Math.abs(unmatchedPR) > AMOUNT_EPSILON) {
    rows.push({
      acquirer: 'Only in POS (no terminal match)',
      count: pinelabs.onlyPOS.length,
      pinelabsTotal: 0,
      prTotal: unmatchedPR,
      diff: -unmatchedPR,
    });
  }

  return {
    rows,
    totalCount: counts.AMEX + counts.HDFC + counts.Kotak + counts.Other,
    totalPinelabs,
    totalPR,
    totalDiff: totalPinelabs - totalPR,
    amexDupCount: pinelabs.amexDup.length,
  };
}
