'use client';

/**
 * The results view for one session: master tabs, KPI tiles, and whichever panel
 * the selected tile reveals.
 *
 * Split out from `ReconciliationApp` so the same view serves both a session
 * that was just run and one opened from storage at `/sessions/[id]`. Holds only
 * view state (which tab, which panel); all figures come from the API.
 */

import type { SessionDTO } from '@toit/contracts';
import { fmt } from '@toit/recon-core/display';
import { useState } from 'react';
import { FinalReconSummary } from '@/components/FinalReconSummary';
import { KpiTiles, type PanelId } from '@/components/KpiTiles';
import { AggregatePanel } from '@/components/panels/AggregatePanel';
import { PinelabsPanel } from '@/components/panels/PinelabsPanel';

type MasterTab = 'txn' | 'summary';

interface Props {
  session: SessionDTO;
  /** Omitted when the session was opened from storage rather than just run. */
  onNewUpload?: () => void;
}

export function SessionWorkspace({ session, onNewUpload }: Props) {
  const [master, setMaster] = useState<MasterTab>('txn');
  const [panel, setPanel] = useState<PanelId>('pinelabs');

  return (
    <>
      <nav className="master-tabs">
        <button
          type="button"
          className={`master-tab${master === 'txn' ? ' master-tab-active' : ''}`}
          onClick={() => setMaster('txn')}
        >
          📋 Transaction Reconciliation
        </button>
        <button
          type="button"
          className={`master-tab${master === 'summary' ? ' master-tab-active' : ''}`}
          onClick={() => setMaster('summary')}
        >
          📊 Final Recon Summary
        </button>
      </nav>

      <main className="app-main">
        {master === 'txn' ? (
          <TransactionView session={session} panel={panel} onPanel={setPanel} onNewUpload={onNewUpload} />
        ) : (
          <FinalReconSummary frs={session.frs} />
        )}
      </main>
    </>
  );
}

function TransactionView({
  session,
  panel,
  onPanel,
  onNewUpload,
}: {
  session: SessionDTO;
  panel: PanelId;
  onPanel: (p: PanelId) => void;
  onNewUpload?: () => void;
}) {
  const { meta, result, counts, totals } = session;

  return (
    <>
      <div className="results-header mt-6">
        <div>
          <h1 className="results-title">Reconciliation results</h1>
          <div className="results-meta">
            <span className="pill">
              🕐 <strong>{meta.businessWindow ?? 'no window'}</strong>
            </span>
            <span className="pill">
              {meta.outletName} · {meta.prFileRows} POS rows · {meta.zipRows} terminal rows
            </span>
            {meta.zipFilteredRows > 0 && (
              <span className="pill">{meta.zipFilteredRows} terminal rows excluded</span>
            )}
          </div>
        </div>
        {onNewUpload && (
          <div className="flex gap-2 flex-wrap items-center">
            <button className="btn" type="button" onClick={onNewUpload}>
              ↑ New upload
            </button>
          </div>
        )}
      </div>

      {meta.warnings.map((w, i) => (
        <div className="alert alert-warn" key={i}>
          <span>⚠</span>
          <span>{w}</span>
        </div>
      ))}

      {meta.hdfcStatement && (
        <div className="alert alert-info">
          <span>ℹ</span>
          <span>
            HDFC UPI Statement applied — {meta.hdfcStatement.rows} rows in window
            {meta.hdfcStatement.skippedFailed > 0 &&
              `, ${meta.hdfcStatement.skippedFailed} not SaleSuccess`}
            {meta.hdfcStatement.unknownCity > 0 &&
              `, ${meta.hdfcStatement.unknownCity} unknown city`}
            . Static UPI is reconciled transaction-by-transaction.
          </span>
        </div>
      )}

      <KpiTiles counts={counts} totals={totals} active={panel} onSelect={onPanel} />

      {panel === 'pinelabs' && <PinelabsPanel pinelabs={result.pinelabs} />}

      {panel === 'cash' && (
        <AggregatePanel title="Cash" totals={totals.cash} rows={result.cash} />
      )}

      {panel === 'upi' && (
        <AggregatePanel
          title="Static UPI"
          totals={totals.hdfcUpi}
          rows={result.upi}
          extraStats={[
            { label: 'HDFC POS total', value: fmt(totals.hdfcUpi.prTotal) },
            { label: 'Kotak POS total', value: fmt(totals.kotakUpi.prTotal) },
          ]}
          note={
            counts.upiHdfc
              ? `HDFC Static UPI is reconciled transaction-by-transaction: ${counts.upiHdfc.reconciled} matched, ${counts.upiHdfc.unreconciled} mismatched, ${counts.upiHdfc.onlyPOS} POS-only, ${counts.upiHdfc.onlyTerm} statement-only. Kotak remains on the aggregate flow.`
              : 'No HDFC statement uploaded — both HDFC and Kotak Static UPI use the aggregate drawer comparison.'
          }
        />
      )}

      {panel === 'bank' && (
        <AggregatePanel title="Bank transfer" totals={totals.bank} rows={result.bank} />
      )}

      {panel === 'bills' && (
        <AggregatePanel title="Bills on hold" totals={totals.bills} rows={result.bills} />
      )}

      {panel === 'swiggy' && (
        <AggregatePanel
          title="Swiggy / Zomato"
          rows={result.swiggy}
          note="POS-integrated — assumed reconciled, and never blocks submission."
        />
      )}
    </>
  );
}
