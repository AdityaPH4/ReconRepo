'use client';

/**
 * Pinelabs transaction-level panel.
 * Ported from `reconciliation (68).html` lines 371–392 (markup) and 1592–1879
 * (`renderPinelabs`).
 *
 * Both sub-tabs are one continuous table with one column set — legacy never
 * renders a separate `<table>` per bucket. Unreconciled buckets (Only in
 * POS/Only in Pinelabs/Amount mismatch/Duplicate RRN/AMEX dup — POS/AMEX dup
 * — Pinelabs) are inserted as a group-header divider row followed by that
 * bucket's own rows, each tagged with its category + `globalId` in the first
 * column (1712–1832); the Reconciled tab appends AMEX-matched rows into the
 * very same table body as the RRN-matched rows (1663–1668), not a second
 * table.
 */

import type { Jsonified } from '@toit/contracts';
import type { PinelabsResult, ResolvableItem } from '@toit/recon-core/display';
import {
  AMOUNT_EPSILON,
  buildPinelabsItems,
  fmt,
  fmtDate,
  isSquareOffResolved,
  pinelabsCompleteness,
} from '@toit/recon-core/display';
import { useMemo, useState } from 'react';
import { useJustification } from '@/components/justification/JustificationProvider';
import { RemarkCell } from '@/components/justification/RemarkCell';
import { EmptyRow, PanelSection, diffClass } from '@/components/ui/table';

type PL = Jsonified<PinelabsResult>;
type ReconRow = PL['reconRows'][number];
type SubTab = 'unreconciled' | 'reconciled';

interface BucketRow {
  key: string;
  tagLabel: string;
  tagClass: string;
  rrn: string;
  orderNo: string;
  ordersTitle: string;
  date: string | null | undefined;
  paymentName: string;
  plAmt: number | null;
  prAmt: number | null;
  diff: number | null;
  item: ResolvableItem;
}

