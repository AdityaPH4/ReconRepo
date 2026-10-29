'use client';

/**
 * MPR (Layer 2) top-level workspace state machine.
 *
 * MPR ingestion is now fully automated (mail-fetch + ingest Lambdas), so
 * nobody uploads files through this screen anymore — an admin picks a
 * business date (defaulting to today) and sees every outlet's rows for that
 * date, pooled across whatever automated runs touched it (a date's rows can
 * land in more than one run — see `buildDaySession` on the API side). GMs
 * get their own outlet-scoped status view instead (see the early return
 * below).
 */

import type { MprSessionDTO } from '@toit/contracts';
import { OUTLET_CODES, OUTLET_NAMES, todayIsoIST } from '@toit/recon-core';
import { useEffect, useState } from 'react';
import { useCurrentUser } from '@/components/auth/AuthProvider';
import { GmMprDashboard } from '@/components/mpr/GmMprDashboard';
import { MprHeader } from '@/components/mpr/MprHeader';
import { MprRangeStrip } from '@/components/mpr/MprRangeStrip';
import { MprWorkspace } from '@/components/mpr/MprWorkspace';
import { ApiError, getAdminMprDaySession, mprDayExportCsvUrl } from '@/lib/mprApi';

export function MprApp() {
  const user = useCurrentUser();
  const [selectedOutlet, setSelectedOutlet] = useState('ALL');
  const [selectedDate, setSelectedDate] = useState(() => todayIsoIST());
  const [session, setSession] = useState<MprSessionDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    if (user.role === 'gm') return;
    setLoading(true);
    setError(null);
    getAdminMprDaySession(selectedDate, selectedOutlet)
      .then(setSession)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load that date.'))
      .finally(() => setLoading(false));
  }, [user.role, selectedDate, selectedOutlet, refreshNonce]);

  if (user.role === 'gm') {
    return (
      <>
        <MprHeader subtitle="Automated — showing your outlet's status" />
        <GmMprDashboard />
      </>
    );
  }

  return (
    <>
      <MprHeader subtitle="Automated MPR runs — pick an outlet and a business date" />
      <main className="app-main">
        <div className="inline-flex items-center gap-2 mb-4 flex-wrap">
          <label className="text-tiny text-ink-3 font-semibold" htmlFor="mpr-outlet">
            Outlet
          </label>
          <select
            id="mpr-outlet"
            className="toolbar-select"
            value={selectedOutlet}
            onChange={(e) => setSelectedOutlet(e.target.value)}
          >
            <option value="ALL">All outlets</option>
            {OUTLET_CODES.map((code) => (
              <option key={code} value={code}>
                {OUTLET_NAMES[code]}
              </option>
            ))}
          </select>
          <label className="text-tiny text-ink-3 font-semibold ml-2" htmlFor="mpr-date">
            Date
          </label>
          <input
            id="mpr-date"
            type="date"
            className="toolbar-input flex-none"
            value={selectedDate}
            onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
          />
          {selectedDate !== todayIsoIST() && (
            <button type="button" className="btn" onClick={() => setSelectedDate(todayIsoIST())}>
              Today
            </button>
          )}
        </div>

        <MprRangeStrip outlet={selectedOutlet} refreshKey={refreshNonce} selectedDate={selectedDate} onSelectDate={setSelectedDate} />

        {loading ? (
          <p className="text-body text-ink-3">Loading…</p>
        ) : error ? (
          <div className="alert alert-err">
            <span>✕</span>
            <span>{error}</span>
          </div>
        ) : session && Object.values(session.result).some((rows) => rows.length > 0) ? (
          <MprWorkspace
            key={`${selectedOutlet}-${selectedDate}-${refreshNonce}`}
            session={session}
            exportUrl={mprDayExportCsvUrl(selectedDate, selectedOutlet)}
            afterRowChange={() => setRefreshNonce((n) => n + 1)}
          />
        ) : (
          <div className="panel">
            <div className="panel-section-title px-5 pt-5">No automated MPR runs for this date</div>
            <p className="text-body text-ink-3 px-5 pb-5">
              Once the mail-fetch and ingest pipeline processes bank files for this business date, its rows will show
              up here automatically.
            </p>
          </div>
        )}
      </main>
    </>
  );
}
