'use client';

/**
 * The manual justification form + entries table for Cash, Static UPI (Kotak
 * and, absent an HDFC statement, HDFC too) and Bank transfer.
 * Ported from `reconciliation (68).html` lines 1987–2192 (Cash),
 * 2556–2830 (UPI), 3042–3269 (Bank).
 *
 * The three tabs share one form shape (`JustificationEntry`) and differ only
 * in which remark list applies and which extra fields show — Cash alone gets
 * "Paid In"/"Paid Out" + Bill Number/Reason; UPI alone gets the 12-digit RRN,
 * required unless the remark is one of `NO_RRN_REMARKS`.
 */

import { useState } from 'react';
import type { JustificationEntryDTO, SessionDTO } from '@toit/contracts';
import {
  CASH_BILL_REMARKS,
  CASH_REMARKS_EXCESS,
  CASH_REMARKS_SHORTAGE,
  MODAL_REMARKS,
  NO_RRN_REMARKS,
  REMARKS_EXCESS,
  REMARKS_SHORTAGE,
  fmt,
} from '@toit/recon-core/display';
import { ApiError, addJustificationEntry, removeJustificationEntry } from '@/lib/api';
import { diffClass } from '@/components/ui/table';
import { modalKindForRemark } from './types';
import { useJustification } from './JustificationProvider';

type Source = 'cash' | 'upi' | 'bank';

const REMARKS_BY_SOURCE: Record<Source, { excess: readonly string[]; shortage: readonly string[] }> = {
  cash: { excess: CASH_REMARKS_EXCESS, shortage: CASH_REMARKS_SHORTAGE },
  upi: { excess: REMARKS_EXCESS, shortage: REMARKS_SHORTAGE },
  bank: { excess: REMARKS_EXCESS, shortage: REMARKS_SHORTAGE },
};

/** BOH Clear's locked-source label per aggregate tab — legacy's `_sourceLabel` per `openBohClearFrom*`. */
const BOH_LOCKED_SOURCE: Record<Source, string> = {
  cash: 'Cash',
  upi: 'Static UPI',
  bank: 'Bank Transfer',
};

