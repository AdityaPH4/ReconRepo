'use client';

/**
 * The `/advances` standalone page — Advance Closure.
 *
 * Unlike `AdvancesPanel.tsx` (read-only, lives only inside a specific
 * session's workspace), this is a genuine top-level module: a GM can close
 * an advance that will never be applied (e.g. a corporate-booking advance
 * returned directly to the POC once full payment settled on the company
 * card instead) without having to open any session first. Outlet-scoped —
 * gated on `outlet !== null`, i.e. GMs (admins see every outlet and aren't
 * the intended user here, matching the plan's GM-owned framing).
 */

import { useEffect, useState } from 'react';
import type { AdvanceWithBalanceDTO } from '@toit/contracts';
import { fmt, fmtEventDate } from '@toit/recon-core/display';
import { useCurrentUser } from '@/components/auth/AuthProvider';
import { ApiError, closeAdvance, listAdvances } from '@/lib/api';

export function AdvancesManagementPage() {
  const user = useCurrentUser();
  const [rows, setRows] = useState<AdvanceWithBalanceDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (user.outlet === null) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    try {
      setRows(await listAdvances());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load advances.');
    }
  }

  async function close(row: AdvanceWithBalanceDTO) {
    const reason = window.prompt(
      `Close the ${fmt(row.balance)} advance from "${row.advance.custName}"? This marks it as returned to the POC outside of recon.\n\nReason (required):`,
      '',
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) {
      setError('A reason is required to close an advance.');
      return;
    }
    setBusyId(row.advance.id);
    setError(null);
    try {
      await closeAdvance(row.advance.id, reason.trim());
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to close advance.');
    } finally {
      setBusyId(null);
    }
  }

  if (user.outlet === null) {
    return (
      <main className="app-main">
        <div className="alert alert-err">
          <span>✕</span>
          <span>This module is for GMs — sign in with an outlet-scoped account.</span>
        </div>
      </main>
    );
  }

  const open = (rows ?? []).filter((r) => r.advance.status !== 'closed');
  const closed = (rows ?? [])
    .filter((r) => r.advance.status === 'closed')
    .sort((a, b) => (b.advance.closedAt ?? '').localeCompare(a.advance.closedAt ?? ''));

  return (
    <main className="app-main">
      <div className="results-header mt-6">
        <div>
          <h1 className="results-title">Advance Closure</h1>
          <div className="results-meta">
            <span className="pill">Close advances that will never be applied — e.g. returned to the POC outside of recon</span>
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
        <h3 className="panel-section-title">Open ({open.length})</h3>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Event date</th>
                <th>Notes</th>
                <th className="num">Balance</th>
                <th>Recorded</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!rows ? (
                <tr>
                  <td colSpan={6} className="text-center text-ink-3">
                    Loading…
                  </td>
                </tr>
              ) : open.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center text-ink-3">
                    No open advances.
                  </td>
                </tr>
              ) : (
                open.map((r) => (
                  <tr key={r.advance.id}>
                    <td>
                      {r.advance.custName}
                      {r.advance.phone && <span className="text-ink-3 text-tiny"> · {r.advance.phone}</span>}
                    </td>
                    <td className="mono">{fmtEventDate(r.advance.eventDate)}</td>
                    <td className="text-tiny text-ink-3">{r.advance.notes || '—'}</td>
                    <td className="num font-semibold">{fmt(r.balance)}</td>
                    <td className="mono">{r.advance.recordedDate}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busyId === r.advance.id}
                        onClick={() => close(r)}
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {closed.length > 0 && (
        <div className="panel mt-4">
          <h3 className="panel-section-title">Closed history ({closed.length})</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Event date</th>
                  <th className="num">Original amount</th>
                  <th className="num">Balance at closure</th>
                  <th>Closed by</th>
                  <th>Closed at</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((r) => (
                  <tr key={r.advance.id}>
                    <td>{r.advance.custName}</td>
                    <td className="mono">{fmtEventDate(r.advance.eventDate)}</td>
                    <td className="num">{fmt(r.advance.originalAmount)}</td>
                    <td className="num">{fmt(r.balance)}</td>
                    <td className="text-tiny text-ink-3">{r.advance.closedBy || '—'}</td>
                    <td className="text-tiny text-ink-3">
                      {r.advance.closedAt ? new Date(r.advance.closedAt).toLocaleString('en-IN') : '—'}
                    </td>
                    <td className="text-tiny text-ink-3">{r.advance.closedReason || '—'}</td>
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
