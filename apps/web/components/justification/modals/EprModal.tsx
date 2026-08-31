'use client';

/** Ported from `reconciliation (68).html` lines 4790–4832 (`saveEpr`). */

import { useState } from 'react';
import { fmt } from '@toit/recon-core/display';
import { ApiError, addJustificationEntry } from '@/lib/api';
import { ModalShell } from '../ModalShell';
import type { ModalProps } from '../types';

export function EprModal({ session, request, onClose, onSaved }: ModalProps) {
  const [billNo, setBillNo] = useState('');
  const [clientName, setClientName] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!billNo.trim()) {
      setError('Bill number is required.');
      return;
    }
    if (!clientName.trim()) {
      setError('Client name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await addJustificationEntry(session.meta.id, {
        source: request.source,
        targetKey: request.targetKey,
        // EPR only ever attaches to an excess-signed item.
        direction: 'excess',
        remark: 'Extra Payment Received',
        amount: request.amount,
        billNo: billNo.trim(),
        clientName: clientName.trim(),
        notes: notes.trim() || null,
        rrn: request.rrn ?? null,
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
      title="💳 Extra Payment Received"
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
      {error && (
        <div className="alert alert-warn mb-3">
          <span>⚠</span>
          <span>{error}</span>
        </div>
      )}
      <label className="field-label">Bill Number *</label>
      <input className="field-input mb-3" value={billNo} onChange={(e) => setBillNo(e.target.value)} autoFocus />
      <label className="field-label">Client Name *</label>
      <input className="field-input mb-3" value={clientName} onChange={(e) => setClientName(e.target.value)} />
      <label className="field-label">Notes</label>
      <textarea className="field-input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
    </ModalShell>
  );
}
