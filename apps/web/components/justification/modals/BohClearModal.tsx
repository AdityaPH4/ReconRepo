'use client';

/**
 * Ported from `reconciliation (68).html` lines 4331–4441/4493
 * (`openBohClearModal`/`setBohSel`/`confirmBohClear`).
 *
 * Clearing is always full — legacy hard-codes this, there is no partial-clear
 * path. Source is locked to a fixed label when triggered from a
 * Pinelabs/HDFC-UPI row or the Cash/UPI/Bank tabs — and, matching legacy's
 * `setBohSel`'s `fromRecon` branch, selection is forced single in that case.
 * Opened from the Bills-on-Hold tab directly (`lockedSource` unset), any
 * number of entries can be selected at once, each with its own independently
 * chosen source (legacy: `_bohClearState[orderNo].source`) — `confirmBohClear`
 * then pushes one `S.bohCleared` record per selected item. The port submits
 * that same set as one `clearBoh` call per entry, sequentially, since the API
 * only accepts one `bohEntryId` per request.
 */

import { useEffect, useState } from 'react';
import type { EligibleBohEntryDTO } from '@toit/contracts';
import { BOH_SOURCES, fmt } from '@toit/recon-core/display';
import { ApiError, clearBoh, listEligibleBoh } from '@/lib/api';
import { ModalShell } from '../ModalShell';
import type { ModalProps } from '../types';

export function BohClearModal({ session, request, onClose, onSaved }: ModalProps) {
  const [entries, setEntries] = useState<EligibleBohEntryDTO[] | null>(null);
  // entryId → chosen source. Locked mode never holds more than one key
  // (source is always `request.lockedSource`); unlocked mode allows many,
  // each independently sourced.
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [includeToday, setIncludeToday] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const exactAmount = request.amount > 0.5 ? request.amount : undefined;
  const selectedIds = Object.keys(selected);

  useEffect(() => {
    listEligibleBoh(session.meta.id, { includeToday, amount: exactAmount })
      .then(setEntries)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load BOH entries.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.meta.id, includeToday, exactAmount]);

  function toggle(entryId: string) {
    setError(null);
    setSelected((prev) => {
      if (prev[entryId] !== undefined) {
        const { [entryId]: _removed, ...rest } = prev;
        return rest;
      }
      const initialSource = request.lockedSource ?? '';
      // Single selection when the source is locked to whichever row/tab
      // triggered this modal — legacy's `setBohSel`, `fromRecon` branch.
      return request.lockedSource ? { [entryId]: initialSource } : { ...prev, [entryId]: initialSource };
    });
  }

  function setSourceFor(entryId: string, value: string) {
    setSelected((prev) => ({ ...prev, [entryId]: value }));
  }

  async function save() {
    if (selectedIds.length === 0) {
      setError('Select at least one bill to clear.');
      return;
    }
    if (!request.lockedSource) {
      const missing = selectedIds.find((id) => !selected[id]);
      if (missing) {
        setError('Select a source for every selected bill.');
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      let updated = session;
      for (const entryId of selectedIds) {
        updated = await clearBoh(session.meta.id, {
          source: request.source,
          targetKey: request.targetKey,
          bohEntryId: entryId,
          clearSource: request.lockedSource ?? selected[entryId]!,
        });
      }
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
          <button type="button" className="btn btn-ok" onClick={save} disabled={saving || selectedIds.length === 0}>
            {saving ? 'Saving…' : selectedIds.length > 1 ? `Clear ${selectedIds.length}` : 'Clear'}
          </button>
        </>
      }
    >
      {request.lockedSource && (
        <div className="mb-3">
          <label className="field-label">Source</label>
          {/* Legacy's own wording ("...since this is a Cash justification
              entry"/"...unreconciled item") varies slightly per opening
              context — the port uses one consistent phrasing everywhere. */}
          <p className="text-body">
            🔒 Source is fixed to <strong>{request.lockedSource}</strong> for this entry.
          </p>
        </div>
      )}
      <label className="flex items-center gap-2 mb-3 text-tiny text-ink-3">
        <input type="checkbox" checked={includeToday} onChange={(e) => setIncludeToday(e.target.checked)} />
        Show today&apos;s BOH <span className="text-warn">(exceptional cases only)</span>
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
            const isSelected = selected[entry.id] !== undefined;
            return (
              <div
                key={entry.id}
                className={`panel px-4 py-3 ${eligible ? 'cursor-pointer' : 'opacity-45 cursor-not-allowed'} ${isSelected ? 'border-accent' : ''}`}
                onClick={() => {
                  if (!eligible) {
                    setError(ineligibleReason);
                    return;
                  }
                  toggle(entry.id);
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
                {isSelected && !request.lockedSource && (
                  <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--border)' }} onClick={(e) => e.stopPropagation()}>
                    <label className="field-label">Source *</label>
                    <select
                      className="field-input"
                      value={selected[entry.id]}
                      onChange={(e) => setSourceFor(entry.id, e.target.value)}
                    >
                      <option value="">Select source…</option>
                      {BOH_SOURCES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="text-tiny text-ink-3 mt-3">Cleared in full — always yes; there is no partial-clear.</p>
    </ModalShell>
  );
}
