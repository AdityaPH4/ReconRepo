/**
 * Shared table furniture used by every panel.
 *
 * Kept here rather than duplicated per panel so a change to how, say, an empty
 * table or a difference cell looks lands in one place. Visual details live in
 * `globals.css`; these components only decide *which* named class applies.
 */

import type { ReactNode } from 'react';
import { AMOUNT_EPSILON } from '@toit/recon-core/display';

/** A titled block inside a panel — panels stack several tables vertically. */
export function PanelSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="panel-section-title">{title}</h3>
      <div className="table-wrap">{children}</div>
    </section>
  );
}

/** Full-width "nothing here" row, so an empty table still reads as deliberate. */
export function EmptyRow({
  cols,
  message,
  icon = '😊',
}: {
  cols: number;
  message: string;
  icon?: string;
}) {
  return (
    <tr>
      <td colSpan={cols}>
        <div className="empty-state">
          <div className="empty-icon">{icon}</div>
          <p>{message}</p>
        </div>
      </td>
    </tr>
  );
}

/**
 * Excess / shortage / exact-match tag.
 * Legacy: `diffTag` (reconciliation (68).html line 1577).
 */
export function DiffTag({ diff }: { diff: number }) {
  if (diff > AMOUNT_EPSILON) return <span className="tag tag-excess">▲ Excess</span>;
  if (diff < -AMOUNT_EPSILON) return <span className="tag tag-short">▼ Shortage</span>;
  return <span className="tag tag-neutral">—</span>;
}

/**
 * Class for a difference cell.
 * Legacy: `diffColor` (reconciliation (68).html line 1578).
 */
export function diffClass(diff: number | null | undefined): string {
  if (diff === null || diff === undefined || Number.isNaN(diff)) return 'diff-zero';
  if (diff > AMOUNT_EPSILON) return 'diff-excess';
  if (diff < -AMOUNT_EPSILON) return 'diff-short';
  return 'diff-zero';
}
