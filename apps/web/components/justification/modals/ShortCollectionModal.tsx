'use client';

/** Ported from `reconciliation (68).html` (`openShortCollectionModal`). */

import { useState } from 'react';
import { fmt } from '@toit/recon-core/display';
import { ApiError, addJustificationEntry } from '@/lib/api';
import { ModalShell } from '../ModalShell';
import type { ModalProps } from '../types';

export function ShortCollectionModal({ session, request, onClose, onSaved }: ModalProps) {
  const [staffName, setStaffName] = useState('');
  const [empId, setEmpId] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!staffName.trim() || !empId.trim()) {
      setError('Staff Name and Employee ID are both mandatory.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await addJustificationEntry(session.meta.id, {
        source: request.source,
        targetKey: request.targetKey,
        // Short Collection only ever attaches to a shortage-signed item.
        direction: 'shortage',
        remark: 'Short Collection',
        amount: request.amount,
        staffName: staffName.trim(),
        empId: empId.trim(),
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
      title="👤 Short Collection"
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
      <div className="alert alert-warn mb-3">
        <span>⚠</span>
        <span>Staff Name and Employee ID are both mandatory.</span>
      </div>
      {error && (
        <div className="alert alert-warn mb-3">
          <span>⚠</span>
          <span>{error}</span>
        </div>
      )}
      <label className="field-label">Staff Name *</label>
      <input
        className="field-input mb-3"
        value={staffName}
        onChange={(e) => setStaffName(e.target.value)}
        autoFocus
      />
      <label className="field-label">Employee ID *</label>
      <input className="field-input mb-3" value={empId} onChange={(e) => setEmpId(e.target.value)} />
      <label className="field-label">Notes</label>
      <textarea className="field-input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
    </ModalShell>
  );
}
