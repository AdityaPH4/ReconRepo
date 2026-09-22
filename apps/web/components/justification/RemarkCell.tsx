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
import type { DirectionDTO, JustificationSourceDTO } from '@toit/contracts';
import {
  AMOUNT_EPSILON,
  REMARKS_ALL,
  REMARKS_EXCESS,
  REMARKS_SHORTAGE_WITH_TDS,
  fmt,
  isEligibleSquareOffPartner,
  squareOffComponent,
  squareOffGroupKey,
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
  const groupKey = isSquared ? squareOffGroupKey(session.justification.squareOff, item.globalId) : null;
  const residualEntry = groupKey ? (entries.find((e) => e.targetKey === groupKey) ?? null) : null;
  const residualRemarkOptions = net === null ? [] : net > 0 ? REMARKS_EXCESS : REMARKS_SHORTAGE_WITH_TDS;

  // A dupRRN item (diff === 0) offers both lists — deduped, since 'Other'
  // appears in both and a raw REMARKS_ALL would render it as two <option>s
  // with the same key.
  //
  // Every row here is Pinelabs or HDFC-UPI (this component's `source` prop
  // is typed to exactly those two) — both traceable, transaction-level
  // sources a corporate client could pay through and have TDS deducted from,
  // same reasoning as the Bank tab — so a shortage-signed row always offers
  // "TDS Deducted" too.
  const remarkOptions =
    item.diff > AMOUNT_EPSILON
      ? REMARKS_EXCESS
      : item.diff < -AMOUNT_EPSILON
        ? REMARKS_SHORTAGE_WITH_TDS
        : [...new Set(REMARKS_ALL)];

  // A zero-diff item (dupRRN — genuinely ambiguous, no reliable amount) can
  // never square off against anything: `isEligibleSquareOffPartner` requires
  // both sides non-zero, so pairing it with any real amount would still net
  // to that partner's own non-zero diff and show as unresolved. It only
  // gets a remark control, matching legacy — ambiguous rows aren't offered a
  // square-off checkbox there either.
  const resolvedTargetKeys = new Set(entries.map((e) => e.targetKey));
  // A candidate already paired elsewhere is only excluded once that pairing
  // is itself net-resolved — a still-unresolved existing pairing doesn't rule
  // it out. Legacy: `mkCell`'s `otherItems` filter (reconciliation
  // (68).html:1010-1014): `if(xPartners.length>0&&Math.abs(getSquareOffNet(x.globalId))<0.5) return false`.
  const eligiblePartners = allItems.filter((x) => {
    if (x.globalId === item.globalId) return false;
    if (!isEligibleSquareOffPartner(item, x)) return false;
    if (resolvedTargetKeys.has(x.targetKey)) return false;
    const xPartners = session.justification.squareOff[x.globalId] ?? [];
    if (xPartners.length > 0) {
      const xNet = squareOffNet(session.justification.squareOff, x.globalId, allItems);
      if (xNet !== null && Math.abs(xNet) < AMOUNT_EPSILON) return false;
    }
    return true;
  });

  /**
   * Adding a member to an already-squared-off group, one row at a time — the
   * engine has always supported an arbitrary-size star group (see
   * `squareOffComponent`), this is purely the missing UI path to build one:
   * today, once a row shows "Squared off," its own cell has no way to add a
   * third row — only a *different*, still-unresolved row's own dropdown can
   * (by offering this group's hub as a partner). Filtered against the
   * group's current *net*, not this row's own diff — a same-signed addition
   * would only widen the residual, never shrink it.
   */
  const currentGroupMembers = isSquared ? new Set(squareOffComponent(session.justification.squareOff, item.globalId)) : null;
  const eligibleAdditionalPartners =
    isSquared && netUnresolved
      ? allItems.filter((x) => {
          if (currentGroupMembers!.has(x.globalId)) return false;
          if (Math.sign(x.diff) === 0 || Math.sign(x.diff) === Math.sign(net!)) return false;
          if (resolvedTargetKeys.has(x.targetKey)) return false;
          const xPartners = session.justification.squareOff[x.globalId] ?? [];
          if (xPartners.length > 0) {
            const xNet = squareOffNet(session.justification.squareOff, x.globalId, allItems);
            if (xNet !== null && Math.abs(xNet) < AMOUNT_EPSILON) return false;
          }
          return true;
        })
      : [];

  /**
   * Shared save path for both a row's own remark and a square-off group's
   * residual remark — same remove-then-add/modal-routing logic either way,
   * just pointed at a different `targetKey`/`amount`/`direction`. Kept as
   * one function rather than two independently-maintained copies.
   */
  async function saveRemark(
    target: { targetKey: string; amount: number; direction: DirectionDTO; existingEntryId: string | null; rrn?: string },
    remark: string,
  ) {
    setBusy(true);
    try {
      let base = session;
      if (target.existingEntryId) {
        base = await removeJustificationEntry(session.meta.id, target.existingEntryId);
        updateSession(base);
      }
      if (!remark) return;

      const modalKind = modalKindForRemark(remark);
      if (modalKind) {
        openModal({
          kind: modalKind,
          source,
          targetKey: target.targetKey,
          amount: target.amount,
          direction: target.direction,
          // BOH Clear's source is locked to whichever row triggered it —
          // legacy: `openBohClearFromRecon` (reconciliation (68).html:4607-4665).
          lockedSource: modalKind === 'boh-clear' ? (source === 'pinelabs' ? 'Pinelabs' : 'HDFC Static UPI') : undefined,
          // A row-level HDFC-UPI item already carries its own RRN (that's how
          // it got matched/listed in the first place) — `BohClearModal` uses
          // this to skip asking the operator to re-type an RRN the system
          // already knows, when the source is HDFC Static UPI specifically.
          // A group residual has no single row's RRN to pass through.
          rrn: target.rrn,
        });
        return;
      }
      const updated = await addJustificationEntry(session.meta.id, {
        source,
        targetKey: target.targetKey,
        direction: target.direction,
        remark: remark as never,
        amount: target.amount,
      });
      updateSession(updated);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Failed to update remark.');
    } finally {
      setBusy(false);
    }
  }

  function handleRemarkChange(remark: string) {
    return saveRemark(
      {
        targetKey: item.targetKey,
        amount: Math.abs(item.diff),
        direction: item.diff >= 0 ? 'excess' : 'shortage',
        existingEntryId: entry?.id ?? null,
        rrn: item.rrn || undefined,
      },
      remark,
    );
  }

  /** Explains a square-off group's leftover net — attached to the group, not this row alone. */
  function handleResidualRemarkChange(remark: string) {
    if (net === null || !groupKey) return;
    return saveRemark(
      {
        targetKey: groupKey,
        amount: Math.abs(net),
        direction: net >= 0 ? 'excess' : 'shortage',
        existingEntryId: residualEntry?.id ?? null,
      },
      remark,
    );
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

  /** Extends the current group by one more row — never an undo, unlike `handleSquareOffToggle`. */
  async function handleAddPartner(partnerId: string) {
    setBusy(true);
    try {
      const updated = await setSquareOff(session.meta.id, { a: item.globalId, b: partnerId }, true);
      updateSession(updated);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Failed to add to square-off group.');
    } finally {
      setBusy(false);
    }
  }

  const disabled = locked || busy;

  return (
    <div className="flex items-center gap-1">
      {isSquared ? (
        <div className="flex items-center gap-2 text-tiny flex-wrap">
          <span className="tag tag-pur">🔗 Squared off</span>
          {netUnresolved && (
            <span className={`tag ${residualEntry ? 'tag-ok' : 'tag-warn'}`}>
              {residualEntry ? '✓' : '⚠'} Net {net! > 0 ? '+' : ''}
              {fmt(net!)}
              {residualEntry ? ` — ${residualEntry.remark}` : ''}
            </span>
          )}
          {netUnresolved && eligibleAdditionalPartners.length > 0 && (
            <select
              className="field-input flex-1 min-w-0"
              disabled={disabled}
              value=""
              onChange={(e) => e.target.value && handleAddPartner(e.target.value)}
            >
              <option value="">+ Square off another against this…</option>
              {eligibleAdditionalPartners.map((p) => (
                <option key={p.globalId} value={p.globalId}>
                  {p.globalId} ({fmt(p.diff)})
                </option>
              ))}
            </select>
          )}
          {netUnresolved && (
            <select
              className="field-input flex-1 min-w-0"
              value={residualEntry?.remark ?? ''}
              disabled={disabled}
              onChange={(e) => handleResidualRemarkChange(e.target.value)}
            >
              <option value="">Explain residual…</option>
              {residualRemarkOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
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
        <>
          {!entry && eligiblePartners.length > 0 && (
            <select
              className="field-input flex-1 min-w-0"
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
          )}

          <select
            className="field-input flex-1 min-w-0"
            value={entry?.remark ?? ''}
            disabled={disabled}
            onChange={(e) => handleRemarkChange(e.target.value)}
          >
            <option value="">Select remark…</option>
            {remarkOptions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}
