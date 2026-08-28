'use client';

/**
 * HDFC Static UPI — transaction-level reconciliation.
 * Ported from `reconciliation (68).html`'s `renderUPIHdfcSection`
 * (sits above the aggregate UPI form, lines ~2200–2440).
 *
 * Only rendered when an HDFC statement was uploaded (`upiHdfc` non-null) —
 * otherwise Static UPI stays entirely on the aggregate drawer-comparison flow
 * (`AggregateJustificationPanel`). Reuses the exact same `RemarkCell`
 * mechanism as `PinelabsPanel` — `buildHdfcUpiItems` assigns the same
 * `UPOS-N`/`USTMT-N`/`UMM-N` `globalId` scheme the API's completeness check
 * uses, so a remark or square-off entered here resolves the same row the
 * submit gate is checking.
 */

import type { Jsonified } from '@toit/contracts';
import type { HdfcStatementRow, MatchResult } from '@toit/recon-core/display';
import { buildHdfcUpiItems, fmt, fmtDate } from '@toit/recon-core/display';
import { useMemo } from 'react';
import { RemarkCell } from '@/components/justification/RemarkCell';
import { DiffTag, EmptyRow, PanelSection, diffClass } from '@/components/ui/table';

type UpiHdfc = Jsonified<MatchResult<HdfcStatementRow>>;

export function HdfcUpiPanel({ upiHdfc }: { upiHdfc: UpiHdfc }) {
  const mismatched = useMemo(
    () => upiHdfc.reconRows.filter((x) => Math.abs(x.diff ?? 0) > 0.5),
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
    };
  }, [allItems, upiHdfc, mismatched.length]);

  return (
    <div className="panel">
      <PanelSection title="HDFC Static UPI — amount mismatch">
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-[18%]">RRN</th>
              <th className="w-[14%] num">Statement</th>
              <th className="w-[14%] num">POS</th>
              <th className="w-[14%] num">Difference</th>
              <th className="w-[16%]">Type</th>
              <th className="w-[24%]">Remark</th>
            </tr>
          </thead>
          <tbody>
            {mismatched.length === 0 ? (
              <EmptyRow cols={6} message="No amount mismatches." />
            ) : (
              mismatched.map((x, i) => (
                <tr key={x.rrn}>
                  <td className="mono">{x.rrn}</td>
                  <td className="num">{fmt(x.plAmt)}</td>
                  <td className="num">{fmt(x.prAmt)}</td>
                  <td className={`num ${diffClass(x.diff)}`}>{fmt(x.diff)}</td>
                  <td>
                    <DiffTag diff={x.diff ?? 0} />
                  </td>
                  <td>
                    <RemarkCell source="upi_hdfc" item={items.mismatch[i]!} allItems={allItems} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </PanelSection>

      <PanelSection title="Only in POS — no statement record">
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-[16%]">RRN</th>
              <th className="w-[18%]">Order no</th>
              <th className="w-[14%] num">Amount</th>
              <th className="w-[26%]">Note</th>
              <th className="w-[26%]">Remark</th>
            </tr>
          </thead>
          <tbody>
            {upiHdfc.onlyPOS.length === 0 ? (
              <EmptyRow cols={5} message="Every POS row found a statement match." />
            ) : (
              upiHdfc.onlyPOS.map((x, i) => (
                <tr key={`${x.rrn}-${x.orderNo}-${i}`}>
                  <td className="mono">{x.rrn || '—'}</td>
                  <td>{(x.orders ?? [x.orderNo]).filter(Boolean).join(', ')}</td>
                  <td className="num">{fmt(x.amount)}</td>
                  <td className="text-ink-3 text-tiny">{x._note || '—'}</td>
                  <td>
                    <RemarkCell source="upi_hdfc" item={items.onlyPOS[i]!} allItems={allItems} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </PanelSection>

      <PanelSection title="Only in HDFC statement — no POS record">
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-[18%]">RRN</th>
              <th className="w-[16%] num">Amount</th>
              <th className="w-[20%]">Date</th>
              <th className="w-[16%]">Payer</th>
              <th className="w-[30%]">Remark</th>
            </tr>
          </thead>
          <tbody>
            {upiHdfc.onlyTerm.length === 0 ? (
              <EmptyRow cols={5} message="Every statement row found a POS match." />
            ) : (
              upiHdfc.onlyTerm.map((x, i) => (
                <tr key={`${x.rrn}-${i}`}>
                  <td className="mono">{x.rrn || '—'}</td>
                  <td className="num">{fmt(x.amount)}</td>
                  <td className="mono">{fmtDate(x.dateRaw)}</td>
                  <td>{x.payer}</td>
                  <td>
                    <RemarkCell source="upi_hdfc" item={items.onlyTerm[i]!} allItems={allItems} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </PanelSection>

      {upiHdfc.dupRRN.length > 0 && (
        <PanelSection title="Ambiguous — needs a human">
          <div className="alert alert-warn m-5">
            <span>⚠</span>
            <span>Duplicated RRN on the statement side — never matched automatically.</span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-[30%]">RRN</th>
                <th className="w-[70%]">Reason</th>
              </tr>
            </thead>
            <tbody>
              {upiHdfc.dupRRN.map((x, i) => (
                <tr key={`dup-${x.rrn}-${i}`}>
                  <td className="mono">{x.rrn}</td>
                  <td className="text-warn-ink">{x._note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PanelSection>
      )}
    </div>
  );
}
