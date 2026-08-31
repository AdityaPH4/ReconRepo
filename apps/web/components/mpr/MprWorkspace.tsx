'use client';

/**
 * MPR (Layer 2) results view — KPI tiles + tab switcher.
 * Ported from `mpr-recon (10).html` lines 1310–1720 (`renderResults`/`renderTab`).
 *
 * Two tiles beyond legacy's six: **Ambiguous** (the duplicate-RRN fix — see
 * `mpr-core`) and the Pending tile/tab now count *every* pending row,
 * "No RRN" included, instead of legacy's silent split between what the tile
 * shows and what the CSV export contains.
 */

import type { MprSessionDTO } from '@toit/contracts';
import { normDate } from '@toit/mpr-core';
import { useState } from 'react';
import { mprExportCsvUrl } from '@/lib/mprApi';
import { EmptyRow, PanelSection } from '@/components/ui/table';

type TabId = 'settled' | 'mismatch' | 'pending' | 'ambiguous' | 'unexpected' | 'amex' | 'upi';

const ACQUIRER_LABELS: Record<string, string> = {
  KOTAK: 'Kotak',
  PINELABS: 'Pinelabs',
  HDFC_UPI: 'HDFC Static UPI',
  AMEX: 'AMEX',
  UNKNOWN: 'Unknown',
};

function fmt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return '₹' + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** Mismatch-style diff cell: unsigned amount, direction by color only (legacy: `dc`/`+fmt(diff)` — no literal minus). */
function signedFmt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  if (Math.abs(n) < 0.5) return '—';
  return (n > 0 ? '+' : '') + fmt(n);
}

/** UPI/AMEX-style diff cell with ▲/▼ direction glyph + near-zero ✓ (legacy `amexRow`/UPI mismatch render). */
function directionalFmt(n: number | null | undefined): { text: string; ok: boolean } {
  if (n == null || Number.isNaN(n)) return { text: '—', ok: false };
  if (Math.abs(n) < 0.5) return { text: '✓', ok: true };
  return { text: (n > 0 ? '▲ +' : '▼ ') + fmt(n), ok: false };
}

function dateRangeLabel(dates: string[]): string {
  if (dates.length === 0) return '—';
  const sorted = [...dates].sort();
  return sorted.length === 1 ? sorted[0]! : `${sorted[0]} – ${sorted[sorted.length - 1]}`;
}

