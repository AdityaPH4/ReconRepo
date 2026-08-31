'use client';

/**
 * Aggregate panels — Cash, Static UPI, Bank transfer, Bills on hold, Swiggy.
 * Ported from `reconciliation (68).html` lines 1930–2045 (cash), 2441–2611
 * (UPI), 3009–3095 (bank), 2877–2968 (bills), 1880–1929 (swiggy).
 *
 * These methods have no transaction-level source to match against, so they
 * reconcile as a single total against the drawer summary. The manual
 * justification forms (advance received/applied, short collection, BOH
 * clearing, extra payment) belong to the session-state layer.
 */

import type { Jsonified, PanelTotalsDTO } from '@toit/contracts';
import type { PRRow } from '@toit/recon-core/display';
import { fmt, fmtDate } from '@toit/recon-core/display';
import { EmptyRow, diffClass } from '@/components/ui/table';

type Row = Jsonified<PRRow>;

interface Props {
  title: string;
  /** Absent for Swiggy/Zomato, which has no drawer comparison. */
  totals?: PanelTotalsDTO;
  rows: Row[];
  /** Explanatory line shown above the table. */
  note?: string;
  /** Extra stat cards, e.g. the HDFC/Kotak split on the UPI panel. */
  extraStats?: Array<{ label: string; value: string }>;
  /**
   * Legacy's Swiggy/Zomato table (line 1902) carries a Payment type column
   * that the other aggregate tables don't. Every aggregate table (Cash,
   * Bank, Static UPI, Swiggy — lines 2031, 3083, 2600, 1902) shows Employee,
   * so that column is unconditional here.
   */
  showPaymentType?: boolean;
}

export function AggregatePanel({ title, totals, rows, note, extraStats, showPaymentType }: Props) {
  const diff = totals?.diff ?? null;
  const total = totals?.prTotal ?? sumRows(rows);

  return (
    <div className="panel">
      <div className="info-panel">
        <div className="info-grid">
          <div className="info-card">
            <p className="info-label">POS total</p>
            <p className="info-value">{fmt(total)}</p>
          </div>

          {totals && (
            <>
              <div className="info-card">
                <p className="info-label">Drawer summary</p>
                <p className="info-value">
                  {totals.summaryTotal === null ? '—' : fmt(totals.summaryTotal)}
                </p>
                {totals.summaryTotal === null && (
                  <p className="text-micro text-ink-3 mt-1">No Payment Summary uploaded</p>
                )}
              </div>

              <div className="info-card">
                <p className="info-label">Difference</p>
                <p className={`info-value ${diffClass(diff)}`}>
                  {diff === null ? '—' : fmt(diff)}
                </p>
              </div>
            </>
          )}

          {extraStats?.map((s) => (
            <div className="info-card" key={s.label}>
              <p className="info-label">{s.label}</p>
              <p className="info-value">{s.value}</p>
            </div>
          ))}
        </div>

        {note && (
          <div className="alert alert-info mb-0">
            <span>ℹ</span>
            <span>{note}</span>
          </div>
        )}
      </div>

      <h3 className="panel-section-title">
        {title} — transactions ({rows.length})
      </h3>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-[14%]">Order no</th>
              <th className="w-[20%]">Date</th>
              <th className="w-[15%]">Customer</th>
              <th className="w-[15%]">Payment name</th>
              {showPaymentType && <th className="w-[12%]">Payment type</th>}
              <th className="w-[16%] num">Amount</th>
              <th className="w-[13%]">Employee</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow
                cols={showPaymentType ? 7 : 6}
                icon="📭"
                message={`No ${title.toLowerCase()} transactions in this session.`}
              />
            ) : (
              <>
                {rows.map((r, i) => (
                  <tr key={`${r.orderNo}-${i}`}>
                    <td>{r.orderNo}</td>
                    <td className="mono">{fmtDate(r.date)}</td>
                    <td>{r.customer || '—'}</td>
                    <td>{r.paymentName}</td>
                    {showPaymentType && <td>{r.paymentType}</td>}
                    <td className="num">{fmt(r.amount)}</td>
                    <td>{r.employee || '—'}</td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td colSpan={showPaymentType ? 5 : 4}>Total</td>
                  <td className="num">{fmt(sumRows(rows))}</td>
                  <td />
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function sumRows(rows: Row[]): number {
  // A blank source cell parses to NaN by design, and survives JSON as null.
  // Either must not poison the total.
  return rows.reduce((s, r) => s + (typeof r.amount === 'number' ? r.amount : 0), 0);
}
