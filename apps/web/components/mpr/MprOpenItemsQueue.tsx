'use client';

/**
 * Cross-session queue of every still-open MPR item — admin-only. Mirrors
 * `AdminApprovalQueue.tsx`'s shape; resolving inline reuses the same
 * `ResolveRow` affordance as `MprWorkspace.tsx`'s per-run tabs, so an admin
 * can clear an item without leaving this page.
 */

import type { MprOpenRowDTO } from '@toit/contracts';
import { useEffect, useState } from 'react';
import { useCurrentUser } from '@/components/auth/AuthProvider';
import { ResolveRow } from '@/components/mpr/MprWorkspace';
import { ApiError, listOpenMprRows } from '@/lib/mprApi';

const BUCKET_LABELS: Record<MprOpenRowDTO['bucket'], string> = {
  amountMismatch: 'Amount mismatch',
  pending: 'Pending settlement',
  ambiguous: 'Ambiguous',
  unexpected: 'Unexpected MPR credit',
  amexResults: 'AMEX',
  upiResults: 'HDFC Static UPI',
};

function rowRrn(item: MprOpenRowDTO): string {
  const row = item.row as { rrn?: string; mpr?: { rrn?: string }; mid?: string };
  return row.rrn || row.mpr?.rrn || row.mid || '—';
}

function rowAmount(item: MprOpenRowDTO): number | null {
  const row = item.row as { plAmount?: number; mprAmount?: number; l1Total?: number };
  return row.plAmount ?? row.mprAmount ?? row.l1Total ?? null;
}

export function MprOpenItemsQueue() {
  const user = useCurrentUser();
  const [items, setItems] = useState<MprOpenRowDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user.role !== 'admin') return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    try {
      setItems(await listOpenMprRows());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load open MPR items.');
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

  return (
    <main className="app-main">
      <div className="results-header mt-6">
        <div>
          <h1 className="results-title">Open MPR items</h1>
          <div className="results-meta">
            <span className="pill">Every mismatch, pending, ambiguous or unexpected row still awaiting resolution</span>
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
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Run date</th>
                <th>Bucket</th>
                <th>RRN</th>
                <th className="num">Amount</th>
                <th />
                <th />
              </tr>
            </thead>
            <tbody>
              {!items ? (
                <tr>
                  <td colSpan={6} className="text-center text-ink-3">
                    Loading…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center text-ink-3">
                    Nothing open — every MPR run is fully reconciled.
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.row.id}>
                    <td className="mono">{new Date(item.sessionCreatedAt).toLocaleString('en-IN')}</td>
                    <td>{BUCKET_LABELS[item.bucket]}</td>
                    <td className="mono">{rowRrn(item)}</td>
                    <td className="num">
                      {rowAmount(item) != null ? `₹${rowAmount(item)!.toLocaleString('en-IN')}` : '—'}
                    </td>
                    <td>
                      <a className="btn btn-sm" href={`/mpr/${item.sessionId}`}>
                        View run
                      </a>
                    </td>
                    <td>
                      <ResolveRow sessionId={item.sessionId} row={item.row} onResolved={() => refresh()} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
