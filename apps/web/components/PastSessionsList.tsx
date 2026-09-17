'use client';

/**
 * Past reconciliation sessions — mirrors `MprApp.tsx`'s "Past runs" table
 * exactly (same shown-alongside-the-upload-form placement, same
 * fetch-once-on-mount, same row-click navigation). `listSessions()` already
 * existed with zero callers anywhere in the frontend; `outletScope()` on the
 * API side already scopes this to the caller's own outlet for a GM, or every
 * outlet for an admin — so this one component serves both roles as-is.
 */

import { useEffect, useState } from 'react';
import type { SessionListItemDTO } from '@toit/contracts';
import { fmt } from '@toit/recon-core/display';
import { diffClass } from '@/components/ui/table';
import { listSessions } from '@/lib/api';

export function PastSessionsList() {
  const [sessions, setSessions] = useState<SessionListItemDTO[] | null>(null);

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

  // Always render the panel itself — even empty/loading — so the feature is
  // discoverable and its state is legible (same fix already applied to the
  // Tips panel: a section that vanishes when there's no data is
  // indistinguishable from a section that was never built at all).
  return (
    <div className="panel mt-6">
      <div className="panel-section-title">Past sessions{sessions ? ` (${sessions.length})` : ''}</div>
      {!sessions ? (
        <p className="text-body text-ink-3 px-5 py-4">Loading…</p>
      ) : sessions.length === 0 ? (
        <div className="empty-state">
          <p>No past sessions yet — reconciliations you run will show up here.</p>
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
                <tr key={s.id} className="cursor-pointer" onClick={() => (window.location.href = `/recon/sessions/${s.id}`)}>
                  <td className="text-left!">{s.outlet}</td>
                  <td className="text-left! mono">{s.businessDate ?? '—'}</td>
                  <td className="text-left!">
                    <span className={`tag ${s.status === 'submitted' ? 'tag-ok' : 'tag-neutral'}`}>
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
