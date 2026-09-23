/**
 * The printable settlement report.
 * Ported from `reconciliation (68).html` lines 5266–5366 (`downloadReport`),
 * then redesigned to match the outlet-facing sample report format — grouped
 * variance explanations, a Pinelabs acquirer breakdown, a 3-way Bills on
 * Hold split, and a Taxes table sourced from the optional Sale Summary
 * upload.
 *
 * Legacy builds this as a client-side `Blob` download, available only once,
 * at the moment of submission. The port serves it from `GET
 * /api/sessions/:id/report`, regenerated from the persisted snapshot on every
 * request — so it can be reprinted any time after submit, not just once.
 *
 * Every field this template reads beyond the original snapshot shape
 * (`pinelabs.acquirerBreakdown`, `billsOnHold.openThisSession`, `taxes`) is
 * optional on `Snapshot` — a report generated for a session submitted before
 * this redesign simply omits those sections rather than crashing.
 */

import { fmt } from '../util/money.js';
import { civilToISO, fmtDate, fmtEventDate, parsePRDate } from '../util/dates.js';
import type { ExplainedItem } from './residual.js';
import type { Snapshot } from './snapshot.js';

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Groups explained items by remark, preserving first-seen order — ported from `FinalReconSummary.tsx`'s `groupByRemark()` so the report and the live FRS tab agree on how variances are bucketed. */
function groupByRemark(
  items: readonly ExplainedItem[],
): Array<{ remark: string; rows: ExplainedItem[]; total: number }> {
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

const explanationRow = (x: ExplainedItem, sign: '+' | '-', color: string) =>
  `<tr><td>${esc(x.label)}</td><td>${esc(x.orderNo || '—')}</td><td class="mono">${esc(x.rrn || '—')}</td><td class=ra style="color:${color}">${sign}${fmt(Math.abs(x.diff))}</td></tr>`;

/** One mini-table per remark group — the grouped layout the sample report uses in place of one flat excess/shortage table. Each group's own subtotal sits in its header bar, not a table footer. */
function explanationGroupsHtml(items: readonly ExplainedItem[], sign: '+' | '-', color: string): string {
  const groups = groupByRemark(items);
  if (!groups.length) return '<p style="color:#9ca3af;font-size:12px">None</p>';
  return groups
    .map(
      (g) => `<div class=rg-label><span>${esc(g.remark)} (${g.rows.length} item${g.rows.length > 1 ? 's' : ''})</span><span style="color:${color}">${sign}${fmt(g.total)}</span></div>
<table><thead><tr><th>Source</th><th>Order No</th><th>RRN</th><th class=ra>Amount</th></tr></thead>
<tbody>${g.rows.map((x) => explanationRow(x, sign, color)).join('')}</tbody></table>`,
    )
    .join('');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days between a raw PR-format `bohDate` and today, matching the GM/Admin dashboards' own BOH aging math. `null` when `bohDate` doesn't parse. */
function bohAgeDays(bohDate: string): number | null {
  const civil = parsePRDate(bohDate);
  if (!civil) return null;
  const civilISO = civilToISO(civil);
  const todayISO = new Date().toISOString().slice(0, 10);
  return Math.round((Date.parse(`${todayISO}T00:00:00Z`) - Date.parse(`${civilISO}T00:00:00Z`)) / DAY_MS);
}

type BohRow = Snapshot['billsOnHold']['open'][number];

const bohRow = (b: BohRow) =>
  `<tr><td>${esc(b.orderNo)}</td><td>${esc(b.custName)}</td><td>${esc(fmtDate(b.bohDate))}</td><td class=ra>${fmt(b.amount)}</td></tr>`;

const bohRowWithAge = (b: BohRow) => {
  const age = bohAgeDays(b.bohDate);
  return `<tr><td>${esc(b.orderNo)}</td><td>${esc(b.custName)}</td><td>${esc(fmtDate(b.bohDate))}</td><td class=ra>${age === null ? '—' : age}</td><td class=ra>${fmt(b.amount)}</td></tr>`;
};

export function buildReportHtml(snapshot: Snapshot): string {
  const m = snapshot.meta;
  const frs = snapshot.finalReconSummary;
  const statusLabel =
    frs.status === 'balanced' ? 'Fully Balanced' : frs.status === 'within_threshold' ? 'Within Threshold' : 'Needs Review';
  const sc = frs.status === 'needs_explanation' ? '#dc2626' : '#16a34a';

  const mrows = frs.methodBreakdown
    .map((r) => {
      const expected = r.usingSource ? r.sourceAmt : r.drawerAmt;
      const settled = r.assumedReconciled || Math.abs(r.diff) < 0.5;
      const c = settled ? '#6b7280' : r.diff > 0 ? '#16a34a' : '#dc2626';
      return `<tr><td>${esc(r.label)}</td><td class=ra>${fmt(r.pr)}</td><td class=ra>${expected === null ? '—' : fmt(expected)}</td><td class=ra style="color:${c};font-weight:600">${settled ? '—' : (r.diff > 0 ? '+' : '') + fmt(r.diff)}</td></tr>`;
    })
    .join('');

  const acq = snapshot.pinelabs.acquirerBreakdown;
  const acqRows = (acq?.rows ?? [])
    .map(
      (r) =>
        `<tr><td>${esc(r.acquirer)}</td><td class=ra>${r.count}</td><td class=ra>${fmt(r.pinelabsTotal)}</td><td class=ra>${fmt(r.prTotal)}</td><td class=ra style="color:${r.diff === null || Math.abs(r.diff) < 0.5 ? '#6b7280' : r.diff > 0 ? '#16a34a' : '#dc2626'};font-weight:600">${r.diff === null ? '—' : `${r.diff > 0 ? '+' : ''}${fmt(r.diff)}`}</td></tr>`,
    )
    .join('');

  const excess = frs.explanations.filter((x) => x.diff > 0.5);
  const short = frs.explanations.filter((x) => x.diff < -0.5);

  const bohOpenThisSession = snapshot.billsOnHold.openThisSession ?? [];
  const bohOpenThisSessionRows = bohOpenThisSession.map(bohRow).join('');
  const bohClearedRows = snapshot.billsOnHold.cleared
    .map(
      (c) =>
        `<tr><td>${esc(c.orderNo)}</td><td>${esc(c.source)}</td><td>${esc(c.clearedDate)}</td><td class=ra>${fmt(c.amount)}</td></tr>`,
    )
    .join('');
  const bohTotalOpenRows = snapshot.billsOnHold.open.map(bohRowWithAge).join('');

  const openAdvances = snapshot.advances.repository.filter((a) => a.balance > 0.5);
  const openAdvancesTotal = openAdvances.reduce((s, a) => s + a.balance, 0);
  const advOpenRows = openAdvances
    .map(
      (a) =>
        `<tr><td>${esc(a.custName)}</td><td>${esc(fmtEventDate(a.eventDate))}</td><td class=ra>${fmt(a.originalAmount)}</td><td class=ra>${fmt(a.appliedAmount)}</td><td class=ra style="color:#2563eb;font-weight:600">${fmt(a.balance)}</td></tr>`,
    )
    .join('');
  const advRepoById = new Map(snapshot.advances.repository.map((a) => [a.id, a]));
  const advAppliedRows = snapshot.advances.applications
    .map((ap) => {
      const eventDate = advRepoById.get(ap.advanceId)?.eventDate;
      return `<tr><td>${esc(ap.advanceCustName)}</td><td>${eventDate ? esc(fmtEventDate(eventDate)) : '—'}</td><td>${esc(fmtEventDate(ap.appliedDate))}</td><td class=ra>${fmt(ap.amount)}</td></tr>`;
    })
    .join('');

  const taxes = snapshot.taxes;

  return `<!DOCTYPE html><html lang=en><head><meta charset=UTF-8>
<title>Toit Recon ${esc(m.businessDate)}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#1f2937;background:#fff;padding:2rem;max-width:960px;margin:0 auto}
h1{font-size:22px;font-weight:700;margin-bottom:.25rem}
h2{font-size:15px;font-weight:700;margin:1.75rem 0 .75rem;padding:.4rem 0;border-bottom:2px solid #e5e7eb;color:#374151}
h3{font-size:12px;font-weight:600;margin:.75rem 0 .4rem;color:#6b7280;text-transform:uppercase;letter-spacing:.05em}
.var-total{display:flex;justify-content:space-between;align-items:center;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:.6rem 1rem;font-weight:700;font-size:13px;margin:1rem 0 .5rem}
.rg-label{display:flex;justify-content:space-between;align-items:center;background:#f3f4f6;padding:.4rem .75rem;font-weight:600;font-size:12px;color:#374151;margin:.7rem 0 0}
.rg-label + table{margin-top:0}
.meta{color:#6b7280;font-size:12px;margin-bottom:1.5rem}
.badge{display:inline-block;padding:.35rem 1rem;border-radius:20px;font-weight:700;font-size:13px;background:#f0fdf4;color:${sc};border:1px solid ${sc}44;margin-bottom:1.5rem}
table{width:100%;border-collapse:collapse;margin-bottom:1rem;font-size:12px}
th{background:#f9fafb;padding:.4rem .75rem;text-align:left;font-weight:600;border-bottom:2px solid #e5e7eb}
td{padding:.35rem .75rem;border-bottom:1px solid #f3f4f6}
.ra{text-align:right}.mono{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#6b7280}tfoot td{font-weight:700;background:#f9fafb;border-top:2px solid #e5e7eb}
.footer{margin-top:2rem;padding-top:1rem;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af}
@media print{.np{display:none}}</style></head>
<body>
<div style="display:flex;justify-content:space-between;align-items:flex-start">
  <div><h1>Payment Reconciliation — ${esc(m.outletName)}</h1>
  <div class=meta>Business date: ${esc(m.businessWindow)} &nbsp;|&nbsp; Submitted: ${esc(m.submittedAt)} by ${esc(m.submittedBy)}</div></div>
  <button class=np onclick="window.print()" style="padding:.4rem .9rem;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;font-size:12px">Print</button>
</div>
<div class=badge>${statusLabel} &nbsp;|&nbsp; Net difference: ${fmt(frs.grandDiff)}</div>

<h2>Payment Report vs Actual Collection</h2>
<table><thead><tr><th>Payment Method</th><th class=ra>PR Amount</th><th class=ra>Actual Collection</th><th class=ra>Difference</th></tr></thead>
<tbody>${mrows}</tbody>
<tfoot><tr><td>Grand Total</td><td class=ra>${fmt(frs.methodBreakdown.reduce((s, r) => s + r.pr, 0))}</td><td></td><td class=ra style="color:${sc}">${fmt(frs.grandDiff)}</td></tr></tfoot></table>

${
  acq
    ? `<h2>Pinelabs Terminal Breakdown</h2>
<table><thead><tr><th>Acquirer</th><th class=ra>Txn Count</th><th class=ra>Terminal</th><th class=ra>PR Amount</th><th class=ra>Difference</th></tr></thead>
<tbody>${acqRows}</tbody>
<tfoot><tr><td>Grand Total</td><td class=ra>${acq.totalCount}</td><td class=ra>${fmt(acq.totalPinelabs)}</td><td class=ra>${fmt(acq.totalPR)}</td><td class=ra style="color:${sc}">${fmt(acq.totalDiff)}</td></tr></tfoot></table>`
    : ''
}

<h2>Explanation of Variances</h2>
<div class=var-total><span>Total excess (${excess.length} item${excess.length === 1 ? '' : 's'})</span><span style="color:#16a34a">+${fmt(frs.totalExcess)}</span></div>
${explanationGroupsHtml(excess, '+', '#16a34a')}
<div class=var-total><span>Total shortage (${short.length} item${short.length === 1 ? '' : 's'})</span><span style="color:#dc2626">-${fmt(frs.totalShortage)}</span></div>
${explanationGroupsHtml(short, '-', '#dc2626')}

${
  bohOpenThisSession.length || snapshot.billsOnHold.cleared.length || snapshot.billsOnHold.open.length
    ? `<h2>Bills on Hold</h2>
${bohOpenThisSession.length ? `<h3>BOH from current session (${bohOpenThisSession.length})</h3><table><thead><tr><th>Order No</th><th>Customer</th><th>BOH Date</th><th class=ra>Amount</th></tr></thead><tbody>${bohOpenThisSessionRows}</tbody></table>` : ''}
${snapshot.billsOnHold.cleared.length ? `<h3>Cleared this session (${snapshot.billsOnHold.cleared.length})</h3><table><thead><tr><th>Order No</th><th>Source</th><th>Cleared Date</th><th class=ra>Amount</th></tr></thead><tbody>${bohClearedRows}</tbody></table>` : ''}
${snapshot.billsOnHold.open.length ? `<h3>Total open BOH (${snapshot.billsOnHold.open.length})</h3><table><thead><tr><th>Order No</th><th>Customer</th><th>BOH Date</th><th class=ra>Age (days)</th><th class=ra>Amount</th></tr></thead><tbody>${bohTotalOpenRows}</tbody></table>` : ''}`
    : ''
}

${
  openAdvances.length || snapshot.advances.applications.length
    ? `<h2>Advance Repository</h2>
${openAdvances.length ? `<h3>Open advances (${openAdvances.length} — total balance ${fmt(openAdvancesTotal)})</h3><table><thead><tr><th>Customer</th><th>Event Date</th><th class=ra>Original</th><th class=ra>Applied</th><th class=ra>Balance</th></tr></thead><tbody>${advOpenRows}</tbody></table>` : ''}
${snapshot.advances.applications.length ? `<h3>Applied this session (${snapshot.advances.applications.length})</h3><table><thead><tr><th>Customer</th><th>Event Date</th><th>Applied On</th><th class=ra>Amount</th></tr></thead><tbody>${advAppliedRows}</tbody></table>` : ''}`
    : ''
}

${
  taxes
    ? `<h2>Taxes</h2>
<table><thead><tr><th>Category</th><th class=ra>Amount</th></tr></thead><tbody>
<tr><td>Net Sales</td><td class=ra>${fmt(taxes.netSales)}</td></tr>
<tr><td>Net CGST</td><td class=ra>${fmt(taxes.netCgst)}</td></tr>
<tr><td>Net SGST</td><td class=ra>${fmt(taxes.netSgst)}</td></tr>
${taxes.vat !== null ? `<tr><td>VAT</td><td class=ra>${fmt(taxes.vat)}</td></tr>` : ''}
</tbody>${taxes.total !== null ? `<tfoot><tr><td>Total</td><td class=ra>${fmt(taxes.total)}</td></tr></tfoot>` : ''}</table>`
    : ''
}

<div class=footer>Toit Payment Reconciliation &nbsp;|&nbsp; ${esc(m.submittedAt)}</div>
</body></html>`;
}