export function MprWorkspace({ session }: { session: MprSessionDTO }) {
  const [tab, setTab] = useState<TabId>('settled');
  const { result } = session;

  const totalLedger = result.settled.length + result.amountMismatch.length + result.pending.length;

  const tiles: Array<{ id: TabId; label: string; main: string; sub: string; stat: 'ok' | 'err' | 'neutral' }> = [
    {
      id: 'settled',
      label: 'Settled (RRN match)',
      main: String(result.settled.length),
      sub: totalLedger ? `${Math.round((result.settled.length / totalLedger) * 100)}% of ledger` : '—',
      stat: 'ok',
    },
    {
      id: 'mismatch',
      label: 'Amount Mismatch',
      main: String(result.amountMismatch.length),
      sub: 'RRN matched, amounts differ',
      stat: result.amountMismatch.length ? 'err' : 'ok',
    },
    {
      id: 'pending',
      label: 'Pending Settlement',
      main: String(result.pending.length),
      sub: 'in ledger, not in MPR',
      stat: result.pending.length ? 'err' : 'ok',
    },
    {
      id: 'ambiguous',
      label: 'Ambiguous',
      main: String(result.ambiguous.length),
      sub: 'duplicate RRN across MPR rows',
      stat: result.ambiguous.length ? 'err' : 'ok',
    },
    {
      id: 'unexpected',
      label: 'Unexpected MPR Credits',
      main: String(result.unexpected.length),
      sub: 'in MPR, not in ledger',
      stat: result.unexpected.length ? 'err' : 'ok',
    },
    {
      id: 'amex',
      label: 'AMEX Batches',
      main: `${result.amexResults.filter((r) => r._match === 'settled').length}/${result.amexResults.length}`,
      sub: 'settled / total',
      stat: result.amexResults.some((r) => r._match !== 'settled') ? 'err' : 'ok',
    },
    {
      id: 'upi',
      label: 'HDFC Static UPI',
      main: `${result.upiResults.filter((r) => r._match === 'settled').length}/${result.upiResults.length}`,
      sub: 'settled / total',
      stat: result.upiResults.some((r) => r._match === 'pending') ? 'err' : 'ok',
    },
  ];

  return (
    <>
      <div className="results-header mt-6">
        <div>
          <h1 className="results-title">MPR reconciliation results</h1>
          <div className="results-meta">
            {session.meta.outlets.length > 0 && (
              <span className="pill">🏢 {session.meta.outlets.join(', ')}</span>
            )}
            <span className="pill">📅 {dateRangeLabel(session.meta.businessDates)}</span>
            <span className="pill">
              {session.meta.jsonFiles.length} snapshot{session.meta.jsonFiles.length === 1 ? '' : 's'} ·{' '}
              {session.meta.mprFiles.length} MPR file{session.meta.mprFiles.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <a className="btn" href={mprExportCsvUrl(session.meta.id)}>
          ⬇ Export CSV
        </a>
      </div>

      {(session.meta.mprFiles.some((f) => f.error) || session.meta.jsonFiles.some((f) => f.error)) && (
        <div className="alert alert-warn">
          <span>⚠</span>
          <div>
            {session.meta.jsonFiles
              .filter((f) => f.error)
              .map((f) => (
                <p key={`json-${f.filename}`}>{f.error}</p>
              ))}
            {session.meta.mprFiles
              .filter((f) => f.error)
              .map((f) => (
                <p key={`mpr-${f.filename}`}>{f.error}</p>
              ))}
          </div>
        </div>
      )}

      <div className="kpi-grid">
        {tiles.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`kpi${tab === t.id ? ' kpi-active' : ''}`}
            aria-pressed={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            <span className="kpi-label">{t.label}</span>
            <span className={`kpi-value ${t.stat === 'ok' ? 'kpi-value-ok' : t.stat === 'err' ? 'kpi-value-err' : ''}`}>
              {t.main}
            </span>
            <span className="kpi-note">{t.sub}</span>
          </button>
        ))}
      </div>

      {tab === 'settled' && <SettledTab rows={result.settled} />}
      {tab === 'mismatch' && <MismatchTab rows={result.amountMismatch} />}
      {tab === 'pending' && <PendingTab rows={result.pending} />}
      {tab === 'ambiguous' && <AmbiguousTab rows={result.ambiguous} />}
      {tab === 'unexpected' && <UnexpectedTab rows={result.unexpected} />}
      {tab === 'amex' && <AmexTab rows={result.amexResults} />}
      {tab === 'upi' && <UpiTab rows={result.upiResults} />}
    </>
  );
}

// ── Settled — grouped by acquirer ───────────────────────────────────────

