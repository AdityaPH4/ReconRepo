'use client';

/**
 * HDFC Payment Link — transaction-level reconciliation.
 * Mirrors `HdfcUpiPanel.tsx` exactly, but keyed by ARN (Acquirer Reference
 * Number) rather than a UPI RRN — see
 * `packages/recon-core/src/parsers/hdfcPaymentLink.ts`'s own doc comment.
 * Displayed as "ARN" throughout this panel, not "RRN", even though the
 * underlying field/type is still named `rrn` (the generic join-key name
 * every `MatchResult<T>` source uses). Only rendered when a Payment Link
 * report was uploaded (`linkStmt` non-null) — otherwise HDFC Link stays
 * entirely on the aggregate drawer-comparison flow
 * (`AggregateJustificationPanel`), shown instead of this panel, not
 * alongside it. `buildHdfcLinkItems` assigns the same
 * `LPOS-N`/`LSTMT-N`/`LMM-N`/`LDUP-N` `globalId` scheme the API's
 * completeness check uses, so a remark or square-off entered here resolves
 * the same row the submit gate is checking.
 */

import type { Jsonified } from '@toit/contracts';
import type { MatchResult, PaymentLinkRow, ResolvableItem } from '@toit/recon-core/display';
import {
  AMOUNT_EPSILON,
  buildHdfcLinkItems,
  fmt,
  fmtDate,
  hdfcLinkCompleteness,
  isSquareOffResolved,
} from '@toit/recon-core/display';
import { useMemo, useState } from 'react';
import { useJustification } from '@/components/justification/JustificationProvider';
import { RemarkCell } from '@/components/justification/RemarkCell';
import { EmptyRow, PanelSection, diffClass } from '@/components/ui/table';

type LinkStmt = Jsonified<MatchResult<PaymentLinkRow>>;
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

export function HdfcLinkPanel({ linkStmt }: { linkStmt: LinkStmt }) {
  const { session } = useJustification();
  const [sub, setSub] = useState<SubTab>('unreconciled');

  const mismatched = useMemo(
    () => linkStmt.reconRows.filter((x) => Math.abs(x.diff ?? 0) > AMOUNT_EPSILON),
    [linkStmt.reconRows],
  );
  const matched = useMemo(
    () => linkStmt.reconRows.filter((x) => Math.abs(x.diff ?? 0) <= AMOUNT_EPSILON),
    [linkStmt.reconRows],
  );
  const allItems = useMemo(() => buildHdfcLinkItems(linkStmt as never), [linkStmt]);

  const items = useMemo(() => {
    let cursor = 0;
    const take = (n: number) => {
      const slice = allItems.slice(cursor, cursor + n);
      cursor += n;
      return slice;
    };
    return {
      onlyPOS: take(linkStmt.onlyPOS.length),
      onlyTerm: take(linkStmt.onlyTerm.length),
      mismatch: take(mismatched.length),
      dupRRN: take(linkStmt.dupRRN.length),
    };
  }, [allItems, linkStmt, mismatched.length]);

  const rowFadeStyle = (globalId: string): { opacity: number } | undefined =>
    isSquareOffResolved(session.justification.squareOff, globalId, allItems, session.justification.entries)
      ? { opacity: 0.55 }
      : undefined;

  const buckets: Array<{ label: string; rows: BucketRow[] }> = [
    {
      label: 'Only in Payment Report',
      rows: linkStmt.onlyPOS.map((x, i): BucketRow => ({
        key: `lpos-${i}`,
        tagLabel: 'Only in Payment Report',
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
      rows: linkStmt.onlyTerm.map((x, i): BucketRow => ({
        key: `lstmt-${i}`,
        tagLabel: 'Only in Statement',
        tagClass: 'tag-pur',
        rrn: x.rrn || '—',
        orderNo: x.merchantOrderId || '—',
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
        key: `lmm-${i}`,
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
      label: 'Duplicate ARN',
      rows: linkStmt.dupRRN.map((x, i): BucketRow => ({
        key: `ldup-${i}`,
        tagLabel: 'Duplicate ARN',
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
  // not (matches `HdfcUpiPanel` — a remarked/squared-off row stays visible,
  // just faded); `totalUnreconciled` describes that. The sub-tab badge,
  // though, is the live "still needs action" figure — `hdfcLinkCompleteness`'s
  // `unresolvedCount` covers onlyPOS/onlyTerm/mismatch, plus a live
  // dupRRN-unresolved count since the completeness check never includes
  // that bucket (see `items.ts`'s own `dupRRN` doc comment).
  const totalUnreconciled = buckets.reduce((s, b) => s + b.rows.length, 0);
  const linkCompleteness = hdfcLinkCompleteness(
    linkStmt as never,
    session.justification.entries,
    session.justification.squareOff,
  );
  const dupRRNUnresolved = items.dupRRN.filter(
    (item) =>
      !session.justification.entries.some((e) => e.source === 'hdfc_link_stmt' && e.targetKey === item.targetKey),
  ).length;
  const liveUnresolvedCount = (linkCompleteness?.unresolvedCount ?? 0) + dupRRNUnresolved;

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
                <th className="w-[13%]">Category / ID</th>
                <th className="w-[7%]">ARN</th>
                <th className="w-[7%]">Order(s)</th>
                <th className="w-[11%]">Date / Time</th>
                <th className="w-[13%] num">Payment Report</th>
                <th className="w-[8%] num">Statement</th>
                <th className="w-[10%] num">Diff</th>
                <th className="w-[31%]">Action</th>
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
                            <td className={`num whitespace-nowrap ${diffClass(r.diff)}`}>
                              {r.diff === null ? '—' : `${r.diff > 0 ? '+' : ''}${fmt(r.diff)}`}
                            </td>
                            <td>
                              <RemarkCell source="hdfc_link_stmt" item={r.item} allItems={allItems} />
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
                <th className="w-[17%]">ARN</th>
                <th className="w-[26%]">Order No(s)</th>
                <th className="w-[18%] num">Statement amount</th>
                <th className="w-[21%] num">Payment Report amount</th>
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
