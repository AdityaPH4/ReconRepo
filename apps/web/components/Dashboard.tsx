'use client';

/**
 * The GM's dashboard, shown before/after running recon — today's status, a
 * rolling Tips breakdown, and a Bills-on-Hold aging table.
 */

import type { BohAgingBucket, DashboardBohAgingRowDTO, DashboardDateRangeDTO, DashboardDTO, DashboardTipsRowDTO } from '@toit/contracts';
import { fmt, fmtDate } from '@toit/recon-core/display';
import { useEffect, useState } from 'react';
import { useCurrentUser } from '@/components/auth/AuthProvider';
import { ModalShell } from '@/components/justification/ModalShell';
import { ApiError, getDashboard } from '@/lib/api';
import { diffClass } from '@/components/ui/table';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft — not yet submitted',
  submitted: 'Submitted',
};

/** `row.label` is internal shorthand ('T', 'T-1', …) — a GM needs an actual day, not engineering notation. */
function tipsDayLabel(row: DashboardTipsRowDTO): string {
  if (row.label === 'T') return 'Today';
  if (row.label === 'T-1') return 'Yesterday';
  return new Date(`${row.date}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function tipsRangeLabel(range: DashboardDateRangeDTO): string {
  const fmtShort = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${fmtShort(range.from)} – ${fmtShort(range.to)}`;
}

/** Same green/amber/red logic as everywhere else a magnitude implies urgency — 1-2 days is fine, 3-4 needs attention, 5+ is stale. */
const BOH_BUCKET_TAG: Record<BohAgingBucket, string> = {
  '1': 'tag-ok',
  '2': 'tag-ok',
  '3': 'tag-warn',
  '4': 'tag-warn',
  '5': 'tag-err',
  '5+': 'tag-err',
};

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadBohAgingCsv(outlet: string, aging: DashboardBohAgingRowDTO[], total: { count: number; amount: number }): void {
  const rows = [
    ['Ageing (Days)', 'Number of Items', 'Amount'],
    ...aging.map((r) => [r.bucket, r.count, r.amount]),
    ['Total', total.count, total.amount],
  ];
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `boh-aging-${outlet}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function Dashboard() {
  const user = useCurrentUser();
  const [dashboard, setDashboard] = useState<DashboardDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedBucket, setSelectedBucket] = useState<DashboardBohAgingRowDTO | null>(null);

  useEffect(() => {
    getDashboard()
      .then(setDashboard)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load dashboard.'));
  }, [user.email]);

  if (error) {
    return (
      <div className="alert alert-err mb-6">
        <span>✕</span>
        <span>{error}</span>
      </div>
    );
  }

  if (!dashboard) {
    return <p className="text-body text-ink-3 mb-6">Loading dashboard…</p>;
  }

  const { todayStatus } = dashboard;

  return (
    <div className="mb-6">
      <div className="alert alert-info mb-4">
        <span>ℹ</span>
        <span>
          {todayStatus.sessionId
            ? `${dashboard.outlet} — today (${dashboard.today}): ${STATUS_LABEL[todayStatus.status ?? ''] ?? todayStatus.status} — grand diff ${fmt(todayStatus.grandDiff ?? 0)}`
            : `${dashboard.outlet} — no reconciliation run for ${dashboard.today} yet.`}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="panel">
          <div className="panel-header">
            <div className="panel-header-left">
              <div className="panel-icon">🪙</div>
              <div>
                <p className="panel-title">Tips</p>
                <p className="panel-subtitle">Daily tips collected from payment reports</p>
              </div>
            </div>
            <span className="pill">
              📅 {tipsRangeLabel(dashboard.tipsWeekCurrentRange)}
            </span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="text-left!">Date</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.tips.map((row) => (
                  <tr key={row.label} className={row.label === 'T' ? 'bg-warn-soft!' : undefined}>
                    <td className="text-left!">
                      <span className="inline-flex items-center gap-2">
                        <span aria-hidden className="text-body">📅</span>
                        <span className={row.label === 'T' ? 'font-semibold' : undefined}>{tipsDayLabel(row)}</span>
                        {row.label === 'T' && <span className="tag tag-warn">Today</span>}
                      </span>
                    </td>
                    <td className="num">{fmt(row.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2} />
                </tr>
                <tr className="total-row">
                  <td className="text-left!">
                    <span className="inline-flex items-center gap-2">
                      <span aria-hidden>📊</span>
                      <span className="font-semibold">This week</span>
                      <span className="text-tiny text-ink-3 font-normal">({tipsRangeLabel(dashboard.tipsWeekCurrentRange)})</span>
                    </span>
                  </td>
                  <td className="num">
                    <span className="border-b-2 border-warn pb-0.5">{fmt(dashboard.tipsWeekCurrent)}</span>
                  </td>
                </tr>
                <tr className="total-row">
                  <td className="text-left!">
                    <span className="inline-flex items-center gap-2">
                      <span aria-hidden>📊</span>
                      <span className="font-semibold">Last week</span>
                      <span className="text-tiny text-ink-3 font-normal">({tipsRangeLabel(dashboard.tipsWeekPreviousRange)})</span>
                    </span>
                  </td>
                  <td className="num">
                    <span className="border-b-2 border-warn pb-0.5">{fmt(dashboard.tipsWeekPrevious)}</span>
                  </td>
                </tr>
                {dashboard.tipsWeekPrevious > 0 && (
                  <tr>
                    <td className="text-left! text-tiny text-ink-3">vs. last week</td>
                    <td className={`num text-tiny font-semibold ${diffClass(dashboard.tipsWeekCurrent - dashboard.tipsWeekPrevious)}`}>
                      {dashboard.tipsWeekCurrent >= dashboard.tipsWeekPrevious ? '▲' : '▼'}{' '}
                      {fmt(Math.abs(dashboard.tipsWeekCurrent - dashboard.tipsWeekPrevious))}
                      {' '}({Math.round((Math.abs(dashboard.tipsWeekCurrent - dashboard.tipsWeekPrevious) / dashboard.tipsWeekPrevious) * 100)}%)
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {dashboard.tipsWeekCurrent === 0 && dashboard.tipsWeekPrevious === 0 && (
            <p className="text-tiny text-ink-3 px-5 py-3 flex items-start gap-1.5">
              <span aria-hidden>ℹ</span>
              <span>
                No tips recorded in the last 14 days — this fills in automatically from the Payment Report&apos;s Tips
                column once a session is submitted.
              </span>
            </p>
          )}
        </div>

        <div className="panel">
          <div className="panel-header">
            <div className="panel-header-left">
              <div className="panel-icon">📦</div>
              <div>
                <p className="panel-title">BOH Table</p>
                <p className="panel-subtitle">Back of House summary by ageing</p>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => downloadBohAgingCsv(dashboard.outlet, dashboard.bohAging, dashboard.bohTotal)}
            >
              📄 Export CSV
            </button>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="text-left!">Ageing (Days)</th>
                  <th className="num">Number of Items</th>
                  <th className="num">Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.bohAging.map((row) => (
                  <tr
                    key={row.bucket}
                    className={row.count > 0 ? 'cursor-pointer' : undefined}
                    onClick={() => row.count > 0 && setSelectedBucket(row)}
                  >
                    <td className="text-left!">
                      <span className={`tag ${BOH_BUCKET_TAG[row.bucket]}`}>{row.bucket}</span>
                    </td>
                    <td className="num">{row.count}</td>
                    <td className="num">{fmt(row.amount)}</td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td className="text-left!">
                    <span className="inline-flex items-center gap-2">
                      <span aria-hidden>🧮</span>
                      <span>Total</span>
                    </span>
                  </td>
                  <td className="num">{dashboard.bohTotal.count}</td>
                  <td className="num">{fmt(dashboard.bohTotal.amount)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {selectedBucket && (
        <ModalShell
          title={`Bills on hold — ${selectedBucket.bucket} day${selectedBucket.bucket === '1' ? '' : 's'} (${selectedBucket.count})`}
          onClose={() => setSelectedBucket(null)}
          footer={
            <button type="button" className="btn" onClick={() => setSelectedBucket(null)}>
              Close
            </button>
          }
        >
          <div className="flex flex-col gap-3">
            {selectedBucket.entries.map((e) => (
              <div key={e.id} className="pick-card">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold">
                    {e.orderNo} — {e.custName}
                  </span>
                  <span className="font-semibold">{fmt(e.amount)}</span>
                </div>
                <div className="text-tiny text-ink-3 mt-1">
                  {fmtDate(e.bohDate)}
                  {e.phone && <> · {e.phone}</>}
                </div>
                {e.notes && <div className="text-tiny text-ink-3 mt-1">{e.notes}</div>}
              </div>
            ))}
          </div>
        </ModalShell>
      )}
    </div>
  );
}
