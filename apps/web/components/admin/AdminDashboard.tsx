'use client';

/**
 * Admin's landing page — cross-outlet Bills-on-hold and Open-advances
 * exposure, submission timeliness, a Justifications stat summary, and the
 * approval-requests queue. Replaces the old bare approvals-only `/admin`
 * page.
 */

import type { AdminDashboardDTO, AdminOutletBohSummaryDTO, BohAgingBucket } from '@toit/contracts';
import { fmt, fmtDate } from '@toit/recon-core/display';
import { useEffect, useState } from 'react';
import { useCurrentUser } from '@/components/auth/AuthProvider';
import { ModalShell } from '@/components/justification/ModalShell';
import { SubmissionCalendar } from '@/components/SubmissionCalendar';
import { ApiError, getAdminDashboard } from '@/lib/api';
import { AdminApprovalQueue } from './AdminApprovalQueue';

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const BOH_BUCKET_LABEL: Record<BohAgingBucket, string> = {
  '1': '1 day',
  '2': '2 days',
  '3': '3 days',
  '4': '4 days',
  '5': '5 days',
  '5+': '5+ days',
};

/** Same green/amber/red urgency logic as the GM dashboard's own BOH card. */
const BOH_BUCKET_TAG: Record<BohAgingBucket, string> = {
  '1': 'tag-ok',
  '2': 'tag-ok',
  '3': 'tag-warn',
  '4': 'tag-warn',
  '5': 'tag-warn',
  '5+': 'tag-err',
};

/** Stat-card icons — only the remarks actually shown here (see `HIDDEN_REMARKS` below for why the other 3 are excluded). */
const REMARK_ICON: Record<string, string> = {
  Tips: '🪙',
  'Extra Payment Received': '➕',
  'Short Collection': '⚠️',
  'Paid In': '⬇️',
  'Paid Out': '⬆️',
  'TDS Deducted': '🧾',
  Other: '📝',
};

/** These three remarks' detail already lives elsewhere the admin would actually look (the Advance Closure module, the BOH card's own click-through) — kept out of this panel per explicit request. */
const HIDDEN_REMARKS = new Set(['Advance Received', 'Advance Applied', 'Bill on Hold Cleared']);

export function AdminDashboard() {
  const user = useCurrentUser();
  const [dashboard, setDashboard] = useState<AdminDashboardDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedBohOutlet, setSelectedBohOutlet] = useState<AdminOutletBohSummaryDTO | null>(null);

  useEffect(() => {
    if (user.role !== 'admin') return;
    getAdminDashboard()
      .then(setDashboard)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load admin dashboard.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (user.role !== 'admin') {
    return (
      <main className="app-main">
        <div className="alert alert-err">
          <span>✕</span>
          <span>Admins only.</span>
        </div>
      </main>
    );
  }

  const justificationChips = dashboard?.justificationCounts.filter((jc) => !HIDDEN_REMARKS.has(jc.remark)) ?? [];

  return (
    <main className="app-main">
      <div className="results-header mt-6">
        <div>
          <h1 className="results-title">Admin dashboard</h1>
          <div className="results-meta">
            <span className="pill">Review submission timeliness and justifications across outlets</span>
          </div>
        </div>
        <a className="btn" href="/">
          🏠 All modules
        </a>
      </div>

      {error && (
        <div className="alert alert-err mt-4">
          <span>✕</span>
          <span>{error}</span>
        </div>
      )}

      {!dashboard ? (
        <p className="text-body text-ink-3 mt-4">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-6">
            <div className="panel">
              <div className="panel-header">
                <div className="panel-header-left">
                  <div className="panel-icon">📦</div>
                  <div>
                    <p className="panel-title">Bills on hold</p>
                    <p className="panel-subtitle">
                      {dashboard.boh.count} open · {fmt(dashboard.boh.amount)} across all outlets
                    </p>
                  </div>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="text-left!">Outlet</th>
                      <th className="num">Open</th>
                      <th className="num">Amount</th>
                      <th className="text-left!">Oldest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.boh.byOutlet.map((o) => (
                      <tr
                        key={o.outlet}
                        className={o.count > 0 ? 'cursor-pointer' : undefined}
                        onClick={() => o.count > 0 && setSelectedBohOutlet(o)}
                      >
                        <td className="text-left!">{o.outletName}</td>
                        <td className="num">{o.count}</td>
                        <td className="num">{fmt(o.amount)}</td>
                        <td className="text-left!">
                          {o.worstBucket ? (
                            <span className={`tag ${BOH_BUCKET_TAG[o.worstBucket]}`}>{BOH_BUCKET_LABEL[o.worstBucket]}</span>
                          ) : (
                            <span className="text-tiny text-ink-3">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <div className="panel-header-left">
                  <div className="panel-icon">🤝</div>
                  <div>
                    <p className="panel-title">Open advances</p>
                    <p className="panel-subtitle">
                      {dashboard.advances.count} open · {fmt(dashboard.advances.balance)} balance
                    </p>
                  </div>
                </div>
                <a className="btn btn-sm" href="/advances">
                  View all →
                </a>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="text-left!">Outlet</th>
                      <th className="num">Open</th>
                      <th className="num">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.advances.byOutlet.map((o) => (
                      <tr key={o.outlet}>
                        <td className="text-left!">{o.outletName}</td>
                        <td className="num">{o.count}</td>
                        <td className="num">{fmt(o.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <section className="mt-6">
            <h2 className="text-lede font-semibold mb-3">Submissions — {monthLabel(dashboard.month)}</h2>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              {dashboard.submissions.map((s) => (
                <SubmissionCalendar key={s.outlet} outlet={s} />
              ))}
            </div>
          </section>

          <section className="mt-6">
            <h2 className="text-lede font-semibold mb-3">Justifications</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {justificationChips.map((jc) => (
                <div key={jc.remark} className={`pick-card p-3 ${jc.count === 0 ? 'opacity-50' : 'bg-sunken'}`}>
                  <div className="flex items-center gap-1.5 text-tiny text-ink-3">
                    <span aria-hidden>{REMARK_ICON[jc.remark] ?? '•'}</span>
                    <span className="truncate">{jc.remark}</span>
                  </div>
                  <div className="font-semibold mt-1">{jc.count}</div>
                  <div className="text-tiny text-ink-3">{fmt(jc.amount)}</div>
                </div>
              ))}
            </div>
          </section>

          <AdminApprovalQueue />
        </>
      )}

      {selectedBohOutlet && (
        <ModalShell
          title={`Bills on hold — ${selectedBohOutlet.outletName} (${selectedBohOutlet.count})`}
          onClose={() => setSelectedBohOutlet(null)}
          footer={
            <button type="button" className="btn" onClick={() => setSelectedBohOutlet(null)}>
              Close
            </button>
          }
        >
          <div className="flex flex-col gap-3">
            {selectedBohOutlet.entries.map((e) => (
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
    </main>
  );
}
