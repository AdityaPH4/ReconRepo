'use client';

/**
 * Ported from `reconciliation (68).html` lines 3981–4032
 * (`openAdvanceReceivedModal`/`saveAdvanceReceived`).
 */

import { useState } from 'react';
import { fmt } from '@toit/recon-core/display';
import { ApiError, recordAdvance } from '@/lib/api';
import { ModalShell } from '../ModalShell';
import type { ModalProps } from '../types';

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function AdvanceReceivedModal({ session, request, onClose, onSaved }: ModalProps) {
  const [custName, setCustName] = useState('');
  const [phone, setPhone] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const minDate = session.meta.businessDate ? addDays(session.meta.businessDate, 1) : undefined;

  async function save() {
    if (!custName.trim()) {
      setError('Customer name is required.');
      return;
    }
    if (!eventDate) {
      setError('Event date is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await recordAdvance(session.meta.id, {
        source: request.source,
        targetKey: request.targetKey,
        amount: request.amount,
        custName: custName.trim(),
        phone: phone.trim() || null,
        eventDate,
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
      title="💰 Advance Received"
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
      <label className="field-label">Customer Name *</label>
      <input
        className="field-input mb-3"
        value={custName}
        onChange={(e) => setCustName(e.target.value)}
        autoFocus
      />
      <label className="field-label">Contact Number</label>
      <input className="field-input mb-3" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <label className="field-label">
        Event Date * <span className="hint">must be after the business date</span>
      </label>
      <input
        type="date"
        className="field-input mb-3"
        min={minDate}
        value={eventDate}
        onChange={(e) => setEventDate(e.target.value)}
      />
      <label className="field-label">Notes</label>
      <textarea className="field-input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
    </ModalShell>
  );
}