function SettledTab({ rows }: { rows: MprSessionDTO['result']['settled'] }) {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.acquirer || 'UNKNOWN';
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  return (
    <div className="panel">
      {rows.length === 0 ? (
        <EmptyRow cols={1} message="No settled rows yet." />
      ) : (
        [...groups.entries()].map(([acquirer, group]) => (
          <PanelSection key={acquirer} title={`${ACQUIRER_LABELS[acquirer] ?? acquirer} (${group.length})`}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>RRN</th>
                  <th>Outlet</th>
                  <th>Txn Date</th>
                  <th>Settlement Date</th>
                  <th className="num">L1 Amount</th>
                  <th className="num">MPR Amount</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {group.slice(0, 50).map((r, i) => (
                  <tr key={`${r.rrn}-${i}`}>
                    <td className="mono">{r.rrn || '—'}</td>
                    <td>{r.outlet || '—'}</td>
                    <td className="mono">{r.mpr.txnDate ?? '—'}</td>
                    <td className="mono">{r.mpr.settlementDate ?? '—'}</td>
                    <td className="num">{fmt(r.plAmount)}</td>
                    <td className="num">{fmt(r.mpr.grossAmount)}</td>
                    <td>{r.mpr._source}</td>
                  </tr>
                ))}
                {group.length > 50 && (
                  <tr>
                    <td colSpan={7} className="text-ink-3 text-tiny">
                      …{group.length - 50} more
                    </td>
                  </tr>
                )}
                <tr className="total-row">
                  <td colSpan={4}>Total</td>
                  <td className="num">{fmt(group.reduce((s, r) => s + r.plAmount, 0))}</td>
                  <td className="num">{fmt(group.reduce((s, r) => s + r.mpr.grossAmount, 0))}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </PanelSection>
        ))
      )}
    </div>
  );
}

// ── Amount mismatch — flat ───────────────────────────────────────────────

function MismatchTab({ rows }: { rows: MprSessionDTO['result']['amountMismatch'] }) {
  return (
    <div className="panel">
      <PanelSection title={`Amount mismatch (${rows.length})`}>
        <table className="data-table">
          <thead>
            <tr>
              <th>RRN</th>
              <th>Outlet</th>
              <th>Acquirer</th>
              <th>Business Date</th>
              <th className="num">L1 Amount</th>
              <th className="num">MPR Amount</th>
              <th className="num">Diff</th>
              <th>L1 Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow cols={8} message="No amount mismatches." />
            ) : (
              rows.map((r, i) => (
                <tr key={`${r.rrn}-${i}`}>
                  <td className="mono">{r.rrn}</td>
                  <td>{r.outlet || '—'}</td>
                  <td>{r.acquirer || '—'}</td>
                  <td className="mono">{r._businessDate}</td>
                  <td className="num">{fmt(r.plAmount)}</td>
                  <td className="num">{fmt(r.mpr.grossAmount)}</td>
                  <td className={`num ${r._diff > 0 ? 'diff-excess' : 'diff-short'}`}>{signedFmt(r._diff)}</td>
                  <td>{r.l1Status || '—'}</td>
                </tr>
              ))
            )}
            {rows.length > 0 && (
              <tr className="total-row">
                <td colSpan={4}>Total</td>
                <td className="num">{fmt(rows.reduce((s, r) => s + r.plAmount, 0))}</td>
                <td className="num">{fmt(rows.reduce((s, r) => s + r.mpr.grossAmount, 0))}</td>
                <td className="num">{fmt(rows.reduce((s, r) => s + r._diff, 0))}</td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
      </PanelSection>
    </div>
  );
}

// ── Pending — grouped by acquirer ───────────────────────────────────────

