'use client';

/**
 * A GM's own view of MPR (Layer 2) status — replaces the old upload/run
 * screen for them now that ingestion is fully automated (see
 * mailFetchService.ts/mprIngestService.ts). A GM never uploads or runs MPR
 * directly anymore. With no date picked, this is the last 15 days' worth of
 * reconciled/unreconciled counts for their own outlet — no per-acquirer
 * breakdown, there's no room for it at this level. Clicking a listed date
 * (or picking an older one from the date picker) opens that day's full
 * breakdown (the same AMEX/HDFC/Kotak tile dashboard the admin view uses),
 * pooled from whichever automated runs touched this outlet on that date.
 * Resolving an item stays admin-only — see ResolveRow's own doc comment; a
 * GM can always comment.
 */

import type { GmMprStatusDTO, MprSessionDTO } from '@toit/contracts';
import { fmtEventDate, OUTLET_NAMES } from '@toit/recon-core/display';
import { useEffect, useState } from 'react';
import { ApiError, getGmMprDaySession, getGmMprStatus } from '@/lib/mprApi';
import { MprWorkspace } from './MprWorkspace';

export function GmMprDashboard() {
  const [status, setStatus] = useState<GmMprStatusDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [daySession, setDaySession] = useState<MprSessionDTO | null>(null);
  const [dayError, setDayError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    getGmMprStatus()
      .then(setStatus)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load MPR status.'));
  }, []);

  useEffect(() => {
    if (!selectedDate) return;
    setDaySession(null);
    setDayError(null);
    getGmMprDaySession(selectedDate)
      .then(setDaySession)
      .catch((err) => setDayError(err instanceof ApiError ? err.message : 'Failed to load that day.'));
  }, [selectedDate, refreshNonce]);

  return (
    <main className="app-main">
      <div className="inline-flex items-center gap-2 mb-4">
        <label className="text-tiny text-ink-3 font-semibold" htmlFor="gm-mpr-date">
          Day-wise view
        </label>
        <input
          id="gm-mpr-date"
          type="date"
          className="toolbar-input flex-none"
          value={selectedDate ?? ''}
          onChange={(e) => setSelectedDate(e.target.value || null)}
        />
        {selectedDate && (
          <button type="button" className="btn" onClick={() => setSelectedDate(null)}>
            ← Back to overview
          </button>
        )}
      </div>

      {selectedDate ? (
        dayError ? (
          <div className="alert alert-err mt-4">
            <span>✕</span>
            <span>{dayError}</span>
          </div>
        ) : !daySession ? (
          <p className="text-body text-ink-3 mt-4">Loading…</p>
        ) : (
          <MprWorkspace
            key={`${daySession.meta.id}-${refreshNonce}`}
            session={daySession}
            hideExport
            afterRowChange={() => setRefreshNonce((n) => n + 1)}
          />
        )
      ) : (
        <GmMprOverview status={status} error={error} onSelectDate={setSelectedDate} />
      )}
    </main>
  );
}

function GmMprOverview({
  status,
  error,
  onSelectDate,
}: {
  status: GmMprStatusDTO | null;
  error: string | null;
  onSelectDate: (date: string) => void;
}) {
  return (
    <>
      <div className="results-header">
        <div>
          <h1 className="results-title">MPR status — {status ? OUTLET_NAMES[status.outlet] : '…'}</h1>
          <div className="results-meta">
            <span className="pill">
              Settlement confirmation is fully automated — bank files are matched against your submitted recon
              sessions on their own schedule.
            </span>
          </div>
        </div>
      </div>

      {error && (
        <div className="alert alert-err mt-4">
          <span>✕</span>
          <span>{error}</span>
        </div>
      )}

      {!status ? (
        <p className="text-body text-ink-3 mt-4">Loading…</p>
      ) : (
        <section className="mt-6">
          <div className="panel">
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="text-left!">Business date</th>
                    <th className="num">Reconciled</th>
                    <th className="num">Unreconciled</th>
                    <th className="num">AMEX</th>
                    <th className="num">HDFC</th>
                    <th className="num">Pinelabs</th>
                    <th className="num">Kotak</th>
                  </tr>
                </thead>
                <tbody>
                  {status.days.map((d) => (
                    <tr key={d.date} className="cursor-pointer" onClick={() => onSelectDate(d.date)}>
                      <td className="text-left!">{fmtEventDate(d.date)}</td>
                      <td className="num text-ok">{d.reconciled}</td>
                      <td className={`num ${d.unreconciled > 0 ? 'text-err font-semibold' : 'text-ink-3'}`}>
                        {d.unreconciled}
                      </td>
                      {(['amex', 'hdfc', 'pinelabs', 'kotak'] as const).map((bank) => {
                        const b = d.banks[bank];
                        return (
                          <td key={bank} className={`num ${b.reconciled < b.total ? 'text-err' : 'text-ink-3'}`}>
                            {b.reconciled}/{b.total}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
