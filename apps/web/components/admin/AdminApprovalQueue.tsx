'use client';

/**
 * The approval queue — every pending "please let me re-reconcile this
 * outlet/date" request, with one-click approve/deny. Admin-only; redirects
 * anyone else back to the module hub.
 */

import type { ApprovalRequestDTO } from '@toit/contracts';
import { useEffect, useState } from 'react';
import { useCurrentUser } from '@/components/auth/AuthProvider';
import { ApiError, approveRequest, denyRequest, listApprovalRequests } from '@/lib/api';

export function AdminApprovalQueue() {
  const user = useCurrentUser();
  const [requests, setRequests] = useState<ApprovalRequestDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (user.role !== 'admin') return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    try {
      const all = await listApprovalRequests();
      setRequests(all);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load approval requests.');
    }
  }

  async function decide(id: string, action: 'approve' | 'deny') {
    setBusyId(id);
    try {
      await (action === 'approve' ? approveRequest(id) : denyRequest(id));
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record decision.');
    } finally {
      setBusyId(null);
    }
  }

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

  const pending = requests?.filter((r) => r.status === 'pending') ?? [];
  const decided = requests?.filter((r) => r.status !== 'pending') ?? [];

  return (
    <main className="app-main">
      <div className="results-header mt-6">
        <div>
          <h1 className="results-title">Approval requests</h1>
          <div className="results-meta">
            <span className="pill">Re-reconciliation requests from GMs</span>
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

      <div className="panel mt-4">
        <h3 className="panel-section-title">Pending ({pending.length})</h3>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Outlet</th>
                <th>Business date</th>
                <th>Requested by</th>
                <th>Requested at</th>
                <th>Reason</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!requests ? (
                <tr>
                  <td colSpan={6} className="text-center text-ink-3">
                    Loading…
                  </td>
                </tr>
              ) : pending.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center text-ink-3">
                    No pending requests.
                  </td>
                </tr>
              ) : (
                pending.map((r) => (
                  <tr key={r.id}>
                    <td>{r.outlet}</td>
                    <td className="mono">{r.businessDate}</td>
                    <td>{r.requestedBy}</td>
                    <td className="text-tiny text-ink-3">{new Date(r.requestedAt).toLocaleString('en-IN')}</td>
                    <td className="text-tiny text-ink-3">{r.reason || '—'}</td>
                    <td>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="btn btn-sm btn-ok"
                          disabled={busyId === r.id}
                          onClick={() => decide(r.id, 'approve')}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busyId === r.id}
                          onClick={() => decide(r.id, 'deny')}
                        >
                          Deny
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {decided.length > 0 && (
        <div className="panel mt-4">
          <h3 className="panel-section-title">Decided ({decided.length})</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Outlet</th>
                  <th>Business date</th>
                  <th>Requested by</th>
                  <th>Status</th>
                  <th>Decided by</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((r) => (
                  <tr key={r.id}>
                    <td>{r.outlet}</td>
                    <td className="mono">{r.businessDate}</td>
                    <td>{r.requestedBy}</td>
                    <td>
                      <span className={`tag ${r.status === 'approved' ? 'tag-ok' : 'tag-err'}`}>{r.status}</span>
                    </td>
                    <td className="text-tiny text-ink-3">{r.decidedBy || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
