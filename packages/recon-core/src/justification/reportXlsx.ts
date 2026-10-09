/**
 * The settlement report, as an .xlsx workbook — same underlying `Snapshot`
 * as `buildReportHtml`'s HTML report, but as real spreadsheet rows (plain
 * numbers, not pre-formatted strings) so the accounts team can sum/filter/
 * pivot it directly in Excel rather than reading an email body.
 *
 * One sheet per section of the HTML report, same grouping, plus a
 * "Settlement Ledger" sheet (the full per-transaction audit trail) the HTML
 * report doesn't show at all.
 */

import * as XLSX from 'xlsx';
import { civilToISO, fmtDate, fmtEventDate, parsePRDate } from '../util/dates.js';
import type { ExplainedItem } from './residual.js';
import type { Snapshot } from './snapshot.js';

type Row = Array<string | number | null>;

function sheetFromRows(rows: Row[]): XLSX.WorkSheet {
  return XLSX.utils.aoa_to_sheet(rows);
}

function groupByRemark(items: readonly ExplainedItem[]): Array<{ remark: string; rows: ExplainedItem[]; total: number }> {
  const map = new Map<string, { remark: string; rows: ExplainedItem[]; total: number }>();
  for (const x of items) {
    const existing = map.get(x.remark);
    if (existing) {
      existing.rows.push(x);
      existing.total += Math.abs(x.diff);
    } else {
      map.set(x.remark, { remark: x.remark, rows: [x], total: Math.abs(x.diff) });
    }
  }
  return [...map.values()];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days between a raw PR-format `bohDate` and today — mirrors `report.ts`'s own `bohAgeDays`. */
function bohAgeDays(bohDate: string): number | null {
  const civil = parsePRDate(bohDate);
  if (!civil) return null;
  const civilISO = civilToISO(civil);
  const todayISO = new Date().toISOString().slice(0, 10);
  return Math.round((Date.parse(`${todayISO}T00:00:00Z`) - Date.parse(`${civilISO}T00:00:00Z`)) / DAY_MS);
}

export function buildReportXlsx(snapshot: Snapshot): Buffer {
  const m = snapshot.meta;
  const frs = snapshot.finalReconSummary;
  const statusLabel =
    frs.status === 'balanced' ? 'Fully Balanced' : frs.status === 'within_threshold' ? 'Within Threshold' : 'Needs Review';

  const wb = XLSX.utils.book_new();

  // ── Summary ──────────────────────────────────────────────────────────
  const summaryRows: Row[] = [
    ['Payment Reconciliation', m.outletName],
    ['Business date', m.businessWindow],
    ['Submitted', m.submittedAt],
    ['Submitted by', m.submittedBy],
    ['Status', statusLabel],
    ['Net difference', frs.grandDiff],
    [],
    ['Payment Method', 'PR Amount', 'Actual Collection', 'Difference'],
    ...frs.methodBreakdown.map((r): Row => {
      const expected = r.usingSource ? r.sourceAmt : r.drawerAmt;
      const settled = r.assumedReconciled || Math.abs(r.diff) < 0.5;
      return [r.label, r.pr, expected, settled ? 0 : r.diff];
    }),
    ['Grand Total', frs.methodBreakdown.reduce((s, r) => s + r.pr, 0), null, frs.grandDiff],
  ];
  XLSX.utils.book_append_sheet(wb, sheetFromRows(summaryRows), 'Summary');

  // ── Settlement Ledger — the full per-transaction audit trail ──────────
  const ledgerRows: Row[] = [
    ['RRN', 'Auth Code', 'Acquirer', 'MID', 'Invoice', 'Pinelabs Amount', 'Pinelabs Date', 'Settlement Date', 'POS Amount', 'POS Order No', 'Outlet', 'Store', 'Status', 'Remark', 'Diff', 'Squared Off', 'Match By'],
    ...snapshot.settlementLedger.map(
      (r): Row => [
        r.rrn,
        r.authCode,
        r.acquirer,
        r.mid,
        r.invoice,
        r.plAmount,
        r.plDate,
        r.plSettlementDate,
        r.posAmount,
        r.posOrderNo,
        r.outlet,
        r.store,
        r.l1Status,
        r.l1Remark,
        r.l1Diff,
        r.squaredOff ? 'Yes' : 'No',
        r.matchBy,
      ],
    ),
  ];
  XLSX.utils.book_append_sheet(wb, sheetFromRows(ledgerRows), 'Settlement Ledger');

  // ── Pinelabs Terminal Breakdown ────────────────────────────────────────
  const acq = snapshot.pinelabs.acquirerBreakdown;
  if (acq) {
    const acqRows: Row[] = [
      ['Acquirer', 'Txn Count', 'Terminal', 'PR Amount', 'Difference'],
      ...acq.rows.map((r): Row => [r.acquirer, r.count, r.pinelabsTotal, r.prTotal, r.diff]),
      ['Grand Total', acq.totalCount, acq.totalPinelabs, acq.totalPR, acq.totalDiff],
    ];
    XLSX.utils.book_append_sheet(wb, sheetFromRows(acqRows), 'Pinelabs Breakdown');
  }

  // ── Explanation of Variances ───────────────────────────────────────────
  const excess = frs.explanations.filter((x) => x.diff > 0.5);
  const short = frs.explanations.filter((x) => x.diff < -0.5);
  const varianceBlock = (title: string, total: number, items: readonly ExplainedItem[]): Row[] => {
    const rows: Row[] = [[`${title} (${items.length} items, total ${total})`]];
    for (const g of groupByRemark(items)) {
      rows.push([]);
      rows.push([`${g.remark} (${g.rows.length} items, subtotal ${g.total})`]);
      rows.push(['Source', 'Order No', 'RRN', 'Amount']);
      for (const x of g.rows) rows.push([x.label, x.orderNo, x.rrn, Math.abs(x.diff)]);
    }
    return rows;
  };
  const variancesRows: Row[] = [
    ...varianceBlock('Excess', frs.totalExcess, excess),
    [],
    ...varianceBlock('Shortage', frs.totalShortage, short),
  ];
  XLSX.utils.book_append_sheet(wb, sheetFromRows(variancesRows), 'Variances');

  // ── Bills on Hold ──────────────────────────────────────────────────────
  const bohOpenThisSession = snapshot.billsOnHold.openThisSession;
  const bohRows: Row[] = [];
  if (bohOpenThisSession !== undefined) {
    bohRows.push([`BOH opened this session (${bohOpenThisSession.length})`]);
    bohRows.push(['Order No', 'Customer', 'BOH Date', 'Amount']);
    for (const b of bohOpenThisSession) bohRows.push([b.orderNo, b.custName, fmtDate(b.bohDate), b.amount]);
    bohRows.push([]);
  }
  bohRows.push([`Cleared this session (${snapshot.billsOnHold.cleared.length})`]);
  bohRows.push(['Order No', 'Source', 'Cleared Date', 'Amount']);
  for (const c of snapshot.billsOnHold.cleared) bohRows.push([c.orderNo, c.source, c.clearedDate, c.amount]);
  bohRows.push([]);
  bohRows.push([`Total open BOH (${snapshot.billsOnHold.open.length})`]);
  bohRows.push(['Order No', 'Customer', 'BOH Date', 'Age (days)', 'Amount']);
  for (const b of snapshot.billsOnHold.open) {
    bohRows.push([b.orderNo, b.custName, fmtDate(b.bohDate), bohAgeDays(b.bohDate), b.amount]);
  }
  XLSX.utils.book_append_sheet(wb, sheetFromRows(bohRows), 'Bills on Hold');

  // ── Advance Repository ───────────────────────────────────────────────
  const openAdvances = snapshot.advances.repository.filter((a) => a.balance > 0.5);
  const advRepoById = new Map(snapshot.advances.repository.map((a) => [a.id, a]));
  const advRows: Row[] = [
    [`Open advances (${openAdvances.length}, total balance ${openAdvances.reduce((s, a) => s + a.balance, 0)})`],
    ['Customer', 'Event Date', 'Original', 'Applied', 'Balance'],
    ...openAdvances.map((a): Row => [a.custName, fmtEventDate(a.eventDate), a.originalAmount, a.appliedAmount, a.balance]),
    [],
    [`Applied this session (${snapshot.advances.applications.length})`],
    ['Customer', 'Event Date', 'Applied On', 'Amount'],
    ...snapshot.advances.applications.map((ap): Row => {
      const eventDate = advRepoById.get(ap.advanceId)?.eventDate;
      return [ap.advanceCustName, eventDate ? fmtEventDate(eventDate) : null, fmtEventDate(ap.appliedDate), ap.amount];
    }),
  ];
  XLSX.utils.book_append_sheet(wb, sheetFromRows(advRows), 'Advances');

  // ── Taxes ────────────────────────────────────────────────────────────
  const taxes = snapshot.taxes;
  if (taxes) {
    const taxRows: Row[] = [
      ['Net Sales', 'Net CGST', 'Net SGST', 'VAT', 'Total'],
      [taxes.netSales, taxes.netCgst, taxes.netSgst, taxes.vat ?? 0, taxes.total],
    ];
    XLSX.utils.book_append_sheet(wb, sheetFromRows(taxRows), 'Taxes');
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
