'use client';

/**
 * Past reconciliation sessions — mirrors `MprApp.tsx`'s "Past runs" table
 * exactly (same shown-alongside-the-upload-form placement, same
 * fetch-once-on-mount, same row-click navigation). `listSessions()` already
 * existed with zero callers anywhere in the frontend; `outletScope()` on the
 * API side already scopes this to the caller's own outlet for a GM, or every
 * outlet for an admin — so this one component serves both roles as-is.
 *
 * A GM only gets the last 7 days here — the API itself caps the list (and
 * 403s the report route directly), this just reflects that back so the
 * "why is my old session gone" question answers itself. An admin instead
 * gets a by-date lookup to reach further back, since the default list is
 * unrestricted for them but can still run past whatever's on screen.
 */

import { useEffect, useState } from 'react';
import type { SessionListItemDTO } from '@toit/contracts';
import { todayIsoIST } from '@toit/recon-core';
import { fmt } from '@toit/recon-core/display';
import { useCurrentUser } from '@/components/auth/AuthProvider';
import { diffClass } from '@/components/ui/table';
import { listSessions, reportUrl } from '@/lib/api';

/**
 * How far back a submitted row still opens the live workspace instead of the
 * printed report — recent enough that "did the GM actually reconcile this
 * right" is still a live question worth checking tile-by-tile, same view a
 * GM sees right before they submit. Deliberately separate from the API's own
 * `RECENT_REPORT_WINDOW_DAYS` (7) — that one gates whether a GM can reach
 * their own report at all; this is purely "which view opens by default" and
 * applies to anyone who can see the row (GM or admin).
 */
const RECENT_WORKSPACE_WINDOW_DAYS = 15;

function isWithinWorkspaceWindow(s: SessionListItemDTO): boolean {
  const date = s.businessDate ?? todayIsoIST(new Date(s.createdAt));
  const ageDays = Math.round((Date.parse(`${todayIsoIST()}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(ageDays) && ageDays <= RECENT_WORKSPACE_WINDOW_DAYS;
}

/**
 * A still-draft row always opens the workspace to keep working on it. A
 * submitted row within the last 15 days also opens the workspace — the same
 * full tile-by-tile view a GM sees right before submitting, for reviewing
 * whether it was actually done correctly. A submitted row older than that
 * opens the printed report instead, same as always.
 */
function openSession(s: SessionListItemDTO): void {
  if (s.status === 'submitted' && !isWithinWorkspaceWindow(s)) {
    window.open(reportUrl(s.id), '_blank');
  } else {
    window.location.href = `/recon/sessions/${s.id}`;
  }
}

/** Falls back to the session's `createdAt` day when the Payment Report had no parseable business date — this column should never show a bare dash. Today's own row reads "Today" rather than its raw date. */
function businessDateLabel(s: SessionListItemDTO): string {
  const date = s.businessDate ?? s.createdAt.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  return date === today ? 'Today' : date;
}

export function PastSessionsList() {
  const user = useCurrentUser();
  const [sessions, setSessions] = useState<SessionListItemDTO[] | null>(null);
  const [dateQuery, setDateQuery] = useState('');
  const [filterDate, setFilterDate] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    // No dependency array items needed beyond mount — this component is
    // only ever rendered inside the "no active session" branch of
    // `ReconciliationApp`, so it remounts fresh (refetching) every time a
    // submission returns there, the same way `MprApp`'s own past-runs list
    // does via its `[session]` effect dependency.
    listSessions()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);

  function handleSearch(): void {
    if (!dateQuery) return;
    setSearching(true);
    listSessions({ businessDate: dateQuery })
      .then((rows) => {
        setSessions(rows);
        setFilterDate(dateQuery);
      })
      .catch(() => setSessions([]))
      .finally(() => setSearching(false));
  }

  function handleClear(): void {
    setDateQuery('');
    setFilterDate(null);
    setSessions(null);
    listSessions()
      .then(setSessions)
      .catch(() => setSessions([]));
  }

  // Always render the panel itself — even empty/loading — so the feature is
  // discoverable and its state is legible (same fix already applied to the
  // Tips panel: a section that vanishes when there's no data is
  // indistinguishable from a section that was never built at all).
  return (
    <div className="panel mt-6">
      <div className="panel-section-title flex items-center justify-between gap-2">
        <span>Past sessions{sessions ? ` (${sessions.length})` : ''}</span>
        {user.role !== 'admin' && (
          <span className="normal-case font-normal text-ink-3">Last 7 days — ask an admin for older reports</span>
        )}
      </div>

      {user.role === 'admin' && (
        <div className="toolbar">
          <label className="text-tiny text-ink-3 font-semibold" htmlFor="past-sessions-date">
            Look up a date
          </label>
          <input
            id="past-sessions-date"
            type="date"
            className="toolbar-input"
            value={dateQuery}
            onChange={(e) => setDateQuery(e.target.value)}
          />
          <button type="button" className="btn" disabled={!dateQuery || searching} onClick={handleSearch}>
            {searching ? 'Searching…' : 'Search'}
          </button>
          {filterDate && (
            <button type="button" className="btn" onClick={handleClear}>
              Clear
            </button>
          )}
        </div>
      )}

      {!sessions ? (
        <p className="text-body text-ink-3 px-5 py-4">Loading…</p>
      ) : sessions.length === 0 ? (
        <div className="empty-state">
          <p>
            {filterDate
              ? `No submissions found for ${filterDate}.`
              : 'No past sessions yet — reconciliations you run will show up here.'}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="text-left!">Outlet</th>
                <th className="text-left!">Business date</th>
                <th className="text-left!">Status</th>
                <th className="num">Grand diff</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="cursor-pointer" onClick={() => openSession(s)}>
                  <td className="text-left!">{s.outlet}</td>
                  <td className="text-left! mono">{businessDateLabel(s)}</td>
                  <td className="text-left!">
                    <span className={`tag ${s.status === 'submitted' ? 'tag-ok' : 'tag-warn'}`}>
                      {s.status === 'submitted' ? 'Submitted' : 'Draft'}
                    </span>
                  </td>
                  <td className={`num font-semibold ${diffClass(s.grandDiff)}`}>{fmt(s.grandDiff)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
