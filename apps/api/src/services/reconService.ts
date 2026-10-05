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
  findUnsettledSuccessRows,
  fmtWin,
  FRS_METHODS,
  frsRowAmounts,
  grandTotals,
  HdfcStatementFormatError,
  isMaterial,
  isoToCivil,
  money,
  OUTLET_NAMES,
  parseHdfcStatement,
  parsePaymentLinkStatement,
  parsePaymentReport,
  parsePaymentSummary,
  parseSaleSummaryDrawerSection,
  parseSaleSummarySalesSection,
  parseSaleSummaryTaxesSection,
  parseTransactionsZip,
  PaymentLinkStatementFormatError,
  pinelabsAcquirerBreakdown,
  reconcile,
} from '@toit/recon-core';
import type {
  BusinessWindow,
  HdfcStatementRow,
  OutletCode,
  PaymentLinkRow,
  PRRow,
  ReconResult,
  SummaryData,
  ZipRow,
} from '@toit/recon-core';
import type {
  FrsDTO,
  HdfcLinkStatementMetaDTO,
  HdfcStatementMetaDTO,
  PanelSummariesDTO,
  PanelTotalsDTO,
  PinelabsBreakdownDTO,
  ReconCountsDTO,
  SessionStatus,
  TaxesSummaryDTO,
} from '@toit/contracts';
import { getSessionStore } from '../storage/index.js';

/** Raw file bytes for one run. `pr` and `zip` are required; the rest optional. */
export interface RunInputFiles {
  pr: { buffer: Buffer; originalName: string };
  zip: { buffer: Buffer; originalName: string };
  sum?: { buffer: Buffer; originalName: string };
  hdfc?: { buffer: Buffer; originalName: string };
  /** HDFC Payment Link reconciliation report — optional; see `parsePaymentLinkStatement()`. */
  hdfcLink?: { buffer: Buffer; originalName: string };
  /** Admin-only manual outlet pick (see `routes/sessions.ts`) — wins over whatever the ZIP's terminal store name would otherwise detect. */
  outletOverride?: OutletCode;
  /**
   * The requesting GM's own assigned outlet (`req.user.outlet`). When set,
   * it wins unconditionally over ZIP-based detection and over
   * `outletOverride` (which a GM's own request never carries anyway, per
   * the route's admin-only gate) — a GM already has exactly one outlet, so
   * there is nothing to detect or override. `undefined` for an admin
   * request, which falls through to the existing detect/override/fallback
   * logic unchanged.
   */
  gmOutlet?: OutletCode;
  /**
   * GM-facing fallback (`yyyy-mm-dd`) for a zero-transaction upload, where
   * the Payment Report has no rows to read a date from. Only takes effect
   * when the file itself yields no date — it never overrides a
   * successfully file-derived one, so an ordinary upload can carry a
   * stale/irrelevant value here with no effect. Unlike `outletOverride`,
   * not admin-only: a closed-outlet day is a GM's own call to make, and the
   * resulting date is still fully subject to `assertNoDateGap` in
   * `routes/sessions.ts`, exactly like a file-derived date.
   */
  businessDateOverride?: string;
}

