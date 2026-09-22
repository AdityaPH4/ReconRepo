'use client';

/**
 * Admin's landing page — cross-outlet Bills-on-hold and Open-advances
 * exposure, submission timeliness, a Justifications review feed, and the
 * approval-requests queue. Replaces the old bare approvals-only `/admin`
 * page.
 */

import type { AdminDashboardDTO, BohAgingBucket } from '@toit/contracts';
import { fmt } from '@toit/recon-core/display';
import { useEffect, useState } from 'react';
import { useCurrentUser } from '@/components/auth/AuthProvider';
import { diffClass } from '@/components/ui/table';
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
  '0-7': '0-7 days',
  '8-15': '8-15 days',
  '16-30': '16-30 days',
  '30+': '30+ days',
};

/** Same green/amber/red urgency logic as the GM dashboard's own BOH card. */
const BOH_BUCKET_TAG: Record<BohAgingBucket, string> = {
  '0-7': 'tag-ok',
  '8-15': 'tag-warn',
  '16-30': 'tag-warn',
  '30+': 'tag-err',
};

/** One icon + tag color per remark — 10 remarks across 7 available tag colors, so a few intentionally share a hue (same as `tag-excess`/`tag-ok` already do elsewhere). */
const REMARK_ICON: Record<string, string> = {
  Tips: '🪙',
  'Advance Received': '💵',
  'Advance Applied': '🔄',
  'Bill on Hold Cleared': '📦',
  'Extra Payment Received': '➕',
  'Short Collection': '⚠️',
  'Paid In': '⬇️',
  'Paid Out': '⬆️',
  'TDS Deducted': '🧾',
  Other: '📝',
};

const REMARK_TAG: Record<string, string> = {
  Tips: 'tag-ok',
  'Extra Payment Received': 'tag-ok',
  'Paid In': 'tag-ok',
  'Advance Received': 'tag-accent',
  'Bill on Hold Cleared': 'tag-accent',
  'Advance Applied': 'tag-warn',
  'Paid Out': 'tag-warn',
  'Short Collection': 'tag-err',
  'TDS Deducted': 'tag-pur',
  Other: 'tag-neutral',
};

export function AdminDashboard() {
  const user = useCurrentUser();
  const [dashboard, setDashboard] = useState<AdminDashboardDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterRemark, setFilterRemark] = useState<string | null>(null);

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

  const comments = dashboard?.recentComments ?? [];
  const filteredComments = filterRemark ? comments.filter((c) => c.remark === filterRemark) : comments;

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
                      <tr key={o.outlet}>
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
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lede font-semibold">Justifications</h2>
              {filterRemark && (
                <button type="button" className="btn btn-sm" onClick={() => setFilterRemark(null)}>
                  ✕ Clear filter: {filterRemark}
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-4">
              {dashboard.justificationCounts.map((jc) => (
                <button
                  key={jc.remark}
                  type="button"
                  onClick={() => setFilterRemark(filterRemark === jc.remark ? null : jc.remark)}
                  className={`pick-card text-left p-3 ${
                    filterRemark === jc.remark ? 'pick-card-selected' : jc.count === 0 ? 'opacity-50' : 'bg-sunken'
                  }`}
                >
                  <div className="flex items-center gap-1.5 text-tiny text-ink-3">
                    <span aria-hidden>{REMARK_ICON[jc.remark] ?? '•'}</span>
                    <span className="truncate">{jc.remark}</span>
                  </div>
                  <div className="font-semibold mt-1">{jc.count}</div>
                  <div className="text-tiny text-ink-3">{fmt(jc.amount)}</div>
                </button>
              ))}
            </div>

            <div className="panel">
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Outlet</th>
                      <th>Business date</th>
                      <th>Remark</th>
                      <th className="num">Amount</th>
                      <th>Detail</th>
                      <th>By</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredComments.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="text-center text-ink-3">
                          {filterRemark ? `No ${filterRemark} entries recorded yet.` : 'No justifications recorded yet.'}
                        </td>
                      </tr>
                    ) : (
                      filteredComments.map((c) => (
                        <tr key={c.id}>
                          <td>{c.outlet}</td>
                          <td className="mono">{c.businessDate ?? '—'}</td>
                          <td>
                            <span className={`tag ${REMARK_TAG[c.remark] ?? 'tag-neutral'}`}>
                              {REMARK_ICON[c.remark] ?? ''} {c.remark}
                            </span>
                          </td>
                          <td className={`num ${diffClass(c.direction === 'excess' ? c.amount : -c.amount)}`}>
                            {c.direction === 'excess' ? '▲' : '▼'} {fmt(Math.abs(c.amount))}
                          </td>
                          <td className="text-tiny">{c.text}</td>
                          <td className="text-tiny text-ink-3">{c.createdBy}</td>
                          <td className="text-tiny text-ink-3">{new Date(c.createdAt).toLocaleString('en-IN')}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <AdminApprovalQueue />
        </>
      )}
    </main>
  );
}
