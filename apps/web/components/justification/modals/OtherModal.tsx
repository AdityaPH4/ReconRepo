'use client';

/** Ported from `reconciliation (68).html` (`openOtherModal`/`saveOther`). */

import { useState } from 'react';
import { fmt } from '@toit/recon-core/display';
import { ApiError, addJustificationEntry } from '@/lib/api';
import { ModalShell } from '../ModalShell';
import type { ModalProps } from '../types';

export function OtherModal({ session, request, onClose, onSaved }: ModalProps) {
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!comment.trim()) {
      setError('A comment is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await addJustificationEntry(session.meta.id, {
        source: request.source,
        targetKey: request.targetKey,
        direction: request.direction,
        remark: 'Other',
        amount: request.amount,
        comment: comment.trim(),
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
      title="✏️ Other"
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
      <label className="field-label">Comment *</label>
      <textarea
        className="field-input"
        rows={3}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        autoFocus
      />
    </ModalShell>
  );
}
