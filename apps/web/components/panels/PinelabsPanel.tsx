'use client';

/**
 * Pinelabs transaction-level panel.
 * Ported from `reconciliation (68).html` lines 371–392 (markup) and 1592–1879
 * (`renderPinelabs`).
 *
 * Every unreconciled row gets a `RemarkCell` — the shared remark/square-off
 * picker. `buildPinelabsItems` is called once, over the *unfiltered* result,
 * so each row's `globalId`/`targetKey` matches exactly what the API computed;
 * rows are zipped with their item before the search filter runs, so a search
 * query can never misalign a row with the wrong item.
 */

import type { Jsonified } from '@toit/contracts';
import type { PinelabsResult } from '@toit/recon-core/display';
import { AMOUNT_EPSILON, buildPinelabsItems, fmt, fmtDate } from '@toit/recon-core/display';
import { useMemo, useState } from 'react';
import { RemarkCell } from '@/components/justification/RemarkCell';
import { DiffTag, EmptyRow, PanelSection, diffClass } from '@/components/ui/table';

type PL = Jsonified<PinelabsResult>;
type ReconRow = PL['reconRows'][number];
type SubTab = 'unreconciled' | 'reconciled';

export function PinelabsPanel({ pinelabs }: { pinelabs: PL }) {
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

  const outstandingCount =
    mismatched.length +
    pinelabs.onlyPOS.length +
    pinelabs.onlyTerm.length +
    pinelabs.dupRRN.length +
    pinelabs.amexDup.length +
    pinelabs.amexDupTerm.length;

  const ambiguousCount =
    pinelabs.dupRRN.length + pinelabs.amexDup.length + pinelabs.amexDupTerm.length;

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
        <>
          <PanelSection title="Amount mismatch — matched RRN, different amount">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-[13%]">RRN</th>
                  <th className="w-[15%]">Order no</th>
                  <th className="w-[11%] num">Terminal</th>
                  <th className="w-[11%] num">POS</th>
                  <th className="w-[11%] num">Difference</th>
                  <th className="w-[10%]">Type</th>
                  <th className="w-[13%]">Payment name</th>
                  <th className="w-[16%]">Remark</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const rows = mismatched
                    .map((x, i) => ({ x, item: items.mismatch[i]! }))
                    .filter(({ x }) => hit(x.rrn, x.orders?.join(','), x.diff));
                  if (rows.length === 0)
                    return <EmptyRow cols={8} message="No amount mismatches." />;
                  return rows.map(({ x, item }) => (
                    <tr key={x.rrn}>
                      <td className="mono">{x.rrn}</td>
                      <td>{(x.orders ?? []).join(', ')}</td>
                      <td className="num">{fmt(x.plAmt)}</td>
                      <td className="num">{fmt(x.prAmt)}</td>
                      <td className={`num ${diffClass(x.diff)}`}>{fmt(x.diff)}</td>
                      <td>
                        <DiffTag diff={x.diff ?? 0} />
                      </td>
                      <td>{x.pr?.paymentName}</td>
                      <td>
                        <RemarkCell source="pinelabs" item={item} allItems={allItems} />
                      </td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </PanelSection>

          <PanelSection title="Only in POS — no terminal record">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-[13%]">RRN</th>
                  <th className="w-[16%]">Order no</th>
                  <th className="w-[12%] num">Amount</th>
                  <th className="w-[16%]">Payment name</th>
                  <th className="w-[22%]">Note</th>
                  <th className="w-[21%]">Remark</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const rows = pinelabs.onlyPOS
                    .map((x, i) => ({ x, item: items.onlyPOS[i]! }))
                    .filter(({ x }) => hit(x.rrn, x.orderNo, x.amount));
                  if (rows.length === 0)
                    return (
                      <EmptyRow cols={6} message="Every POS row found a terminal match." />
                    );
                  return rows.map(({ x, item }, i) => (
                    <tr key={`${x.rrn}-${x.orderNo}-${i}`}>
                      <td className="mono">{x.rrn || '—'}</td>
                      <td>{(x.orders ?? [x.orderNo]).filter(Boolean).join(', ')}</td>
                      <td className="num">{fmt(x.amount)}</td>
                      <td>{x.paymentName}</td>
                      <td className="text-ink-3 text-tiny">{x._note || '—'}</td>
                      <td>
                        <RemarkCell source="pinelabs" item={item} allItems={allItems} />
                      </td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </PanelSection>

          <PanelSection title="Only on terminal — no POS record">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-[15%]">RRN</th>
                  <th className="w-[14%]">Acquirer</th>
                  <th className="w-[12%] num">Amount</th>
                  <th className="w-[18%]">Date</th>
                  <th className="w-[18%]">Store</th>
                  <th className="w-[23%]">Remark</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const rows = pinelabs.onlyTerm
                    .map((x, i) => ({ x, item: items.onlyTerm[i]! }))
                    .filter(({ x }) => hit(x.rrn, x.acquirer, x.amount));
                  if (rows.length === 0)
                    return (
                      <EmptyRow cols={6} message="Every terminal row found a POS match." />
                    );
                  return rows.map(({ x, item }, i) => (
                    <tr key={`${x.rrn}-${i}`}>
                      <td className="mono">{x.rrn || '—'}</td>
                      <td>
                        {x.isAmex ? <span className="tag tag-amex">AMEX</span> : x.acquirer}
                      </td>
                      <td className="num">{fmt(x.amount)}</td>
                      <td className="mono">{fmtDate(x.date)}</td>
                      <td>{x.store}</td>
                      <td>
                        <RemarkCell source="pinelabs" item={item} allItems={allItems} />
                      </td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </PanelSection>

          {ambiguousCount > 0 && (
            <PanelSection title="Ambiguous — needs a human">
              <div className="alert alert-warn m-5">
                <span>⚠</span>
                <span>
                  These rows share a reference, auth code or amount with another row, so no
                  one-to-one match can be asserted. They are never matched automatically — but
                  still need a remark to submit.
                </span>
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="w-[15%]">RRN / code</th>
                    <th className="w-[17%]">Order no</th>
                    <th className="w-[12%] num">Amount</th>
                    <th className="w-[33%]">Reason</th>
                    <th className="w-[23%]">Remark</th>
                  </tr>
                </thead>
                <tbody>
                  {pinelabs.dupRRN.map((x, i) => (
                    <tr key={`dup-${x.rrn}-${i}`}>
                      <td className="mono">{x.rrn}</td>
                      <td>{(x.orders ?? []).join(', ')}</td>
                      <td className="num">{fmt(x.amount)}</td>
                      <td className="text-warn-ink">{x._note}</td>
                      <td>
                        <RemarkCell source="pinelabs" item={items.dupRRN[i]!} allItems={allItems} />
                      </td>
                    </tr>
                  ))}
                  {pinelabs.amexDup.map((x, i) => (
                    <tr key={`amex-dup-${i}`}>
                      <td className="mono">{x.pr?.authCode || '—'}</td>
                      <td>{(x.pr?.orders ?? []).join(', ')}</td>
                      <td className="num">{fmt(x.pr?.amount)}</td>
                      <td className="text-warn-ink">{x._note}</td>
                      <td>
                        <RemarkCell source="pinelabs" item={items.amexDup[i]!} allItems={allItems} />
                      </td>
                    </tr>
                  ))}
                  {pinelabs.amexDupTerm.map((x, i) => (
                    <tr key={`amex-dup-term-${i}`}>
                      <td className="mono">{x.approvalCode || '—'}</td>
                      <td>—</td>
                      <td className="num">{fmt(x.amount)}</td>
                      <td className="text-warn-ink">Duplicate on terminal side (AMEX)</td>
                      <td>
                        <RemarkCell source="pinelabs" item={items.amexDupTerm[i]!} allItems={allItems} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </PanelSection>
          )}
        </>
      ) : (
        <>
          <PanelSection title="Matched by RRN">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-[16%]">RRN</th>
                  <th className="w-[22%]">Order no</th>
                  <th className="w-[14%] num">Terminal</th>
                  <th className="w-[14%] num">POS</th>
                  <th className="w-[16%]">Status</th>
                  <th className="w-[18%]">Payment name</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const rows = reconciled.filter((x) => hit(x.rrn, x.orders?.join(',')));
                  if (rows.length === 0)
                    return <EmptyRow cols={6} message="Nothing reconciled yet." />;
                  return rows.map((x) => (
                    <tr key={x.rrn}>
                      <td className="mono">{x.rrn}</td>
                      <td>{(x.orders ?? []).join(', ')}</td>
                      <td className="num">{fmt(x.plAmt)}</td>
                      <td className="num">{fmt(x.prAmt)}</td>
                      <td>
                        {x.squaredOff ? (
                          <span className="tag tag-pur">Squared off</span>
                        ) : (
                          <span className="tag tag-ok">✓ Matched</span>
                        )}
                      </td>
                      <td>{x.pr?.paymentName}</td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </PanelSection>

          <PanelSection title="AMEX — matched on auth code or amount">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-[18%]">Auth code</th>
                  <th className="w-[20%]">Order no</th>
                  <th className="w-[15%] num">Terminal</th>
                  <th className="w-[15%] num">POS</th>
                  <th className="w-[16%]">Matched by</th>
                  <th className="w-[16%]">MID</th>
                </tr>
              </thead>
              <tbody>
                {pinelabs.amexOk.length === 0 ? (
                  <EmptyRow cols={6} message="No AMEX transactions in this session." />
                ) : (
                  pinelabs.amexOk.map((x, i) => (
                    <tr key={`amex-ok-${i}`}>
                      <td className="mono">{x.pr?.authCode || '—'}</td>
                      <td>{(x.pr?.orders ?? []).join(', ')}</td>
                      <td className="num">{fmt(x.zip?.amount)}</td>
                      <td className="num">{fmt(x.pr?.amount)}</td>
                      <td>
                        {/* Amount-matching is weaker evidence than a code match,
                            so it is flagged amber rather than green. */}
                        <span
                          className={`tag ${x._matchBy === 'code' ? 'tag-ok' : 'tag-warn'}`}
                        >
                          {x._matchBy}
                        </span>
                      </td>
                      <td className="mono">{x.zip?.mid || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </PanelSection>
        </>
      )}
    </div>
  );
}
