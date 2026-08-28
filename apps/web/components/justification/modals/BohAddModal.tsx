'use client';

/**
 * Ported from `reconciliation (68).html` lines 2987–3009 (`saveBohEntry`).
 *
 * Stages a new Bills-on-Hold repository row from a `bills` PR row; committed
 * to the cross-session repository only once the draft session submits.
 */

import { useState } from 'react';
import { fmt } from '@toit/recon-core/display';
import { ApiError, addBohStaging } from '@/lib/api';
import { ModalShell } from '../ModalShell';
import type { ModalProps } from '../types';

export function BohAddModal({ session, request, onClose, onSaved }: ModalProps) {
  const row = request.bohRow!;
  const [custName, setCustName] = useState(row.custName ?? '');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!custName.trim()) {
      setError('Customer name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await addBohStaging(session.meta.id, {
        orderNo: row.orderNo,
        custName: custName.trim(),
        phone: phone.trim() || null,
        amount: row.amount,
        bohDate: row.bohDate,
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
      title="🗃 Add to Bills-on-Hold Repository"
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
        Order {row.orderNo} · {fmt(row.amount)}
      </p>
      {error && (
        <div className="alert alert-warn mb-3">
          <span>⚠</span>
          <span>{error}</span>
        </div>
      )}
      <label className="field-label">Customer Name *</label>
      <input
        className="field-input mb-3"
        value={custName}
        onChange={(e) => setCustName(e.target.value)}
        autoFocus
      />
      <label className="field-label">Contact Number</label>
      <input className="field-input mb-3" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <label className="field-label">Notes</label>
      <textarea className="field-input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
    </ModalShell>
  );
}
