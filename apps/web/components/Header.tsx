/**
 * Sticky app header.
 * Ported from `reconciliation (68).html` lines 275–289.
 */

import type { SessionMetaDTO } from '@toit/contracts';

export function Header({
  meta,
  subtitle,
}: {
  meta: SessionMetaDTO | null;
  subtitle: string;
}) {
  return (
    <header className="app-header">
      <div className="app-brand">
        <span className="app-brand-dot" /> Payment Reconciliation
      </div>

      <div className="flex items-center gap-2.5 flex-wrap">
        {meta && (
          <span className="pill pill-accent">
            🏢 <strong>{meta.outlet}</strong>
          </span>
        )}
        {meta?.businessDate && (
          <span className="pill pill-ok">
            📅 <strong>{meta.businessDate}</strong>
          </span>
        )}
        {meta?.status === 'submitted' && <span className="pill pill-ok">✓ Submitted</span>}
      </div>

      <div className="flex items-center gap-3">
        <div className="app-subtitle">{subtitle}</div>
        <a className="btn btn-sm" href="/">
          🏠 All modules
        </a>
      </div>
    </header>
  );
}
