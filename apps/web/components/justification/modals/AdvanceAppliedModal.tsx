'use client';

/**
 * Ported from `reconciliation (68).html` lines 4062–4183
 * (`openAdvanceAppliedModal`/`renderAdvList`/`confirmAdvanceApplied`).
 *
 * Single-selection only — legacy has no multi-advance-per-transaction path.
 * When a real shortage amount is known (opened from a Pinelabs/HDFC-UPI row),
 * only advances whose balance matches it exactly are selectable; opened from
 * Cash/UPI/Bank (amount not yet known), every advance with a balance is
 * eligible and its full balance is applied.
 */

import { useEffect, useState } from 'react';
import type { EligibleAdvanceDTO } from '@toit/contracts';
import { fmt, fmtEventDate } from '@toit/recon-core/display';
import { ApiError, applyAdvance, listEligibleAdvances } from '@/lib/api';
import { ModalShell } from '../ModalShell';
import type { ModalProps } from '../types';

export function AdvanceAppliedModal({ session, request, onClose, onSaved }: ModalProps) {
  const [advances, setAdvances] = useState<EligibleAdvanceDTO[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const exactAmount = request.amount > 0.5 ? request.amount : undefined;

  useEffect(() => {
    listEligibleAdvances(session.meta.id, exactAmount)
      .then(setAdvances)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load advances.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.meta.id, exactAmount]);

  async function save() {
    if (!selectedId) {
      setError('Select an advance to apply.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await applyAdvance(session.meta.id, {
        source: request.source,
        targetKey: request.targetKey,
        advanceId: selectedId,
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
          <button type="button" className="btn btn-ok" onClick={save} disabled={saving || !selectedId}>
            {saving ? 'Saving…' : 'Apply'}
          </button>
        </>
      }
    >
      <p className="text-body mb-3">
        {exactAmount ? (
          <>
            Shortage amount: <strong>{fmt(exactAmount)}</strong> · select the matching advance
          </>
        ) : (
          'Select an advance to apply — its full remaining balance will be used.'
        )}
      </p>
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
          {advances.map(({ advance, balance, eligible, ineligibleReason }) => {
            const selected = selectedId === advance.id;
            return (
              <div
                key={advance.id}
                className={`panel px-4 py-3 ${eligible ? 'cursor-pointer' : 'opacity-45 cursor-not-allowed'} ${selected ? 'border-accent' : ''}`}
                onClick={() => {
                  if (!eligible) {
                    setError(ineligibleReason);
                    return;
                  }
                  setSelectedId(selected ? null : advance.id);
                  setError(null);
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-body">
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
                    {!eligible && <p className="text-tiny text-err mt-1">✗ {ineligibleReason}</p>}
                  </div>
                  <div className="font-bold text-accent">{fmt(balance)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ModalShell>
  );
}
