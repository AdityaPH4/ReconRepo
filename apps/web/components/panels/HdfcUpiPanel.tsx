'use client';

/**
 * HDFC Static UPI — transaction-level reconciliation.
 * Ported from `reconciliation (68).html`'s `renderUPIHdfcSection`
 * (2288–2437, sits above the aggregate UPI form).
 *
 * Only rendered when an HDFC statement was uploaded (`upiHdfc` non-null) —
 * otherwise Static UPI stays entirely on the aggregate drawer-comparison flow
 * (`AggregateJustificationPanel`). Mirrors `PinelabsPanel`'s structure
 * exactly: one continuous Unreconciled table (bucket-header divider rows,
 * one column set, a Category/ID tag per row) and one Reconciled table —
 * legacy never splits either into several per-bucket tables. `buildHdfcUpiItems`
 * assigns the same `UPOS-N`/`USTMT-N`/`UMM-N`/`UDUP-N` `globalId` scheme the
 * API's completeness check uses, so a remark or square-off entered here
 * resolves the same row the submit gate is checking.
 */

import type { Jsonified } from '@toit/contracts';
import type { HdfcStatementRow, MatchResult, ResolvableItem } from '@toit/recon-core/display';
import {
  AMOUNT_EPSILON,
  buildHdfcUpiItems,
  fmt,
  fmtDate,
  hdfcUpiCompleteness,
  isSquareOffResolved,
} from '@toit/recon-core/display';
import { useMemo, useState } from 'react';
import { useJustification } from '@/components/justification/JustificationProvider';
import { RemarkCell } from '@/components/justification/RemarkCell';
import { EmptyRow, PanelSection, diffClass } from '@/components/ui/table';

type UpiHdfc = Jsonified<MatchResult<HdfcStatementRow>>;
type SubTab = 'unreconciled' | 'reconciled';

interface BucketRow {
  key: string;
  tagLabel: string;
  tagClass: string;
  rrn: string;
  orderNo: string;
  date: string | null | undefined;
  pr: number | null;
  statement: number | null;
  diff: number | null;
  item: ResolvableItem;
}

