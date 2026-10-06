'use client';

/**
 * Ported from `reconciliation (68).html` lines 4062–4183
 * (`openAdvanceAppliedModal`/`renderAdvList`/`confirmAdvanceApplied`), since
 * extended to multi-select: a shortage is often the sum of *several*
 * separately-received advances (e.g. ₹2,000 and ₹4,000 toward one ₹6,000
 * gap), neither of which matches it alone. Every open, non-exhausted
 * advance is selectable — there is no longer a per-advance "does this one
 * amount match" gate (`EligibleAdvanceDTO`'s own doc comment). When a real
 * shortage amount is known (opened from a Pinelabs/HDFC-UPI row or a
 * square-off group), Apply only enables once the running total of whatever
 * is currently selected matches it exactly; opened from Cash/UPI/Bank
 * (amount not yet known), Apply enables as soon as at least one advance is
 * selected, same as a single-advance apply always allowed.
 */

import { useEffect, useMemo, useState } from 'react';
import type { EligibleAdvanceDTO } from '@toit/contracts';
import { AMOUNT_EPSILON, fmt, fmtEventDate } from '@toit/recon-core/display';
import { ApiError, applyAdvance, listEligibleAdvances } from '@/lib/api';
import { ModalShell } from '../ModalShell';
import type { ModalProps } from '../types';

export function AdvanceAppliedModal({ session, request, onClose, onSaved }: ModalProps) {
  const [advances, setAdvances] = useState<EligibleAdvanceDTO[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const exactAmount = request.amount > 0.5 ? request.amount : undefined;

  useEffect(() => {
    listEligibleAdvances(session.meta.id)
      .then(setAdvances)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load advances.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.meta.id]);

  const selectedTotal = useMemo(() => {
    if (!advances) return 0;
    return advances
      .filter((a) => selectedIds.has(a.advance.id))
      .reduce((s, a) => s + a.balance, 0);
  }, [advances, selectedIds]);

  const matchesExact = exactAmount === undefined || Math.abs(selectedTotal - exactAmount) < AMOUNT_EPSILON;
  const canApply = selectedIds.size > 0 && matchesExact;

  function toggle(advanceId: string) {
    setError(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(advanceId)) next.delete(advanceId);
      else next.add(advanceId);
      return next;
    });
  }

  async function save() {
    if (!canApply) {
      setError(
        selectedIds.size === 0
          ? 'Select at least one advance to apply.'
          : `Selected total ${fmt(selectedTotal)} does not match the shortage amount ${fmt(exactAmount!)}.`,
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await applyAdvance(session.meta.id, {
        source: request.source,
        targetKey: request.targetKey,
        advanceIds: [...selectedIds],
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      title="↩ Advance Applied"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-ok" onClick={save} disabled={saving || !canApply}>
            {saving ? 'Saving…' : 'Apply'}
          </button>
        </>
      }
    >
      <p className="text-body mb-1">
        {exactAmount
          ? 'Select one or more advances — their balances must add up to the shortage amount below.'
          : 'Select one or more advances — each one’s full remaining balance will be used.'}
      </p>
      {exactAmount !== undefined && (
        <div className={`info-panel mb-3 ${matchesExact ? '' : 'alert-warn'}`}>
          <div className="info-grid">
            <div className="info-card">
              <p className="info-label">Shortage amount</p>
              <p className="info-value">{fmt(exactAmount)}</p>
            </div>
            <div className="info-card">
              <p className="info-label">Selected ({selectedIds.size})</p>
              <p className={`info-value ${matchesExact ? 'text-ok' : 'text-err'}`}>{fmt(selectedTotal)}</p>
            </div>
            <div className="info-card">
              <p className="info-label">{matchesExact ? 'Status' : 'Still needed'}</p>
              <p className={`info-value ${matchesExact ? 'text-ok' : 'text-err'}`}>
                {matchesExact ? '✓ Matches' : fmt(exactAmount - selectedTotal)}
              </p>
            </div>
          </div>
        </div>
      )}
      {exactAmount === undefined && selectedIds.size > 0 && (
        <p className="text-tiny text-ink-3 mb-3">
          Selected {selectedIds.size} advance{selectedIds.size === 1 ? '' : 's'} — total {fmt(selectedTotal)}.
        </p>
      )}
      {error && (
        <div className="alert alert-warn mb-3">
          <span>⚠</span>
          <span>{error}</span>
        </div>
      )}
      {!advances ? (
        <p className="text-ink-3 text-body">Loading…</p>
      ) : advances.length === 0 ? (
        <div className="empty-state">
          <p>No advances with remaining balance.</p>
          <p className="text-tiny text-ink-3 mt-1">
            Record advances using &quot;Advance Received&quot; on excess transactions.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {advances.map(({ advance, balance }) => {
            const selected = selectedIds.has(advance.id);
            return (
              <div
                key={advance.id}
                className={`pick-card px-4 py-3 cursor-pointer ${selected ? 'pick-card-selected' : ''}`}
                onClick={() => toggle(advance.id)}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-start min-w-0">
                    {selected && <span className="pick-card-check mt-0.5">✓</span>}
                    <div className="min-w-0">
                      <p className={`text-body ${selected ? 'font-bold text-accent-ink' : 'font-semibold'}`}>
                        {advance.custName}
                        {advance.eventDate && (
                          <span className="text-ink-3 font-normal"> · 📅 {fmtEventDate(advance.eventDate)}</span>
                        )}
                      </p>
                      <p className="text-tiny text-ink-3">
                        {advance.phone || ''}
                        {advance.phone && advance.notes ? ' · ' : ''}
                        {advance.notes || (!advance.phone ? '—' : '')}
                      </p>
                      {selected && (
                        <p className="text-tiny text-accent-ink font-semibold mt-1">Selected — will apply {fmt(balance)}</p>
                      )}
                    </div>
                  </div>
                  <div className="font-bold text-accent shrink-0">{fmt(balance)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ModalShell>
  );
}
