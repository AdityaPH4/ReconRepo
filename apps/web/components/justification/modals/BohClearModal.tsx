'use client';

/**
 * Ported from `reconciliation (68).html` lines 4331–4441/4493
 * (`openBohClearModal`/`confirmBohClear`).
 *
 * Clearing is always full — legacy hard-codes this, there is no partial-clear
 * path. Source is locked to a fixed label when triggered from a
 * Pinelabs/HDFC-UPI row or the Cash/UPI/Bank tabs; free only when opened from
 * the Bills-on-Hold tab directly. Same-business-day entries are hidden by
 * default — a bill "rarely clears same day".
 */

import { useEffect, useState } from 'react';
import type { EligibleBohEntryDTO } from '@toit/contracts';
import { BOH_SOURCES, fmt } from '@toit/recon-core/display';
import { ApiError, clearBoh, listEligibleBoh } from '@/lib/api';
import { ModalShell } from '../ModalShell';
import type { ModalProps } from '../types';

export function BohClearModal({ session, request, onClose, onSaved }: ModalProps) {
  const [entries, setEntries] = useState<EligibleBohEntryDTO[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [includeToday, setIncludeToday] = useState(false);
  const [source, setSource] = useState(request.lockedSource ?? BOH_SOURCES[0]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const exactAmount = request.amount > 0.5 ? request.amount : undefined;

  useEffect(() => {
    listEligibleBoh(session.meta.id, { includeToday, amount: exactAmount })
      .then(setEntries)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load BOH entries.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.meta.id, includeToday, exactAmount]);

  async function save() {
    if (!selectedId) {
      setError('Select a bill to clear.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await clearBoh(session.meta.id, {
        source: request.source,
        targetKey: request.targetKey,
        bohEntryId: selectedId,
        clearSource: source,
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
      title="🧾 Bill on Hold Cleared"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-ok" onClick={save} disabled={saving || !selectedId}>
            {saving ? 'Saving…' : 'Clear'}
          </button>
        </>
      }
    >
      <div className="mb-3">
        <label className="field-label">Source</label>
        {request.lockedSource ? (
          <p className="text-body">🔒 fixed to {request.lockedSource}</p>
        ) : (
          <select className="field-input" value={source} onChange={(e) => setSource(e.target.value)}>
            {BOH_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
      </div>
      <label className="flex items-center gap-2 mb-3 text-tiny text-ink-3">
        <input type="checkbox" checked={includeToday} onChange={(e) => setIncludeToday(e.target.checked)} />
        Show today&apos;s BOH entries too
      </label>
      {error && (
        <div className="alert alert-warn mb-3">
          <span>⚠</span>
          <span>{error}</span>
        </div>
      )}
      {!entries ? (
        <p className="text-ink-3 text-body">Loading…</p>
      ) : entries.length === 0 ? (
        <div className="empty-state">
          <p>No open bills-on-hold entries.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map(({ entry, eligible, ineligibleReason }) => {
            const selected = selectedId === entry.id;
            return (
              <div
                key={entry.id}
                className={`panel px-4 py-3 ${eligible ? 'cursor-pointer' : 'opacity-45 cursor-not-allowed'} ${selected ? 'border-accent' : ''}`}
                onClick={() => {
                  if (!eligible) {
                    setError(ineligibleReason);
                    return;
                  }
                  setSelectedId(selected ? null : entry.id);
                  setError(null);
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-body">
                      {entry.orderNo} — {entry.custName}
                    </p>
                    <p className="text-tiny text-ink-3">{entry.bohDate}</p>
                    {!eligible && <p className="text-tiny text-err mt-1">✗ {ineligibleReason}</p>}
                  </div>
                  <div className="font-bold text-accent">{fmt(entry.amount)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-tiny text-ink-3 mt-3">Cleared in full — always yes; there is no partial-clear.</p>
    </ModalShell>
  );
}
