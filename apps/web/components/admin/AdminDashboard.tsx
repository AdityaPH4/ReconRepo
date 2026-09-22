'use client';

/**
 * Admin's landing page — submission timeliness across outlets, a comment
 * feed for review, and the approval-requests queue. Replaces the old bare
 * approvals-only `/admin` page.
 */

import type { AdminDashboardDTO } from '@toit/contracts';
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

export function AdminDashboard() {
  const user = useCurrentUser();
  const [dashboard, setDashboard] = useState<AdminDashboardDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <main className="app-main">
      <div className="results-header mt-6">
        <div>
          <h1 className="results-title">Admin dashboard</h1>
          <div className="results-meta">
            <span className="pill">Review submission timeliness and comments across outlets</span>
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
          <section className="mt-6">
            <h2 className="text-lede font-semibold mb-3">Submissions — {monthLabel(dashboard.month)}</h2>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              {dashboard.submissions.map((s) => (
                <SubmissionCalendar key={s.outlet} outlet={s} />
              ))}
            </div>
          </section>

          <section className="mt-6">
            <h2 className="text-lede font-semibold mb-3">Recent comments</h2>
            <div className="panel">
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Outlet</th>
                      <th>Business date</th>
                      <th>Remark</th>
                      <th className="num">Amount</th>
                      <th>Comment</th>
                      <th>By</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.recentComments.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="text-center text-ink-3">
                          No comments recorded yet.
                        </td>
                      </tr>
                    ) : (
                      dashboard.recentComments.map((c) => (
                        <tr key={c.id}>
                          <td>{c.outlet}</td>
                          <td className="mono">{c.businessDate ?? '—'}</td>
                          <td>{c.remark}</td>
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
