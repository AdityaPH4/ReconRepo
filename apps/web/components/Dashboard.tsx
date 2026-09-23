'use client';

/**
 * The GM's dashboard, shown before/after running recon — today's status,
 * and 4 cards: Bills on hold, Tips this month, Open advances, and this
 * outlet's own submissions calendar.
 */

import type { BohAgingBucket, DashboardBohAgingRowDTO, DashboardDTO, DashboardTipsPeriodDTO } from '@toit/contracts';
import { fmt, fmtDate, fmtEventDate } from '@toit/recon-core/display';
import { useEffect, useState } from 'react';
import { useCurrentUser } from '@/components/auth/AuthProvider';
import { ModalShell } from '@/components/justification/ModalShell';
import { SubmissionCalendar } from '@/components/SubmissionCalendar';
import { ApiError, getDashboard } from '@/lib/api';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft — not yet submitted',
  submitted: 'Submitted',
};

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function halfMonthLabel(range: DashboardTipsPeriodDTO['range']): string {
  const from = new Date(`${range.from}T00:00:00Z`);
  const to = new Date(`${range.to}T00:00:00Z`);
  const monthShort = to.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' });
  return `${from.getUTCDate()}–${to.getUTCDate()} ${monthShort}`;
}

const BOH_BUCKET_LABEL: Record<BohAgingBucket, string> = {
  '1': '1 day',
  '2': '2 days',
  '3': '3 days',
  '4': '4 days',
  '5': '5 days',
  '5+': '5+ days',
};

/** Same green/amber/red logic as everywhere else a magnitude implies urgency. */
const BOH_BUCKET_TAG: Record<BohAgingBucket, string> = {
  '1': 'tag-ok',
  '2': 'tag-ok',
  '3': 'tag-warn',
  '4': 'tag-warn',
  '5': 'tag-warn',
  '5+': 'tag-err',
};

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadBohAgingCsv(outlet: string, aging: DashboardBohAgingRowDTO[], total: { count: number; amount: number }): void {
  const rows = [
    ['Ageing range', 'Number of Items', 'Amount'],
    ...aging.map((r) => [BOH_BUCKET_LABEL[r.bucket], r.count, r.amount]),
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

export function Dashboard({ onLoad }: { onLoad?: (dashboard: DashboardDTO) => void } = {}) {
  const user = useCurrentUser();
  const [dashboard, setDashboard] = useState<DashboardDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedBucket, setSelectedBucket] = useState<DashboardBohAgingRowDTO | null>(null);

  useEffect(() => {
    getDashboard()
      .then((d) => {
        setDashboard(d);
        onLoad?.(d);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load dashboard.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const { todayStatus, tipsMonth, openAdvances } = dashboard;

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
              <div className="panel-icon">📦</div>
              <div>
                <p className="panel-title">Bills on hold</p>
                <p className="panel-subtitle">
                  {dashboard.bohTotal.count} open · {fmt(dashboard.bohTotal.amount)}
                </p>
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
          <div className="flex flex-col gap-1 p-4">
            {dashboard.bohAging.map((row) => (
              <div
                key={row.bucket}
                className={`flex items-center justify-between px-3 py-2 rounded-lg ${row.count > 0 ? 'cursor-pointer hover:bg-sunken' : ''}`}
                onClick={() => row.count > 0 && setSelectedBucket(row)}
              >
                <span className={`tag ${BOH_BUCKET_TAG[row.bucket]}`}>{BOH_BUCKET_LABEL[row.bucket]}</span>
                <span className="text-tiny text-ink-3">
                  {row.count} · <span className="font-semibold text-ink-1">{fmt(row.amount)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div className="panel-header-left">
              <div className="panel-icon">🪙</div>
              <div>
                <p className="panel-title">Tips this month</p>
                <p className="panel-subtitle">{monthLabel(tipsMonth.month)}</p>
              </div>
            </div>
          </div>
          <div className="p-4">
            <p className="text-[32px] font-bold leading-tight">{fmt(tipsMonth.total)}</p>
            <p className="text-tiny text-ink-3 mb-3">running total</p>

            <div className="h-2 rounded-full bg-line overflow-hidden flex mb-4">
              {tipsMonth.total > 0 && (
                <>
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${(tipsMonth.periods[2]!.total / tipsMonth.total) * 100}%` }}
                  />
                  <div
                    className="h-full bg-warn"
                    style={{ width: `${(tipsMonth.periods[3]!.total / tipsMonth.total) * 100}%` }}
                  />
                </>
              )}
            </div>

            <p className="text-tiny text-ink-3 font-semibold uppercase tracking-wide mb-1.5">Last month</p>
            <div className="grid grid-cols-2 gap-3 mb-3">
              {tipsMonth.periods.slice(0, 2).map((p, i) => (
                <div key={p.range.from} className="pick-card bg-sunken p-3">
                  <p className="text-tiny text-ink-3 inline-flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${i === 0 ? 'bg-accent' : 'bg-warn'}`} />
                    {halfMonthLabel(p.range)}
                  </p>
                  <p className="font-semibold text-body mt-1">{fmt(p.total)}</p>
                </div>
              ))}
            </div>

            <p className="text-tiny text-ink-3 font-semibold uppercase tracking-wide mb-1.5">This month</p>
            <div className="grid grid-cols-2 gap-3">
              {tipsMonth.periods.slice(2, 4).map((p, i) => (
                <div key={p.range.from} className="pick-card bg-sunken p-3">
                  <p className="text-tiny text-ink-3 inline-flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${i === 0 ? 'bg-accent' : 'bg-warn'}`} />
                    {halfMonthLabel(p.range)}
                  </p>
                  <p className="font-semibold text-body mt-1">{fmt(p.total)}</p>
                </div>
              ))}
            </div>
            {tipsMonth.total === 0 && (
              <p className="text-tiny text-ink-3 mt-3 flex items-start gap-1.5">
                <span aria-hidden>ℹ</span>
                <span>
                  No tips recorded this month yet — this fills in automatically from the Payment Report&apos;s Tips
                  column once a session is submitted.
                </span>
              </p>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div className="panel-header-left">
              <div className="panel-icon">🤝</div>
              <div>
                <p className="panel-title">Open advances</p>
                <p className="panel-subtitle">
                  {openAdvances.count} open · {fmt(openAdvances.totalBalance)} balance
                </p>
              </div>
            </div>
            <a className="btn btn-sm" href="/advances">
              View all →
            </a>
          </div>
          <div className="flex flex-col gap-1 p-4">
            {openAdvances.items.length === 0 ? (
              <p className="text-tiny text-ink-3">No open advances.</p>
            ) : (
              openAdvances.items.map((item) => (
                <div key={item.id} className="flex items-center justify-between px-1 py-1.5">
                  <span className="text-body">
                    {item.custName} <span className="text-tiny text-ink-3">· {fmtEventDate(item.eventDate)}</span>
                  </span>
                  <span className="font-semibold">{fmt(item.balance)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <SubmissionCalendar outlet={dashboard.submissions} />
      </div>

      {selectedBucket && (
        <ModalShell
          title={`Bills on hold — ${BOH_BUCKET_LABEL[selectedBucket.bucket]} (${selectedBucket.count})`}
          onClose={() => setSelectedBucket(null)}
          footer={
            <button type="button" className="btn bg-red-500 text-white" onClick={() => setSelectedBucket(null)}>
              Close
            </button>
          }
        >
          <div className="flex flex-col gap-3">
            {selectedBucket.entries.map((e) => (
              <div key={e.id} className="pick-card p-4">
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
