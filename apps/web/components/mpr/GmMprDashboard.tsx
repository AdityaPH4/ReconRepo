'use client';

/**
 * A GM's own view of MPR (Layer 2) status — replaces the old upload/run
 * screen for them now that ingestion is fully automated (see
 * mailFetchService.ts/mprIngestService.ts). A GM never uploads or runs MPR
 * directly anymore; this shows what the automation has found for their
 * outlet and lets them comment on anything still open. Resolving an item
 * stays admin-only — see ResolveRow's own doc comment.
 */

import type { GmMprStatusDTO, MprSessionDTO } from '@toit/contracts';
import { OUTLET_NAMES } from '@toit/recon-core/display';
import { useEffect, useState } from 'react';
import { fmtEventDate } from '@toit/recon-core/display';
import { ApiError, getGmMprStatus } from '@/lib/mprApi';
import { BUCKET_LABELS, rowAmount, rowRrn } from './MprOpenItemsQueue';
import { ResolveRow } from './MprWorkspace';

export function GmMprDashboard() {
  const [status, setStatus] = useState<GmMprStatusDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refresh();
  }, []);

  function refresh() {
    getGmMprStatus()
      .then(setStatus)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load MPR status.'));
  }

  // A comment/resolve action returns the whole updated MprSessionDTO, but
  // this view only needs to know "something changed" — a full refetch
  // keeps pendingSessions/settledCount/openItems all correctly in sync
  // rather than trying to patch one row into this outlet-scoped shape by
  // hand.
  function onRowChanged(_updated: MprSessionDTO) {
    refresh();
  }

  return (
    <main className="app-main">
      <div className="results-header mt-6">
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
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-6">
            <div className="panel">
              <div className="panel-header">
                <div className="panel-header-left">
                  <div className="panel-icon">⏳</div>
                  <div>
                    <p className="panel-title">Awaiting match</p>
                    <p className="panel-subtitle">{status.pendingSessions.length} session(s)</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="panel">
              <div className="panel-header">
                <div className="panel-header-left">
                  <div className="panel-icon">⚠️</div>
                  <div>
                    <p className="panel-title">Needs attention</p>
                    <p className="panel-subtitle">{status.openItems.length} open item(s)</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="panel">
              <div className="panel-header">
                <div className="panel-header-left">
                  <div className="panel-icon">✓</div>
                  <div>
                    <p className="panel-title">Settled</p>
                    <p className="panel-subtitle">{status.settledCount} row(s)</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <section className="mt-6">
            <h2 className="text-lede font-semibold mb-1">Awaiting an automated match</h2>
            <p className="text-tiny text-ink-3 mb-3">
              Submitted recon sessions not yet checked against a bank settlement file — either the file hasn't
              arrived yet, or the automation hasn't run since this was submitted. Nothing to do here; this is just
              status.
            </p>
            <div className="panel">
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="text-left!">Business date</th>
                      <th className="text-left!">Submitted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.pendingSessions.length === 0 ? (
                      <tr>
                        <td colSpan={2} className="text-center text-ink-3">
                          Nothing waiting — every submitted session has been through a match.
                        </td>
                      </tr>
                    ) : (
                      status.pendingSessions.map((s) => (
                        <tr key={s.sessionId}>
                          <td className="text-left!">{s.businessDate ? fmtEventDate(s.businessDate) : '—'}</td>
                          <td className="text-left!">
                            {s.submittedAt ? new Date(s.submittedAt).toLocaleString('en-IN') : '—'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section className="mt-6">
            <h2 className="text-lede font-semibold mb-1">Needs attention</h2>
            <p className="text-tiny text-ink-3 mb-3">
              Rows the automated match couldn't confirm settled — add a comment with anything you know (e.g. "bank
              confirmed a delay"); an admin makes the final call to resolve it.
            </p>
            <div className="panel">
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="text-left!">Run date</th>
                      <th className="text-left!">Type</th>
                      <th className="text-left!">RRN</th>
                      <th className="num">Amount</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {status.openItems.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="text-center text-ink-3">
                          Nothing open — every matched row for your outlet is settled.
                        </td>
                      </tr>
                    ) : (
                      status.openItems.map((item) => (
                        <tr key={item.row.id}>
                          <td className="text-left!">{new Date(item.sessionCreatedAt).toLocaleDateString('en-IN')}</td>
                          <td className="text-left!">{BUCKET_LABELS[item.bucket]}</td>
                          <td className="mono text-left!">{rowRrn(item)}</td>
                          <td className="num">
                            {rowAmount(item) != null ? `₹${rowAmount(item)!.toLocaleString('en-IN')}` : '—'}
                          </td>
                          <td>
                            <ResolveRow sessionId={item.sessionId} row={item.row} onResolved={onRowChanged} />
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
