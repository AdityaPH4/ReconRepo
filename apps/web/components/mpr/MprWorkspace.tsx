'use client';

/**
 * MPR (Layer 2) results view — one tile per bank (reconciled / total ledger
 * rows) plus an Ambiguous tile, each opening its own tab.
 * Ported from `mpr-recon (10).html` lines 1310–1720 (`renderResults`/`renderTab`).
 */

import type { MprRowClosureDTO, MprSessionDTO } from '@toit/contracts';
import { bankFamily, normDate, type BankFamily } from '@toit/mpr-core';
import { useState } from 'react';
import { useCurrentUser } from '@/components/auth/AuthProvider';
import { addMprRowComment, closeMprRow, mprExportCsvUrl } from '@/lib/mprApi';
import { EmptyRow, LoadMoreSentinel, PanelSection, diffClass, useRevealOnScroll } from '@/components/ui/table';

type TabId = 'amex' | 'hdfc' | 'pinelabs' | 'kotak' | 'ambiguous';
type HdfcSub = 'hdfc_upi' | 'hdfc_dynamic' | 'hdfc_static' | 'hdfc_link';
type AmbiguousSub = 'duplicates' | 'mismatch' | 'unexpected';
type LedgerFamily = Exclude<BankFamily, 'amex'>;

const HDFC_SUBS: Array<{ id: HdfcSub; label: string }> = [
  { id: 'hdfc_upi', label: 'HDFC UPI' },
  { id: 'hdfc_dynamic', label: 'HDFC (dynamic UPI)' },
  { id: 'hdfc_static', label: 'HDFC Static UPI' },
  { id: 'hdfc_link', label: 'HDFC Link' },
];

/** `EmptyRow` is a table row — this is the same empty state where there's no table around it. */
function EmptyTable({ message }: { message: string }) {
  return (
    <table className="data-table">
      <tbody>
        <EmptyRow cols={1} message={message} />
      </tbody>
    </table>
  );
}

type Count = { done: number; total: number };
const fraction = (c: Count) => `${c.done}/${c.total}`;
const addCounts = (...cs: Count[]): Count => ({ done: cs.reduce((s, c) => s + c.done, 0), total: cs.reduce((s, c) => s + c.total, 0) });