export function AggregateJustificationPanel({
  source,
  title,
  diff = null,
}: {
  source: Source;
  title: string;
  /**
   * The aggregate PR-vs-summary difference to reconcile against — `null`
   * when no drawer summary exists yet. Legacy's `renderCash`/`renderUPI`/
   * `renderBank` show this alongside "Net entries" and "Remaining
   * unjustified" in one stats row above the entry form (1959–1976,
   * 2531–2547 for the UPI "Net Entries" tile, 3038–3054).
   */
  diff?: number | null;
}) {
  const { session, locked, updateSession, openModal } = useJustification();
  const [direction, setDirection] = useState<'excess' | 'shortage'>('excess');
  const [remark, setRemark] = useState('');
  const [description, setDescription] = useState('');
  const [billNo, setBillNo] = useState('');
  const [reason, setReason] = useState('');
  const [rrn, setRrn] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const entries = session.justification.entries.filter((e) => e.source === source);
  const net = entries.reduce((s, e) => s + (e.direction === 'excess' ? e.amount : -e.amount), 0);
  const remaining = diff === null ? null : diff - net;
  const remarks = REMARKS_BY_SOURCE[source][direction];
  const needsBill = source === 'cash' && CASH_BILL_REMARKS.includes(remark as never);
  const isModalRemark = MODAL_REMARKS.includes(remark as never);
  const needsRrn = source === 'upi' && remark !== '' && !NO_RRN_REMARKS.includes(remark as never);

  function resetForm() {
    setRemark('');
    setDescription('');
    setBillNo('');
    setReason('');
    setRrn('');
    setAmount('');
    setError(null);
  }

  // BOH Clear's source is locked to whichever tab triggered it — legacy:
  // `openBohClearFromCash`/`openBohClearFromUPI`/`openBohClearFromBank`
  // (reconciliation (68).html:2194, 2832, 3213).
  const lockedSource = BOH_LOCKED_SOURCE[source];

  /**
   * "Bill on Hold Cleared" and "Advance Applied" are repository-driven: their
   * amount comes FROM the BOH/advance the operator picks inside the modal,
   * not from this form, so legacy pops the modal the instant the remark is
   * *selected* — no amount to enter first, nothing to click. Every other
   * modal-backed remark (Advance Received/Extra Payment Received/Short
   * Collection/Other) still needs a real amount typed in first, so those
   * stay gated behind "+ Add". Legacy: `onCashRemarkChange` (2079–2090),
   * `onUpiRemarkChange` (2657–2666), `onBTRemarkChange` (same shape, Bank
   * tab) — both fire their popup directly from the remark `<select>`'s
   * `onchange`, not from the Add button.
   */
  function handleRemarkSelect(newRemark: string) {
    setRemark(newRemark);
    setError(null);
    const modalKind = modalKindForRemark(newRemark);
    if (modalKind === 'boh-clear' || modalKind === 'advance-applied') {
      openModal({
        kind: modalKind,
        source,
        targetKey: null,
        amount: 0,
        direction,
        lockedSource: modalKind === 'boh-clear' ? lockedSource : undefined,
        // Neither remark needs an RRN (`NO_RRN_REMARKS`) — legacy resets any
        // typed RRN before opening (`upiRRNReset()`), matching `resetForm()` below.
        rrn: undefined,
      });
      resetForm();
    }
  }

  async function handleAdd() {
    if (!remark) {
      setError('Select a remark.');
      return;
    }
    const amt = Number.parseFloat(amount);
    const validAmount = amount !== '' && !Number.isNaN(amt) && amt > 0;

    // The RRN check runs before *any* branch — modal-backed or not — since
    // on the UPI tab it applies to "Advance Received"/"Extra Payment
    // Received" too (real, identifiable transactions), not just the
    // directly-added remarks. Legacy: `addUpiEntry`'s RRN validation
    // (reconciliation (68).html:2725-2761) runs ahead of every remark
    // branch, including the modal-opening ones.
    if (needsRrn) {
      if (!/^\d{12}$/.test(rrn)) {
        setError('A 12-digit RRN is required for this remark.');
        return;
      }
      if (session.justification.entries.some((e) => e.source === 'upi' && e.rrn === rrn)) {
        setError('This RRN has already been used elsewhere in this session.');
        return;
      }
    }

    // Repository-driven remarks already fired their modal on selection
    // (`handleRemarkSelect`) — reaching here with one of them still selected
    // means the modal was cancelled, so just re-open it. Legacy:
    // `addCashEntry`/`addUpiEntry`'s own defensive
    // `if(remark==='Bill on Hold Cleared'||remark==='Advance Applied'){onCashRemarkChange();return;}`.
    const modalKind = modalKindForRemark(remark);
    const rrnForModal = needsRrn ? rrn : undefined;
    if (modalKind === 'boh-clear' || modalKind === 'advance-applied') {
      handleRemarkSelect(remark);
      return;
    }
    if (modalKind) {
      if (!validAmount) {
        setError('Enter a valid amount.');
        return;
      }
      openModal({ kind: modalKind, source, targetKey: null, amount: amt, direction, lockedSource, rrn: rrnForModal });
      resetForm();
      return;
    }

    if (needsBill && (!billNo.trim() || !reason.trim())) {
      setError('Bill Number and Reason are both required.');
      return;
    }
    if (!validAmount) {
      setError('Enter a valid amount.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const updated = await addJustificationEntry(session.meta.id, {
        source,
        targetKey: null,
        direction,
        remark: remark as never,
        amount: amt,
        description: description.trim() || null,
        rrn: needsRrn ? rrn : null,
        billNo: needsBill ? billNo.trim() : null,
        reason: needsBill ? reason.trim() : null,
      });
      updateSession(updated);
      resetForm();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add entry.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(entry: JustificationEntryDTO) {
    try {
      const updated = await removeJustificationEntry(session.meta.id, entry.id);
      updateSession(updated);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Failed to remove entry.');
    }
  }

  return (
    <div className="panel mt-4">
      {diff !== null && (
        <div className="info-panel">
          <div className="info-grid">
            <div className="info-card">
              <p className="info-label">Net entries</p>
              <p className={`info-value ${diffClass(net)}`}>
                {net >= 0 ? '+' : ''}
                {fmt(net)}
              </p>
              <p className="text-micro text-ink-3 mt-1">
                {entries.length ? `${entries.length} line${entries.length === 1 ? '' : 's'}` : 'none yet'}
              </p>
            </div>
            <div className="info-card">
              <p className="info-label">Remaining unjustified</p>
              <p className={`info-value ${diffClass(remaining)}`}>
                {remaining === null ? '—' : `${remaining >= 0 ? '+' : ''}${fmt(remaining)}`}
              </p>
            </div>
          </div>
        </div>
      )}

      {!locked && (
        <div className="entry-form p-5">
          <h4 className="font-semibold text-body mb-3">Add {title.toLowerCase()} justification</h4>
          <div className="field-grid">
            <div>
              <label className="field-label">Direction</label>
              <select
                className="field-input"
                value={direction}
                onChange={(e) => {
                  setDirection(e.target.value as 'excess' | 'shortage');
                  setRemark('');
                }}
              >
                <option value="excess">Excess (+)</option>
                <option value="shortage">Shortage (−)</option>
              </select>
            </div>
            <div>
              <label className="field-label">Remark</label>
              <select className="field-input" value={remark} onChange={(e) => handleRemarkSelect(e.target.value)}>
                <option value="">Select remark…</option>
                {remarks.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            {source === 'upi' && (
              <div>
                <label className="field-label">{needsRrn ? '12 Digit RRN *' : '12 Digit RRN'}</label>
                <input
                  className="field-input"
                  value={rrn}
                  disabled={!needsRrn && remark !== ''}
                  onChange={(e) => setRrn(e.target.value.replace(/\D/g, '').slice(0, 12))}
                />
              </div>
            )}
            <div>
              <label className="field-label">Description</label>
              <input
                className="field-input"
                value={description}
                disabled={isModalRemark}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Customer name / note"
              />
            </div>
            {needsBill && (
              <>
                <div>
                  <label className="field-label">Bill Number *</label>
                  <input className="field-input" value={billNo} onChange={(e) => setBillNo(e.target.value)} />
                </div>
                <div>
                  <label className="field-label">Reason *</label>
                  <input className="field-input" value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
              </>
            )}
            <div>
              <label className="field-label">Amount (₹)</label>
              <input
                type="number"
                step="0.01"
                className="field-input"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>
          {error && (
            <div className="alert alert-warn mt-3">
              <span>⚠</span>
              <span>{error}</span>
            </div>
          )}
          <div className="btn-row">
            <button type="button" className="btn btn-ok" onClick={handleAdd} disabled={saving}>
              + Add
            </button>
          </div>
        </div>
      )}

      {entries.length > 0 && (
        <div className="mt-4">
          <h4 className="panel-section-title">{title} justifications ({entries.length})</h4>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-[12%]">Direction</th>
                  <th className="w-[18%]">Remark</th>
                  <th className="w-[30%]">Details</th>
                  <th className="w-[18%] num">Amount</th>
                  <th className="w-[22%]" />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <span className={`tag ${e.direction === 'excess' ? 'tag-ok' : 'tag-short'}`}>
                        {e.direction === 'excess' ? 'Excess' : 'Shortage'}
                      </span>
                    </td>
                    <td>{e.remark}</td>
                    <td className="text-ink-3 text-tiny">{entryDetails(e)}</td>
                    <td className={`num font-semibold ${e.direction === 'excess' ? 'diff-excess' : 'diff-short'}`}>
                      {e.direction === 'excess' ? '+' : '-'}
                      {fmt(e.amount)}
                    </td>
                    <td>
                      {!locked && (
                        <button type="button" className="btn btn-sm" onClick={() => handleRemove(e)}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td colSpan={3}>Net total</td>
                  <td className="num">
                    {net >= 0 ? '+' : ''}
                    {fmt(net)}
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function entryDetails(e: JustificationEntryDTO): string {
  if (e.rrn) return `RRN ${e.rrn}`;
  if (e.billNo) return `Bill: ${e.billNo}${e.reason ? ` — ${e.reason}` : ''}`;
  if (e.staffName) return `${e.staffName} (${e.empId ?? '—'})`;
  if (e.clientName) return `${e.clientName}${e.billNo ? ` · Bill ${e.billNo}` : ''}`;
  if (e.comment) return e.comment;
  return e.description || '—';
}
