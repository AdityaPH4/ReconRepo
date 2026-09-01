'use client';

/**
 * The results view for one session: master tabs, KPI tiles, and whichever panel
 * the selected tile reveals.
 *
 * Split out from `ReconciliationApp` so the same view serves both a session
 * that was just run and one opened from storage at `/sessions/[id]`. Holds
 * view state (which tab, which panel) plus the session itself, since every
 * justification mutation returns the whole updated `SessionDTO` and this is
 * where it lands.
 */

import type { SessionDTO } from '@toit/contracts';
import { fmt, hdfcUpiCompleteness } from '@toit/recon-core/display';
import { useState } from 'react';
import { FinalReconSummary } from '@/components/FinalReconSummary';
import { KpiTiles, type PanelId } from '@/components/KpiTiles';
import { AggregateJustificationPanel } from '@/components/justification/AggregateJustificationPanel';
import { JustificationProvider } from '@/components/justification/JustificationProvider';
import { AdvancesPanel } from '@/components/panels/AdvancesPanel';
import { AggregatePanel } from '@/components/panels/AggregatePanel';
import { BillsOnHoldPanel } from '@/components/panels/BillsOnHoldPanel';
import { HdfcUpiPanel } from '@/components/panels/HdfcUpiPanel';
import { PinelabsPanel } from '@/components/panels/PinelabsPanel';

type MasterTab = 'txn' | 'summary';

interface Props {
  session: SessionDTO;
  /** Omitted when the session was opened from storage rather than just run. */
  onNewUpload?: () => void;
}

export function SessionWorkspace({ session: initialSession, onNewUpload }: Props) {
  const [session, setSession] = useState(initialSession);
  const [master, setMaster] = useState<MasterTab>('txn');
  const [panel, setPanel] = useState<PanelId>('pinelabs');

  return (
    <JustificationProvider session={session} onSessionUpdate={setSession}>
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
          <FinalReconSummary session={session} onSessionUpdate={setSession} />
        )}
      </main>
    </JustificationProvider>
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
  const { meta, result, counts, totals, justification } = session;
  const locked = meta.status === 'submitted';

  // Same canonical figure the "HDFC / Kotak UPI" KPI tile shows (`KpiTiles.tsx`):
  // once an HDFC statement exists, HDFC's own share switches from the aggregate
  // diff to the transaction-level completeness net — Kotak always stays aggregate.
  const hdfcCompletenessForDiff = hdfcUpiCompleteness(
    result.upiHdfc as never,
    justification.entries,
    justification.squareOff,
  );
  const upiDiff =
    (hdfcCompletenessForDiff ? hdfcCompletenessForDiff.netDiff : (totals.hdfcUpi.diff ?? 0)) +
    (totals.kotakUpi.diff ?? 0);

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
            {locked && <span className="pill pill-ok">✓ Submitted</span>}
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

      <KpiTiles session={session} active={panel} onSelect={onPanel} />

      {panel === 'pinelabs' && <PinelabsPanel pinelabs={result.pinelabs} />}

      {panel === 'cash' && (
        <>
          <AggregateJustificationPanel source="cash" title="Cash" diff={totals.cash.diff} />
          <AggregatePanel title="Cash" totals={totals.cash} rows={result.cash} />
        </>
      )}

      {panel === 'upi' && (
        <>
          {result.upiHdfc && <HdfcUpiPanel upiHdfc={result.upiHdfc} />}
          <AggregateJustificationPanel source="upi" title="Static UPI" diff={upiDiff} />
          <AggregatePanel
            title="Static UPI"
            totals={totals.hdfcUpi}
            rows={result.upi}
            extraStats={[
              { label: 'HDFC POS total', value: fmt(totals.hdfcUpi.prTotal) },
              { label: 'Kotak POS total', value: fmt(totals.kotakUpi.prTotal) },
              {
                label: 'Kotak Drawer summary',
                value: totals.kotakUpi.summaryTotal === null ? '—' : fmt(totals.kotakUpi.summaryTotal),
              },
              {
                label: 'Kotak Difference',
                value: totals.kotakUpi.diff === null ? '—' : fmt(totals.kotakUpi.diff),
              },
            ]}
            note={
              counts.upiHdfc
                ? `HDFC Static UPI is reconciled transaction-by-transaction: ${counts.upiHdfc.reconciled} matched, ${counts.upiHdfc.unreconciled} mismatched, ${counts.upiHdfc.onlyPOS} POS-only, ${counts.upiHdfc.onlyTerm} statement-only. Kotak remains on the aggregate flow.`
                : 'No HDFC statement uploaded — both HDFC and Kotak Static UPI use the aggregate drawer comparison.'
            }
          />
        </>
      )}

      {panel === 'bank' && (
        <>
          <AggregateJustificationPanel source="bank" title="Bank transfer" diff={totals.bank.diff} />
          <AggregatePanel title="Bank transfer" totals={totals.bank} rows={result.bank} />
        </>
      )}

      {panel === 'bills' && <BillsOnHoldPanel rows={result.bills} totals={totals.bills} />}

      {panel === 'advances' && <AdvancesPanel />}

      {panel === 'swiggy' && (
        <AggregatePanel
          title="Swiggy / Zomato"
          rows={result.swiggy}
          showPaymentType
          extraStats={[
            { label: 'Swiggy — PR total', value: fmt(totals.swiggy.swiggy.prTotal) },
            {
              label: 'Swiggy — Summary total',
              value: totals.swiggy.swiggy.summaryTotal === null ? '—' : fmt(totals.swiggy.swiggy.summaryTotal),
            },
            {
              label: 'Swiggy difference',
              value: totals.swiggy.swiggy.diff === null ? '—' : fmt(totals.swiggy.swiggy.diff),
            },
            { label: 'Zomato — PR total', value: fmt(totals.swiggy.zomato.prTotal) },
            {
              label: 'Zomato — Summary total',
              value: totals.swiggy.zomato.summaryTotal === null ? '—' : fmt(totals.swiggy.zomato.summaryTotal),
            },
            {
              label: 'Zomato difference',
              value: totals.swiggy.zomato.diff === null ? '—' : fmt(totals.swiggy.zomato.diff),
            },
          ]}
          note="POS-integrated — never blocks submission, but still compared against the drawer summary for each brand."
        />
      )}
    </>
  );
}