export interface RunOutcome {
  prData: PRRow[];
  zipInside: ZipRow[];
  zipFiltered: ZipRow[];
  summaryData: SummaryData | null;
  taxes: TaxesSummaryDTO | null;
  hdfcStmtRows: HdfcStatementRow[] | null;
  hdfcStatementMeta: HdfcStatementMetaDTO | null;
  linkStmtRows: PaymentLinkRow[] | null;
  hdfcLinkStatementMeta: HdfcLinkStatementMetaDTO | null;
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
    warnings.push(
      'No transaction rows found in the Payment Report — treating this as a zero-transaction/closed day. ' +
        'If this outlet was not actually closed, check this is the correct POS Payment Report export before submitting.',
    );
  }
  // An unrecognized payment name used to fall silently into `tab: 'other'`,
  // which nothing downstream reads — the money neither reconciled nor was
  // flagged. Reject the whole upload instead, naming the offender, same
  // severity as the "no PR rows" check above. A `tab: 'other'` row isn't
  // automatically unrecognized, though — Gift From Toit/Vouchers have no
  // dedicated `Tab` at all and route here by design; `FRS_METHODS[*].prKeys`
  // is the other, equally-valid way a payment name is recognized (exact,
  // trimmed match — the same lookup `buildPRMap`/`frsMethodTotals` use).
  const knownFrsNames = new Set(FRS_METHODS.flatMap((m) => m.prKeys));
  const unrecognizedNames = [
    ...new Set(
      prData.filter((r) => r.tab === 'other' && !knownFrsNames.has(r.paymentName.trim())).map((r) => r.paymentName),
    ),
  ];
  if (unrecognizedNames.length) {
    throw new BadRequestError(
      `Unrecognized payment method(s) in the Payment Report: ${unrecognizedNames.join(', ')}. Add support for them or check for a typo before re-uploading.`,
    );
  }
  let effectiveBizDate = bizDate;
  if (!bizDate) {
    // Zero PR rows (or, rarer, rows present but every date cell
    // unparseable) both share the same defect: no business date to key
    // the session, the sequence gate, or the snapshot on. A manual
    // override is the only fallback — there is nowhere else in the file
    // to read a date from.
    const override = files.businessDateOverride ? isoToCivil(files.businessDateOverride) : null;
    if (files.businessDateOverride && !override) {
      throw new BadRequestError(`Invalid business date "${files.businessDateOverride}" — expected yyyy-mm-dd.`);
    }
    if (override) {
      effectiveBizDate = override;
      warnings.push(
        `No business date could be read from the Payment Report (0 transaction rows) — using the manually entered business date ${files.businessDateOverride} instead. Verify this is correct before submitting.`,
      );
    } else {
      throw new BusinessDateRequiredError(
        'Could not determine a business date — the Payment Report has no rows to read one from. ' +
          'If this is a zero-transaction/closed day, enter the business date manually and try again.',
      );
    }
  }
  const win = buildWin(effectiveBizDate!);

  // 3. Terminal rows, filtered through the window.
  const { inside, filtered } = await parseTransactionsZip(files.zip.buffer, win);
  if (!inside.length && !filtered.length) {
    warnings.push(
      'No transaction rows found inside the ZIP — treating this as a zero-transaction/closed day. ' +
        'If this outlet was not actually closed, check this is the correct Pinelabs All Transactions export before submitting.',
    );
  }

  // Batch Settle Check — blocks the whole upload rather than silently
  // reconciling against not-yet-final money. See `findUnsettledSuccessRows`.
  const unsettled = findUnsettledSuccessRows(inside, filtered);
  if (unsettled.length) {
    const sample = unsettled.slice(0, 10).map((r) => r.rrn || r.name || '(no RRN)');
    const more = unsettled.length > sample.length ? `, +${unsettled.length - sample.length} more` : '';
    throw new BadRequestError(
      `${unsettled.length} transaction(s) in the Pinelabs report show as Success but are not yet Settled (Batch Status) — RRN(s): ${sample.join(', ')}${more}. Settle them in Pinelabs before uploading.`,
    );
  }

  // 4. Outlet, before reconcile() — it filters the HDFC statement by outlet.
  const detectedOutlet = detectOutletFromZip(inside);
  let outlet: OutletCode;
  if (files.gmOutlet) {
    // A GM already has exactly one outlet — never let file-based detection
    // override it, and never silently fall back to FALLBACK_OUTLET for
    // them (which is exactly what a zero-transaction ZIP, with no store
    // name to detect from, would otherwise trigger).
    outlet = files.gmOutlet;
    if (detectedOutlet && detectedOutlet !== outlet) {
      warnings.push(
        `This file's terminal store name looks like it might belong to ${outletName(detectedOutlet)}, not your outlet (${outletName(outlet)}) — double-check you selected the right file before submitting.`,
      );
    }
  } else {
    outlet = files.outletOverride ?? detectedOutlet ?? FALLBACK_OUTLET;
    if (files.outletOverride) {
      if (detectedOutlet && detectedOutlet !== files.outletOverride) {
        warnings.push(
          `Outlet manually set to ${outlet} — the terminal store name in this ZIP suggested ${detectedOutlet} instead. Verify this is correct before submitting.`,
        );
      }
    } else if (!detectedOutlet) {
      const stores = [...new Set(inside.map((r) => r.store).filter(Boolean))];
      warnings.push(
        `Outlet could not be determined from the terminal store name${
          stores.length ? ` (saw: ${stores.join(', ')})` : ''
        } — defaulted to ${outlet}. Verify before submitting.`,
      );
    }
  }

  // 5. Optional inputs.
  const summaryText = files.sum?.buffer.toString('utf8');
  let summaryData: SummaryData | null = null;
  if (summaryText) {
    summaryData = parsePaymentSummary(summaryText);
    if (!summaryData) {
      summaryData = parseSaleSummaryDrawerSection(summaryText);
    }
  }
  if (files.sum && !summaryData) {
    warnings.push(
      'The Sales Summary file could not be read as either a Drawer Summary Report or a Sale Summary report — drawer comparisons are unavailable.',
    );
  }
  const taxes = summaryText ? buildTaxesSummary(summaryText) : null;

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

  let linkStmtRows: PaymentLinkRow[] | null = null;
  let hdfcLinkStatementMeta: HdfcLinkStatementMetaDTO | null = null;
  if (files.hdfcLink) {
    try {
      const parsed = parsePaymentLinkStatement(files.hdfcLink.buffer.toString('utf8'), win);
      linkStmtRows = parsed.rows;
      hdfcLinkStatementMeta = { rows: parsed.rows.length, skippedNonSale: parsed.skippedNonSale };
      if (!parsed.rows.length) {
        warnings.push(
          'The HDFC Payment Link report contained no SALE rows inside the business window — HDFC Link used the aggregate flow.',
        );
      }
    } catch (err) {
      // A bad optional file must never block a session — same tolerance as the HDFC UPI statement above.
      const msg = err instanceof PaymentLinkStatementFormatError ? err.message : (err as Error).message;
      warnings.push(
        `HDFC Payment Link report could not be read: ${msg}. Continuing without it — HDFC Link used the aggregate flow.`,
      );
    }
  }

  // 6. Reconcile.
  const result = reconcile({ prData, zipInside: inside, hdfcStmtRows, linkStmtRows, outlet });
  result.zipFiltered = filtered;

  // ── Derived figures, computed here so the UI never does reconciliation
  // arithmetic of its own ────────────────────────────────────────────────
  const prMap = buildPRMap(prData);
  const sumMap = buildSumMap(summaryData);
  const ctx = { prData, zipInside: inside, upiHdfc: result.upiHdfc, linkStmt: result.linkStmt };

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
    taxes,
    hdfcStmtRows,
    hdfcStatementMeta,
    linkStmtRows,
    hdfcLinkStatementMeta,
    result,
    outlet,
    win,
    businessDate: civilToISO(effectiveBizDate!),
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

