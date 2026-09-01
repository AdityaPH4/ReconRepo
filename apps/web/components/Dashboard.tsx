'use client';

/**
 * The GM's dashboard, shown before/after running recon — today's status, a
 * rolling Tips breakdown, and a Bills-on-Hold aging table.
 */

import type { DashboardDTO } from '@toit/contracts';
import { fmt } from '@toit/recon-core/display';
import { useEffect, useState } from 'react';
import { useCurrentUser } from '@/components/auth/AuthProvider';
import { ApiError, getDashboard } from '@/lib/api';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft — not yet submitted',
  submitted: 'Submitted',
};

export function Dashboard() {
  const user = useCurrentUser();
  const [dashboard, setDashboard] = useState<DashboardDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          <h3 className="panel-section-title">Tips</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tips</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.tips.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td className="num">{fmt(row.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2} />
                </tr>
                <tr className="total-row">
                  <td>Week X</td>
                  <td className="num">{fmt(dashboard.tipsWeekCurrent)}</td>
                </tr>
                <tr className="total-row">
                  <td>Week X-1</td>
                  <td className="num">{fmt(dashboard.tipsWeekPrevious)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <h3 className="panel-section-title">BOH table</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Aging</th>
                  <th className="num">Number</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.bohAging.map((row) => (
                  <tr key={row.bucket}>
                    <td>{row.bucket}</td>
                    <td className="num">{row.count}</td>
                    <td className="num">{fmt(row.amount)}</td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td>Total</td>
                  <td className="num">{dashboard.bohTotal.count}</td>
                  <td className="num">{fmt(dashboard.bohTotal.amount)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