function SubTabs<T extends string>({ tabs, active, onSelect }: { tabs: Array<{ id: T; label: string; badge: string; ok: boolean }>; active: T; onSelect: (id: T) => void }) {
  return (
    <div className="panel mb-3">
      <div className="subtabs">
        {tabs.map((t) => (
          <button key={t.id} type="button" className={`subtab${active === t.id ? ' subtab-active' : ''}`} onClick={() => onSelect(t.id)}>
            {t.label}
            <span className={`badge ${t.ok ? 'badge-ok' : 'badge-err'}`}>{t.badge}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** One bank's open ledger rows (Not in MPR / No RRN), with its reconciled count on top. */
function BankTab({
  count,
  open,
  sessionId,
  onResolved,
}: {
  count: Count;
  open: MprSessionDTO['result']['pending'];
  sessionId: string;
  onResolved: (updated: MprSessionDTO) => void;
}) {
  return (
    <>
      <p className="text-tiny text-ink-3 mb-2">
        {count.done} reconciled · {count.total - count.done} not reconciled (amount mismatches are under Ambiguous)
      </p>
      <PendingTab rows={open} sessionId={sessionId} onResolved={onResolved} />
    </>
  );
}

const ACQUIRER_LABELS: Record<string, string> = {
  KOTAK: 'Kotak',
  PINELABS: 'Pinelabs',
  HDFC_UPI: 'HDFC Static UPI',
  HDFC_LINK: 'HDFC Link',
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

export function MprWorkspace({
  session: initialSession,
  hideExport,
  exportUrl,
  afterRowChange,
}: {
  session: MprSessionDTO;
  /** Hide the CSV export link — there's no real stored session behind a synthetic (e.g. GM day-view) one for it to export. */
  hideExport?: boolean;
  /** Override the export link's URL — a pooled/synthetic session (e.g. the admin day-view) has its own dedicated export route rather than `session.meta.id`'s. */
  exportUrl?: string;
  /**
   * A row's comment/resolve call returns the one *real* session it actually
   * lives in — fine to adopt directly when this view already shows that real
   * session, but wrong for a pooled view (e.g. a GM's day-view, which spans
   * several real sessions) where adopting it would replace the whole pooled
   * result with just that one session's unfiltered data. When set, the
   * caller owns re-fetching instead, and should pass a changing `key` prop
   * alongside it so this component remounts with the refreshed session.
   */
  afterRowChange?: () => void;
}) {
  const user = useCurrentUser();
  const [session, setSession] = useState(initialSession);
  const handleResolved = afterRowChange ? () => afterRowChange() : setSession;
  const [tab, setTab] = useState<TabId>('amex');
  const [hdfcSub, setHdfcSub] = useState<HdfcSub>('hdfc_upi');
  const [ambiguousSub, setAmbiguousSub] = useState<AmbiguousSub>('duplicates');
  const { result } = session;
  // A pooled day-view scoped to one outlet — bank-side rows (duplicates, unexpected) carry no outlet, so the API leaves them out there.
  const outletScopedDay = session.meta.id.startsWith('gm-day:');

  // Reconciled = settled by the bank or resolved by an admin (status 'closed') — the same rule the GM overview counts by; total = every ledger row.
  const isDone = (r: MprRowClosureDTO) => r.status === 'closed';
  const ledgerCount = Object.fromEntries(
    (['kotak', 'pinelabs', 'hdfc_upi', 'hdfc_dynamic', 'hdfc_link'] as const).map((f) => [f, { done: 0, total: 0 }]),
  ) as Record<LedgerFamily, Count>;
  const openByFamily = Object.fromEntries(Object.keys(ledgerCount).map((f) => [f, []])) as unknown as Record<
    LedgerFamily,
    MprSessionDTO['result']['pending']
  >;
  for (const r of [...result.settled, ...result.amountMismatch, ...result.pending]) {
    const c = ledgerCount[bankFamily(r.acquirer) as LedgerFamily];
    c.total++;
    if (isDone(r)) c.done++;
  }
  for (const r of result.pending) if (!isDone(r)) openByFamily[bankFamily(r.acquirer) as LedgerFamily].push(r);
  // Static UPI is counted by POS transaction (distinct order numbers), the same unit as every other bank. A row with no POS transaction behind it is a manual entry a GM made (e.g. "Advance Received") — it stays in the Static UPI tab but never inflates the fraction.
  const realOrders = (r: MprSessionDTO['result']['upiResults'][number]) =>
    new Set(
      (Array.isArray(r.pr) ? r.pr : [r.pr]).flatMap((p) => {
        const t = p as { source?: string; orderNo?: string } | null;
        return t?.source === 'HDFC' && t.orderNo ? [t.orderNo] : [];
      }),
    );
  const staticUpi: Count = { done: 0, total: 0 };
  let manualUpiEntries = 0;
  for (const r of result.upiResults) {
    const orders = realOrders(r).size;
    if (orders === 0) manualUpiEntries++;
    staticUpi.total += orders;
    if (isDone(r)) staticUpi.done += orders;
  }
  // Denominator excludes 'unexpected' (an AMEX bank credit with no ledger counterpart), so this stays "how many of the ledger's AMEX transactions are confirmed".
  const amexLedger = result.amexResults.filter((r) => r._match !== 'unexpected');
  const amex: Count = { done: amexLedger.filter(isDone).length, total: amexLedger.length };
  const hdfcCount: Record<HdfcSub, Count> = {
    hdfc_upi: ledgerCount.hdfc_upi,
    hdfc_dynamic: ledgerCount.hdfc_dynamic,
    hdfc_static: staticUpi,
    hdfc_link: ledgerCount.hdfc_link,
  };
  const hdfc = addCounts(...Object.values(hdfcCount));
  const ambiguousCount: Record<AmbiguousSub, number> = {
    duplicates: result.ambiguous.length,
    mismatch: result.amountMismatch.length,
    unexpected: result.unexpected.length,
  };
  const ambiguousTotal = ambiguousCount.duplicates + ambiguousCount.mismatch + ambiguousCount.unexpected;

  const bankTile = (id: TabId, label: string, c: Count) => ({
    id,
    label,
    main: fraction(c),
    sub: 'reconciled / total in ledger',
    stat: (c.done < c.total ? 'err' : 'ok') as 'ok' | 'err',
  });
  const hdfcTile = {
    ...bankTile('hdfc', 'HDFC', hdfc),
    sub: `reconciled / total in ledger${manualUpiEntries ? ` · +${manualUpiEntries} manual entr${manualUpiEntries === 1 ? 'y' : 'ies'} listed separately` : ''}`,
  };

  // What each tile's total must equal: the rows the day's saved POS JSON holds. Only pooled day views carry it.
  const snapshot = session.snapshotCounts;
  const tileTotals = {
    amex: amex.total,
    kotak: ledgerCount.kotak.total,
    pinelabs: ledgerCount.pinelabs.total,
    hdfc_upi: ledgerCount.hdfc_upi.total,
    hdfc_dynamic: ledgerCount.hdfc_dynamic.total,
    hdfc_link: ledgerCount.hdfc_link.total,
    hdfc_static: staticUpi.total,
  };
  const checkRows = [
    { label: 'AMEX', keys: ['amex'] as const },
    { label: 'HDFC', keys: ['hdfc_upi', 'hdfc_dynamic', 'hdfc_static', 'hdfc_link'] as const },
    { label: 'Pinelabs', keys: ['pinelabs'] as const },
    { label: 'Kotak', keys: ['kotak'] as const },
  ].map((c) => ({
    label: c.label,
    json: snapshot ? c.keys.reduce((n, k) => n + snapshot.counts[k], 0) : 0,
    tile: c.keys.reduce((n, k) => n + tileTotals[k], 0),
  }));
  const checkFailures = checkRows.filter((c) => c.json !== c.tile);
  const tiles = [
    bankTile('amex', 'AMEX', amex),
    hdfcTile,
    bankTile('pinelabs', 'Pinelabs', ledgerCount.pinelabs),
    bankTile('kotak', 'Kotak', ledgerCount.kotak),
    {
      id: 'ambiguous' as TabId,
      label: 'Ambiguous',
      main: String(ambiguousTotal),
      sub: `${ambiguousCount.duplicates} duplicate RRN · ${ambiguousCount.mismatch} mismatch · ${ambiguousCount.unexpected} unexpected`,
      stat: (ambiguousTotal ? 'err' : 'ok') as 'ok' | 'err',
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
        {!hideExport && (
          <a className="btn" href={exportUrl ?? mprExportCsvUrl(session.meta.id)}>
            ⬇ Export CSV
          </a>
        )}
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
        {tiles.map((t) => {
          const accent = t.stat === 'err' ? 'kpi-border-err' : '';
          return (
            <button
              key={t.id}
              type="button"
              className={`kpi ${accent}${tab === t.id ? ' kpi-active' : ''}`}
              aria-pressed={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              <span className="kpi-label">{t.label}</span>
              <span className={`kpi-value ${t.stat === 'ok' ? 'kpi-value-ok' : t.stat === 'err' ? 'kpi-value-err' : ''}`}>
                {t.main}
              </span>
              <span className="kpi-note">{t.sub}</span>
            </button>
          );
        })}
      </div>

      {snapshot && snapshot.sessions > 0 && (
        <div className={`alert ${checkFailures.length ? 'alert-warn' : 'alert-info'}`} data-testid="snapshot-check">
          <span>{checkFailures.length ? '⚠' : '✓'}</span>
          <span>
            {checkFailures.length ? (
              <>
                <strong>Tile totals don&apos;t match this day&apos;s saved POS recon JSON.</strong>{' '}
                {checkFailures.map((c) => `${c.label}: JSON has ${c.json}, tiles count ${c.tile}`).join(' · ')}.{' '}
                {checkFailures.some((c) => c.json > c.tile)
                  ? 'Some JSON rows have not been through an MPR run yet (e.g. submitted after the last run).'
                  : 'The tiles hold more rows than the JSON — a re-submitted day may be double counted.'}
              </>
            ) : (
              <>
                <strong>Checked against this day&apos;s saved POS recon JSON</strong>
                {snapshot.sessions > 1 ? ` (${snapshot.sessions} sessions)` : ''}: {checkRows.map((c) => `${c.label} ${c.json}`).join(' · ')} — every tile total matches.
              </>
            )}
          </span>
        </div>
      )}

      {tab === 'amex' && <AmexTab rows={result.amexResults} sessionId={session.meta.id} onResolved={handleResolved} />}

      {tab === 'hdfc' && (
        <>
          <SubTabs
            tabs={HDFC_SUBS.map((s) => ({ ...s, badge: fraction(hdfcCount[s.id]), ok: hdfcCount[s.id].done === hdfcCount[s.id].total }))}
            active={hdfcSub}
            onSelect={setHdfcSub}
          />
          {hdfcSub === 'hdfc_static' ? (
            <UpiTab rows={result.upiResults} sessionId={session.meta.id} onResolved={handleResolved} />
          ) : (
            <BankTab count={hdfcCount[hdfcSub]} open={openByFamily[hdfcSub]} sessionId={session.meta.id} onResolved={handleResolved} />
          )}
        </>
      )}

      {tab === 'pinelabs' && (
        <BankTab count={ledgerCount.pinelabs} open={openByFamily.pinelabs} sessionId={session.meta.id} onResolved={handleResolved} />
      )}
      {tab === 'kotak' && (
        <BankTab count={ledgerCount.kotak} open={openByFamily.kotak} sessionId={session.meta.id} onResolved={handleResolved} />
      )}

      {tab === 'ambiguous' && (
        <>
          <SubTabs
            tabs={(
              [
                { id: 'duplicates', label: 'Duplicate RRNs' },
                { id: 'mismatch', label: 'Amount mismatch' },
                { id: 'unexpected', label: 'Unexpected MPR' },
              ] as const
            ).map((s) => ({ ...s, badge: String(ambiguousCount[s.id]), ok: ambiguousCount[s.id] === 0 }))}
            active={ambiguousSub}
            onSelect={setAmbiguousSub}
          />
          {outletScopedDay && ambiguousSub !== 'mismatch' && (
            <div className="alert alert-info mb-3">
              <span>ℹ</span>
              <span>
                Bank files don&apos;t say which outlet these belong to
                {user.role === 'admin' ? ' — pick "All outlets" to see them.' : ', so the admin team reviews them centrally.'}
              </span>
            </div>
          )}
          {ambiguousSub === 'duplicates' && (
            <AmbiguousTab rows={result.ambiguous} sessionId={session.meta.id} onResolved={handleResolved} />
          )}
          {ambiguousSub === 'mismatch' && (
            <MismatchTab rows={result.amountMismatch} sessionId={session.meta.id} onResolved={handleResolved} />
          )}
          {ambiguousSub === 'unexpected' && (
            <UnexpectedTab rows={result.unexpected} sessionId={session.meta.id} onResolved={handleResolved} />
          )}
        </>
      )}
    </>
  );
}

// ── Resolve — the one admin-only "close with a note" affordance shared by
//    every open-item tab. Settled rows are auto-closed at persistence time
//    with `closedBy: null` (no admin acted on them) — shown as a bare
//    "✓ Resolved" tag rather than "by null". ─────────────────────────────

export function ResolveRow({
  sessionId,
  row,
  onResolved,
}: {
  sessionId: string;
  row: MprRowClosureDTO;
  onResolved: (updated: MprSessionDTO) => void;
}) {
  const user = useCurrentUser();
  const [busy, setBusy] = useState(false);
  const comments = row.comments ?? [];

  if (row.status === 'closed') {
    return (
      <span className="tag tag-ok" title={row.closedNote ?? undefined}>
        ✓ Resolved{row.closedBy ? ` by ${row.closedBy}` : ''}
      </span>
    );
  }

  async function addComment() {
    const text = window.prompt('Add a comment on this item:');
    if (!text?.trim()) return;
    setBusy(true);
    try {
      onResolved(await addMprRowComment(sessionId, row.id, text.trim()));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to add comment.');
    } finally {
      setBusy(false);
    }
  }

  async function resolve() {
    const note = window.prompt('Resolve this item — note (required):');
    if (!note?.trim()) return;
    setBusy(true);
    try {
      onResolved(await closeMprRow(sessionId, row.id, note.trim()));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to resolve this item.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {comments.length > 0 && (
        <span
          className="tag tag-neutral"
          title={comments.map((c) => `${c.createdBy} — ${new Date(c.createdAt).toLocaleString('en-IN')}\n${c.text}`).join('\n\n')}
        >
          💬 {comments.length}
        </span>
      )}
      {user.role === 'admin' ? (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={resolve}>
          Resolve
        </button>
      ) : (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={addComment}>
          Comment
        </button>
      )}
    </div>
  );
}

// ── Amount mismatch — flat ───────────────────────────────────────────────

function MismatchTab({
  rows,
  sessionId,
  onResolved,
}: {
  rows: MprSessionDTO['result']['amountMismatch'];
  sessionId: string;
  onResolved: (updated: MprSessionDTO) => void;
}) {
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
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow cols={9} message="No amount mismatches." />
            ) : (
              rows.map((r, i) => (
                <tr key={`${r.rrn}-${i}`}>
                  <td className="mono">{r.rrn}</td>
                  <td>{r.outlet || '—'}</td>
                  <td>{r.acquirer || '—'}</td>
                  <td className="mono">{r._businessDate}</td>
                  <td className="num">{fmt(r.plAmount)}</td>
                  <td className="num">{fmt(r.mpr.grossAmount)}</td>
                  <td className={`num ${diffClass(r._diff)}`}>{signedFmt(r._diff)}</td>
                  <td>{r.l1Status || '—'}</td>
                  <td>
                    <ResolveRow sessionId={r._storageSessionId ?? sessionId} row={r} onResolved={onResolved} />
                  </td>
                </tr>
              ))
            )}
            {rows.length > 0 && (
              <tr className="total-row">
                <td colSpan={4}>Total</td>
                <td className="num">{fmt(rows.reduce((s, r) => s + r.plAmount, 0))}</td>
                <td className="num">{fmt(rows.reduce((s, r) => s + r.mpr.grossAmount, 0))}</td>
                <td className={`num ${diffClass(rows.reduce((s, r) => s + r._diff, 0))}`}>
                  {signedFmt(rows.reduce((s, r) => s + r._diff, 0))}
                </td>
                <td />
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

function PendingTab({
  rows,
  sessionId,
  onResolved,
}: {
  rows: MprSessionDTO['result']['pending'];
  sessionId: string;
  onResolved: (updated: MprSessionDTO) => void;
}) {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.acquirer || 'UNKNOWN';
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  return (
    <div className="panel">
      {rows.length === 0 ? (
        <EmptyTable message="Nothing pending." />
      ) : (
        [...groups.entries()].map(([acquirer, group]) => (
          <PendingGroupTable
            key={acquirer}
            acquirer={acquirer}
            group={group}
            sessionId={sessionId}
            onResolved={onResolved}
          />
        ))
      )}
    </div>
  );
}

/** One acquirer's pending table — a real-world group can run into the hundreds of
 * rows, so it reveals 50 at a time on scroll instead of mounting them all up front. */
function PendingGroupTable({
  acquirer,
  group,
  sessionId,
  onResolved,
}: {
  acquirer: string;
  group: MprSessionDTO['result']['pending'];
  sessionId: string;
  onResolved: (updated: MprSessionDTO) => void;
}) {
  const { visible, sentinelRef } = useRevealOnScroll(group.length);
  const shown = group.slice(0, visible);

  return (
    <PanelSection title={`${ACQUIRER_LABELS[acquirer] ?? acquirer} (${group.length})`}>
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
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
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
              <td>
                <ResolveRow sessionId={r._storageSessionId ?? sessionId} row={r} onResolved={onResolved} />
              </td>
            </tr>
          ))}
          <LoadMoreSentinel sentinelRef={sentinelRef} cols={10} remaining={group.length - visible} />
          <tr className="total-row">
            <td colSpan={5}>Total</td>
            <td className="num">{fmt(group.reduce((s, r) => s + r.plAmount, 0))}</td>
            <td />
            <td />
            <td />
            <td />
          </tr>
        </tbody>
      </table>
    </PanelSection>
  );
}

// ── Ambiguous — the port's own fix, no legacy equivalent screen ─────────

function AmbiguousTab({
  rows,
  sessionId,
  onResolved,
}: {
  rows: MprSessionDTO['result']['ambiguous'];
  sessionId: string;
  onResolved: (updated: MprSessionDTO) => void;
}) {
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
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow cols={5} message="No ambiguous RRNs." />
          ) : (
            rows.map((r) => (
              <tr key={r.rrn}>
                <td className="mono">{r.rrn}</td>
                <td>{r.candidates.length}</td>
                <td className="num">{r.candidates.map((c) => fmt(c.grossAmount)).join(', ')}</td>
                <td className="text-tiny text-ink-3">{r.candidates.map((c) => c._file).join(', ')}</td>
                <td>
                  <ResolveRow sessionId={r._storageSessionId ?? sessionId} row={r} onResolved={onResolved} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Unexpected — grouped by MPR source ──────────────────────────────────

function UnexpectedTab({
  rows,
  sessionId,
  onResolved,
}: {
  rows: MprSessionDTO['result']['unexpected'];
  sessionId: string;
  onResolved: (updated: MprSessionDTO) => void;
}) {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(r._source, [...(groups.get(r._source) ?? []), r]);

  return (
    <div className="panel">
      <div className="alert alert-info m-5">
        <span>ℹ</span>
        <span>In MPR but not in the settlement ledger. May be BOH clearances, system adjustments, or missing JSON files.</span>
      </div>
      {rows.length === 0 ? (
        <EmptyTable message="No unexpected MPR credits." />
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
                  <th />
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
                    <td>
                      <ResolveRow sessionId={r._storageSessionId ?? sessionId} row={r} onResolved={onResolved} />
                    </td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td colSpan={3}>Total</td>
                  <td className="num">{fmt(group.reduce((s, r) => s + r.mprAmount, 0))}</td>
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

// ── AMEX — reconciled vs not-reconciled, 4-way status ───────────────────

const AMEX_STATUS: Record<
  MprSessionDTO['result']['amexResults'][number]['_match'],
  { tag: string; label: string }
> = {
  settled: { tag: 'tag-ok', label: '✓ Matched' },
  mismatch: { tag: 'tag-warn', label: '⚠ Mismatch' },
  unexpected: { tag: 'tag-pur', label: '❓ Unexpected' },
  pending: { tag: 'tag-accent', label: '⏳ Pending' },
  ambiguous: { tag: 'tag-warn', label: '⚠ Ambiguous' },
};

function AmexTab({
  rows,
  sessionId,
  onResolved,
}: {
  rows: MprSessionDTO['result']['amexResults'];
  sessionId: string;
  onResolved: (updated: MprSessionDTO) => void;
}) {
  const reconciled = rows.filter((r) => r._match === 'settled');
  const mismatch = rows.filter((r) => r._match === 'mismatch');
  const pending = rows.filter((r) => r._match === 'pending');
  const unexpected = rows.filter((r) => r._match === 'unexpected');
  const ambiguous = rows.filter((r) => r._match === 'ambiguous');
  const notReconciled = [...mismatch, ...pending, ...unexpected, ...ambiguous];

  const table = (group: typeof rows) => (
    <table className="data-table">
      <thead>
        <tr>
          <th>Outlet</th>
          <th>Txn Date</th>
          <th>Card (last 4)</th>
          <th className="num">L1 Amount</th>
          <th className="num">MPR Amount</th>
          <th className="num">Diff (Payment Report−MPR)</th>
          <th>MPR Settlement Date</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {group.length === 0 ? (
          <EmptyRow cols={9} message="None." />
        ) : (
          group.map((r, i) => {
            const diff = r.mprRow ? (r.l1Amount ?? 0) - r.mprRow.amount : null;
            const d = directionalFmt(diff);
            const status = AMEX_STATUS[r._match];
            return (
              <tr key={`${r.cardLast4}-${r.date}-${i}`}>
                <td>{r.outlet || '—'}</td>
                <td className="mono">{r.date ?? '—'}</td>
                <td className="mono">{r.cardLast4 || '—'}</td>
                <td className="num">{r.l1Amount != null ? fmt(r.l1Amount) : '—'}</td>
                <td className="num">{r.mprRow ? fmt(r.mprRow.amount) : '—'}</td>
                <td className={`num ${diff != null && !d.ok ? (diff > 0 ? 'diff-excess' : 'diff-short') : ''}`}>
                  {d.ok ? <span className="diff-excess">✓</span> : d.text}
                </td>
                <td className="mono">{r.mprRow?.settlementDate ?? '—'}</td>
                <td>
                  <span className={`tag ${status.tag}`} title={r._note}>
                    {status.label}
                  </span>
                </td>
                <td>
                  <ResolveRow sessionId={r._storageSessionId ?? sessionId} row={r} onResolved={onResolved} />
                </td>
              </tr>
            );
          })
        )}
        {group.length > 0 && (() => {
          const l1Sum = group.reduce((s, r) => s + (r.l1Amount || 0), 0);
          const mprSum = group.reduce((s, r) => s + (r.mprRow?.amount || 0), 0);
          const totalDiff = l1Sum - mprSum;
          return (
            <tr className="total-row">
              <td colSpan={3}>Total</td>
              <td className="num">{fmt(l1Sum)}</td>
              <td className="num">{fmt(mprSum)}</td>
              <td className={`num ${diffClass(totalDiff)}`}>{signedFmt(totalDiff)}</td>
              <td colSpan={3} />
            </tr>
          );
        })()}
      </tbody>
    </table>
  );

  return (
    <div className="panel">
      <PanelSection title={`Reconciled (${reconciled.length})`}>{null}</PanelSection>
      <PanelSection title={`Not reconciled (${notReconciled.length})`}>
        <p className="text-tiny text-ink-3 mb-2">
          {mismatch.length} mismatch · {pending.length} pending · {unexpected.length} unexpected · {ambiguous.length} ambiguous
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

function SettledLikeTable({
  rows,
  sessionId,
  onResolved,
}: {
  rows: UpiRow[];
  sessionId: string;
  onResolved: (updated: MprSessionDTO) => void;
}) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Outlet</th>
          <th>Order No(s)</th>
          <th>RRN(s)</th>
          <th>Payment Report Date</th>
          <th>Date adj?</th>
          <th className="num">Payment Report Total</th>
          <th>MPR Txn Date</th>
          <th className="num">MPR Amount</th>
          <th>Time diff</th>
          <th>Match by</th>
          <th>GM Note</th>
          <th />
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
            <td>
              <ResolveRow sessionId={r._storageSessionId ?? sessionId} row={r} onResolved={onResolved} />
            </td>
          </tr>
        ))}
        <tr className="total-row">
          <td colSpan={5}>Total</td>
          <td className="num">{fmt(rows.reduce((s, r) => s + prTotal(r), 0))}</td>
          <td />
          <td className="num">{fmt(rows.reduce((s, r) => s + (r.mpr?.grossAmount || 0), 0))}</td>
          <td colSpan={4} />
        </tr>
      </tbody>
    </table>
  );
}

function UpiTab({
  rows,
  sessionId,
  onResolved,
}: {
  rows: MprSessionDTO['result']['upiResults'];
  sessionId: string;
  onResolved: (updated: MprSessionDTO) => void;
}) {
  const settled = rows.filter((r) => r._match === 'settled');
  const partial = rows.filter((r) => r._match === 'partial');
  const mismatch = rows.filter((r) => r._match === 'mismatch');
  const pending = rows.filter((r) => r._match === 'pending');

  if (rows.length === 0) {
    return (
      <div className="panel">
        <EmptyTable message="No HDFC Static UPI data." />
      </div>
    );
  }

  return (
    <div className="panel">
      {settled.length > 0 && (
        <PanelSection title={`✓ Settled — ${settled.length} transaction${settled.length > 1 ? 's' : ''}`}>
          <SettledLikeTable rows={settled} sessionId={sessionId} onResolved={onResolved} />
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
          <SettledLikeTable rows={partial} sessionId={sessionId} onResolved={onResolved} />
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
                <th>Payment Report Date</th>
                <th className="num">Payment Report Amount</th>
                <th className="num">MPR Amount</th>
                <th className="num">Diff (Payment Report−MPR)</th>
                <th />
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
                    <td className={`num ${diffClass(r._diff)}`}>{d.text}</td>
                    <td>
                      <ResolveRow sessionId={r._storageSessionId ?? sessionId} row={r} onResolved={onResolved} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </PanelSection>
      )}

      {pending.length > 0 && (
        <PanelSection title={`⏳ Pending — ${pending.length} Payment Report transaction${pending.length > 1 ? 's' : ''} not found in MPR`}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Outlet</th>
                <th>Order No</th>
                <th>RRN</th>
                <th>Business Date</th>
                <th>Payment Report Date (raw)</th>
                <th>GM Note</th>
                <th className="num">Amount</th>
                <th />
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
                  <td>
                    <ResolveRow sessionId={r._storageSessionId ?? sessionId} row={r} onResolved={onResolved} />
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={6}>Total</td>
                <td className="num">{fmt(pending.reduce((s, r) => s + prTotal(r), 0))}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </PanelSection>
      )}
    </div>
  );
}