/**
 * Net Sales / net CGST / net SGST / VAT, read from the Sale Summary
 * upload's `SALES` and `TAXES` sections. `null` when the file has no
 * `TAXES` section at all — the Sale Summary upload is optional, and even
 * when present it may be a native Drawer Summary Report export that lacks
 * these sections entirely.
 */
function buildTaxesSummary(text: string): TaxesSummaryDTO | null {
  const sales = parseSaleSummarySalesSection(text);
  const taxes = parseSaleSummaryTaxesSection(text);
  if (!taxes) return null;

  const entries = Object.entries(taxes).filter(([k]) => k.toLowerCase() !== 'total');
  // CGST/SGST/VAT each ride on a free-form label, not a fixed one — real
  // exports have category suffixes like "CGST - TOBACCO (20%)" or
  // "VAT - LIQUOR (5%)", so every category sums every line whose label
  // *starts with* its prefix rather than looking up one exact key.
  const matches = (prefix: string) => entries.filter(([k]) => k.toLowerCase().startsWith(prefix));
  const sum = (prefix: string) => matches(prefix).reduce((s, [, v]) => s + money(v), 0);

  return {
    netSales: sales?.['Net Sales'] !== undefined ? money(sales['Net Sales']!) : null,
    netCgst: sum('cgst'),
    netSgst: sum('sgst'),
    vat: matches('vat').length ? sum('vat') : null,
    total: taxes['Total'] !== undefined ? money(taxes['Total']!) : null,
  };
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
    hdfcLink: result.linkStmt
      ? {
          reconciled: result.linkStmt.reconRows.filter((x) => !isMaterial(x.diff)).length,
          unreconciled: result.linkStmt.reconRows.filter((x) => isMaterial(x.diff)).length,
          onlyPOS: result.linkStmt.onlyPOS.length,
          onlyTerm: result.linkStmt.onlyTerm.length,
          dupRRN: result.linkStmt.dupRRN.length,
        }
      : null,
    swiggy: result.swiggy.length,
    cash: result.cash.length,
    upi: result.upi.length,
    bills: result.bills.length,
    bank: result.bank.length,
    paperPos: result.paperPos.length,
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
    hdfcLink: drawerTotals(sumAmounts(result.hdfcLink), drawer('HDFC Payment Link')),
    paperPos: drawerTotals(sumAmounts(result.paperPos), drawer('Paper POS')),
    bills: drawerTotals(sumAmounts(result.bills), drawer('Bills on Hold')),
    swiggy: {
      prTotal: sumAmounts(result.swiggy),
      swiggy: drawerTotals(sumAmounts(swiggyRows), drawer('Swiggy')),
      zomato: drawerTotals(sumAmounts(zomatoRows), drawer('ZOMATO')),
    },
    pinelabs: { prTotal: plPR, terminalTotal: plTerm, diff: plTerm - plPR },
  };
}

