'use client';

/**
 * Bank tab only. A corporate client deducted TDS before remitting, so the
 * bank credit is legitimately less than what was billed — a real, expected
 * shortage. This resolves that shortage immediately (same as every other
 * modal-backed remark) and also opens a long-lived repository entry that
 * stays `open` until an admin verifies the deducted amount in Form 26AS,
 * months later, from the standalone `/tds` page.
 */

import { useState } from 'react';
import { fmt } from '@toit/recon-core/display';
import { ApiError, recordTds } from '@/lib/api';
import { ModalShell } from '../ModalShell';
import type { ModalProps } from '../types';

export function TdsDeductedModal({ session, request, onClose, onSaved }: ModalProps) {
  const [clientName, setClientName] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!clientName.trim()) {
      setError('Client name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await recordTds(session.meta.id, {
        source: request.source,
        targetKey: request.targetKey,
        amount: request.amount,
        clientName: clientName.trim(),
        notes: notes.trim() || null,
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
      title="🧾 TDS Deducted"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-ok" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <p className="text-body mb-3">
        Amount: <strong>{fmt(request.amount)}</strong>
      </p>
      <p className="text-tiny text-ink-3 mb-3">
        Stays open in the TDS repository until Accounts verifies it against Form 26AS — this only resolves
        today&apos;s shortage.
      </p>
      {error && (
        <div className="alert alert-warn mb-3">
          <span>⚠</span>
          <span>{error}</span>
        </div>
      )}
      <label className="field-label">Client Name *</label>
      <input
        className="field-input mb-3"
        value={clientName}
        onChange={(e) => setClientName(e.target.value)}
        autoFocus
      />
      <label className="field-label">Notes</label>
      <textarea className="field-input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
    </ModalShell>
  );
}