export function HdfcUpiPanel({ upiHdfc }: { upiHdfc: UpiHdfc }) {
  const { session } = useJustification();
  const [sub, setSub] = useState<SubTab>('unreconciled');

  const mismatched = useMemo(
    () => upiHdfc.reconRows.filter((x) => Math.abs(x.diff ?? 0) > AMOUNT_EPSILON),
    [upiHdfc.reconRows],
  );
  const matched = useMemo(
    () => upiHdfc.reconRows.filter((x) => Math.abs(x.diff ?? 0) <= AMOUNT_EPSILON),
    [upiHdfc.reconRows],
  );
  const allItems = useMemo(() => buildHdfcUpiItems(upiHdfc as never), [upiHdfc]);

  const items = useMemo(() => {
    let cursor = 0;
    const take = (n: number) => {
      const slice = allItems.slice(cursor, cursor + n);
      cursor += n;
      return slice;
    };
    return {
      onlyPOS: take(upiHdfc.onlyPOS.length),
      onlyTerm: take(upiHdfc.onlyTerm.length),
      mismatch: take(mismatched.length),
      dupRRN: take(upiHdfc.dupRRN.length),
    };
  }, [allItems, upiHdfc, mismatched.length]);

  const rowFadeStyle = (globalId: string): { opacity: number } | undefined =>
    isSquareOffResolved(session.justification.squareOff, globalId, allItems) ? { opacity: 0.55 } : undefined;

  const buckets: Array<{ label: string; rows: BucketRow[] }> = [
    {
      label: 'Only in PR',
      rows: upiHdfc.onlyPOS.map((x, i): BucketRow => ({
        key: `upos-${i}`,
        tagLabel: 'Only in PR',
        tagClass: 'tag-short',
        rrn: x.rrn || '—',
        orderNo: (x.orders ?? [x.orderNo]).filter(Boolean).join(', '),
        date: x.date,
        pr: x.amount ?? 0,
        statement: null,
        diff: -(x.amount ?? 0),
        item: items.onlyPOS[i]!,
      })),
    },
    {
      label: 'Only in Statement',
      rows: upiHdfc.onlyTerm.map((x, i): BucketRow => ({
        key: `ustmt-${i}`,
        tagLabel: 'Only in Statement',
        tagClass: 'tag-pur',
        rrn: x.rrn || '—',
        orderNo: '—',
        date: x.dateRaw,
        pr: null,
        statement: x.amount ?? 0,
        diff: +(x.amount ?? 0),
        item: items.onlyTerm[i]!,
      })),
    },
    {
      label: 'Amount mismatch',
      rows: mismatched.map((x, i): BucketRow => ({
        key: `umm-${i}`,
        tagLabel: 'Mismatch',
        tagClass: 'tag-warn',
        rrn: x.rrn || '—',
        orderNo: (x.orders ?? []).join(', '),
        date: null,
        pr: x.prAmt,
        statement: x.plAmt,
        diff: x.diff,
        item: items.mismatch[i]!,
      })),
    },
    {
      label: 'Duplicate RRN',
      rows: upiHdfc.dupRRN.map((x, i): BucketRow => ({
        key: `udup-${i}`,
        tagLabel: 'Duplicate RRN',
        tagClass: 'tag-accent',
        rrn: x.rrn || '',
        orderNo: (x.orders ?? []).join(', '),
        date: x.date,
        pr: null,
        statement: x.amount ?? 0,
        diff: null,
        item: items.dupRRN[i]!,
      })),
    },
  ];
  // The bucket table below always lists every row structurally, resolved or
  // not (matches legacy — a remarked/squared-off row stays visible, just
  // faded); `totalUnreconciled` describes that. The sub-tab badge, though, is
  // the live "still needs action" figure — `hdfcUpiCompleteness`'s
  // `unresolvedCount` covers onlyPOS/onlyTerm/mismatch (the same one the
  // submit gate uses), plus a live dupRRN-unresolved count since
  // `getHdfcCompleteness` never includes that bucket (see `items.ts`).
  const totalUnreconciled = buckets.reduce((s, b) => s + b.rows.length, 0);
  const hdfcCompleteness = hdfcUpiCompleteness(
    upiHdfc as never,
    session.justification.entries,
    session.justification.squareOff,
  );
  const dupRRNUnresolved = items.dupRRN.filter(
    (item) => !session.justification.entries.some((e) => e.source === 'upi_hdfc' && e.targetKey === item.targetKey),
  ).length;
  const liveUnresolvedCount = (hdfcCompleteness?.unresolvedCount ?? 0) + dupRRNUnresolved;

  return (
    <div className="panel">
      <div className="subtabs">
        <button
          type="button"
          className={`subtab${sub === 'unreconciled' ? ' subtab-active' : ''}`}
          onClick={() => setSub('unreconciled')}
        >
          Unreconciled
          <span className="badge badge-err">{liveUnresolvedCount}</span>
        </button>
        <button
          type="button"
          className={`subtab${sub === 'reconciled' ? ' subtab-active' : ''}`}
          onClick={() => setSub('reconciled')}
        >
          Reconciled
          <span className="badge badge-ok">{matched.length}</span>
        </button>
      </div>

      {sub === 'unreconciled' ? (
        <PanelSection title={`Unreconciled — ${totalUnreconciled} item${totalUnreconciled === 1 ? '' : 's'}`}>
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-[12%]">Category / ID</th>
                <th className="w-[8%]">RRN</th>
                <th className="w-[8%]">Order(s)</th>
                <th className="w-[13%]">Date / Time</th>
                <th className="w-[8%] num">PR</th>
                <th className="w-[8%] num">Statement</th>
                <th className="w-[7%] num">Diff</th>
                <th className="w-[36%]">Action</th>
              </tr>
            </thead>
            <tbody>
              {totalUnreconciled === 0 ? (
                <EmptyRow cols={8} message="Everything matched — no gaps to explain." icon="✓" />
              ) : (
                buckets.map(
                  (bucket) =>
                    bucket.rows.length > 0 && (
                      <>
                        <tr key={`${bucket.label}-header`} className="bucket-header-row">
                          <td colSpan={8}>
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
                            <td>{r.orderNo}</td>
                            <td className="text-ink-3 text-micro whitespace-nowrap">{r.date ? fmtDate(r.date) : '—'}</td>
                            <td className="num">{r.pr === null ? '—' : fmt(r.pr)}</td>
                            <td className="num">{r.statement === null ? '—' : fmt(r.statement)}</td>
                            <td className={`num ${diffClass(r.diff)}`}>
                              {r.diff === null ? '—' : `${r.diff > 0 ? '+' : ''}${fmt(r.diff)}`}
                            </td>
                            <td>
                              <RemarkCell source="upi_hdfc" item={r.item} allItems={allItems} />
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
                <th className="w-[20%]">RRN</th>
                <th className="w-[26%]">Order No(s)</th>
                <th className="w-[18%] num">Statement amount</th>
                <th className="w-[18%] num">PR amount</th>
                <th className="w-[18%]">Status</th>
              </tr>
            </thead>
            <tbody>
              {matched.length === 0 ? (
                <EmptyRow cols={5} message="No reconciled transactions." />
              ) : (
                <>
                  {matched.map((x) => (
                    <tr key={x.rrn}>
                      <td className="mono">{x.rrn || '—'}</td>
                      <td>{(x.orders ?? []).join(', ')}</td>
                      <td className="num">{fmt(x.plAmt)}</td>
                      <td className="num">{fmt(x.prAmt)}</td>
                      <td>
                        <span className="tag tag-ok">✓ Matched</span>
                      </td>
                    </tr>
                  ))}
                  <tr className="total-row">
                    <td colSpan={2}>Total ({matched.length} rows)</td>
                    <td className="num">{fmt(matched.reduce((s, x) => s + (x.plAmt ?? 0), 0))}</td>
                    <td className="num">{fmt(matched.reduce((s, x) => s + (x.prAmt ?? 0), 0))}</td>
                    <td />
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </PanelSection>
      )}
    </div>
  );
}