export function PinelabsPanel({ pinelabs }: { pinelabs: PL }) {
  const { session } = useJustification();
  const [sub, setSub] = useState<SubTab>('unreconciled');
  const [search, setSearch] = useState('');

  // A row counts as reconciled if it ties within tolerance, or if it is a
  // Manual APOS row the engine auto-squared-off.
  const isReconciled = (x: ReconRow) =>
    Math.abs(x.diff ?? 0) < AMOUNT_EPSILON || x.squaredOff;

  const reconciled = useMemo(
    () => pinelabs.reconRows.filter(isReconciled),
    [pinelabs.reconRows],
  );
  const mismatched = useMemo(
    () => pinelabs.reconRows.filter((x) => !isReconciled(x)),
    [pinelabs.reconRows],
  );

  const allItems = useMemo(() => buildPinelabsItems(pinelabs as never), [pinelabs]);
  const items = useMemo(() => {
    let cursor = 0;
    const take = (n: number) => {
      const slice = allItems.slice(cursor, cursor + n);
      cursor += n;
      return slice;
    };
    return {
      onlyPOS: take(pinelabs.onlyPOS.length),
      onlyTerm: take(pinelabs.onlyTerm.length),
      mismatch: take(mismatched.length),
      dupRRN: take(pinelabs.dupRRN.length),
      amexDup: take(pinelabs.amexDup.length),
      amexDupTerm: take(pinelabs.amexDupTerm.length),
    };
  }, [allItems, pinelabs, mismatched.length]);

  const q = search.trim().toLowerCase();
  const hit = (...fields: Array<string | number | null | undefined>) =>
    !q || fields.some((f) => String(f ?? '').toLowerCase().includes(q));

  // Live, entries-aware count — a structural row count fixed at upload time
  // never shrinks as remarks/square-offs resolve rows; `unresolvedCount` is
  // the same figure the submit gate itself uses (see `canSubmit`'s `plOk`).
  const plCompleteness = pinelabsCompleteness(
    pinelabs as never,
    session.justification.entries,
    session.justification.squareOff,
  );
  const outstandingCount = plCompleteness.unresolvedCount;
  const rowFadeStyle = (globalId: string): { opacity: number } | undefined =>
    isSquareOffResolved(session.justification.squareOff, globalId, allItems) ? { opacity: 0.55 } : undefined;

  const buckets: Array<{ label: string; rows: BucketRow[] }> = [
    {
      label: 'Only in POS',
      rows: pinelabs.onlyPOS
        .map((x, i): BucketRow => {
          const orders = (x.orders ?? [x.orderNo]).filter(Boolean);
          return {
            key: `pos-${i}`,
            tagLabel: 'Only in POS',
            tagClass: 'tag-short',
            rrn: x.rrn || '—',
            orderNo: orders.join(', '),
            ordersTitle: orders.join(', '),
            date: x.date,
            paymentName: x.paymentName || '',
            plAmt: null,
            prAmt: x.amount ?? 0,
            diff: -(x.amount ?? 0),
            item: items.onlyPOS[i]!,
          };
        })
        .filter((r) => hit(r.rrn, r.orderNo, r.prAmt)),
    },
    {
      label: 'Only in Pinelabs',
      rows: pinelabs.onlyTerm
        .map((x, i): BucketRow => ({
          key: `term-${i}`,
          tagLabel: 'Only in Pinelabs',
          tagClass: 'tag-excess',
          rrn: x.rrn || '—',
          orderNo: '—',
          ordersTitle: '',
          date: x.date,
          paymentName: x.paymentMode || x.acquirer || '',
          plAmt: x.amount ?? 0,
          prAmt: null,
          diff: +(x.amount ?? 0),
          item: items.onlyTerm[i]!,
        }))
        .filter((r) => hit(r.rrn, r.plAmt)),
    },
    {
      label: 'Amount mismatch',
      rows: mismatched
        .map((x, i): BucketRow => {
          const orders = (x.orders ?? [x.pr?.orderNo]).filter(Boolean);
          return {
            key: `mm-${i}`,
            tagLabel: 'Amount mismatch',
            tagClass: 'tag-neutral',
            rrn: x.rrn,
            orderNo: orders.join(', '),
            ordersTitle: orders.join(', '),
            date: x.pr?.date,
            paymentName: x.pr?.paymentName || '',
            plAmt: x.plAmt,
            prAmt: x.prAmt,
            diff: x.diff,
            item: items.mismatch[i]!,
          };
        })
        .filter((r) => hit(r.rrn, r.orderNo, r.diff)),
    },
    {
      label: 'Duplicate RRN',
      rows: pinelabs.dupRRN
        .map((x, i): BucketRow => ({
          key: `dup-${i}`,
          tagLabel: 'Duplicate RRN',
          tagClass: 'tag-warn',
          rrn: x.rrn || '',
          orderNo: x.orderNo || '—',
          ordersTitle: '',
          date: x.date,
          paymentName: x._dupSrc || '',
          plAmt: null,
          prAmt: x.amount ?? 0,
          diff: null,
          item: items.dupRRN[i]!,
        }))
        .filter((r) => hit(r.rrn, r.orderNo)),
    },
    {
      label: 'AMEX dup — POS',
      rows: pinelabs.amexDup
        .map((x, i): BucketRow => ({
          key: `adp-${i}`,
          tagLabel: 'AMEX dup — POS',
          tagClass: 'tag-amex',
          rrn: x.pr?.authCode || '—',
          orderNo: x.pr?.orderNo || '',
          ordersTitle: '',
          date: x.pr?.date,
          paymentName: 'AMEX',
          plAmt: null,
          prAmt: x.pr?.amount ?? 0,
          diff: -(x.pr?.amount ?? 0),
          item: items.amexDup[i]!,
        }))
        .filter((r) => hit(r.orderNo, r.prAmt)),
    },
    {
      label: 'AMEX dup — Pinelabs',
      rows: pinelabs.amexDupTerm
        .map((x, i): BucketRow => ({
          key: `adpl-${i}`,
          tagLabel: 'AMEX dup — Pinelabs',
          tagClass: 'tag-amex',
          rrn: x.approvalCode || '—',
          orderNo: '—',
          ordersTitle: '',
          date: x.date,
          paymentName: 'AMEX',
          plAmt: x.amount ?? 0,
          prAmt: null,
          diff: +(x.amount ?? 0),
          item: items.amexDupTerm[i]!,
        }))
        .filter((r) => hit(r.rrn, r.plAmt)),
    },
  ];
  const totalUnreconciled = buckets.reduce((s, b) => s + b.rows.length, 0);

  return (
    <div className="panel">
      <div className="subtabs">
        <button
          type="button"
          className={`subtab${sub === 'unreconciled' ? ' subtab-active' : ''}`}
          onClick={() => setSub('unreconciled')}
        >
          Unreconciled
          <span className="badge badge-err">{outstandingCount}</span>
        </button>
        <button
          type="button"
          className={`subtab${sub === 'reconciled' ? ' subtab-active' : ''}`}
          onClick={() => setSub('reconciled')}
        >
          Reconciled
          <span className="badge badge-ok">{reconciled.length + pinelabs.amexOk.length}</span>
        </button>
      </div>

      <div className="toolbar">
        <input
          type="text"
          className="toolbar-input"
          placeholder="Search RRN, order no, amount…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {sub === 'unreconciled' ? (
        <PanelSection title={`Unreconciled — ${totalUnreconciled} item${totalUnreconciled === 1 ? '' : 's'} across ${buckets.filter((b) => b.rows.length).length} categories`}>
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-[12%]">Category / ID</th>
                <th className="w-[8%]">RRN</th>
                <th className="w-[8%]">Order No(s)</th>
                <th className="w-[13%]">Date / Time</th>
                <th className="w-[7%]">Payment name</th>
                <th className="w-[8%] num">Pinelabs</th>
                <th className="w-[8%] num">PR</th>
                <th className="w-[7%] num">Difference</th>
                <th className="w-[29%]">Remark</th>
              </tr>
            </thead>
            <tbody>
              {totalUnreconciled === 0 ? (
                <EmptyRow cols={9} message="No unreconciled transactions ✓" icon="✓" />
              ) : (
                buckets.map(
                  (bucket) =>
                    bucket.rows.length > 0 && (
                      <>
                        <tr key={`${bucket.label}-header`} className="bucket-header-row">
                          <td colSpan={9}>
                            {bucket.label}{' '}
                            <span className="text-ink-3 font-normal">
                              ({bucket.rows.length} item{bucket.rows.length > 1 ? 's' : ''})
                            </span>
                          </td>
                        </tr>
                        {bucket.rows.map((r) => (
                          <tr key={r.key} style={rowFadeStyle(r.item.globalId)}>
                            <td className="whitespace-nowrap">
                              <span className={`tag ${r.tagClass}`}>{r.tagLabel}</span>{' '}
                              <span className="mono text-ink-3 text-tiny">{r.item.globalId}</span>
                            </td>
                            <td className="mono text-tiny">{r.rrn}</td>
                            <td title={r.ordersTitle}>{r.orderNo}</td>
                            <td className="text-ink-3 text-micro whitespace-nowrap">{r.date ? fmtDate(r.date) : '—'}</td>
                            <td>{r.paymentName}</td>
                            <td className="num">{r.plAmt === null ? '—' : fmt(r.plAmt)}</td>
                            <td className="num">{r.prAmt === null ? '—' : fmt(r.prAmt)}</td>
                            <td className={`num ${diffClass(r.diff)}`}>
                              {r.diff === null ? '—' : `${r.diff > 0 ? '+' : ''}${fmt(r.diff)}`}
                            </td>
                            <td>
                              <RemarkCell source="pinelabs" item={r.item} allItems={allItems} />
                            </td>
                          </tr>
                        ))}
                      </>
                    ),
                )
              )}
            </tbody>
          </table>
        </PanelSection>
      ) : (
        <PanelSection title="Reconciled">
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-[16%]">RRN</th>
                <th className="w-[22%]">Order No(s)</th>
                <th className="w-[18%]">Payment name</th>
                <th className="w-[13%] num">Pinelabs</th>
                <th className="w-[13%] num">PR</th>
                <th className="w-[10%] num">Difference</th>
                <th className="w-[8%]">Status</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const rows = reconciled.filter((x) => hit(x.rrn, x.orders?.join(',')));
                const amexRows = pinelabs.amexOk.filter((x) =>
                  hit(x.pr?.authCode, x.pr?.orders?.join(',')),
                );
                if (rows.length === 0 && amexRows.length === 0)
                  return <EmptyRow cols={7} message="No reconciled transactions." />;
                const tPl = rows.reduce((s, x) => s + (x.plAmt ?? 0), 0) + amexRows.reduce((s, x) => s + (x.zip?.amount ?? 0), 0);
                const tPr = rows.reduce((s, x) => s + (x.prAmt ?? 0), 0) + amexRows.reduce((s, x) => s + (x.pr?.amount ?? 0), 0);
                return (
                  <>
                    {rows.map((x) => (
                      <tr key={x.rrn}>
                        <td className="mono">{x.rrn}</td>
                        <td>{(x.orders ?? []).join(', ')}</td>
                        <td>{x.pr?.paymentName}</td>
                        <td className="num">{fmt(x.plAmt)}</td>
                        <td className="num">{fmt(x.prAmt)}</td>
                        <td className={`num ${diffClass(x.diff)}`}>
                          {Math.abs(x.diff ?? 0) < AMOUNT_EPSILON ? '—' : `${(x.diff ?? 0) > 0 ? '+' : ''}${fmt(x.diff)}`}
                        </td>
                        <td>
                          {x.squaredOff ? (
                            <span className="tag tag-pur">Squared off</span>
                          ) : (
                            <span className="tag tag-ok">✓ Matched</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {amexRows.map((x, i) => (
                      <tr key={`amex-ok-${i}`}>
                        <td className="mono text-ink-3">
                          {x._matchBy === 'code' ? `AMEX·code ${x.pr?.authCode || ''}` : 'AMEX·amount'}
                        </td>
                        <td>{(x.pr?.orders ?? [x.pr?.orderNo]).filter(Boolean).join(', ')}</td>
                        <td>
                          <span className="tag tag-amex">AMEX</span>
                        </td>
                        <td className="num">{fmt(x.zip?.amount)}</td>
                        <td className="num">{fmt(x.pr?.amount)}</td>
                        <td className="num text-ink-3">—</td>
                        <td>
                          <span className="tag tag-ok">✓ Match</span>
                        </td>
                      </tr>
                    ))}
                    <tr className="total-row">
                      <td colSpan={3}>Total ({rows.length + amexRows.length} rows)</td>
                      <td className="num">{fmt(tPl)}</td>
                      <td className="num">{fmt(tPr)}</td>
                      <td colSpan={2} />
                    </tr>
                  </>
                );
              })()}
            </tbody>
          </table>
        </PanelSection>
      )}
    </div>
  );
}
