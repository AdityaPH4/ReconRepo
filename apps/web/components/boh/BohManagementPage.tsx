'use client';

/**
 * The `/boh` standalone page — Bills on Hold management.
 *
 * Mirrors `AdvancesManagementPage.tsx`: GMs see only their own outlet
 * (implicit from their token); admins get every outlet at once, with a
 * selector to narrow to one. Unlike Advance Closure, there is no "close"
 * action here — a bill is only ever cleared from within a recon session's
 * Bills on Hold tab. This page's own addition is Reopen (admin-only,
 * undoing a mistaken clearance within `REOPEN_WINDOW_DAYS`) — there is no
 * "reopen against multiple payments" concept to carry over from the
 * multi-advance-apply feature; a bill is cleared, or reopened, as one
 * whole row.
 */

import { useEffect, useState } from 'react';
import type { BohEntryDTO } from '@toit/contracts';
import { OUTLET_CODES, OUTLET_NAMES, type OutletCode, fmt, fmtDate } from '@toit/recon-core/display';
import { useCurrentUser } from '@/components/auth/AuthProvider';
import { ApiError, listBoh, reopenBoh } from '@/lib/api';

/** Mirrors the server's own window — see repositories.ts's `REOPEN_WINDOW_DAYS`. Purely a UX nicety (hide a button that would just fail); the server enforces this independently regardless of what the client shows. */
const REOPEN_WINDOW_DAYS = 7;

function daysSince(iso: string): number {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
}

export function BohManagementPage() {
  const user = useCurrentUser();
  const isAdmin = user.role === 'admin';
  const [outletFilter, setOutletFilter] = useState<OutletCode | ''>('');
  const [rows, setRows] = useState<BohEntryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin && user.outlet === null) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outletFilter]);

  async function refresh() {
    try {
      setRows(await listBoh(outletFilter || undefined));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load bills on hold.');
    }
  }

  async function reopen(row: BohEntryDTO) {
    if (!window.confirm(`Reopen the bill on hold for "${row.custName}" (Order ${row.orderNo})? It will go back to the Open list.`)) return;
    setBusyId(row.id);
    setError(null);
    try {
      await reopenBoh(row.id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reopen bill.');
    } finally {
      setBusyId(null);
    }
  }

  if (!isAdmin && user.outlet === null) {
    return (
      <main className="app-main">
        <div className="alert alert-err">
          <span>✕</span>
          <span>This module is for GMs — sign in with an outlet-scoped account.</span>
        </div>
      </main>
    );
  }

  const open = (rows ?? []).filter((r) => r.status === 'open');
  const cleared = (rows ?? [])
    .filter((r) => r.status === 'cleared')
    .sort((a, b) => (b.clearedAt ?? '').localeCompare(a.clearedAt ?? ''));

  return (
    <main className="app-main">
      <div className="results-header mt-6">
        <div>
          <h1 className="results-title">Bills on Hold</h1>
          <div className="results-meta">
            <span className="pill">Every outstanding and cleared bill-on-hold entry</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isAdmin && (
            <select
              className="field-input"
              value={outletFilter}
              onChange={(e) => setOutletFilter(e.target.value as OutletCode | '')}
            >
              <option value="">All outlets</option>
              {OUTLET_CODES.map((code) => (
                <option key={code} value={code}>
                  {OUTLET_NAMES[code]}
                </option>
              ))}
            </select>
          )}
          <a className="btn" href="/">
            🏠 All modules
          </a>
        </div>
      </div>

      {error && (
        <div className="alert alert-err mt-4">
          <span>✕</span>
          <span>{error}</span>
        </div>
      )}

      <div className="panel mt-4">
        <h3 className="panel-section-title">Open ({open.length})</h3>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {isAdmin && <th>Outlet</th>}
                <th>Order No</th>
                <th>Customer</th>
                <th>Notes</th>
                <th className="num">Amount</th>
                <th>On hold since</th>
              </tr>
            </thead>
            <tbody>
              {!rows ? (
                <tr>
                  <td colSpan={isAdmin ? 6 : 5} className="text-center text-ink-3">
                    Loading…
                  </td>
                </tr>
              ) : open.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 6 : 5} className="text-center text-ink-3">
                    No open bills on hold.
                  </td>
                </tr>
              ) : (
                open.map((r) => (
                  <tr key={r.id}>
                    {isAdmin && <td>{r.outlet}</td>}
                    <td className="mono">{r.orderNo}</td>
                    <td>
                      {r.custName}
                      {r.phone && <span className="text-ink-3 text-tiny"> · {r.phone}</span>}
                    </td>
                    <td className="text-tiny text-ink-3">{r.notes || '—'}</td>
                    <td className="num font-semibold">{fmt(r.amount)}</td>
                    <td className="mono">{fmtDate(r.bohDate)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {cleared.length > 0 && (
        <div className="panel mt-4">
          <h3 className="panel-section-title">Cleared history ({cleared.length})</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {isAdmin && <th>Outlet</th>}
                  <th>Order No</th>
                  <th>Customer</th>
                  <th className="num">Amount</th>
                  <th>Cleared at</th>
                  {isAdmin && <th />}
                </tr>
              </thead>
              <tbody>
                {cleared.map((r) => {
                  const ageDays = r.clearedAt ? daysSince(r.clearedAt) : null;
                  const reopenable = isAdmin && ageDays !== null && ageDays <= REOPEN_WINDOW_DAYS;
                  return (
                    <tr key={r.id}>
                      {isAdmin && <td>{r.outlet}</td>}
                      <td className="mono">{r.orderNo}</td>
                      <td>{r.custName}</td>
                      <td className="num">{fmt(r.amount)}</td>
                      <td className="text-tiny text-ink-3">{r.clearedAt ? new Date(r.clearedAt).toLocaleString('en-IN') : '—'}</td>
                      {isAdmin && (
                        <td>
                          {reopenable && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busyId === r.id}
                              onClick={() => reopen(r)}
                            >
                              Reopen
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
