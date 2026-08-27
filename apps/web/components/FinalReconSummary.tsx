'use client';

/**
 * Final Recon Summary table.
 * Ported from `reconciliation (68).html` lines 3443–3794 (`renderFRS`).
 *
 * Every figure here comes from the API, which computes it through the engine's
 * single `frsRowAmounts` resolver — so this table, the submission gate and the
 * downloaded report cannot disagree about which column an amount belongs in or
 * what its difference means. The legacy comment called that property out
 * explicitly; routing all three through one resolver is what preserves it.
 *
 * Scope note: the manual-explanation entry form and the submit action arrive
 * with the session-state layer.
 */

import type { FrsDTO, FrsRowDTO } from '@toit/contracts';
import { AMOUNT_EPSILON, THRESHOLD, fmt } from '@toit/recon-core/display';

export function FinalReconSummary({ frs }: { frs: FrsDTO }) {
  const { rows, grandPR, grandSum, grandDiff } = frs;

  // Rows with nothing on either side are omitted rather than shown as zeroes —
  // an outlet that takes no vouchers should not have a Vouchers line.
  const visible = rows.filter((r) => r.pr || r.drawerAmt || r.sourceAmt);

  const verdict = classifyVerdict(grandDiff);

  return (
    <div className="frs-section pt-6">
      <h2 className="frs-title">Final Recon Summary</h2>

      <table className="frs-table">
        <thead>
          <tr>
            <th>Payment method</th>
            <th className="num">Payment Report</th>
            <th className="num">Expected</th>
            <th>Basis</th>
            <th className="num">Difference</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <FrsRow key={r.label} row={r} />
          ))}

          <tr className="frs-grandtotal">
            <td>Grand total (excl. POS-integrated)</td>
            <td className="num">{fmt(grandPR)}</td>
            <td className="num">{fmt(grandSum)}</td>
            <td />
            <td className="num">{fmt(grandDiff)}</td>
          </tr>
        </tbody>
      </table>

      <div className={`net-box ${verdict.className}`}>
        <span>Net difference</span>
        <span>
          {fmt(grandDiff)} · {verdict.label}
        </span>
      </div>

      <div className="alert alert-info mt-6">
        <span>ℹ</span>
        <span>
          Explanation entry (advances, tips, short collections, bills-on-hold clearing) and
          session submission are part of the session-state layer and are not wired up yet.
          The figures above are final and match the legacy calculation.
        </span>
      </div>
    </div>
  );
}

function FrsRow({ row }: { row: FrsRowDTO }) {
  const expected = row.usingSource ? row.sourceAmt : row.drawerAmt;
  const settled = row.assumedReconciled || Math.abs(row.diff) < AMOUNT_EPSILON;

  return (
    <tr>
      <td>{row.label}</td>
      <td className="num">{fmt(row.pr)}</td>
      <td className="num">{expected === null ? '—' : fmt(expected)}</td>
      <td>
        <BasisTag row={row} />
      </td>
      <td className={`num ${settled ? 'diff-zero' : row.diff > 0 ? 'diff-excess' : 'diff-short'}`}>
        {settled ? '—' : (row.diff > 0 ? '+' : '') + fmt(row.diff)}
      </td>
    </tr>
  );
}

/**
 * Which side the "expected" figure came from. Worth surfacing per row: Pinelabs
 * and (with a statement) HDFC UPI reconcile against a transaction-level source
 * report, while everything else compares to the hand-entered drawer summary —
 * and the operator should be able to see which at a glance.
 */
function BasisTag({ row }: { row: FrsRowDTO }) {
  if (row.assumedReconciled) {
    return <span className="tag tag-ok">{row.reconciledNote ?? 'assumed reconciled'}</span>;
  }
  if (row.usingSource) {
    return <span className="tag tag-accent">source report</span>;
  }
  return <span className="tag tag-neutral">drawer summary</span>;
}

function classifyVerdict(grandDiff: number): { className: string; label: string } {
  if (Math.abs(grandDiff) < AMOUNT_EPSILON) {
    return { className: 'net-box-neutral', label: 'Fully balanced' };
  }
  if (Math.abs(grandDiff) <= THRESHOLD) {
    return { className: 'net-box-ok', label: `Within threshold (₹${THRESHOLD})` };
  }
  return {
    className: 'net-box-err',
    label: `Exceeds threshold (₹${THRESHOLD}) — needs explanation`,
  };
}
