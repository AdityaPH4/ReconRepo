'use client';

/**
 * Bills-on-hold repository management.
 * Ported from `reconciliation (68).html` lines 2877–2987 (repository add)
 * and 4331–4441 (clear).
 *
 * Not a diff-driven tab — it's the BOH repository UI: PR rows tagged `bills`
 * can be staged into the cross-session repository, open repository entries
 * (this outlet's, from any session) can be cleared, and clearing here — with
 * no originating row or tab — carries the `'boh'` pseudo-source, so it has
 * zero effect on any residual (see `JustificationSource` in recon-core).
 */

import { useEffect, useState } from 'react';
import type { EligibleBohEntryDTO, Jsonified, PanelTotalsDTO } from '@toit/contracts';
import type { PRRow } from '@toit/recon-core/display';
import { fmt, fmtDate } from '@toit/recon-core/display';
import { ApiError, listEligibleBoh, removeBohStaging, removeJustificationEntry } from '@/lib/api';
import { EmptyRow, PanelSection } from '@/components/ui/table';
import { useJustification } from '@/components/justification/JustificationProvider';

type Row = Jsonified<PRRow>;

export function BillsOnHoldPanel({ rows, totals }: { rows: Row[]; totals: PanelTotalsDTO }) {
  const { session, locked, updateSession, openModal } = useJustification();
  const [open, setOpen] = useState<EligibleBohEntryDTO[] | null>(null);

  useEffect(() => {
    listEligibleBoh(session.meta.id, { includeToday: true })
      .then(setOpen)
      .catch(() => setOpen([]));
  }, [session.meta.id, session.justification.bohStaging, session.justification.draftBohClearances]);

  const staged = session.justification.bohStaging;
  const stagedOrderNos = new Set(staged.map((s) => s.orderNo));
  const cleared = session.justification.draftBohClearances;

  async function removeStaging(id: string) {
    try {
      const updated = await removeBohStaging(session.meta.id, id);
      updateSession(updated);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Failed to remove.');
    }
  }

  // A clearance's own row carries no entry id — it's linked the other way,
  // via the justification entry's `bohClearanceId` (see `clearBoh` in
  // `justificationService.ts`). `removeJustificationEntry` already cascades
  // to `removeBohClearance` for any entry that carries one, regardless of
  // which tab/source created it — legacy's own `removeBohCleared` (4554–4571)
  // is reachable for a BOH-tab-direct clearance the same way.
  async function undoClearance(clearanceId: string) {
    const entry = session.justification.entries.find((e) => e.bohClearanceId === clearanceId);
    if (!entry) return;
    try {
      const updated = await removeJustificationEntry(session.meta.id, entry.id);
      updateSession(updated);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Failed to undo.');
    }
  }

  return (
    <div className="panel">
      <div className="info-panel">
        <div className="info-grid">
          <div className="info-card">
            <p className="info-label">POS total</p>
            <p className="info-value">{fmt(totals.prTotal)}</p>
          </div>
          <div className="info-card">
            <p className="info-label">Drawer summary</p>
            <p className="info-value">{totals.summaryTotal === null ? '—' : fmt(totals.summaryTotal)}</p>
          </div>
        </div>
      </div>

      <PanelSection title={`Bills on hold — Payment Report rows (${rows.length})`}>
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-[18%]">Order no</th>
              <th className="w-[28%]">Date</th>
              <th className="w-[18%]">Customer</th>
              <th className="w-[18%] num">Amount</th>
              <th className="w-[18%]" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow cols={5} message="No bills-on-hold transactions in this session." />
            ) : (
              rows.map((r, i) => (
                <tr key={`${r.orderNo}-${i}`}>
                  <td>{r.orderNo}</td>
                  <td className="mono">{fmtDate(r.date)}</td>
                  <td>{r.customer || '—'}</td>
                  <td className="num">{fmt(r.amount)}</td>
                  <td>
                    {!locked && !stagedOrderNos.has(r.orderNo) && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          openModal({
                            kind: 'boh-add',
                            source: 'boh',
                            targetKey: null,
                            amount: 0,
                            direction: 'excess',
                            bohRow: {
                              orderNo: r.orderNo,
                              custName: r.customer || '',
                              amount: r.amount ?? 0,
                              bohDate: session.meta.businessDate ?? '',
                            },
                          })
                        }
                      >
                        + Add to repository
                      </button>
                    )}
                    {stagedOrderNos.has(r.orderNo) && <span className="tag tag-accent">Staged</span>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </PanelSection>

      <PanelSection title={`Open in repository (${open?.length ?? 0})`}>
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-[18%]">Order no</th>
              <th className="w-[26%]">Customer</th>
              <th className="w-[18%]">BOH date</th>
              <th className="w-[18%] num">Amount</th>
              <th className="w-[20%]" />
            </tr>
          </thead>
          <tbody>
            {!open ? (
              <EmptyRow cols={5} message="Loading…" />
            ) : open.length === 0 ? (
              <EmptyRow cols={5} message="No open bills-on-hold entries for this outlet." />
            ) : (
              open.map(({ entry }) => (
                <tr key={entry.id}>
                  <td>{entry.orderNo}</td>
                  <td>{entry.custName}</td>
                  <td className="mono">{entry.bohDate}</td>
                  <td className="num">{fmt(entry.amount)}</td>
                  <td>
                    {!locked && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          openModal({
                            kind: 'boh-clear',
                            source: 'boh',
                            targetKey: null,
                            amount: 0,
                            direction: 'excess',
                          })
                        }
                      >
                        Clear
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </PanelSection>

      {staged.length > 0 && (
        <PanelSection title={`Staged this session — committed on submit (${staged.length})`}>
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-[20%]">Order no</th>
                <th className="w-[30%]">Customer</th>
                <th className="w-[20%] num">Amount</th>
                <th className="w-[30%]" />
              </tr>
            </thead>
            <tbody>
              {staged.map((s) => (
                <tr key={s.id}>
                  <td>{s.orderNo}</td>
                  <td>{s.custName}</td>
                  <td className="num">{fmt(s.amount)}</td>
                  <td>
                    {!locked && (
                      <button type="button" className="btn btn-sm" onClick={() => removeStaging(s.id)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </PanelSection>
      )}

      {cleared.length > 0 && (
        <PanelSection title={`Cleared this session (${cleared.length})`}>
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-[25%]">Source</th>
                <th className="w-[25%]">Cleared date</th>
                <th className="w-[25%] num">Amount</th>
                <th className="w-[25%]" />
              </tr>
            </thead>
            <tbody>
              {cleared.map((c) => (
                <tr key={c.id}>
                  <td>{c.source}</td>
                  <td className="mono">{c.clearedDate}</td>
                  <td className="num">{fmt(c.amount)}</td>
                  <td>
                    {!locked && (
                      <button type="button" className="btn btn-sm" onClick={() => undoClearance(c.id)}>
                        Undo
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </PanelSection>
      )}
    </div>
  );
}
