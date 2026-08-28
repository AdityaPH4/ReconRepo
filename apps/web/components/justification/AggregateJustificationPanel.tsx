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
import { modalKindForRemark } from './types';
import { useJustification } from './JustificationProvider';

type Source = 'cash' | 'upi' | 'bank';

const REMARKS_BY_SOURCE: Record<Source, { excess: readonly string[]; shortage: readonly string[] }> = {
  cash: { excess: CASH_REMARKS_EXCESS, shortage: CASH_REMARKS_SHORTAGE },
  upi: { excess: REMARKS_EXCESS, shortage: REMARKS_SHORTAGE },
  bank: { excess: REMARKS_EXCESS, shortage: REMARKS_SHORTAGE },
};

export function AggregateJustificationPanel({ source, title }: { source: Source; title: string }) {
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

  async function handleAdd() {
    if (!remark) {
      setError('Select a remark.');
      return;
    }
    const amt = Number.parseFloat(amount);
    const validAmount = amount !== '' && !Number.isNaN(amt) && amt > 0;

    // Repository-driven remarks fire their modal immediately (BOH Cleared /
    // Advance Applied) or once a valid amount has been entered (everything
    // else that's modal-backed) — matching legacy's `onCashRemarkChange`/
    // `addCashEntry` split.
    const modalKind = modalKindForRemark(remark);
    if (modalKind === 'boh-clear' || modalKind === 'advance-applied') {
      openModal({ kind: modalKind, source, targetKey: null, amount: 0, direction });
      resetForm();
      return;
    }
    if (modalKind) {
      if (!validAmount) {
        setError('Enter a valid amount.');
        return;
      }
      openModal({ kind: modalKind, source, targetKey: null, amount: amt, direction });
      resetForm();
      return;
    }

    if (needsRrn && !/^\d{12}$/.test(rrn)) {
      setError('A 12-digit RRN is required for this remark.');
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
              <select className="field-input" value={remark} onChange={(e) => setRemark(e.target.value)}>
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
