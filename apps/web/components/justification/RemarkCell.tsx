'use client';

/**
 * The remark picker + square-off control for one Pinelabs or HDFC-UPI
 * transaction-level row.
 * Ported from `reconciliation (68).html` lines 1000–1060 (`mkCell`) and
 * 3926–3960 (`toggleSquareOff`/`getSquareOffNet`).
 *
 * Controlled entirely by server state: the select's value is whichever
 * remark this row's justification entry (if any) carries, not local UI
 * state. That is what makes "cancel" trivial — a modal opened but not saved
 * never created an entry, so the row simply keeps showing blank; there is no
 * revert bookkeeping to do (unlike legacy's `S.actions[rmkKey]=''` on every
 * modal's cancel path).
 */

import { useState } from 'react';
import type { JustificationSourceDTO } from '@toit/contracts';
import {
  AMOUNT_EPSILON,
  REMARKS_ALL,
  REMARKS_EXCESS,
  REMARKS_SHORTAGE,
  fmt,
  isEligibleSquareOffPartner,
  squareOffNet,
  type ResolvableItem,
} from '@toit/recon-core/display';
import { ApiError, addJustificationEntry, removeJustificationEntry, setSquareOff } from '@/lib/api';
import { modalKindForRemark } from './types';
import { useJustification } from './JustificationProvider';

interface Props {
  source: Extract<JustificationSourceDTO, 'pinelabs' | 'upi_hdfc'>;
  item: ResolvableItem;
  /** Every resolvable item in this same domain (Pinelabs or HDFC-UPI) — needed to offer square-off partners. */
  allItems: ResolvableItem[];
}

export function RemarkCell({ source, item, allItems }: Props) {
  const { session, locked, updateSession, openModal } = useJustification();
  const [busy, setBusy] = useState(false);

  const entries = session.justification.entries.filter((e) => e.source === source);
  const entry = entries.find((e) => e.targetKey === item.targetKey) ?? null;
  const partners = session.justification.squareOff[item.globalId] ?? [];
  const isSquared = partners.length > 0;
  const net = isSquared ? squareOffNet(session.justification.squareOff, item.globalId, allItems) : null;
  const netUnresolved = net !== null && Math.abs(net) >= AMOUNT_EPSILON;

  // A dupRRN item (diff === 0) offers both lists — deduped, since 'Other'
  // appears in both and a raw REMARKS_ALL would render it as two <option>s
  // with the same key.
  const remarkOptions =
    item.diff > AMOUNT_EPSILON
      ? REMARKS_EXCESS
      : item.diff < -AMOUNT_EPSILON
        ? REMARKS_SHORTAGE
        : [...new Set(REMARKS_ALL)];

  // A zero-diff item (dupRRN — genuinely ambiguous, no reliable amount) can
  // never square off against anything: `isEligibleSquareOffPartner` requires
  // both sides non-zero, so pairing it with any real amount would still net
  // to that partner's own non-zero diff and show as unresolved. It only
  // gets a remark control, matching legacy — ambiguous rows aren't offered a
  // square-off checkbox there either.
  const resolvedTargetKeys = new Set(entries.map((e) => e.targetKey));
  const eligiblePartners = allItems.filter(
    (x) =>
      x.globalId !== item.globalId &&
      isEligibleSquareOffPartner(item, x) &&
      !resolvedTargetKeys.has(x.targetKey) &&
      (session.justification.squareOff[x.globalId] ?? []).length === 0,
  );

  async function handleRemarkChange(remark: string) {
    setBusy(true);
    try {
      let base = session;
      if (entry) {
        base = await removeJustificationEntry(session.meta.id, entry.id);
        updateSession(base);
      }
      if (!remark) return;

      const direction = item.diff >= 0 ? 'excess' : 'shortage';
      const modalKind = modalKindForRemark(remark);
      if (modalKind) {
        openModal({ kind: modalKind, source, targetKey: item.targetKey, amount: Math.abs(item.diff), direction });
        return;
      }
      const updated = await addJustificationEntry(session.meta.id, {
        source,
        targetKey: item.targetKey,
        direction,
        remark: remark as never,
        amount: Math.abs(item.diff),
      });
      updateSession(updated);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Failed to update remark.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSquareOffToggle(partnerId: string) {
    setBusy(true);
    try {
      const updated = isSquared
        ? await setSquareOff(session.meta.id, { a: item.globalId, b: partners[0]! }, false)
        : await setSquareOff(session.meta.id, { a: item.globalId, b: partnerId }, true);
      updateSession(updated);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Failed to update square-off.');
    } finally {
      setBusy(false);
    }
  }

  const disabled = locked || busy;

  return (
    <div className="flex flex-col gap-1">
      <select
        className="field-input"
        value={entry?.remark ?? ''}
        disabled={disabled || isSquared}
        onChange={(e) => handleRemarkChange(e.target.value)}
      >
        <option value="">{isSquared ? 'Squared off' : 'Select remark…'}</option>
        {remarkOptions.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>

      {isSquared ? (
        <div className="flex items-center gap-2 text-tiny">
          <span className="tag tag-pur">🔗 Squared off</span>
          {netUnresolved && (
            <span className="tag tag-warn">⚠ Net {net! > 0 ? '+' : ''}{fmt(net!)}</span>
          )}
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => handleSquareOffToggle(partners[0]!)}
          >
            Undo
          </button>
        </div>
      ) : (
        !entry &&
        eligiblePartners.length > 0 && (
          <select
            className="field-input"
            disabled={disabled}
            value=""
            onChange={(e) => e.target.value && handleSquareOffToggle(e.target.value)}
          >
            <option value="">Square off against…</option>
            {eligiblePartners.map((p) => (
              <option key={p.globalId} value={p.globalId}>
                {p.globalId} ({fmt(p.diff)})
              </option>
            ))}
          </select>
        )
      )}
    </div>
  );
}
