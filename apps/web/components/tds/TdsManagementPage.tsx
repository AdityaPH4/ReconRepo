'use client';

/**
 * The `/tds` standalone page — unlike Advances/BOH, which only ever exist as
 * tabs inside a specific session's `SessionWorkspace`, TDS verification is a
 * months-later, cross-outlet, session-independent Accounts task, so it gets
 * a genuine top-level page instead. Admin-only; redirects anyone else back
 * to the module hub, same pattern as `AdminApprovalQueue`.
 */

import { useEffect, useState } from 'react';
import type { TdsEntryDTO } from '@toit/contracts';
import { fmt } from '@toit/recon-core/display';
import { useCurrentUser } from '@/components/auth/AuthProvider';
import { ApiError, closeTds, listTds, reopenTds } from '@/lib/api';

function ageDays(recordedDate: string): number {
  const then = new Date(`${recordedDate}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

export function TdsManagementPage() {
  const user = useCurrentUser();
  const [entries, setEntries] = useState<TdsEntryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (user.role !== 'admin') return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    try {
      setEntries(await listTds());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load TDS entries.');
    }
  }

  async function markVerified(entry: TdsEntryDTO) {
    const note = window.prompt(
      `Mark the ${fmt(entry.amount)} TDS deduction from "${entry.clientName}" as verified in Form 26AS?\n\nOptional note:`,
      '',
    );
    if (note === null) return; // cancelled
    setBusyId(entry.id);
    try {
      await closeTds(entry.id, note.trim() || null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to close TDS entry.');
    } finally {
      setBusyId(null);
    }
  }

  async function reopen(entry: TdsEntryDTO) {
    if (!window.confirm(`Reopen the ${fmt(entry.amount)} TDS deduction from "${entry.clientName}"? It will show as unreconciled again.`)) {
      return;
    }
    setBusyId(entry.id);
    try {
      await reopenTds(entry.id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reopen TDS entry.');
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

  const open = (entries ?? [])
    .filter((e) => e.status === 'open')
    .sort((a, b) => a.recordedDate.localeCompare(b.recordedDate));
  const closed = (entries ?? [])
    .filter((e) => e.status === 'closed')
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));

  return (
    <main className="app-main">
      <div className="results-header mt-6">
        <div>
          <h1 className="results-title">Unreconciled TDS</h1>
          <div className="results-meta">
            <span className="pill">TDS deducted by clients on Bank transfer — pending verification in Form 26AS</span>
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
                <th>Outlet</th>
                <th>Client</th>
                <th className="num">Amount</th>
                <th>Notes</th>
                <th>Recorded</th>
                <th>Age</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!entries ? (
                <tr>
                  <td colSpan={7} className="text-center text-ink-3">
                    Loading…
                  </td>
                </tr>
              ) : open.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center text-ink-3">
                    No open TDS entries.
                  </td>
                </tr>
              ) : (
                open.map((e) => (
                  <tr key={e.id}>
                    <td>{e.outlet}</td>
                    <td>{e.clientName}</td>
                    <td className="num">{fmt(e.amount)}</td>
                    <td className="text-tiny text-ink-3">{e.notes || '—'}</td>
                    <td className="mono">{e.recordedDate}</td>
                    <td>{ageDays(e.recordedDate)}d</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm btn-ok"
                        disabled={busyId === e.id}
                        onClick={() => markVerified(e)}
                      >
                        Mark verified in 26AS
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
                  <th>Outlet</th>
                  <th>Client</th>
                  <th className="num">Amount</th>
                  <th>Closed by</th>
                  <th>Closed at</th>
                  <th>Note</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {closed.map((e) => (
                  <tr key={e.id}>
                    <td>{e.outlet}</td>
                    <td>{e.clientName}</td>
                    <td className="num">{fmt(e.amount)}</td>
                    <td className="text-tiny text-ink-3">{e.closedBy || '—'}</td>
                    <td className="text-tiny text-ink-3">
                      {e.closedAt ? new Date(e.closedAt).toLocaleString('en-IN') : '—'}
                    </td>
                    <td className="text-tiny text-ink-3">{e.closedNote || '—'}</td>
                    <td>
                      <button type="button" className="btn btn-sm" disabled={busyId === e.id} onClick={() => reopen(e)}>
                        Reopen
                      </button>
                    </td>
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