// ── Draft session lifecycle ─────────────────────────────────────────────

/**
 * Marks every OTHER session for this outlet+businessDate whose status is in
 * `discardStatuses` as `'discarded'`, superseded by `keepSessionId`. Called
 * from two places, with two different `discardStatuses`:
 *   - session creation (`routes/sessions.ts`'s `POST /`): `['draft']` only —
 *     a GM uploading fresh files while an old draft sits open starts from
 *     scratch; the old draft is discarded, an existing *submitted* session
 *     is untouched (that pairing only exists via the approval flow, and
 *     isn't superseded until the new session is itself submitted).
 *   - submit (`routes/sessions.ts`'s `POST /:id/submit`): `['draft',
 *     'submitted']` — covers both a stray sibling draft left open the same
 *     day, and a prior submitted session from an approved re-run (which
 *     otherwise leaves two live submitted sessions for one outlet+date with
 *     no relationship recorded between them).
 * `list()` already excludes `'discarded'` sessions by default, so this
 * naturally never re-discards something it (or an earlier call) already did.
 */
export async function supersedeSessions(
  outlet: OutletCode,
  businessDate: string | null,
  keepSessionId: string,
  discardStatuses: readonly SessionStatus[],
): Promise<void> {
  if (!businessDate) return; // nothing to key the sweep on — same tolerance assertReconAllowed() already has
  const store = getSessionStore();
  const siblings = await store.list({ outlet });
  const toDiscard = siblings.filter(
    (s) => s.businessDate === businessDate && s.id !== keepSessionId && discardStatuses.includes(s.status),
  );
  for (const item of toDiscard) {
    const full = await store.get(item.id);
    if (!full) continue;
    await store.update(full.meta.id, {
      ...full,
      meta: {
        ...full.meta,
        status: 'discarded',
        discardedAt: new Date().toISOString(),
        supersededBySessionId: keepSessionId,
      },
    });
  }
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

/**
 * Thrown when neither the Payment Report nor a manual override yields a
 * business date — nothing to key the session, the sequence gate, or the
 * snapshot on. Dedicated class (rather than folding into `BadRequestError`)
 * so the frontend can offer the date-entry field via `code:
 * 'BUSINESS_DATE_REQUIRED'` instead of string-matching the message.
 */
export class BusinessDateRequiredError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BusinessDateRequiredError';
  }
}
