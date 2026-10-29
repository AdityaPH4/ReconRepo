'use client';

/**
 * Last 30 days at a glance: cleared / total per bank for every business day,
 * read from the per-day counters only (never the stored runs), so it is cheap
 * enough to load with the page. Clicking a day opens that day below.
 */

import type { MprRangeCountersDTO } from '@toit/contracts';
import { fmtEventDate } from '@toit/recon-core/display';
import { useEffect, useState } from 'react';
import { ApiError, getMprRangeCounters } from '@/lib/mprApi';

const COLUMNS = [
  { label: 'AMEX', keys: ['amex'] },
  { label: 'HDFC', keys: ['hdfc_upi', 'hdfc_dynamic', 'hdfc_static', 'hdfc_link'] },
  { label: 'Pinelabs', keys: ['pinelabs'] },
  { label: 'Kotak', keys: ['kotak'] },
] as const;

export function MprRangeStrip({ outlet, refreshKey, selectedDate, onSelectDate }: { outlet: string; refreshKey: number; selectedDate: string; onSelectDate: (date: string) => void }) {
  const [data, setData] = useState<MprRangeCountersDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    getMprRangeCounters(outlet)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load the 30-day view.'));
  }, [outlet, refreshKey]);

  if (error) return <div className="alert alert-err mb-4"><span>✕</span><span>{error}</span></div>;
  if (!data) return <p className="text-body text-ink-3 mb-4">Loading 30-day view…</p>;

  return (
    <section className="panel mb-6" data-testid="range-strip">
      <div className="panel-section-title px-5 pt-5">Last 30 days — cleared / total</div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th className="text-left!">Business date</th>
              {COLUMNS.map((c) => <th key={c.label} className="num">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.days.map((d) => (
              <tr key={d.date} className={`cursor-pointer ${d.date === selectedDate ? 'bg-sunken' : ''}`} onClick={() => onSelectDate(d.date)}>
                <td className="text-left!">{fmtEventDate(d.date)}</td>
                {COLUMNS.map((c) => {
                  const total = c.keys.reduce((n, k) => n + d.counts[k].total, 0);
                  const cleared = c.keys.reduce((n, k) => n + d.counts[k].cleared, 0);
                  return (
                    <td key={c.label} className={`num ${total === 0 ? 'text-ink-3' : cleared >= total ? 'text-ok' : 'text-err font-semibold'}`}>
                      {total === 0 ? '—' : `${cleared}/${total}`}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
