'use client';

/**
 * Partial submission — lock in a GM-selected subset of this session's
 * modules ("KPI tiles", everything except Swiggy/Zomato — those are
 * POS-integrated and never need settling) right now, rather than waiting
 * for the whole session to be ready at once. Every module defaults to
 * selected (the common case is still "submit everything"); unchecking one
 * leaves it open for later.
 *
 * Two-step: picking modules, then — only if at least one selected module
 * isn't actually reconciled yet — an explicit confirmation step naming
 * which ones are clean and which aren't, per the spec ("these are
 * reconciled, these are still unreconciled — are you sure you want to
 * submit still?"). A fully clean selection skips straight to submitting.
 */

import { useMemo, useState } from 'react';
import type { SessionDTO, SubmissionModuleDTO, SubmitGateDTO } from '@toit/contracts';
import { SUBMISSION_MODULES, SUBMISSION_MODULE_LABELS } from '@toit/recon-core/display';
import { ApiError, submitPartial } from '@/lib/api';
import { ModalShell } from './ModalShell';

/** `perSource`'s keys don't all match `SubmissionModule`'s own naming (`hdfc_link` vs. `hdfcLink`) — this is the one place that bridges them. */
function isModuleResolved(gate: SubmitGateDTO, module: SubmissionModuleDTO): boolean {
  switch (module) {
    case 'pinelabs':
      return gate.perSource.pinelabs;
    case 'cash':
      return gate.perSource.cash;
    case 'upi':
      return gate.perSource.upi;
    case 'bank':
      return gate.perSource.bank;
    case 'hdfc_link':
      return gate.perSource.hdfcLink;
    case 'advances':
      return gate.perSource.advances;
    case 'bills':
      return gate.perSource.bills;
  }
}

export function PartialSubmitModal({
  session,
  onClose,
  onSubmitted,
}: {
  session: SessionDTO;
  onClose: () => void;
  onSubmitted: (session: SessionDTO) => void;
}) {
  const lockedModules = session.meta.submittedModules ?? [];
  const availableModules = SUBMISSION_MODULES.filter((m) => !lockedModules.includes(m));

  const [selected, setSelected] = useState<Set<SubmissionModuleDTO>>(new Set(availableModules));
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedList = useMemo(() => availableModules.filter((m) => selected.has(m)), [availableModules, selected]);
  const unresolvedSelected = selectedList.filter((m) => !isModuleResolved(session.submitGate, m));
  const resolvedSelected = selectedList.filter((m) => isModuleResolved(session.submitGate, m));

  function toggle(module: SubmissionModuleDTO) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(module)) next.delete(module);
      else next.add(module);
      return next;
    });
  }

  function handleSubmitClick() {
    if (selectedList.length === 0) return;
    if (unresolvedSelected.length > 0) {
      setConfirming(true);
      return;
    }
    void doSubmit();
  }

  async function doSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const updated = await submitPartial(session.meta.id, selectedList);
      onSubmitted(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Submit failed.');
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  }

  if (confirming) {
    return (
      <ModalShell
        title="Confirm submission"
        onClose={onClose}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={submitting}>
              Back
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void doSubmit()} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Yes, submit anyway'}
            </button>
          </>
        }
      >
        <p className="text-body mb-3">
          Some of what you're submitting is still unreconciled. Are you sure you want to submit it anyway?
        </p>
        <ul className="mb-2">
          {resolvedSelected.map((m) => (
            <li key={m} className="flex items-center gap-2 py-1">
              <span className="text-ok">✓</span>
              <span>{SUBMISSION_MODULE_LABELS[m]} — reconciled</span>
            </li>
          ))}
          {unresolvedSelected.map((m) => (
            <li key={m} className="flex items-center gap-2 py-1">
              <span className="text-err">✗</span>
              <span>{SUBMISSION_MODULE_LABELS[m]} — still unreconciled</span>
            </li>
          ))}
        </ul>
        {error && (
          <div className="alert alert-warn mt-2">
            <span>⚠</span>
            <span>{error}</span>
          </div>
        )}
      </ModalShell>
    );
  }

  return (
    <ModalShell
      title="Submit modules"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSubmitClick}
            disabled={selectedList.length === 0 || submitting}
          >
            Submit {selectedList.length ? `(${selectedList.length})` : ''}
          </button>
        </>
      }
    >
      <p className="text-tiny text-ink-3 mb-3">
        Pick which modules to submit now. Anything left unchecked stays open for later.
      </p>
      <div className="mb-2">
        {availableModules.map((m) => {
          const ok = isModuleResolved(session.submitGate, m);
          return (
            <label key={m} className="flex items-center gap-2 py-1.5 cursor-pointer">
              <input type="checkbox" checked={selected.has(m)} onChange={() => toggle(m)} />
              <span className="flex-1">{SUBMISSION_MODULE_LABELS[m]}</span>
              <span className={ok ? 'text-ok' : 'text-err'}>{ok ? '✓ Reconciled' : '✗ Unreconciled'}</span>
            </label>
          );
        })}
      </div>
      {lockedModules.length > 0 && (
        <p className="text-tiny text-ink-3 mt-3">
          Already submitted: {lockedModules.map((m) => SUBMISSION_MODULE_LABELS[m]).join(', ')}.
        </p>
      )}
      {error && (
        <div className="alert alert-warn mt-3">
          <span>⚠</span>
          <span>{error}</span>
        </div>
      )}
    </ModalShell>
  );
}
