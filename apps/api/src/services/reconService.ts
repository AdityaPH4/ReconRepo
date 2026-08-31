/**
 * Reconciliation orchestration — the server-side equivalent of the legacy
 * `run()` (reconciliation (68).html lines 1230–1285).
 *
 * Sequencing matters and is preserved exactly:
 *   1. Parse the Payment Report to obtain the business date.
 *   2. Build the business window from it.
 *   3. Parse the ZIP *through* that window.
 *   4. Detect the outlet from the ZIP — before reconcile(), because reconcile()
 *      needs it to filter the HDFC statement. The legacy code originally did
 *      this inside renderResults(), i.e. after reconcile(), so reconcile() read
 *      a stale outlet from the previous session; the fix is carried over here.
 *   5. Parse the optional summary and HDFC statement.
 *   6. Reconcile.
 */

import {
  buildPRMap,
  buildSumMap,
  buildWin,
  civilToISO,
  detectOutletFromZip,
  fmtWin,
  FRS_METHODS,
  frsRowAmounts,
  grandTotals,
  HdfcStatementFormatError,
  isMaterial,
  money,
  OUTLET_NAMES,
  parseHdfcStatement,
  parsePaymentReport,
  parsePaymentSummary,
  parseTransactionsZip,
  pinelabsAcquirerBreakdown,
  reconcile,
} from '@toit/recon-core';
import type {
  BusinessWindow,
  HdfcStatementRow,
  OutletCode,
  PRRow,
  ReconResult,
  SummaryData,
  ZipRow,
} from '@toit/recon-core';
import type {
  FrsDTO,
  HdfcStatementMetaDTO,
  PanelSummariesDTO,
  PanelTotalsDTO,
  PinelabsBreakdownDTO,
  ReconCountsDTO,
} from '@toit/contracts';

/** Raw file bytes for one run. `pr` and `zip` are required; the rest optional. */
export interface RunInputFiles {
  pr: { buffer: Buffer; originalName: string };
  zip: { buffer: Buffer; originalName: string };
  sum?: { buffer: Buffer; originalName: string };
  hdfc?: { buffer: Buffer; originalName: string };
}

export interface RunOutcome {
  prData: PRRow[];
  zipInside: ZipRow[];
  zipFiltered: ZipRow[];
  summaryData: SummaryData | null;
  hdfcStmtRows: HdfcStatementRow[] | null;
  hdfcStatementMeta: HdfcStatementMetaDTO | null;
  result: ReconResult;
  outlet: OutletCode;
  win: BusinessWindow | null;
  businessDate: string | null;
  frs: FrsDTO;
  counts: ReconCountsDTO;
  totals: PanelSummariesDTO;
  pinelabsBreakdown: PinelabsBreakdownDTO;
  warnings: string[];
}

/** Default outlet when the ZIP's store name matches nothing known. */
const FALLBACK_OUTLET: OutletCode = 'BLRT';

