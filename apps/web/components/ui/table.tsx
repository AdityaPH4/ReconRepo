/**
 * Shared table furniture used by every panel.
 *
 * Kept here rather than duplicated per panel so a change to how, say, an empty
 * table or a difference cell looks lands in one place. Visual details live in
 * `globals.css`; these components only decide *which* named class applies.
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
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

/**
 * Reveals rows a page at a time as the user scrolls near the bottom of a long
 * table, instead of mounting hundreds of rows (each with its own
 * resolve/comment controls) up front — real-world row counts in the hundreds
 * were freezing the browser on first paint.
 */
export function useRevealOnScroll(total: number, pageSize = 50) {
  const [visible, setVisible] = useState(Math.min(pageSize, total));
  const sentinelRef = useRef<HTMLTableRowElement | null>(null);

  useEffect(() => {
    setVisible(Math.min(pageSize, total)); // reset when the underlying data changes
  }, [total, pageSize]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visible >= total) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setVisible((v) => Math.min(v + pageSize, total));
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, total, pageSize]);

  return { visible, sentinelRef };
}

/** Row to place at the end of a table body, just before any totals row — renders nothing once everything is shown. */
export function LoadMoreSentinel({
  sentinelRef,
  cols,
  remaining,
}: {
  sentinelRef: RefObject<HTMLTableRowElement | null>;
  cols: number;
  remaining: number;
}) {
  if (remaining <= 0) return null;
  return (
    <tr ref={sentinelRef}>
      <td colSpan={cols} className="text-ink-3 text-tiny text-center py-3">
        Loading more… ({remaining} left)
      </td>
    </tr>
  );
}
