/**
 * Sticky header for the MPR (Layer 2) module — mirrors `Header.tsx`'s
 * styling, but has no session outlet/business-date/submitted state of its
 * own to show (an MPR run can span several outlets and dates at once).
 */

import { UserMenu } from '@/components/auth/UserMenu';

export function MprHeader({ subtitle }: { subtitle: string }) {
  return (
    <header className="app-header">
      <div className="app-brand">
        <span className="app-brand-dot" /> MPR Reconciliation
      </div>

      <div />

      <div className="flex items-center gap-3">
        <div className="app-subtitle">{subtitle}</div>
        <a className="btn btn-sm" href="/">
          🏠 All modules
        </a>
        <UserMenu />
      </div>
    </header>
  );
}
