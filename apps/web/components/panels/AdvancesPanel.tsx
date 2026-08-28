'use client';

/**
 * Advances repository — read-only view.
 * Ported from `reconciliation (68).html` lines 4097–4122 (`renderAdvList`).
 *
 * There is no "record an advance" button here — an advance is only ever
 * created via the "Advance Received" remark, on an excess-signed row or the
 * Cash/UPI/Bank tabs. This view exists so a GM can see the outlet's
 * outstanding balances without having to trigger that flow first.
 */

import { useEffect, useState } from 'react';
import type { EligibleAdvanceDTO } from '@toit/contracts';
import { fmt, fmtEventDate } from '@toit/recon-core/display';
import { listEligibleAdvances } from '@/lib/api';
import { EmptyRow, PanelSection } from '@/components/ui/table';
import { useJustification } from '@/components/justification/JustificationProvider';

export function AdvancesPanel() {
  const { session } = useJustification();
  const [advances, setAdvances] = useState<EligibleAdvanceDTO[] | null>(null);

  useEffect(() => {
    listEligibleAdvances(session.meta.id)
      .then(setAdvances)
      .catch(() => setAdvances([]));
  }, [session.meta.id, session.justification.draftAdvances, session.justification.draftApplications]);

  const appliedThisSession = session.justification.draftApplications;

  return (
    <div className="panel">
      <PanelSection title={`Outstanding advances — ${session.meta.outletName} (${advances?.length ?? 0})`}>
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-[24%]">Customer</th>
              <th className="w-[18%]">Event date</th>
              <th className="w-[24%]">Notes</th>
              <th className="w-[17%] num">Balance</th>
              <th className="w-[17%]">Recorded</th>
            </tr>
          </thead>
          <tbody>
            {!advances ? (
              <EmptyRow cols={5} message="Loading…" />
            ) : advances.length === 0 ? (
              <EmptyRow
                cols={5}
                message="No advances with remaining balance. Record one via &quot;Advance Received&quot; on an excess transaction."
              />
            ) : (
              advances.map(({ advance, balance }) => (
                <tr key={advance.id}>
                  <td>
                    {advance.custName}
                    {advance.phone && <span className="text-ink-3 text-tiny"> · {advance.phone}</span>}
                  </td>
                  <td className="mono">{fmtEventDate(advance.eventDate)}</td>
                  <td className="text-ink-3 text-tiny">{advance.notes || '—'}</td>
                  <td className="num font-semibold">{fmt(balance)}</td>
                  <td className="mono">{advance.recordedDate}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </PanelSection>

      {appliedThisSession.length > 0 && (
        <PanelSection title={`Applied this session (${appliedThisSession.length})`}>
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-[50%]">Advance</th>
                <th className="w-[25%] num">Amount</th>
                <th className="w-[25%]">Applied</th>
              </tr>
            </thead>
            <tbody>
              {appliedThisSession.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.advanceId}</td>
                  <td className="num">{fmt(a.amount)}</td>
                  <td className="mono">{a.appliedDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PanelSection>
      )}
    </div>
  );
}