export async function runReconciliation(files: RunInputFiles): Promise<RunOutcome> {
  const warnings: string[] = [];

  // 1–2. Payment Report drives the business date, and the date drives the window.
  const { rows: prData, bizDate } = parsePaymentReport(files.pr.buffer.toString('utf8'));
  if (!prData.length) {
    throw new BadRequestError(
      'No transaction rows found in the Payment Report. Check the file is the POS Payment Report export.',
    );
  }
  if (!bizDate) {
    warnings.push(
      'No business date could be read from the Payment Report, so no time window was applied — every terminal row was included.',
    );
  }
  const win = bizDate ? buildWin(bizDate) : null;

  // 3. Terminal rows, filtered through the window.
  const { inside, filtered } = await parseTransactionsZip(files.zip.buffer, win);
  if (!inside.length && !filtered.length) {
    throw new BadRequestError(
      'No transaction rows found inside the ZIP. Check it contains the Pinelabs All Transactions CSV.',
    );
  }

  // 4. Outlet, before reconcile() — it filters the HDFC statement by outlet.
  const detectedOutlet = detectOutletFromZip(inside);
  const outlet = detectedOutlet ?? FALLBACK_OUTLET;
  if (!detectedOutlet) {
    const stores = [...new Set(inside.map((r) => r.store).filter(Boolean))];
    warnings.push(
      `Outlet could not be determined from the terminal store name${
        stores.length ? ` (saw: ${stores.join(', ')})` : ''
      } — defaulted to ${outlet}. Verify before submitting.`,
    );
  }

  // 5. Optional inputs.
  const summaryData = files.sum
    ? parsePaymentSummary(files.sum.buffer.toString('utf8'))
    : null;
  if (files.sum && !summaryData) {
    warnings.push(
      'The Payment Summary file could not be read (no "Business Date" header row found) — drawer comparisons are unavailable.',
    );
  }

  let hdfcStmtRows: HdfcStatementRow[] | null = null;
  let hdfcStatementMeta: HdfcStatementMetaDTO | null = null;
  if (files.hdfc) {
    try {
      const parsed = parseHdfcStatement(files.hdfc.buffer, win);
      hdfcStmtRows = parsed.rows;
      hdfcStatementMeta = {
        rows: parsed.rows.length,
        skippedFailed: parsed.skippedFailed,
        unknownCity: parsed.unknownCity,
      };
      if (!parsed.rows.length) {
        warnings.push(
          'The HDFC UPI Statement contained no SaleSuccess rows inside the business window — Static UPI used the aggregate flow.',
        );
      }
    } catch (err) {
      // Matches the legacy behaviour: warn and continue on the aggregate flow.
      // A bad optional file must never block a session.
      const msg =
        err instanceof HdfcStatementFormatError ? err.message : (err as Error).message;
      warnings.push(
        `HDFC UPI Statement could not be read: ${msg}. Continuing without it — Static UPI used the aggregate flow.`,
      );
    }
  }

  // 6. Reconcile.
  const result = reconcile({ prData, zipInside: inside, hdfcStmtRows, outlet });
  result.zipFiltered = filtered;

  // ── Derived figures, computed here so the UI never does reconciliation
  // arithmetic of its own ────────────────────────────────────────────────
  const prMap = buildPRMap(prData);
  const sumMap = buildSumMap(summaryData);
  const ctx = { prData, zipInside: inside, upiHdfc: result.upiHdfc };

  const frsRows = FRS_METHODS.map((m) => {
    const a = frsRowAmounts(m, prMap, sumMap, ctx);
    return {
      label: m.label,
      pr: a.pr,
      drawerAmt: a.drawerAmt,
      sourceAmt: a.sourceAmt,
      diff: a.diff,
      usingSource: a.usingSource,
      basis: (a.usingSource ? 'source_report' : 'drawer_summary') as
        | 'source_report'
        | 'drawer_summary',
      assumedReconciled: Boolean(m.assumedReconciled),
      reconciledNote: m.reconciledNote ?? null,
    };
  });
  const { grandPR, grandSum, grandDiff } = grandTotals(prMap, sumMap, ctx);

  return {
    prData,
    zipInside: inside,
    zipFiltered: filtered,
    summaryData,
    hdfcStmtRows,
    hdfcStatementMeta,
    result,
    outlet,
    win,
    businessDate: bizDate ? civilToISO(bizDate) : null,
    frs: { rows: frsRows, grandPR, grandSum, grandDiff },
    counts: buildCounts(result),
    totals: buildTotals(result, prData, inside, summaryData),
    pinelabsBreakdown: pinelabsAcquirerBreakdown(prData, inside, result.pinelabs),
    warnings,
  };
}

/** Window label for the session header, or null when no date was found. */
export function windowLabel(win: BusinessWindow | null): string | null {
  return win ? fmtWin(win) : null;
}

export function outletName(outlet: OutletCode): string {
  return OUTLET_NAMES[outlet] ?? outlet;
}

// ── Counts ────────────────────────────────────────────────────────────────

