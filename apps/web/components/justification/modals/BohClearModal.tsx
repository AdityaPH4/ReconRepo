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
 * number of entries can still be selected at once — but unlike legacy (which
 * offers a free `BOH_SOURCES` choice per row there), the port simplifies this
 * one case to always clear as `'MPR'`: a bill cleared from the BOH tab with
 * no originating recon row/tab is definitionally money that showed up
 * through the bank settlement layer, not through Cash/UPI/Pinelabs, so a
 * per-row source picker had nothing real to decide. `confirmBohClear` in
 * legacy pushes one `S.bohCleared` record per selected item; the port
 * submits that same set as one `clearBoh` call per entry, sequentially,
 * since the API only accepts one `bohEntryId` per request.
 */

import { useEffect, useState } from 'react';
import type { EligibleBohEntryDTO } from '@toit/contracts';
import { fmt, fmtDate } from '@toit/recon-core/display';
import { ApiError, clearBoh, listEligibleBoh } from '@/lib/api';
import { ModalShell } from '../ModalShell';
import type { ModalProps } from '../types';

export function BohClearModal({ session, request, onClose, onSaved }: ModalProps) {
  const [entries, setEntries] = useState<EligibleBohEntryDTO[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [includeToday, setIncludeToday] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Every clearance from this modal has exactly one possible source now —
  // whichever row/tab locked it, or 'MPR' when opened from the BOH tab
  // directly (see module doc comment above).
  const effectiveSource = request.lockedSource ?? 'MPR';

  const exactAmount = request.amount > 0.5 ? request.amount : undefined;

  useEffect(() => {
    listEligibleBoh(session.meta.id, { includeToday, amount: exactAmount })
      .then((result) => {
        setEntries(result);
        // Opened from a specific repository row's own "Clear" button — put
        // it straight into the selection so the operator doesn't have to
        // re-find it in the list.
        if (request.preselectBohEntryId && result.some((r) => r.entry.id === request.preselectBohEntryId)) {
          setSelectedIds((prev) => (prev.includes(request.preselectBohEntryId!) ? prev : [...prev, request.preselectBohEntryId!]));
        }
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load BOH entries.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.meta.id, includeToday, exactAmount]);

  function toggle(entryId: string) {
    setError(null);
    setSelectedIds((prev) => {
      if (prev.includes(entryId)) return prev.filter((id) => id !== entryId);
      // Single selection when the source is locked to whichever row/tab
      // triggered this modal — legacy's `setBohSel`, `fromRecon` branch.
      return request.lockedSource ? [entryId] : [...prev, entryId];
    });
  }

  async function save() {
    if (selectedIds.length === 0) {
      setError('Select at least one bill to clear.');
      return;
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
          clearSource: effectiveSource,
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
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
    >
      <div className="mb-3">
        <label className="field-label">Source</label>
        {/* Legacy's own wording ("...since this is a Cash justification
            entry"/"...unreconciled item") varies slightly per opening
            context — the port uses one consistent phrasing everywhere. */}
        <p className="text-body">
          🔒 Source is fixed to <strong>{effectiveSource}</strong> for this entry.
        </p>
      </div>
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
            const isSelected = selectedIds.includes(entry.id);
            return (
              <div
                key={entry.id}
                className={`pick-card px-4 py-3 ${eligible ? 'cursor-pointer' : 'opacity-45 cursor-not-allowed'} ${isSelected ? 'pick-card-selected' : ''}`}
                onClick={() => {
                  if (!eligible) {
                    setError(ineligibleReason);
                    return;
                  }
                  toggle(entry.id);
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-start min-w-0">
                    {isSelected && <span className="pick-card-check mt-0.5">✓</span>}
                    <div className="min-w-0">
                      <p className={`text-body ${isSelected ? 'font-bold text-accent-ink' : 'font-semibold'}`}>
                        {entry.orderNo} — {entry.custName}
                      </p>
                      <p className="text-tiny text-ink-3 whitespace-nowrap">{fmtDate(entry.bohDate)}</p>
                      {!eligible && <p className="text-tiny text-err mt-1">✗ {ineligibleReason}</p>}
                      {isSelected && (
                        <p className="text-body font-bold text-accent-ink mt-1">
                          Source: <span className="tag tag-accent font-bold">{effectiveSource}</span>
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="font-bold text-accent shrink-0">{fmt(entry.amount)}</div>
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
