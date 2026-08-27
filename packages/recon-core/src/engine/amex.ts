/**
 * AMEX matching — auth code first, amount as fallback.
 * Ported from `reconciliation (68).html` lines 1157–1212.
 *
 * AMEX terminal rows do not carry a usable RRN, so the RRN-group matcher
 * cannot see them. Instead the PR `Auth Code` is matched against the terminal
 * `Approval Code`, with an amount-based fallback for rows where either code is
 * blank or found no counterpart.
 */

import { AMOUNT_EPSILON } from '../constants.js';
import type { AmexDup, AmexMatch, AmexPR, PRGroup, PRRow, ZipRow } from '../types.js';
import { fmt } from '../util/money.js';

export interface AmexResult {
  amexOk: AmexMatch[];
  amexDup: AmexDup[];
  amexOnlyPOS: AmexPR[];
  amexOnlyTerm: ZipRow[];
  amexDupTerm: ZipRow[];
}

/** Groups AMEX PR rows by RRN so split bills total correctly, as elsewhere. */
export function groupAmexPR(plAmexRows: readonly PRRow[]): PRGroup[] {
  const m: Record<string, PRGroup> = {};
  for (const r of plAmexRows) {
    if (!r.rrn) continue;
    let g = m[r.rrn];
    if (!g) {
      g = m[r.rrn] = {
        rrn: r.rrn,
        total: 0,
        orders: [],
        rows: [],
        paymentName: r.paymentName,
        bank: r.bank,
        date: r.date,
        employee: r.employee,
        paymentType: r.paymentType,
      };
    }
    g.total += r.amount;
    g.orders.push(r.orderNo);
    g.rows.push(r);
  }
  return Object.values(m);
}

/**
 * Matches AMEX PR groups to AMEX terminal rows.
 *
 * Ambiguity is never guessed at. A code (or, in the fallback, an amount) that
 * occurs more than once on either side cannot be attributed to a specific
 * transaction, so those rows go to `amexDup` for a human to resolve rather
 * than being matched arbitrarily.
 *
 * Pass 1 — unique, non-blank auth code ↔ approval code.
 * Pass 2 — for whatever pass 1 left over (blank code, or a code with no
 *          counterpart), match on unique amount within ±0.50.
 */
export function matchAmex(
  plAmexGroups: readonly PRGroup[],
  zipAmex: readonly ZipRow[],
): AmexResult {
  const prAmexList: AmexPR[] = plAmexGroups.map((g) => ({
    ...g.rows[0]!,
    amount: g.total,
    orders: g.orders,
    authCode: g.rows[0]!.authCode || '',
  }));

  // Occurrence counts drive the ambiguity check on both sides.
  const prCodeCnt: Record<string, number> = {};
  const zipCodeCnt: Record<string, number> = {};
  for (const r of prAmexList) {
    if (r.authCode) prCodeCnt[r.authCode] = (prCodeCnt[r.authCode] || 0) + 1;
  }
  for (const r of zipAmex) {
    if (r.approvalCode) zipCodeCnt[r.approvalCode] = (zipCodeCnt[r.approvalCode] || 0) + 1;
  }

  const amexOk: AmexMatch[] = [];
  const amexDup: AmexDup[] = [];
  const amexOnlyPOS: AmexPR[] = [];
  const amexOnlyTerm: ZipRow[] = [];
  const usedZA = new Set<number>();

  // ── Pass 1: match by code ───────────────────────────────────────────────
  const prNeedingAmountMatch: AmexPR[] = [];
  for (const pr of prAmexList) {
    const code = pr.authCode;
    if (!code) {
      prNeedingAmountMatch.push(pr);
      continue;
    }
    if ((prCodeCnt[code] ?? 0) > 1 || (zipCodeCnt[code] ?? 0) > 1) {
      const inPOS = (prCodeCnt[code] ?? 0) > 1;
      amexDup.push({
        pr,
        _note:
          (inPOS ? 'Duplicate auth code in POS' : 'Duplicate approval code in terminal') +
          ` (${code})`,
        _dupIn: inPOS ? 'POS' : 'Terminal',
      });
      continue;
    }
    const zi = zipAmex.findIndex((z, i) => !usedZA.has(i) && z.approvalCode === code);
    if (zi >= 0) {
      usedZA.add(zi);
      amexOk.push({ pr, zip: zipAmex[zi]!, _matchBy: 'code' });
    } else {
      // Code was present but unmatched — fall through to the amount fallback.
      prNeedingAmountMatch.push(pr);
    }
  }

  // ── Pass 2: amount fallback ─────────────────────────────────────────────
  // Counts are taken over what pass 1 actually left unconsumed.
  const remainingZip = zipAmex.filter((_z, i) => !usedZA.has(i));
  const fallbackAmtCnt: Record<number, number> = {};
  for (const r of prNeedingAmountMatch) {
    fallbackAmtCnt[r.amount] = (fallbackAmtCnt[r.amount] || 0) + 1;
  }
  const zipFallbackAmtCnt: Record<number, number> = {};
  for (const r of remainingZip) {
    zipFallbackAmtCnt[r.amount] = (zipFallbackAmtCnt[r.amount] || 0) + 1;
  }

  for (const pr of prNeedingAmountMatch) {
    const a = pr.amount;
    if ((fallbackAmtCnt[a] ?? 0) > 1 || (zipFallbackAmtCnt[a] ?? 0) > 1) {
      const inPOS = (fallbackAmtCnt[a] ?? 0) > 1;
      amexDup.push({
        pr,
        _note:
          (inPOS ? 'Duplicate amount in POS' : 'Duplicate amount in terminal') +
          ` (${fmt(a)}, no matching code)`,
        _dupIn: inPOS ? 'POS' : 'Terminal',
      });
      continue;
    }
    const zi = zipAmex.findIndex(
      (z, i) => !usedZA.has(i) && Math.abs(z.amount - a) < AMOUNT_EPSILON,
    );
    if (zi >= 0) {
      usedZA.add(zi);
      amexOk.push({ pr, zip: zipAmex[zi]!, _matchBy: 'amount' });
    } else {
      amexOnlyPOS.push(pr);
    }
  }

  // ── Leftover terminal rows ──────────────────────────────────────────────
  // Split by *why* they are unmatched: ambiguous key vs genuinely absent from
  // the Payment Report. Only the latter is a reconciliation exception.
  const amexDupTerm: ZipRow[] = [];
  zipAmex.forEach((z, i) => {
    if (usedZA.has(i)) return;
    const code = z.approvalCode;
    if (code && (zipCodeCnt[code] ?? 0) > 1) amexDupTerm.push(z);
    else if (!code && (zipFallbackAmtCnt[z.amount] ?? 0) > 1) amexDupTerm.push(z);
    else amexOnlyTerm.push(z);
  });

  return { amexOk, amexDup, amexOnlyPOS, amexOnlyTerm, amexDupTerm };
}