function buildCounts(result: ReconResult): ReconCountsDTO {
  const p = result.pinelabs;
  // "Reconciled" mirrors the legacy tile logic (`plRecTotal`): RRN-matched
  // rows within tolerance or an auto-squared-off Manual APOS row, *plus*
  // AMEX matches — legacy's own tile always adds `amexOk.length`. Omitting
  // it here (as this used to) undercounts against both legacy and the
  // Pinelabs panel's own "Reconciled" tab badge, which already includes it.
  const reconciledRows = p.reconRows.filter((x) => !isMaterial(x.diff) || x.squaredOff).length;
  const reconciled = reconciledRows + p.amexOk.length;

  return {
    pinelabs: {
      reconciled,
      unreconciled: p.reconRows.length - reconciledRows,
      onlyPOS: p.onlyPOS.length,
      onlyTerm: p.onlyTerm.length,
      dupRRN: p.dupRRN.length,
      amexOk: p.amexOk.length,
      amexDup: p.amexDup.length,
      amexDupTerm: p.amexDupTerm.length,
    },
    upiHdfc: result.upiHdfc
      ? {
          reconciled: result.upiHdfc.reconRows.filter((x) => !isMaterial(x.diff)).length,
          unreconciled: result.upiHdfc.reconRows.filter((x) => isMaterial(x.diff)).length,
          onlyPOS: result.upiHdfc.onlyPOS.length,
          onlyTerm: result.upiHdfc.onlyTerm.length,
          dupRRN: result.upiHdfc.dupRRN.length,
        }
      : null,
    swiggy: result.swiggy.length,
    cash: result.cash.length,
    upi: result.upi.length,
    bills: result.bills.length,
    bank: result.bank.length,
    other: result.other.length,
    zipFiltered: result.zipFiltered.length,
  };
}

// ── Per-panel totals ─────────────────────────────────────────────────────

function sumAmounts(rows: readonly { amount: number }[]): number {
  // Blank source cells parse to NaN by design; they must not poison a total.
  return rows.reduce((s, x) => s + (Number.isNaN(x.amount) ? 0 : x.amount), 0);
}

function drawerTotals(prTotal: number, drawer: number | null): PanelTotalsDTO {
  return {
    prTotal,
    summaryTotal: drawer,
    diff: drawer === null ? null : drawer - prTotal,
  };
}

function buildTotals(
  result: ReconResult,
  prData: readonly PRRow[],
  zipInside: readonly ZipRow[],
  summaryData: SummaryData | null,
): PanelSummariesDTO {
  const drawer = (key: string): number | null => {
    if (!summaryData) return null;
    const raw = summaryData[key];
    if (raw === undefined) return null;
    const n = money(raw);
    return Number.isNaN(n) ? null : n;
  };

  const hdfcRows = result.upi.filter((x) => /hdfc/i.test(x.paymentName));
  const kotakRows = result.upi.filter((x) => /kotak/i.test(x.paymentName));

  const plPR = prData
    .filter((r) => r.tab === 'pinelabs')
    .reduce((s, r) => s + (Number.isNaN(r.amount) ? 0 : r.amount), 0);
  const plTerm = sumAmounts(zipInside);

  // Swiggy/Zomato: legacy still splits the drawer comparison per brand
  // (`summaryData['Swiggy']` vs `summaryData['ZOMATO']`) even though neither
  // ever blocks submission.
  const swiggyRows = result.swiggy.filter((r) => /swiggy/i.test(r.paymentName));
  const zomatoRows = result.swiggy.filter((r) => /zomato/i.test(r.paymentName));

  return {
    cash: drawerTotals(sumAmounts(result.cash), drawer('Cash')),
    hdfcUpi: drawerTotals(sumAmounts(hdfcRows), drawer('HDFC Static UPI')),
    kotakUpi: drawerTotals(sumAmounts(kotakRows), drawer('Kotak Static UPI')),
    bank: drawerTotals(sumAmounts(result.bank), drawer('Bank transfer')),
    bills: drawerTotals(sumAmounts(result.bills), drawer('Bills on Hold')),
    swiggy: {
      prTotal: sumAmounts(result.swiggy),
      swiggy: drawerTotals(sumAmounts(swiggyRows), drawer('Swiggy')),
      zomato: drawerTotals(sumAmounts(zomatoRows), drawer('ZOMATO')),
    },
    pinelabs: { prTotal: plPR, terminalTotal: plTerm, diff: plTerm - plPR },
  };
}

// ── Errors ────────────────────────────────────────────────────────────────

/** A problem with the uploaded files, not with the server. Surfaces as 400. */
export class BadRequestError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}