function PendingTab({ rows }: { rows: MprSessionDTO['result']['pending'] }) {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.acquirer || 'UNKNOWN';
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  return (
    <div className="panel">
      {rows.length === 0 ? (
        <EmptyRow cols={1} message="Nothing pending." />
      ) : (
        [...groups.entries()].map(([acquirer, group]) => (
          <PanelSection key={acquirer} title={`${ACQUIRER_LABELS[acquirer] ?? acquirer} (${group.length})`}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>RRN</th>
                  <th>Outlet</th>
                  <th>Store</th>
                  <th>Business Date</th>
                  <th>L1 Date</th>
                  <th className="num">Amount</th>
                  <th>L1 Status</th>
                  <th>L1 Remark</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {group.map((r, i) => (
                  <tr key={`${r.rrn}-${i}`}>
                    <td className="mono">{r.rrn || '—'}</td>
                    <td>{r.outlet || '—'}</td>
                    <td>{r.store || '—'}</td>
                    <td className="mono">{r._businessDate}</td>
                    <td className="text-tiny text-ink-3">{normDate(r.plDate) || '—'}</td>
                    <td className="num">{fmt(r.plAmount)}</td>
                    <td>{r.l1Status || '—'}</td>
                    <td className="text-tiny text-ink-3">{r.l1Remark || '—'}</td>
                    <td>
                      <span className={`tag ${r._reason === 'No RRN' ? 'tag-warn' : 'tag-neutral'}`}>{r._reason}</span>
                    </td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td colSpan={5}>Total</td>
                  <td className="num">{fmt(group.reduce((s, r) => s + r.plAmount, 0))}</td>
                  <td />
                  <td />
                  <td />
                </tr>
              </tbody>
            </table>
          </PanelSection>
        ))
      )}
    </div>
  );
}

// ── Ambiguous — the port's own fix, no legacy equivalent screen ─────────

function AmbiguousTab({ rows }: { rows: MprSessionDTO['result']['ambiguous'] }) {
  return (
    <div className="panel">
      <div className="alert alert-warn m-5">
        <span>⚠</span>
        <span>
          These RRNs appear more than once across the uploaded MPR files, so no single candidate can be matched with
          confidence — neither is available to the primary matcher until the duplicate is resolved (e.g. remove a
          re-exported file).
        </span>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>RRN</th>
            <th>Candidates</th>
            <th className="num">Amounts</th>
            <th>Files</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow cols={4} message="No ambiguous RRNs." />
          ) : (
            rows.map((r) => (
              <tr key={r.rrn}>
                <td className="mono">{r.rrn}</td>
                <td>{r.candidates.length}</td>
                <td className="num">{r.candidates.map((c) => fmt(c.grossAmount)).join(', ')}</td>
                <td className="text-tiny text-ink-3">{r.candidates.map((c) => c._file).join(', ')}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Unexpected — grouped by MPR source ──────────────────────────────────

function UnexpectedTab({ rows }: { rows: MprSessionDTO['result']['unexpected'] }) {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(r._source, [...(groups.get(r._source) ?? []), r]);

  return (
    <div className="panel">
      <div className="alert alert-info m-5">
        <span>ℹ</span>
        <span>In MPR but not in the settlement ledger. May be BOH clearances, system adjustments, or missing JSON files.</span>
      </div>
      {rows.length === 0 ? (
        <EmptyRow cols={1} message="No unexpected MPR credits." />
      ) : (
        [...groups.entries()].map(([source, group]) => (
          <PanelSection key={source} title={`${ACQUIRER_LABELS[source] ?? source} (${group.length})`}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>RRN</th>
                  <th>Txn Date</th>
                  <th>Settlement Date</th>
                  <th className="num">MPR Amount</th>
                  <th>File</th>
                </tr>
              </thead>
              <tbody>
                {group.map((r, i) => (
                  <tr key={`${r.rrn}-${i}`}>
                    <td className="mono">{r.rrn || '—'}</td>
                    <td className="text-tiny text-ink-3">{r.mprTxnDate ?? '—'}</td>
                    <td className="text-tiny text-ink-3">{r.mprDate ?? '—'}</td>
                    <td className="num">{fmt(r.mprAmount)}</td>
                    <td className="text-tiny text-ink-3">{r._file}</td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td colSpan={3}>Total</td>
                  <td className="num">{fmt(group.reduce((s, r) => s + r.mprAmount, 0))}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </PanelSection>
        ))
      )}
    </div>
  );
}

// ── AMEX — reconciled vs not-reconciled, 4-way status ───────────────────

const AMEX_STATUS: Record<
  MprSessionDTO['result']['amexResults'][number]['_match'],
  { tag: string; label: string }
> = {
  settled: { tag: 'tag-ok', label: '✓ Matched' },
  mismatch: { tag: 'tag-warn', label: '⚠ Mismatch' },
  unexpected: { tag: 'tag-pur', label: '❓ Unexpected' },
  pending: { tag: 'tag-accent', label: '⏳ Pending' },
};

function AmexTab({ rows }: { rows: MprSessionDTO['result']['amexResults'] }) {
  const reconciled = rows.filter((r) => r._match === 'settled');
  const mismatch = rows.filter((r) => r._match === 'mismatch');
  const pending = rows.filter((r) => r._match === 'pending');
  const unexpected = rows.filter((r) => r._match === 'unexpected');
  const notReconciled = [...mismatch, ...pending, ...unexpected];

  const table = (group: typeof rows) => (
    <table className="data-table">
      <thead>
        <tr>
          <th>Outlet</th>
          <th>MID</th>
          <th>DBA Name</th>
          <th>Submission Date</th>
          <th>L1 Timestamp</th>
          <th className="num">Txn Count</th>
          <th className="num">L1 Total</th>
          <th className="num">MPR Amount</th>
          <th className="num">Diff (PR−MPR)</th>
          <th>SOC No.</th>
          <th>SOC Expected</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {group.length === 0 ? (
          <EmptyRow cols={12} message="None." />
        ) : (
          group.map((r, i) => {
            const diff = r.mprRow ? (r.l1Total ?? 0) - r.mprRow.submissionAmount : null;
            const d = directionalFmt(diff);
            const status = AMEX_STATUS[r._match];
            return (
              <tr key={`${r.mid}-${i}`}>
                <td>{r.outlet || '—'}</td>
                <td className="mono">{r.mid || '—'}</td>
                <td>{r.dbaName || r.mprRow?.dbaName || '—'}</td>
                <td className="mono">{r.date ?? '—'}</td>
                <td className="text-tiny text-ink-3">{r.timestamp ?? '—'}</td>
                <td className="num">{r.txnCount ?? '—'}</td>
                <td className="num">{r.l1Total != null ? fmt(r.l1Total) : '—'}</td>
                <td className="num">{r.mprRow ? fmt(r.mprRow.submissionAmount) : '—'}</td>
                <td className={`num ${diff != null && !d.ok ? (diff > 0 ? 'diff-excess' : 'diff-short') : ''}`}>
                  {d.ok ? <span className="diff-excess">✓</span> : d.text}
                </td>
                <td className="mono">{r.socNumber || '—'}</td>
                <td>
                  {r.socExpected == null ? (
                    '—'
                  ) : (
                    <span className="text-tiny text-ink-3">
                      {r.socExpected}
                      {r.socMatch != null && (
                        <span className={r.socMatch ? 'diff-excess' : 'diff-short'}> {r.socMatch ? '✓' : '✗'}</span>
                      )}
                    </span>
                  )}
                </td>
                <td>
                  <span className={`tag ${status.tag}`}>{status.label}</span>
                </td>
              </tr>
            );
          })
        )}
        {group.length > 0 && (
          <tr className="total-row">
            <td colSpan={6}>Total</td>
            <td className="num">{fmt(group.reduce((s, r) => s + (r.l1Total || 0), 0))}</td>
            <td className="num">{fmt(group.reduce((s, r) => s + (r.mprRow?.submissionAmount || 0), 0))}</td>
            <td
              className={`num ${
                Math.abs(
                  group.reduce((s, r) => s + (r.l1Total || 0), 0) -
                    group.reduce((s, r) => s + (r.mprRow?.submissionAmount || 0), 0),
                ) > 0.5
                  ? 'diff-short'
                  : 'diff-excess'
              }`}
            >
              {signedFmt(
                group.reduce((s, r) => s + (r.l1Total || 0), 0) -
                  group.reduce((s, r) => s + (r.mprRow?.submissionAmount || 0), 0),
              )}
            </td>
            <td colSpan={3} />
          </tr>
        )}
      </tbody>
    </table>
  );

  return (
    <div className="panel">
      <PanelSection
        title={`Reconciled (${reconciled.length})`}
      >
        <p className="text-tiny text-ink-3 mb-2">matched by MID + Submission Date + Amount ±₹1</p>
        {table(reconciled)}
      </PanelSection>
      <PanelSection title={`Not reconciled (${notReconciled.length})`}>
        <p className="text-tiny text-ink-3 mb-2">
          {mismatch.length} mismatch · {pending.length} pending · {unexpected.length} unexpected
        </p>
        {table(notReconciled)}
      </PanelSection>
    </div>
  );
}

// ── HDFC Static UPI — settled / partial / mismatch / pending, each with its
//    own legacy column set ───────────────────────────────────────────────

type UpiRow = MprSessionDTO['result']['upiResults'][number];

function prRowsOf(r: UpiRow) {
  return Array.isArray(r.pr) ? r.pr : [r.pr];
}
function prOutlet(r: UpiRow): string {
  const first = prRowsOf(r)[0] as { outlet?: string } | undefined;
  return first?.outlet || '—';
}
function prOrderNos(r: UpiRow): string {
  return prRowsOf(r)
    .map((p) => (p as { orderNo?: string })?.orderNo || '—')
    .join(', ');
}
function prRRNs(r: UpiRow): string {
  const valid = prRowsOf(r)
    .map((p) => (p as { rrn?: string })?.rrn || '')
    .filter(Boolean);
  return valid.length ? valid.join(', ') : r.mpr?.rrn || '—';
}
function prDate(r: UpiRow): string {
  const first = prRowsOf(r)[0] as { date?: string } | undefined;
  return first?.date || '—';
}
function prTotal(r: UpiRow): number {
  return prRowsOf(r).reduce((s, p) => s + ((p as { amount?: number })?.amount || 0), 0);
}
function prBusinessDate(r: UpiRow): string {
  const first = prRowsOf(r)[0] as { _businessDate?: string } | undefined;
  return first?._businessDate || '—';
}

/** legacy `timePill` — raw seconds + a <1/1-5/>5 min tag. */
function TimeDiffPill({ seconds }: { seconds: number }) {
  const cls = seconds < 60 ? 'tag-ok' : seconds < 300 ? 'tag-warn' : 'tag-err';
  const label = seconds < 60 ? '<1 min' : seconds < 300 ? '1-5 min' : '>5 min';
  return (
    <span>
      {seconds}s <span className={`tag ${cls} ml-1`}>{label}</span>
    </span>
  );
}

function SettledLikeTable({ rows }: { rows: UpiRow[] }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Outlet</th>
          <th>Order No(s)</th>
          <th>RRN(s)</th>
          <th>PR Date</th>
          <th>Date adj?</th>
          <th className="num">PR Total</th>
          <th>MPR Txn Date</th>
          <th className="num">MPR Amount</th>
          <th>Time diff</th>
          <th>Match by</th>
          <th>GM Note</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{prOutlet(r)}</td>
            <td className="mono">{prOrderNos(r)}</td>
            <td className="mono">{prRRNs(r)}</td>
            <td className="text-tiny text-ink-3">{prDate(r)}</td>
            <td>{r._dateAdjusted ? <span className="tag tag-warn">+1 day</span> : '—'}</td>
            <td className="num">{fmt(prTotal(r))}</td>
            <td className="text-tiny text-ink-3">{r.mpr?.txnDateRaw || r.mpr?.txnDate || '—'}</td>
            <td className="num">{r.mpr ? fmt(r.mpr.grossAmount) : '—'}</td>
            <td>{r._timeDiffSec != null ? <TimeDiffPill seconds={r._timeDiffSec} /> : '—'}</td>
            <td>
              <span className="tag tag-ok">{r._matchBy || '—'}</span>
            </td>
            <td className="text-tiny text-ink-3">{r._gmNote || ''}</td>
          </tr>
        ))}
        <tr className="total-row">
          <td colSpan={5}>Total</td>
          <td className="num">{fmt(rows.reduce((s, r) => s + prTotal(r), 0))}</td>
          <td />
          <td className="num">{fmt(rows.reduce((s, r) => s + (r.mpr?.grossAmount || 0), 0))}</td>
          <td colSpan={3} />
        </tr>
      </tbody>
    </table>
  );
}

function UpiTab({ rows }: { rows: MprSessionDTO['result']['upiResults'] }) {
  const settled = rows.filter((r) => r._match === 'settled');
  const partial = rows.filter((r) => r._match === 'partial');
  const mismatch = rows.filter((r) => r._match === 'mismatch');
  const pending = rows.filter((r) => r._match === 'pending');

  if (rows.length === 0) {
    return (
      <div className="panel">
        <EmptyRow cols={1} message="No HDFC Static UPI data." />
      </div>
    );
  }

  return (
    <div className="panel">
      {settled.length > 0 && (
        <PanelSection title={`✓ Settled — ${settled.length} transaction${settled.length > 1 ? 's' : ''}`}>
          <SettledLikeTable rows={settled} />
        </PanelSection>
      )}

      {partial.length > 0 && (
        <PanelSection title={`⚠ Partial match — needs review — ${partial.length} row${partial.length > 1 ? 's' : ''}`}>
          <div className="alert alert-warn m-5">
            <span>⚠</span>
            <span>
              One or more RRNs in the MPR field are not 12 digits (fat-finger). The valid RRNs and amounts reconcile,
              but the invalid RRN(s) must be verified with HDFC.
            </span>
          </div>
          <SettledLikeTable rows={partial} />
        </PanelSection>
      )}

      {mismatch.length > 0 && (
        <PanelSection title={`⚠ Amount mismatch — ${mismatch.length} transaction${mismatch.length > 1 ? 's' : ''}`}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Outlet</th>
                <th>Order No(s)</th>
                <th>RRN(s)</th>
                <th>PR Date</th>
                <th className="num">PR Amount</th>
                <th className="num">MPR Amount</th>
                <th className="num">Diff (PR−MPR)</th>
              </tr>
            </thead>
            <tbody>
              {mismatch.map((r, i) => {
                const d = directionalFmt(r._diff);
                return (
                  <tr key={i}>
                    <td>{prOutlet(r)}</td>
                    <td className="mono">{prOrderNos(r)}</td>
                    <td className="mono">{prRRNs(r)}</td>
                    <td className="text-tiny text-ink-3">{prDate(r)}</td>
                    <td className="num">{fmt(prTotal(r))}</td>
                    <td className="num">{r.mpr ? fmt(r.mpr.grossAmount) : '—'}</td>
                    <td className={`num ${d.ok ? 'diff-excess' : r._diff != null && r._diff > 0 ? 'diff-excess' : 'diff-short'}`}>
                      {d.text}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </PanelSection>
      )}

      {pending.length > 0 && (
        <PanelSection title={`⏳ Pending — ${pending.length} PR transaction${pending.length > 1 ? 's' : ''} not found in MPR`}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Outlet</th>
                <th>Order No</th>
                <th>RRN</th>
                <th>Business Date</th>
                <th>PR Date (raw)</th>
                <th>GM Note</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((r, i) => (
                <tr key={i}>
                  <td>{prOutlet(r)}</td>
                  <td className="mono">{prOrderNos(r)}</td>
                  <td className="mono">{prRRNs(r)}</td>
                  <td className="text-tiny text-ink-3">{prBusinessDate(r)}</td>
                  <td className="text-tiny text-ink-3">{prDate(r)}</td>
                  <td className="text-tiny text-ink-3 italic">{r._gmNote || ''}</td>
                  <td className="num">{fmt(prTotal(r))}</td>
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={6}>Total</td>
                <td className="num">{fmt(pending.reduce((s, r) => s + prTotal(r), 0))}</td>
              </tr>
            </tbody>
          </table>
        </PanelSection>
      )}
    </div>
  );
}
