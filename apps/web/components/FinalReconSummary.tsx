'use client';

/**
 * Final Recon Summary screen.
 * Ported from `reconciliation (68).html` lines 3443–3927 (`renderFRS`) and
 * 4895–4999 (`initiateSubmit`).
 *
 * Five sections, same order as legacy: method-level breakdown + Pinelabs
 * acquirer breakdown side by side, Explanation of Excess, Explanation of
 * Shortage, Source reconciliation status, Net position (+ submit).
 *
 * Every figure comes from the API, which computes it through the engine's
 * single `frsRowAmounts`/`canSubmit` resolvers — so this screen, the
 * submission gate and the downloaded report cannot disagree about what a
 * number means. `submitGate` and `explanation` are recomputed on every
 * fetch, never stored, so they can never drift from what `POST /submit`
 * actually gates on.
 */

import { useState } from 'react';
import type { ExplainedItemDTO, FrsRowDTO, PinelabsBreakdownDTO, SessionDTO } from '@toit/contracts';
import { AMOUNT_EPSILON, THRESHOLD, entryNet, fmt, hdfcUpiCompleteness } from '@toit/recon-core/display';
import { ApiError, reportUrl, snapshotUrl, submitSession } from '@/lib/api';

export function FinalReconSummary({
  session,
  onSessionUpdate,
}: {
  session: SessionDTO;
  onSessionUpdate: (session: SessionDTO) => void;
}) {
  const { frs, submitGate, meta, pinelabsBreakdown, explanation, totals, justification } = session;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const excessItems = explanation.filter((x) => x.diff > AMOUNT_EPSILON);
  const shortItems = explanation.filter((x) => x.diff < -AMOUNT_EPSILON);
  const totalExcess = excessItems.reduce((s, x) => s + x.diff, 0);
  const totalShortage = shortItems.reduce((s, x) => s + Math.abs(x.diff), 0);

  const locked = meta.status === 'submitted';

  async function handleSubmit() {
    const confirmed = window.confirm(
      `Submit reconciliation session?\n\nNet difference: ${fmt(frs.grandDiff)}\nStatus: ${submitGate.status.replace('_', ' ')}\n\nThe session will be locked.`,
    );
    if (!confirmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await submitSession(session.meta.id);
      onSessionUpdate(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Submit failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="frs-section pt-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start mb-8">
        <MethodBreakdown frs={frs} hasSummary={session.summaryData !== null} />
        <PinelabsBreakdown breakdown={pinelabsBreakdown} />
      </div>

      <ExplanationSection
        title="Explanation of Excess"
        items={excessItems}
        total={totalExcess}
        colorClass="diff-excess"
      />
      <ExplanationSection
        title="Explanation of Shortage"
        items={shortItems}
        total={totalShortage}
        colorClass="diff-short"
      />

      <SourceStatusSection session={session} />

      <div className="frs-section">
        <h2 className="frs-title">Net position</h2>
        <div className="info-grid">
          <div className="info-card">
            <p className="info-label">Total difference</p>
            <p className={`info-value ${diffColor(frs.grandDiff)}`}>{fmt(frs.grandDiff)}</p>
          </div>
          <div className="info-card">
            <p className="info-label">Explained excess</p>
            <p className="info-value diff-excess">{fmt(totalExcess)}</p>
          </div>
          <div className="info-card">
            <p className="info-label">Explained shortage</p>
            <p className="info-value diff-short">{fmt(totalShortage)}</p>
          </div>
          <div className="info-card">
            <p className="info-label">Net unexplained</p>
            <p className={`info-value ${diffColor(submitGate.residual)}`}>{fmt(submitGate.residual)}</p>
          </div>
        </div>

        {error && (
          <div className="alert alert-warn mt-4">
            <span>⚠</span>
            <span>{error}</span>
          </div>
        )}

        <div className="panel px-6 py-5 mt-4">
          {locked ? (
            <>
              <div className="alert alert-info mb-3">
                <span>✓</span>
                <span>Session submitted on {meta.submittedAt}.</span>
              </div>
              <div className="btn-row">
                <button type="button" className="btn btn-ok" disabled>
                  ✓ Submitted
                </button>
                <a className="btn" href={reportUrl(session.meta.id)} target="_blank" rel="noreferrer">
                  📄 View printable report
                </a>
                <a className="btn" href={snapshotUrl(session.meta.id)} target="_blank" rel="noreferrer">
                  📋 Download snapshot JSON
                </a>
              </div>
            </>
          ) : !submitGate.ok ? (
            <>
              <p className="font-semibold text-err text-body mb-2">✗ Cannot submit — resolve all source issues first</p>
              <div className="text-tiny text-ink-3 mb-4 leading-loose">
                {submitGate.blockers.map((b, i) => (
                  <p key={i}>• {b}</p>
                ))}
              </div>
              <button type="button" className="btn btn-primary" disabled>
                ✓ Submit Session
              </button>
            </>
          ) : (
            <>
              <p className="font-semibold text-ok text-body mb-2">✓ All sources reconciled — ready to submit</p>
              <p className="text-tiny text-ink-3 mb-4">
                Persists the settlement snapshot (settlement ledger + full audit) and makes the printable report
                available.
              </p>
              <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Submitting…' : '✓ Submit Session'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Method-level breakdown ──────────────────────────────────────────────────

function MethodBreakdown({ frs, hasSummary }: { frs: SessionDTO['frs']; hasSummary: boolean }) {
  const visible = frs.rows.filter((r) => r.pr || r.drawerAmt || r.sourceAmt);

  return (
    <div className="frs-section mb-0">
      <h2 className="frs-title">Method-level breakdown</h2>
      {!hasSummary && (
        <div className="alert alert-info">
          <span>ℹ</span>
          <span>Upload Payment Summary CSV to see comparison.</span>
        </div>
      )}
      <div className="table-wrap">
        <table className="frs-table">
          <thead>
            <tr>
              <th>Payment method</th>
              <th className="num">PR</th>
              <th className="num">Drawer Summary</th>
              <th className="num">Source Report</th>
              <th className="num">Diff</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <MethodRow key={r.label} row={r} />
            ))}
          </tbody>
          <tfoot>
            <tr className="total-row">
              <td>Grand total</td>
              <td className="num">{fmt(frs.grandPR)}</td>
              <td className="num" colSpan={2}>
                {fmt(frs.grandSum)}
              </td>
              <td className={`num ${diffColor(frs.grandDiff)}`}>
                {Math.abs(frs.grandDiff) < AMOUNT_EPSILON ? '—' : (frs.grandDiff > 0 ? '+' : '') + fmt(Math.abs(frs.grandDiff))}
              </td>
              <td>
                <StatusPill diff={frs.grandDiff} label={Math.abs(frs.grandDiff) < AMOUNT_EPSILON ? 'Balanced' : undefined} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function MethodRow({ row }: { row: FrsRowDTO }) {
  const expected = row.usingSource ? row.sourceAmt : row.drawerAmt;
  return (
    <tr>
      <td>{row.label}</td>
      <td className="num">{fmt(row.pr)}</td>
      <td className="num">{row.drawerAmt === null ? '—' : fmt(row.drawerAmt)}</td>
      <td className="num">{row.sourceAmt === null ? '—' : fmt(row.sourceAmt)}</td>
      <td className={`num ${row.assumedReconciled || Math.abs(row.diff) < AMOUNT_EPSILON ? '' : diffColor(row.diff)}`}>
        {row.assumedReconciled || Math.abs(row.diff) < AMOUNT_EPSILON
          ? '—'
          : (row.diff > 0 ? '+' : '') + fmt(Math.abs(row.diff))}
      </td>
      <td>
        {row.assumedReconciled ? (
          <span className="tag tag-ok">✓ {row.reconciledNote ?? 'Matched'}</span>
        ) : (
          <StatusPill diff={row.diff} label={expected !== null && Math.abs(row.diff) < AMOUNT_EPSILON ? 'Matched' : undefined} />
        )}
      </td>
    </tr>
  );
}

function StatusPill({ diff, label }: { diff: number; label?: string }) {
  if (label || Math.abs(diff) < AMOUNT_EPSILON) {
    return <span className="tag tag-ok">✓ {label ?? 'Matched'}</span>;
  }
  return diff > 0 ? (
    <span className="tag tag-excess">▲ Excess</span>
  ) : (
    <span className="tag tag-short">▼ Shortage</span>
  );
}

function diffColor(diff: number): string {
  if (Math.abs(diff) < AMOUNT_EPSILON) return '';
  return diff > 0 ? 'diff-excess' : 'diff-short';
}

// ── Pinelabs terminal breakdown ─────────────────────────────────────────────

function PinelabsBreakdown({ breakdown }: { breakdown: PinelabsBreakdownDTO }) {
  return (
    <div className="frs-section mb-0">
      <h2 className="frs-title">Pinelabs terminal breakdown</h2>
      <div className="table-wrap">
        <table className="frs-table">
          <thead>
            <tr>
              <th>Acquirer</th>
              <th className="num">Count</th>
              <th className="num">Pinelabs</th>
              <th className="num">PR total</th>
              <th className="num">Diff</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.rows.map((r) => {
              const isOther = r.acquirer === 'Other';
              return (
                <tr key={r.acquirer} className={isOther ? 'text-ink-3' : undefined}>
                  <td className="whitespace-nowrap">
                    {r.acquirer}
                    {r.acquirer === 'AMEX' && breakdown.amexDupCount > 0 && (
                      <span className="text-tiny text-warn ml-1">({breakdown.amexDupCount} dup flagged)</span>
                    )}
                  </td>
                  <td className="num">{r.count}</td>
                  <td className="num font-semibold">{fmt(r.pinelabsTotal)}</td>
                  <td className="num">{r.prTotal === null ? '—' : fmt(r.prTotal)}</td>
                  <td className={`num ${r.diff === null ? '' : diffColor(r.diff)}`}>
                    {r.diff === null
                      ? '—'
                      : Math.abs(r.diff) < AMOUNT_EPSILON
                        ? // Legacy reserves the "✓ Balanced" label for the AMEX row only —
                          // HDFC/Kotak just show "—" on a near-zero diff.
                          r.acquirer === 'AMEX'
                          ? '✓ Balanced'
                          : '—'
                        : (r.diff > 0 ? '+' : '') + fmt(Math.abs(r.diff))}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="total-row">
              <td>Total</td>
              <td className="num">{breakdown.totalCount}</td>
              <td className="num">{fmt(breakdown.totalPinelabs)}</td>
              <td className="num">{fmt(breakdown.totalPR)}</td>
              <td className={`num ${diffColor(breakdown.totalDiff)}`}>
                {Math.abs(breakdown.totalDiff) < AMOUNT_EPSILON
                  ? '✓ Balanced'
                  : (breakdown.totalDiff > 0 ? '▲ +' : '▼ ') + fmt(Math.abs(breakdown.totalDiff))}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {breakdown.amexDupCount > 0 && (
        <div className="alert alert-warn mt-3">
          <span>⚠</span>
          <span>
            <strong>AMEX note:</strong> {breakdown.amexDupCount} AMEX transaction
            {breakdown.amexDupCount > 1 ? 's' : ''} flagged with duplicate amounts and cannot be matched
            individually. The AMEX total still reconciles at aggregate level.
          </span>
        </div>
      )}
    </div>
  );
}

// ── Explanation of Excess / Shortage ────────────────────────────────────────

function ExplanationSection({
  title,
  items,
  total,
  colorClass,
}: {
  title: string;
  items: ExplainedItemDTO[];
  total: number;
  colorClass: string;
}) {
  const groups = groupByRemark(items);

  return (
    <div className="frs-section">
      <div className="flex items-center flex-wrap gap-2 mb-3">
        <h2 className="frs-title mb-0">{title}</h2>
        <span className="text-tiny text-ink-3">(from reconciliation tab remarks)</span>
        <span className={`ml-auto font-bold text-body ${colorClass}`}>Total: {fmt(total)}</span>
      </div>

      {groups.length === 0 ? (
        <p className="text-ink-3 text-body py-2">
          No explained items yet. Add remarks to unreconciled transactions in the Pinelabs tab.
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.remark} className="mb-5">
            <p className="eyebrow mb-1">
              {g.remark} — {g.rows.length} item{g.rows.length > 1 ? 's' : ''}
            </p>
            <div className="table-wrap">
              <table className="frs-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Order No(s)</th>
                    <th>RRN</th>
                    <th>Label</th>
                    <th className="num">Pinelabs</th>
                    <th className="num">PR amount</th>
                    <th className="num">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((x, i) => (
                    <tr key={i}>
                      <td className="text-tiny text-ink-3">{x.source}</td>
                      <td>{x.orderNo || '—'}</td>
                      <td className="mono">{x.rrn || '—'}</td>
                      <td>
                        <span className="tag tag-neutral">{x.label || '—'}</span>
                      </td>
                      <td className="num">{x.plAmt ? fmt(x.plAmt) : '—'}</td>
                      <td className="num">{x.prAmt ? fmt(x.prAmt) : '—'}</td>
                      <td className={`num font-semibold ${colorClass}`}>
                        {x.diff > 0 ? '+' : ''}
                        {fmt(x.diff)}
                      </td>
                    </tr>
                  ))}
                  <tr className="total-row">
                    <td colSpan={6}>Subtotal — {g.remark}</td>
                    <td className={`num ${colorClass}`}>
                      {g.rows[0]!.diff > 0 ? '+' : '−'}
                      {fmt(g.total)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function groupByRemark(items: ExplainedItemDTO[]): Array<{ remark: string; rows: ExplainedItemDTO[]; total: number }> {
  const map = new Map<string, { remark: string; rows: ExplainedItemDTO[]; total: number }>();
  for (const x of items) {
    const existing = map.get(x.remark);
    if (existing) {
      existing.rows.push(x);
      existing.total += Math.abs(x.diff);
    } else {
      map.set(x.remark, { remark: x.remark, rows: [x], total: Math.abs(x.diff) });
    }
  }
  return [...map.values()];
}

// ── Source reconciliation status ────────────────────────────────────────────

function SourceStatusSection({ session }: { session: SessionDTO }) {
  const { submitGate, totals, justification, result } = session;

  const cashDiff = totals.cash.diff ?? 0;
  const cashResidual = cashDiff - entryNet(justification.entries, 'cash');

  // Once an HDFC statement exists, the "unexplained" figure must be the same
  // count-based completeness net the submit gate itself uses
  // (`hdfcUpiCompleteness().netDiff`), not the aggregate drawer-vs-PR diff —
  // otherwise this caption can show a materially different number than what
  // `submitGate.perSource.upi` actually gated on.
  const hdfcCompleteness = hdfcUpiCompleteness(result.upiHdfc as never, justification.entries, justification.squareOff);
  const hdfcDiff = hdfcCompleteness ? hdfcCompleteness.netDiff : (totals.hdfcUpi.diff ?? 0);
  const kotakDiff = totals.kotakUpi.diff ?? 0;
  const upiDiff = hdfcDiff + kotakDiff;
  const upiResidual = upiDiff - entryNet(justification.entries, 'upi');

  const bankDiff = totals.bank.diff ?? 0;
  const bankResidual = bankDiff - entryNet(justification.entries, 'bank');

  const tags = [
    {
      ok: submitGate.perSource.pinelabs,
      label: 'Pinelabs',
      detail: submitGate.perSource.pinelabs ? 'All items explained' : 'Items still need a remark or square-off',
    },
    {
      ok: submitGate.perSource.cash,
      label: 'Cash',
      detail:
        Math.abs(cashDiff) < AMOUNT_EPSILON
          ? 'Balanced'
          : Math.abs(cashDiff) <= THRESHOLD
            ? `Within ₹${THRESHOLD} threshold`
            : `Unexplained: ${fmt(Math.abs(cashResidual))}`,
    },
    {
      ok: submitGate.perSource.upi,
      label: 'HDFC / Kotak UPI',
      detail:
        totals.hdfcUpi.summaryTotal === null
          ? 'No summary'
          : Math.abs(upiDiff) < AMOUNT_EPSILON
            ? 'Balanced'
            : Math.abs(upiResidual) < AMOUNT_EPSILON
              ? 'Fully justified'
              : `Unexplained: ${fmt(Math.abs(upiResidual))}`,
    },
    {
      ok: submitGate.perSource.bank,
      label: 'Bank Transfer',
      detail:
        totals.bank.summaryTotal === null
          ? 'No summary'
          : Math.abs(bankDiff) < AMOUNT_EPSILON
            ? 'Balanced'
            : Math.abs(bankResidual) < AMOUNT_EPSILON
              ? 'Fully justified'
              : `Unexplained: ${fmt(Math.abs(bankResidual))}`,
    },
  ];

  return (
    <div className="frs-section">
      <h2 className="frs-title">Source reconciliation status</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-w-3xl">
        {tags.map((t) => (
          <div
            key={t.label}
            className={`flex items-center gap-2 px-3 py-2 rounded-control border ${
              t.ok ? 'border-ok bg-ok-soft' : 'border-err bg-err-soft'
            }`}
          >
            <span className={t.ok ? 'text-ok' : 'text-err'}>{t.ok ? '✓' : '✗'}</span>
            <span className="font-semibold text-body">{t.label}</span>
            <span className="text-tiny text-ink-3">{t.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
