/**
 * Pinelabs terminal breakdown by acquirer.
 * Ported from `reconciliation (68).html` lines 3496–3557 (`renderFRS`'s
 * "Pinelabs terminal breakdown" table).
 *
 * A second view onto the same Pinelabs numbers as `pinelabsTerminalPR`
 * (`frs.ts`), split by acquirer (HDFC / Kotak-RBL / AMEX / everything else)
 * so a GM can see which acquirer is driving a Pinelabs-wide diff.
 */

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
  // amount), never through `reconRows`.
  const prForGroup = (grp: 'HDFC' | 'Kotak'): number =>
    pinelabs.reconRows
      .filter((x) => {
        const a = ((x.zip as ZipRow)?.acquirer || '').toUpperCase();
        return grp === 'HDFC' ? a.includes('HDFC') : a.includes('KOTAK') || a.includes('RBL');
      })
      .reduce((s, x) => s + x.prAmt, 0);

  const hdfcPR = prForGroup('HDFC');
  const kotakPR = prForGroup('Kotak');
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
    rows.push({ acquirer: 'Other', count: counts.Other, pinelabsTotal: amounts.Other, prTotal: null, diff: null });
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
